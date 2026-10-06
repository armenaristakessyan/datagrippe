// Parse EXPLAIN (FORMAT JSON) output into the dialect-neutral PlanNode tree.
import type { ExplainResult, PlanNode } from '@shared/types'
import { DriverError } from '../errors'

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(node: JsonObject, key: string): string | undefined {
  const v = node[key]
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}

function numberOf(node: JsonObject, key: string): number | undefined {
  const v = node[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function list(node: JsonObject, key: string): string | undefined {
  const v = node[key]
  if (Array.isArray(v)) return v.map((item) => String(item)).join(', ')
  return text(node, key)
}

const AGGREGATE_STRATEGY: Record<string, string> = {
  Plain: 'Aggregate',
  Sorted: 'GroupAggregate',
  Hashed: 'HashAggregate',
  Mixed: 'MixedAggregate',
}

const SETOP_STRATEGY: Record<string, string> = { Sorted: 'SetOp', Hashed: 'HashSetOp' }

/** Mirrors the node labels of text-format EXPLAIN ("HashAggregate", "Hash Join (Left)", "Index Scan Backward"). */
export function operationName(node: JsonObject): string {
  const type = text(node, 'Node Type') ?? 'Unknown'
  const strategy = text(node, 'Strategy')
  let name = type
  if (type === 'Aggregate' && strategy) name = AGGREGATE_STRATEGY[strategy] ?? type
  else if (type === 'SetOp' && strategy) name = SETOP_STRATEGY[strategy] ?? type
  const partial = text(node, 'Partial Mode')
  if (partial && partial !== 'Simple') name = `${partial} ${name}`
  if (text(node, 'Scan Direction') === 'Backward') name = `${name} Backward`
  const join = text(node, 'Join Type')
  if (join && join !== 'Inner') name = `${name} (${join})`
  const command = text(node, 'Operation')
  if (type === 'ModifyTable' && command) name = command
  return name
}

function relationOf(node: JsonObject): string | undefined {
  const relation = text(node, 'Relation Name')
  const alias = text(node, 'Alias')
  if (relation) {
    const schema = text(node, 'Schema')
    const qualified = schema ? `${schema}.${relation}` : relation
    return alias && alias !== relation ? `${qualified} ${alias}` : qualified
  }
  const other = text(node, 'CTE Name') ?? text(node, 'Function Name') ?? text(node, 'Subplan Name')
  if (other) return alias && alias !== other ? `${other} ${alias}` : other
  return undefined
}

/** Detail lines in text-EXPLAIN order: "<label>: <value>". */
const DETAIL_KEYS: [key: string, label?: string][] = [
  ['Index Name'],
  ['Index Cond'],
  ['Recheck Cond'],
  ['Hash Cond'],
  ['Merge Cond'],
  ['Join Filter'],
  ['Filter'],
  ['One-Time Filter'],
  ['TID Cond'],
  ['Rows Removed by Index Recheck'],
  ['Rows Removed by Join Filter'],
  ['Rows Removed by Filter'],
  ['Sort Key'],
  ['Presorted Key'],
  ['Group Key'],
  ['Hash Key'],
  ['Cache Key'],
  ['Sort Method'],
  ['Heap Fetches'],
  ['Workers Planned'],
  ['Workers Launched'],
  ['Hash Buckets'],
  ['Hash Batches'],
  ['Peak Memory Usage', 'Memory Usage (kB)'],
]

const BUFFER_PARTS: [key: string, label: string][] = [
  ['Shared Hit Blocks', 'shared hit'],
  ['Shared Read Blocks', 'shared read'],
  ['Shared Dirtied Blocks', 'shared dirtied'],
  ['Shared Written Blocks', 'shared written'],
  ['Local Hit Blocks', 'local hit'],
  ['Local Read Blocks', 'local read'],
  ['Temp Read Blocks', 'temp read'],
  ['Temp Written Blocks', 'temp written'],
]

function bufferLine(node: JsonObject): string | undefined {
  const parts = BUFFER_PARTS.flatMap(([key, label]) => {
    const n = numberOf(node, key)
    return n ? [`${label}=${n}`] : []
  })
  return parts.length > 0 ? `Buffers: ${parts.join(' ')}` : undefined
}

function detailsOf(node: JsonObject): string[] {
  const out: string[] = []
  for (const [key, label] of DETAIL_KEYS) {
    const value = list(node, key)
    if (value === undefined || value === '') continue
    if (key === 'Sort Method') {
      const space = numberOf(node, 'Sort Space Used')
      const type = text(node, 'Sort Space Type')
      out.push(space !== undefined ? `Sort Method: ${value}  ${type ?? 'Memory'}: ${space}kB` : `Sort Method: ${value}`)
      continue
    }
    out.push(`${label ?? key}: ${value}`)
  }
  const buffers = bufferLine(node)
  if (buffers) out.push(buffers)
  return out
}

export function toPlanNode(node: JsonObject): PlanNode {
  const children = Array.isArray(node.Plans) ? node.Plans.filter(isObject).map(toPlanNode) : []
  return {
    operation: operationName(node),
    details: detailsOf(node),
    relation: relationOf(node),
    estimatedRows: numberOf(node, 'Plan Rows'),
    estimatedCost: numberOf(node, 'Total Cost'),
    actualRows: numberOf(node, 'Actual Rows'),
    actualTimeMs: numberOf(node, 'Actual Total Time'),
    loops: numberOf(node, 'Actual Loops'),
    children,
  }
}

/** `planText` is the single "QUERY PLAN" value of EXPLAIN (FORMAT JSON). */
export function parseExplain(planText: string): ExplainResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(planText)
  } catch {
    throw DriverError.of('internal', 'The server returned an unreadable plan')
  }
  const top = Array.isArray(parsed) ? parsed[0] : parsed
  const raw = JSON.stringify(parsed, null, 2)
  if (!isObject(top) || !isObject(top.Plan)) return { format: 'postgres-json', raw, root: null }
  return {
    format: 'postgres-json',
    raw,
    root: toPlanNode(top.Plan),
    planningTimeMs: numberOf(top, 'Planning Time'),
    totalTimeMs: numberOf(top, 'Execution Time'),
  }
}
