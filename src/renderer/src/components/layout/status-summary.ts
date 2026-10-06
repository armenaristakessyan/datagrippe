// What the status bar says about a console's last run. It always describes the same thing as the
// view above it: the active result (count and that statement's duration, as in the results header),
// the whole script when the Messages view of a multi-statement run is shown, or the plan.
import type { ExecutionResult, ExplainResult, StatementResult } from '@shared/types'
import { formatCount, pluralize } from '@/lib/format'

export interface ExecutionSummary {
  text: string
  durationMs?: number
  danger?: boolean
  /** Longer description (tooltip). */
  title?: string
}

function describeResult(result: StatementResult): string {
  if (result.kind === 'error') return 'Failed'
  if (result.kind === 'rows') {
    const count = result.rowCount ?? result.rows.length
    return `${formatCount(count)}${result.hasMore ? '+' : ''} ${count === 1 ? 'row' : 'rows'}`
  }
  if (result.rowCount !== null) return `${formatCount(result.rowCount)} affected`
  return result.command ?? 'Done'
}

/** Null when there is nothing to describe yet. */
export function summarizeExecution(
  execution: ExecutionResult | undefined,
  activeResult: number,
  view: 'results' | 'messages' | 'explain',
  explain?: ExplainResult,
): ExecutionSummary | null {
  if (view === 'explain' && explain) {
    return explain.totalTimeMs !== undefined
      ? { text: 'Plan', durationMs: explain.totalTimeMs, title: 'Execution time reported by the plan' }
      : { text: 'Plan' }
  }
  if (!execution) return null
  const { results } = execution
  if (execution.cancelled) return { text: 'Cancelled', durationMs: execution.durationMs }
  if (results.length === 0) return { text: 'No statements', durationMs: execution.durationMs }
  const failed = results.filter((r) => r.kind === 'error').length
  const active = results[activeResult]
  if (results.length > 1 && (view === 'messages' || !active)) {
    return {
      text: `${pluralize(results.length, 'statement')}${failed > 0 ? ` · ${formatCount(failed)} failed` : ''}`,
      durationMs: execution.durationMs,
      danger: failed > 0,
      title: 'Whole script, all statements',
    }
  }
  const result = active ?? results[results.length - 1]!
  return {
    text: describeResult(result),
    durationMs: result.durationMs,
    danger: result.kind === 'error',
    title: results.length > 1 ? `Statement ${result.index + 1} of ${results.length}` : undefined,
  }
}
