// Pure helpers behind the visual plan: per-node metrics, time/cost shares, misestimates,
// tree flattening with indentation guides, and raw plan pretty-printing.
//
// Dialect semantics (see src/main/db/postgres/explain.ts and src/main/db/mssql/showplan.ts):
//  - postgres-json: actualRows / actualTimeMs are per loop (averages); time is inclusive of children.
//  - mssql-xml: actualRows is the total over all executions (loops), actualTimeMs is the operator's
//    elapsed wall time (inclusive); estimatedRows is per execution.
// Costs are inclusive (PostgreSQL "Total Cost", SQL Server subtree cost) in both.
import type { ExplainResult, PlanNode } from '@shared/types'

export type PlanFormat = ExplainResult['format']

export type ShareBasis = 'time' | 'cost' | 'none'

export type HeatTone = 'neutral' | 'warning' | 'danger'

export interface Misestimate {
  /** ≥ threshold; how many times the estimate is off. */
  factor: number
  /** under: more rows than estimated; over: fewer rows than estimated. */
  direction: 'under' | 'over'
}

export interface NodeMetrics {
  /** Time spent in the node and its children over all loops (ms). */
  inclusiveTimeMs?: number
  /** Time attributable to the node alone (inclusive minus children, ≥ 0). */
  selfTimeMs?: number
  /** Cost attributable to the node alone (inclusive minus children, ≥ 0). */
  selfCost?: number
  /** Rows per loop, comparable with estimatedRows. */
  actualRowsPerLoop?: number
  /** Rows produced over all loops. */
  actualRowsTotal?: number
  /** Node share (0..1) of the plan's total time, or of the total cost when not analyzed. */
  share: number
  misestimate: Misestimate | null
  /** The node never ran (loops = 0 in an analyzed plan). */
  neverExecuted: boolean
}

export interface PlanAnalysis {
  analyzed: boolean
  basis: ShareBasis
  /** Denominator of `share` (ms or cost units). */
  total?: number
  totalCost?: number
  nodeCount: number
  /** Metrics by node id (see nodeId). */
  metrics: Map<string, NodeMetrics>
  /** Largest share of any node, for scaling. */
  maxShare: number
}

export const MISESTIMATE_THRESHOLD = 10

/** Stable id of a node: its child-index path from the root ("0", "0.1", "0.1.0"). */
export const ROOT_ID = '0'
export const childId = (parent: string, index: number) => `${parent}.${index}`

function finite(n: number | undefined): n is number {
  return n !== undefined && Number.isFinite(n)
}

/** Actual rows per loop (comparable with the per-loop estimate). */
export function actualRowsPerLoop(node: PlanNode, format: PlanFormat): number | undefined {
  if (!finite(node.actualRows)) return undefined
  if (format === 'mssql-xml') {
    const loops = finite(node.loops) && node.loops > 0 ? node.loops : 1
    return node.actualRows / loops
  }
  return node.actualRows
}

/** Actual rows over all loops. */
export function actualRowsTotal(node: PlanNode, format: PlanFormat): number | undefined {
  if (!finite(node.actualRows)) return undefined
  if (format === 'mssql-xml') return node.actualRows
  return node.actualRows * (finite(node.loops) ? node.loops : 1)
}

/** Own inclusive time over all loops, when the node carries timing. */
function ownInclusiveTime(node: PlanNode, format: PlanFormat): number | undefined {
  if (!finite(node.actualTimeMs)) return undefined
  if (format === 'mssql-xml') return node.actualTimeMs
  return node.actualTimeMs * (finite(node.loops) ? node.loops : 1)
}

/**
 * Estimate vs actual (both per loop). Rows are floored at 1 so "0 vs 1" is not flagged;
 * returns null when either side is missing or the node never ran.
 */
export function detectMisestimate(
  estimated: number | undefined,
  actual: number | undefined,
  threshold = MISESTIMATE_THRESHOLD,
): Misestimate | null {
  if (!finite(estimated) || !finite(actual)) return null
  const e = Math.max(1, estimated)
  const a = Math.max(1, actual)
  if (a / e >= threshold) return { factor: a / e, direction: 'under' }
  if (e / a >= threshold) return { factor: e / a, direction: 'over' }
  return null
}

/** Neutral below 15 %, warning below 40 %, danger above. */
export function heatTone(share: number): HeatTone {
  if (share >= 0.4) return 'danger'
  if (share >= 0.15) return 'warning'
  return 'neutral'
}

function hasTiming(node: PlanNode): boolean {
  return finite(node.actualTimeMs) || node.children.some(hasTiming)
}

function hasCost(node: PlanNode): boolean {
  return finite(node.estimatedCost) || node.children.some(hasCost)
}

function countNodes(node: PlanNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0)
}

/** Compute every node's metrics and the plan-wide share basis. */
export function analyzePlan(root: PlanNode, format: PlanFormat): PlanAnalysis {
  const metrics = new Map<string, NodeMetrics>()
  const analyzed = hasTiming(root)
  const costed = hasCost(root)

  // Inclusive time: own timing when present, otherwise the sum of the children (statement / batch nodes).
  const inclusiveTime = new Map<string, number | undefined>()
  const inclusiveCost = new Map<string, number | undefined>()
  const measure = (node: PlanNode, id: string): void => {
    node.children.forEach((child, i) => measure(child, childId(id, i)))
    const own = ownInclusiveTime(node, format)
    const childTimes = node.children.map((_, i) => inclusiveTime.get(childId(id, i)))
    const summed = childTimes.some(finite) ? childTimes.reduce<number>((s, t) => s + (t ?? 0), 0) : undefined
    inclusiveTime.set(id, own ?? summed)
    const childCosts = node.children.map((_, i) => inclusiveCost.get(childId(id, i)))
    const summedCost = childCosts.some(finite) ? childCosts.reduce<number>((s, c) => s + (c ?? 0), 0) : undefined
    inclusiveCost.set(id, finite(node.estimatedCost) ? node.estimatedCost : summedCost)
  }
  measure(root, ROOT_ID)

  // Time when analyzed, unless the whole plan ran below the timer resolution (SQL Server reports
  // whole milliseconds): then cost tells more than a row of zeros.
  const rootTime = inclusiveTime.get(ROOT_ID)
  const basis: ShareBasis = analyzed && finite(rootTime) && rootTime > 0 ? 'time' : costed ? 'cost' : analyzed ? 'time' : 'none'
  const total = basis === 'time' ? rootTime : basis === 'cost' ? inclusiveCost.get(ROOT_ID) : undefined
  let maxShare = 0

  const visit = (node: PlanNode, id: string): void => {
    const time = inclusiveTime.get(id)
    const cost = inclusiveCost.get(id)
    const childTime = node.children.reduce((s, _, i) => s + (inclusiveTime.get(childId(id, i)) ?? 0), 0)
    const childCost = node.children.reduce((s, _, i) => s + (inclusiveCost.get(childId(id, i)) ?? 0), 0)
    const selfTimeMs = finite(time) ? Math.max(0, time - childTime) : undefined
    const selfCost = finite(cost) ? Math.max(0, cost - childCost) : undefined
    const part = basis === 'time' ? selfTimeMs : basis === 'cost' ? selfCost : undefined
    const share = finite(part) && finite(total) && total > 0 ? Math.min(1, part / total) : 0
    if (share > maxShare) maxShare = share
    const neverExecuted = analyzed && finite(node.loops) && node.loops === 0
    const perLoop = actualRowsPerLoop(node, format)
    metrics.set(id, {
      inclusiveTimeMs: time,
      selfTimeMs,
      selfCost,
      actualRowsPerLoop: perLoop,
      actualRowsTotal: actualRowsTotal(node, format),
      share,
      misestimate: neverExecuted ? null : detectMisestimate(node.estimatedRows, perLoop),
      neverExecuted,
    })
    node.children.forEach((child, i) => visit(child, childId(id, i)))
  }
  visit(root, ROOT_ID)

  return {
    analyzed,
    basis,
    total,
    totalCost: inclusiveCost.get(ROOT_ID),
    nodeCount: countNodes(root),
    metrics,
    maxShare,
  }
}

export interface FlatPlanRow {
  id: string
  node: PlanNode
  depth: number
  /**
   * One entry per ancestor level between the root's children and this row (length = max(0, depth - 1)):
   * true when a vertical guide continues through this row at that level (that ancestor has later siblings).
   * Column depth - 1 holds the row's own elbow (├ or └, see isLast).
   */
  guides: boolean[]
  /** Last child of its parent (draws └ instead of ├). */
  isLast: boolean
  hasChildren: boolean
  collapsed: boolean
  /** Number of descendants hidden under a collapsed node. */
  hiddenCount: number
  parentId: string | null
}

/** Depth-first rows of the visible tree; children of collapsed nodes are skipped. */
export function flattenPlan(root: PlanNode, collapsed: ReadonlySet<string>): FlatPlanRow[] {
  const rows: FlatPlanRow[] = []
  const walk = (node: PlanNode, id: string, depth: number, guides: boolean[], isLast: boolean, parentId: string | null) => {
    const isCollapsed = collapsed.has(id) && node.children.length > 0
    rows.push({
      id,
      node,
      depth,
      guides,
      isLast,
      hasChildren: node.children.length > 0,
      collapsed: isCollapsed,
      hiddenCount: isCollapsed ? countNodes(node) - 1 : 0,
      parentId,
    })
    if (isCollapsed) return
    const childGuides = depth === 0 ? [] : [...guides, !isLast]
    node.children.forEach((child, i) => {
      walk(child, childId(id, i), depth + 1, childGuides, i === node.children.length - 1, id)
    })
  }
  walk(root, ROOT_ID, 0, [], true, null)
  return rows
}

/** Ids of every node that has children (for "collapse all"). */
export function branchIds(root: PlanNode): string[] {
  const ids: string[] = []
  const walk = (node: PlanNode, id: string) => {
    if (node.children.length === 0) return
    ids.push(id)
    node.children.forEach((child, i) => walk(child, childId(id, i)))
  }
  walk(root, ROOT_ID)
  return ids
}

// ---------------------------------------------------------------------------
// Raw plan formatting
// ---------------------------------------------------------------------------

/** Pretty-print the raw plan: indented JSON for PostgreSQL, indented XML for SQL Server. */
export function prettyRawPlan(result: Pick<ExplainResult, 'format' | 'raw'>): string {
  if (result.format === 'postgres-json') {
    try {
      return JSON.stringify(JSON.parse(result.raw), null, 2)
    } catch {
      return result.raw
    }
  }
  return formatXml(result.raw)
}

type XmlToken = { kind: 'open' | 'close' | 'self' | 'decl' | 'text'; text: string }

function tokenizeXml(xml: string): XmlToken[] {
  const tokens: XmlToken[] = []
  let i = 0
  const n = xml.length
  while (i < n) {
    if (xml[i] !== '<') {
      const end = xml.indexOf('<', i)
      const text = xml.slice(i, end < 0 ? n : end)
      if (text.trim()) tokens.push({ kind: 'text', text: text.trim() })
      i = end < 0 ? n : end
      continue
    }
    const until = (marker: string, kind: XmlToken['kind']) => {
      const end = xml.indexOf(marker, i)
      const stop = end < 0 ? n : end + marker.length
      tokens.push({ kind, text: xml.slice(i, stop) })
      i = stop
    }
    if (xml.startsWith('<!--', i)) until('-->', 'decl')
    else if (xml.startsWith('<![CDATA[', i)) until(']]>', 'text')
    else if (xml.startsWith('<?', i)) until('?>', 'decl')
    else if (xml.startsWith('<!', i)) until('>', 'decl')
    else {
      // Element tag: find the closing '>' outside quoted attribute values.
      let j = i + 1
      let quote: string | null = null
      while (j < n) {
        const c = xml[j]
        if (quote) {
          if (c === quote) quote = null
        } else if (c === '"' || c === "'") quote = c
        else if (c === '>') break
        j++
      }
      const tag = xml.slice(i, Math.min(n, j + 1))
      const kind: XmlToken['kind'] = tag.startsWith('</') ? 'close' : tag.endsWith('/>') ? 'self' : 'open'
      tokens.push({ kind, text: tag })
      i = j + 1
    }
  }
  return tokens
}

/** Indent XML one element per line; `<a>text</a>` and `<a></a>` stay on one line. Multiple documents are separated by a blank line. */
export function formatXml(xml: string, indent = '  '): string {
  const tokens = tokenizeXml(xml)
  const lines: string[] = []
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    const pad = indent.repeat(depth)
    if (token.kind === 'open') {
      const next = tokens[i + 1]
      const after = tokens[i + 2]
      if (next?.kind === 'text' && after?.kind === 'close') {
        lines.push(`${pad}${token.text}${next.text}${after.text}`)
        i += 2
      } else if (next?.kind === 'close') {
        lines.push(`${pad}${token.text}${next.text}`)
        i += 1
      } else {
        lines.push(pad + token.text)
        depth++
      }
    } else if (token.kind === 'close') {
      depth = Math.max(0, depth - 1)
      lines.push(indent.repeat(depth) + token.text)
    } else {
      // A new top-level document starts after a completed one.
      if (depth === 0 && token.kind === 'decl' && token.text.startsWith('<?xml') && lines.length > 0) lines.push('')
      lines.push(pad + token.text)
    }
  }
  return lines.join('\n')
}
