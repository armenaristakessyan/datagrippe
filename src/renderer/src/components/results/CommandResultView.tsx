// Summary card of a statement that returned no rows (DML / DDL): affected rows, command, duration.
import { CheckCircle2 } from 'lucide-react'
import type { Dialect, StatementResult } from '@shared/types'
import { CodeBlock } from '@/components/ui'
import { formatDuration } from '@/lib/format'
import { commandSummary } from './result-meta'

export function CommandResultView({ result, dialect }: { result: StatementResult; dialect?: Dialect }) {
  return (
    <div className="flex h-full min-h-0 items-start justify-center overflow-auto p-6">
      <div className="flex w-full max-w-xl flex-col gap-3 rounded-xl border border-line bg-panel p-4 shadow-inset">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-success/25 bg-success-soft text-success">
            <CheckCircle2 size={18} strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg tabular">{commandSummary(result, dialect)}</p>
            <p className="text-xs text-subtle tabular">
              {result.command ? `${result.command} · ` : ''}
              {formatDuration(result.durationMs)}
            </p>
          </div>
        </div>
        <CodeBlock code={result.sql} maxHeight={180} />
      </div>
    </div>
  )
}
