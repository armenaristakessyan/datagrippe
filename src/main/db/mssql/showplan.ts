// Showplan XML (SET SHOWPLAN_XML / STATISTICS XML) → PlanNode tree.

import type { ExplainResult, PlanNode } from '@shared/types'
import { childElements, findDescendants, firstChild, parseXml, type XmlElement } from './xml'

const isRelOp = (element: XmlElement): boolean => element.local === 'RelOp'
const isStatement = (element: XmlElement): boolean => element.local.startsWith('Stmt')

function numberAttr(element: XmlElement | undefined, name: string): number | undefined {
  const raw = element?.attributes[name]
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function unbracket(name: string): string {
  return name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1).replace(/]]/g, ']') : name
}

function relationOf(relOp: XmlElement): string | undefined {
  const object = findDescendants(relOp, 'Object', isRelOp)[0]
  if (!object) return undefined
  const { Schema: schema, Table: table, Index: index } = object.attributes
  if (!table) return index ? `[${unbracket(index)}]` : undefined
  const qualified = schema ? `${unbracket(schema)}.${unbracket(table)}` : unbracket(table)
  return index ? `${qualified} [${unbracket(index)}]` : qualified
}

const SCAN_OPERATORS: Record<string, string> = {
  EQ: '=',
  GT: '>',
  GE: '>=',
  LT: '<',
  LE: '<=',
  IS: 'IS',
  IS_NOT: 'IS NOT',
  ISNOT: 'IS NOT',
  IS_NOT_NULL: 'IS NOT NULL',
  IS_NULL: 'IS NULL',
}

function scalarString(element: XmlElement | undefined): string | undefined {
  if (!element) return undefined
  const scalar = element.local === 'ScalarOperator' ? element : firstChild(element, 'ScalarOperator')
  return scalar?.attributes.ScalarString
}

function columnName(reference: XmlElement): string {
  const column = reference.attributes.Column ?? '?'
  const table = reference.attributes.Alias ?? reference.attributes.Table
  return table ? `${unbracket(table)}.${column}` : column
}

/** "id = (1)" style rendering of one Prefix / StartRange / EndRange element. */
function rangeText(range: XmlElement): string | undefined {
  const columns = findDescendants(firstChild(range, 'RangeColumns') ?? range, 'ColumnReference').map(columnName)
  const expressions = childElements(firstChild(range, 'RangeExpressions') ?? range, 'ScalarOperator').map(
    (scalar) => scalar.attributes.ScalarString ?? '?',
  )
  if (columns.length === 0) return undefined
  const op = SCAN_OPERATORS[range.attributes.ScanType ?? 'EQ'] ?? range.attributes.ScanType ?? '='
  return columns.map((column, i) => `${column} ${op} ${expressions[i] ?? ''}`.trim()).join(' AND ')
}

function detailsOf(relOp: XmlElement): string[] {
  const details: string[] = []
  for (const seek of findDescendants(relOp, 'SeekPredicates', isRelOp)) {
    const ranges = [
      ...findDescendants(seek, 'Prefix'),
      ...findDescendants(seek, 'StartRange'),
      ...findDescendants(seek, 'EndRange'),
    ]
    const parts = ranges.map(rangeText).filter((part): part is string => part !== undefined)
    if (parts.length > 0) details.push(`Seek: ${parts.join(' AND ')}`)
  }
  for (const predicate of findDescendants(relOp, 'Predicate', isRelOp)) {
    const text = scalarString(predicate)
    if (text) details.push(`Predicate: ${text}`)
  }
  return details
}

function relOpNode(relOp: XmlElement): PlanNode {
  const physical = relOp.attributes.PhysicalOp ?? relOp.attributes.LogicalOp ?? 'Operator'
  const logical = relOp.attributes.LogicalOp
  const node: PlanNode = {
    operation: logical && logical !== physical ? `${physical} (${logical})` : physical,
    details: detailsOf(relOp),
    estimatedRows: numberAttr(relOp, 'EstimateRows'),
    estimatedCost: numberAttr(relOp, 'EstimatedTotalSubtreeCost'),
    children: findDescendants(relOp, 'RelOp', isRelOp).map(relOpNode),
  }
  const relation = relationOf(relOp)
  if (relation) node.relation = relation

  const runtime = firstChild(relOp, 'RunTimeInformation')
  const counters = runtime ? childElements(runtime, 'RunTimeCountersPerThread') : []
  if (counters.length > 0) {
    let rows = 0
    let executions = 0
    let elapsed: number | undefined
    for (const counter of counters) {
      rows += numberAttr(counter, 'ActualRows') ?? 0
      executions += numberAttr(counter, 'ActualExecutions') ?? 0
      const ms = numberAttr(counter, 'ActualElapsedms')
      // Threads run concurrently: the operator's wall time is the slowest thread.
      if (ms !== undefined) elapsed = Math.max(elapsed ?? 0, ms)
    }
    node.actualRows = rows
    node.loops = executions
    if (elapsed !== undefined) node.actualTimeMs = elapsed
  }
  return node
}

interface StatementPlan {
  node: PlanNode
  hasPlan: boolean
  elapsedMs?: number
  compileMs?: number
}

function statementPlan(statement: XmlElement): StatementPlan {
  const condition = firstChild(statement, 'Condition')
  const plans = [...childElements(statement, 'QueryPlan'), ...(condition ? childElements(condition, 'QueryPlan') : [])]
  const children: PlanNode[] = []
  let elapsedMs: number | undefined
  let compileMs: number | undefined
  for (const plan of plans) {
    children.push(...childElements(plan, 'RelOp').map(relOpNode))
    const elapsed = numberAttr(firstChild(plan, 'QueryTimeStats'), 'ElapsedTime')
    if (elapsed !== undefined) elapsedMs = (elapsedMs ?? 0) + elapsed
    const compile = numberAttr(plan, 'CompileTime')
    if (compile !== undefined) compileMs = (compileMs ?? 0) + compile
  }
  // IF / WHILE branches contain nested statements.
  const nested = findDescendants(statement, 'Statements', isStatement).flatMap((list) =>
    list.children.filter(isStatement).map(statementPlan),
  )
  for (const inner of nested) {
    if (!inner.hasPlan) continue
    children.push(inner.node)
    if (inner.elapsedMs !== undefined) elapsedMs = (elapsedMs ?? 0) + inner.elapsedMs
    if (inner.compileMs !== undefined) compileMs = (compileMs ?? 0) + inner.compileMs
  }
  const text = statement.attributes.StatementText?.trim()
  return {
    node: {
      operation: statement.attributes.StatementType ?? statement.local.replace(/^Stmt/, ''),
      details: text ? [text] : [],
      estimatedRows: numberAttr(statement, 'StatementEstRows'),
      estimatedCost:
        numberAttr(statement, 'StatementSubTreeCost') ??
        (children.some((child) => child.estimatedCost !== undefined)
          ? children.reduce((sum, child) => sum + (child.estimatedCost ?? 0), 0)
          : undefined),
      children,
    },
    hasPlan: children.length > 0,
    elapsedMs,
    compileMs,
  }
}

function documentStatements(document: XmlElement): StatementPlan[] {
  return findDescendants(document, 'Statements', isStatement).flatMap((list) =>
    list.children.filter(isStatement).map(statementPlan),
  )
}

/** Parse one or more showplan documents (one per statement for STATISTICS XML) into a plan tree. */
export function parseShowplan(documents: string[]): ExplainResult {
  const statements = documents.flatMap((xml) => documentStatements(parseXml(xml)))
  const planned = statements.filter((statement) => statement.hasPlan)
  let root: PlanNode | null = null
  if (planned.length === 1) {
    const only = planned[0]?.node
    root = only && only.children.length === 1 ? (only.children[0] ?? null) : (only ?? null)
  } else if (planned.length > 1) {
    root = {
      operation: 'Batch',
      details: [],
      estimatedCost: planned.reduce((sum, s) => sum + (s.node.estimatedCost ?? 0), 0),
      children: planned.map((s) => s.node),
    }
  }

  const sum = (pick: (s: StatementPlan) => number | undefined): number | undefined => {
    const values = statements.map(pick).filter((v): v is number => v !== undefined)
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) : undefined
  }
  const result: ExplainResult = { format: 'mssql-xml', raw: documents.join('\n'), root }
  const total = sum((s) => s.elapsedMs)
  const planning = sum((s) => s.compileMs)
  if (total !== undefined) result.totalTimeMs = total
  if (planning !== undefined) result.planningTimeMs = planning
  return result
}
