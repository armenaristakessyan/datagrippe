// Visual plan tree: one row per operator with indentation guides, metrics and a share bar.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronRight, TriangleAlert } from 'lucide-react'
import type { PlanNode } from '@shared/types'
import { Badge, Tooltip } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatCost, formatFactor, formatPlanTime, formatRows, formatShare } from './format'
import { flattenPlan, heatTone, type FlatPlanRow, type HeatTone, type NodeMetrics, type PlanAnalysis, type PlanFormat } from './plan'

const INDENT = 16
/** Height of a row's first line; elbows and handles are centred on it. */
const LINE = 32

const HEAT_BAR: Record<HeatTone, string> = {
  neutral: 'bg-faint',
  warning: 'bg-warning',
  danger: 'bg-danger',
}

const HEAT_TEXT: Record<HeatTone, string> = {
  neutral: 'text-subtle',
  warning: 'text-warning',
  danger: 'text-danger',
}

export interface PlanTreeProps {
  root: PlanNode
  format: PlanFormat
  analysis: PlanAnalysis
  collapsed: ReadonlySet<string>
  onToggleCollapse: (id: string) => void
}

/**
 * Grid template shared by the header and the rows: the operation column takes the free space and
 * truncates; the metric columns keep fixed widths. Below 760px of plan width (an `@container` set by
 * ExplainView) the metric columns tighten and the share column keeps only its percentage.
 */
const COLUMNS = cn(
  'grid grid-cols-[minmax(240px,1fr)_136px_52px_84px_84px_128px]',
  '@max-[760px]:grid-cols-[minmax(180px,1fr)_120px_44px_72px_72px_52px]',
)

export function PlanTree({ root, format, analysis, collapsed, onToggleCollapse }: PlanTreeProps) {
  const rows = useMemo(() => flattenPlan(root, collapsed), [root, collapsed])
  const [active, setActive] = useState<string>(rows[0]?.id ?? '0')
  const [expandedDetails, setExpandedDetails] = useState<ReadonlySet<string>>(() => new Set())
  const treeRef = useRef<HTMLDivElement>(null)

  // Keep the active row valid when a subtree collapses under it.
  useEffect(() => {
    if (rows.some((r) => r.id === active)) return
    const ancestor = rows.filter((r) => active.startsWith(`${r.id}.`)).pop()
    setActive(ancestor?.id ?? rows[0]?.id ?? '0')
  }, [rows, active])

  useEffect(() => {
    treeRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(active)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const toggleDetails = (id: string) => {
    setExpandedDetails((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex((r) => r.id === active)
    const row = rows[index]
    if (!row) return
    const go = (i: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, i))]
      if (target) setActive(target.id)
    }
    switch (e.key) {
      case 'ArrowDown':
        go(index + 1)
        break
      case 'ArrowUp':
        go(index - 1)
        break
      case 'Home':
        go(0)
        break
      case 'End':
        go(rows.length - 1)
        break
      case 'ArrowRight':
        if (row.collapsed) onToggleCollapse(row.id)
        else if (row.hasChildren) go(index + 1)
        break
      case 'ArrowLeft':
        if (row.hasChildren && !row.collapsed) onToggleCollapse(row.id)
        else if (row.parentId) setActive(row.parentId)
        break
      case 'Enter':
      case ' ':
        if (row.node.details.length > 0) toggleDetails(row.id)
        break
      default:
        return
    }
    e.preventDefault()
  }

  const basisLabel = analysis.basis === 'time' ? 'Time share' : analysis.basis === 'cost' ? 'Cost share' : 'Share'

  return (
    <div className="min-w-[540px]">
      <div
        className={cn(
          COLUMNS,
          'sticky top-0 z-10 h-7 items-center border-b border-line bg-panel text-2xs font-medium uppercase tracking-wider text-subtle',
        )}
      >
        <span className="px-3">Operation</span>
        <span className="truncate pr-3 text-right" title={analysis.analyzed ? 'Estimated → actual rows' : 'Estimated rows'}>
          <span className="@max-[760px]:hidden">{analysis.analyzed ? 'Rows est. → act.' : 'Rows est.'}</span>
          <span className="hidden @max-[760px]:inline">Rows</span>
        </span>
        <span className="pr-3 text-right">Loops</span>
        <span className="pr-3 text-right">Cost</span>
        <span className="pr-3 text-right">Time</span>
        <span className="truncate pr-3 @max-[760px]:text-right" title={basisLabel}>
          <span className="@max-[760px]:hidden">{basisLabel}</span>
          <span className="hidden @max-[760px]:inline">Share</span>
        </span>
      </div>
      <div
        ref={treeRef}
        role="tree"
        aria-label="Query plan"
        tabIndex={0}
        aria-activedescendant={`plan-row-${active}`}
        onKeyDown={onKeyDown}
        className="group/tree outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
      >
        {rows.map((row) => (
          <PlanRow
            key={row.id}
            row={row}
            format={format}
            analysis={analysis}
            metrics={analysis.metrics.get(row.id)}
            active={row.id === active}
            detailsOpen={expandedDetails.has(row.id)}
            onActivate={() => setActive(row.id)}
            onToggleCollapse={() => onToggleCollapse(row.id)}
            onToggleDetails={() => toggleDetails(row.id)}
          />
        ))}
      </div>
    </div>
  )
}

interface PlanRowProps {
  row: FlatPlanRow
  format: PlanFormat
  analysis: PlanAnalysis
  metrics: NodeMetrics | undefined
  active: boolean
  detailsOpen: boolean
  onActivate: () => void
  onToggleCollapse: () => void
  onToggleDetails: () => void
}

function PlanRow({ row, format, analysis, metrics, active, detailsOpen, onActivate, onToggleCollapse, onToggleDetails }: PlanRowProps) {
  const { node } = row
  const share = metrics?.share ?? 0
  const tone = heatTone(share)
  const hasDetails = node.details.length > 0
  const dim = metrics?.neverExecuted

  return (
    <div
      id={`plan-row-${row.id}`}
      data-row={row.id}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.hasChildren ? !row.collapsed : undefined}
      aria-selected={active}
      onMouseDown={onActivate}
      onClick={() => hasDetails && onToggleDetails()}
      className={cn(
        COLUMNS,
        'group relative border-b border-line/60 text-xs',
        // The active row is emphasised only while the tree has focus.
        active ? 'bg-hover group-focus/tree:bg-active' : 'hover:bg-hover',
        hasDetails && 'cursor-default',
      )}
    >
      <div className={cn('relative flex min-w-0', dim && 'opacity-50')}>
        <Guides row={row} />
        <div className="min-w-0 flex-1 py-[7px] pr-3">
          <div className="flex h-[18px] min-w-0 items-center gap-2">
            <span className="shrink-0 text-[12.5px] font-semibold text-fg">{node.operation}</span>
            {node.relation && <span className="min-w-0 shrink truncate font-mono text-xs text-muted">{node.relation}</span>}
            {metrics?.misestimate && <MisestimateBadge node={node} metrics={metrics} />}
            {row.collapsed && (
              <Badge tone="outline" className="shrink-0">
                +{row.hiddenCount}
              </Badge>
            )}
          </div>
          {hasDetails && !detailsOpen && <p className="mt-0.5 truncate font-mono text-2xs leading-4 text-subtle">{node.details[0]}</p>}
          {hasDetails && detailsOpen && (
            <dl className="selectable mt-1 space-y-0.5 font-mono text-2xs leading-4" onClick={(e) => e.stopPropagation()}>
              {node.details.map((line, i) => (
                <DetailLine key={i} line={line} />
              ))}
            </dl>
          )}
        </div>
      </div>

      <Metric dim={dim}>
        <RowsCell node={node} format={format} metrics={metrics} analyzed={analysis.analyzed} />
      </Metric>
      <Metric dim={dim}>
        {node.loops !== undefined && node.loops !== 1 ? <span className="text-muted">×{formatRows(node.loops)}</span> : <Faint />}
      </Metric>
      <Metric dim={dim}>
        {node.estimatedCost !== undefined ? (
          <Tooltip content={metrics?.selfCost !== undefined ? `Self: ${formatCost(metrics.selfCost)}` : undefined} side="top">
            <span className="text-muted">{formatCost(node.estimatedCost)}</span>
          </Tooltip>
        ) : (
          <Faint />
        )}
      </Metric>
      <Metric dim={dim}>
        {metrics?.inclusiveTimeMs !== undefined ? (
          <Tooltip
            content={`Self: ${formatPlanTime(metrics.selfTimeMs)}${node.loops && node.loops > 1 && format === 'postgres-json' ? ` · ${formatPlanTime(node.actualTimeMs)} per loop` : ''}`}
            side="top"
          >
            <span className="text-fg">{formatPlanTime(metrics.inclusiveTimeMs)}</span>
          </Tooltip>
        ) : (
          <Faint />
        )}
      </Metric>
      <div className="flex items-start pr-3 pt-[9px]">
        {analysis.basis === 'none' ? (
          <Faint />
        ) : (
          <div className="flex w-full items-center gap-2" title={`${formatShare(share)} of the plan's ${analysis.basis === 'time' ? 'time' : 'cost'} spent in this node`}>
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-hover @max-[760px]:hidden">
              <div
                className={cn('h-full rounded-full transition-[width] duration-150', HEAT_BAR[tone])}
                style={{ width: `${Math.max(share > 0 ? 2 : 0, share * 100)}%` }}
              />
            </div>
            <span
              className={cn(
                'min-w-9 shrink-0 whitespace-nowrap text-right text-2xs tabular @max-[760px]:ml-auto',
                HEAT_TEXT[tone],
                tone !== 'neutral' && 'font-medium',
              )}
            >
              {formatShare(share)}
            </span>
          </div>
        )}
      </div>

      {row.hasChildren && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={row.collapsed ? 'Expand' : 'Collapse'}
          onClick={(e) => {
            e.stopPropagation()
            onToggleCollapse()
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute flex size-4 items-center justify-center rounded-[3px] border border-line-strong bg-elevated text-muted hover:border-faint hover:text-fg"
          style={{ left: handleLeft(row.depth), top: LINE / 2 - 8 }}
        >
          <ChevronRight size={11} strokeWidth={2.25} className={cn('transition-transform duration-100', !row.collapsed && 'rotate-90')} />
        </button>
      )}
    </div>
  )
}

/** Left offset of a row's handle column (12px padding + one INDENT per depth level). */
const handleLeft = (depth: number) => 12 + depth * INDENT

/** Indentation columns: continuing guides, the row's elbow, and the line down to its children. */
function Guides({ row }: { row: FlatPlanRow }) {
  const width = 12 + (row.depth + 1) * INDENT + 6
  const center = (column: number) => 12 + column * INDENT + 7.5
  const lines: ReactNode[] = []
  row.guides.forEach((continues, k) => {
    if (continues) lines.push(<span key={`g${k}`} className="absolute inset-y-0 w-px bg-line-strong" style={{ left: center(k) }} />)
  })
  if (row.depth > 0) {
    const column = row.depth - 1
    lines.push(
      <span
        key="elbow-v"
        className="absolute top-0 w-px bg-line-strong"
        style={{ left: center(column), height: row.isLast ? LINE / 2 : '100%' }}
      />,
      <span key="elbow-h" className="absolute h-px bg-line-strong" style={{ left: center(column), top: LINE / 2, width: INDENT - 4 }} />,
    )
  }
  if (row.hasChildren && !row.collapsed) {
    lines.push(<span key="down" className="absolute bottom-0 w-px bg-line-strong" style={{ left: center(row.depth), top: LINE / 2 }} />)
  }
  if (!row.hasChildren) {
    lines.push(
      <span
        key="dot"
        className="absolute size-[5px] rounded-full bg-faint"
        style={{ left: center(row.depth) - 2, top: LINE / 2 - 2.5 }}
      />,
    )
  }
  return (
    <div aria-hidden className="relative shrink-0" style={{ width }}>
      {lines}
    </div>
  )
}

function Metric({ children, dim }: { children: ReactNode; dim?: boolean }) {
  return <div className={cn('flex justify-end pr-3 pt-[9px] text-right tabular', dim && 'opacity-50')}>{children}</div>
}

function Faint() {
  return <span className="text-faint">—</span>
}

function RowsCell({ node, format, metrics, analyzed }: { node: PlanNode; format: PlanFormat; metrics: NodeMetrics | undefined; analyzed: boolean }) {
  if (metrics?.neverExecuted) return <span className="text-2xs italic text-subtle">never executed</span>
  const estimate = node.estimatedRows !== undefined ? formatRows(node.estimatedRows) : '—'
  if (!analyzed || metrics?.actualRowsPerLoop === undefined) return <span className="text-muted">{estimate}</span>
  const misestimated = metrics.misestimate !== null
  const total = metrics.actualRowsTotal
  const perLoopNote = node.loops && node.loops > 1 && total !== undefined ? `${formatRows(total)} rows over ${formatRows(node.loops)} loops` : undefined
  const unit = format === 'mssql-xml' && node.loops && node.loops > 1 ? 'per execution' : node.loops && node.loops > 1 ? 'per loop' : undefined
  return (
    <Tooltip content={perLoopNote ? `${perLoopNote}${unit ? ` (shown ${unit})` : ''}` : undefined} side="top">
      <span className="inline-flex items-baseline gap-1">
        <span className="text-subtle">{estimate}</span>
        <span className="text-faint">→</span>
        <span className={cn(misestimated ? 'font-medium text-warning' : 'text-fg')}>{formatRows(metrics.actualRowsPerLoop)}</span>
      </span>
    </Tooltip>
  )
}

function MisestimateBadge({ node, metrics }: { node: PlanNode; metrics: NodeMetrics }) {
  const m = metrics.misestimate
  if (!m) return null
  const severe = m.factor >= 100
  const content = `Planner expected ${formatRows(node.estimatedRows)} row${node.estimatedRows === 1 ? '' : 's'}, got ${formatRows(metrics.actualRowsPerLoop)} — ${formatFactor(m.factor)} ${m.direction === 'under' ? 'more' : 'fewer'}. Outdated statistics or correlated predicates are common causes.`
  return (
    <Tooltip content={content} side="top">
      <Badge tone={severe ? 'danger' : 'warning'} icon={TriangleAlert} className="shrink-0">
        {formatFactor(m.factor)} {m.direction}
      </Badge>
    </Tooltip>
  )
}

function DetailLine({ line }: { line: string }) {
  const colon = line.indexOf(': ')
  if (colon <= 0 || colon > 40) return <dd className="text-muted [overflow-wrap:anywhere]">{line}</dd>
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-subtle">{line.slice(0, colon)}</dt>
      <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">{line.slice(colon + 2)}</dd>
    </div>
  )
}
