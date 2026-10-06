// Query plan view used by the results panel: summary header, visual tree or raw plan.
import { useMemo, useState } from 'react'
import { Check, ChevronsDownUp, ChevronsUpDown, Copy, ListTree, FileCode } from 'lucide-react'
import type { ExplainResult } from '@shared/types'
import { Badge, Callout, CodeBlock, IconButton, SegmentedControl, Tooltip } from '@/components/ui'
import { pluralize } from '@/lib/format'
import { formatCost, formatPlanTime } from './format'
import { analyzePlan, branchIds, prettyRawPlan, type PlanAnalysis } from './plan'
import { PlanTree } from './PlanTree'

type PlanView = 'visual' | 'raw'

const FORMAT_LABEL: Record<ExplainResult['format'], string> = {
  'postgres-json': 'PostgreSQL · JSON',
  'mssql-xml': 'SQL Server · Showplan XML',
}

// Remembered across results while the app runs.
let preferredView: PlanView = 'visual'

/** `sql`: the statement the plan describes, shown in the header. */
export function ExplainView({ result, sql }: { result: ExplainResult; sql?: string }) {
  const [view, setView] = useState<PlanView>(preferredView)
  const root = result.root
  const effectiveView: PlanView = root ? view : 'raw'
  const analysis = useMemo(() => (root ? analyzePlan(root, result.format) : null), [root, result.format])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [prevResult, setPrevResult] = useState(result)
  if (prevResult !== result) {
    setPrevResult(result)
    setCollapsed(new Set())
  }
  const raw = useMemo(() => prettyRawPlan(result), [result])
  // The root stays open: collapse all folds every level below it.
  const branches = useMemo(() => (root ? branchIds(root).filter((id) => id !== '0') : []), [root])

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const allCollapsed = branches.length > 0 && branches.every((id) => collapsed.has(id))

  return (
    // @container: the plan header and columns adapt to the width of the results panel, not the window.
    <div className="@container flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line px-3">
        <SegmentedControl<PlanView>
          size="xs"
          aria-label="Plan view"
          value={effectiveView}
          onValueChange={(v) => {
            preferredView = v
            setView(v)
          }}
          options={[
            { value: 'visual', label: 'Visual', icon: ListTree, disabled: !root },
            { value: 'raw', label: 'Raw', icon: FileCode },
          ]}
        />
        <PlanSummary result={result} analysis={analysis} />
        {sql ? (
          <span className="selectable hidden min-w-0 flex-1 truncate text-right font-mono text-2xs text-subtle @[560px]:block" title={sql}>
            {sql.replace(/\s+/g, ' ')}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {sql && <span className="flex-1 @[560px]:hidden" />}
        {effectiveView === 'visual' && branches.length > 0 && (
          <IconButton
            size="xs"
            icon={allCollapsed ? ChevronsUpDown : ChevronsDownUp}
            label={allCollapsed ? 'Expand all' : 'Collapse all'}
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(branches))}
          />
        )}
        <CopyButton text={raw} label={result.format === 'postgres-json' ? 'Copy JSON' : 'Copy XML'} />
      </div>

      {effectiveView === 'visual' && root && analysis ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <PlanTree root={root} format={result.format} analysis={analysis} collapsed={collapsed} onToggleCollapse={toggle} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
          {!root && (
            <Callout tone="info" title="No visual plan for this statement">
              The server returned a plan without operators to draw. The raw plan is shown below.
            </Callout>
          )}
          {raw.trim() ? (
            <CodeBlock code={raw} language="text" wrap={false} copyable={false} className="min-h-0" />
          ) : (
            <p className="px-1 text-xs text-subtle">The server returned an empty plan.</p>
          )}
        </div>
      )}
    </div>
  )
}

function SummaryItem({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Tooltip content={hint} side="bottom">
      <span className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap">
        <span className="text-subtle">{label}</span>
        <span className="font-medium text-fg tabular">{value}</span>
      </span>
    </Tooltip>
  )
}

function PlanSummary({ result, analysis }: { result: ExplainResult; analysis: PlanAnalysis | null }) {
  const analyzed = analysis?.analyzed ?? false
  return (
    <div className="flex min-w-0 items-center gap-3.5 overflow-hidden text-xs">
      {analysis && (
        <Badge tone={analyzed ? 'success' : 'neutral'} className="shrink-0">
          {analyzed ? 'Analyzed' : 'Estimated'}
        </Badge>
      )}
      {result.planningTimeMs !== undefined && (
        <SummaryItem
          label={result.format === 'mssql-xml' ? 'Compile' : 'Planning'}
          value={formatPlanTime(result.planningTimeMs)}
          hint={result.format === 'mssql-xml' ? 'Compile time reported by SQL Server' : 'Time the planner spent choosing this plan'}
        />
      )}
      {result.totalTimeMs !== undefined && (
        <SummaryItem label="Execution" value={formatPlanTime(result.totalTimeMs)} hint="Total execution time reported by the server" />
      )}
      {analysis?.totalCost !== undefined && <SummaryItem label="Cost" value={formatCost(analysis.totalCost)} hint="Estimated total cost (planner units)" />}
      {analysis && <span className="shrink-0 text-subtle">{pluralize(analysis.nodeCount, 'node')}</span>}
      {/* Hidden rather than truncated when short ("Post…" says nothing). */}
      <span className="shrink-0 whitespace-nowrap text-2xs text-subtle @max-[900px]:hidden">{FORMAT_LABEL[result.format]}</span>
    </div>
  )
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <IconButton
      size="xs"
      icon={copied ? <Check size={13} strokeWidth={2.25} className="text-success" /> : Copy}
      label={copied ? 'Copied' : label}
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          })
          .catch(() => setCopied(false))
      }}
    />
  )
}
