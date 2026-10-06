// Server messages of an execution (notices, PRINT, warnings) and the status of each statement, in
// one timestamped log; statement lines link back to their result.
import { useEffect, useRef, type ReactNode } from 'react'
import { MessageSquareText } from 'lucide-react'
import type { Dialect, ExecutionResult, MessageLevel, QueryMessage, StatementResult } from '@shared/types'
import { EmptyState, toast } from '@/components/ui'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/format'
import { commandSummary, resultLabel, rowCountLabel } from './result-meta'

const LEVEL_CLASS: Record<MessageLevel, string> = {
  info: 'text-muted',
  notice: 'text-info',
  warning: 'text-warning',
  error: 'text-danger',
}

function clock(at: number): string {
  const d = new Date(at)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function statementLine(execution: ExecutionResult, index: number, dialect?: Dialect): string {
  const r = execution.results[index]!
  if (r.kind === 'error') return `failed: ${r.error?.message ?? 'error'}`
  if (r.kind === 'command') return commandSummary(r, dialect)
  return rowCountLabel(r).text
}

/** "INSERT — 2 rows affected", or just "CREATE TABLE" when the summary would repeat the label. */
function statementText(execution: ExecutionResult, index: number, dialect?: Dialect): { label: string; detail?: string } {
  const r = execution.results[index]!
  const full = resultLabel(r, dialect).label
  // a command's tab label carries its row count ("INSERT · 2"), which the detail repeats
  const label = r.kind === 'command' ? (full.split(' · ')[0] ?? full) : full
  const line = statementLine(execution, index, dialect)
  const redundant = line === label || line === `${label} completed` || line.startsWith(`${label} · `)
  return redundant ? { label } : { label, detail: line }
}

/** Main logs one summary line per statement ("INSERT · 2 rows affected · 1 ms"; errors: the message). */
const SUMMARY_TAIL = / · \d[\d.,]* (ms|s|min)( \d+ s)?$/

function isSummaryOf(message: QueryMessage, result: StatementResult): boolean {
  if (result.kind === 'error') return message.level === 'error' && message.text === (result.error?.message ?? 'Statement failed')
  return message.level === 'info' && SUMMARY_TAIL.test(message.text)
}

export type MessageEntry = { type: 'message'; message: QueryMessage } | { type: 'statement'; index: number; at?: number }

/**
 * One chronological list: server messages, and each statement's status in place of the summary line
 * main logs for it (the same statement is never listed twice). Statements without a summary line
 * come last.
 */
export function messageEntries(execution: ExecutionResult): MessageEntry[] {
  const entries: MessageEntry[] = []
  let next = 0
  for (const message of execution.messages) {
    const result = execution.results[next]
    if (result && isSummaryOf(message, result)) {
      entries.push({ type: 'statement', index: next, at: message.at })
      next++
    } else {
      entries.push({ type: 'message', message })
    }
  }
  for (; next < execution.results.length; next++) entries.push({ type: 'statement', index: next })
  return entries
}

export interface MessagesViewProps {
  execution: ExecutionResult
  dialect?: Dialect
  onOpenResult: (index: number) => void
}

/** Plain-text log for "Copy all". */
export function messagesText(execution: ExecutionResult, dialect?: Dialect): string {
  return messageEntries(execution)
    .map((e) => {
      if (e.type === 'message') return `${clock(e.message.at)}  ${e.message.level.toUpperCase().padEnd(7)} ${e.message.text}`
      const r = execution.results[e.index]!
      const { label, detail } = statementText(execution, e.index, dialect)
      const time = e.at !== undefined ? `${clock(e.at)}  ` : ''
      return `${time}${(r.kind === 'error' ? 'FAILED' : 'DONE').padEnd(7)} [${e.index + 1}] ${label}${detail ? ` — ${detail}` : ''} (${formatDuration(r.durationMs)})`
    })
    .join('\n')
}

export async function copyMessages(execution: ExecutionResult, dialect?: Dialect): Promise<void> {
  try {
    await copyText(messagesText(execution, dialect))
    toast.success('Messages copied', { duration: 1600 })
  } catch (error) {
    toast.error('Could not copy', error)
  }
}

/** Server messages of the run in progress (notices, PRINT…), newest at the bottom, kept in view. */
export function LiveMessagesView({ messages, footer }: { messages: QueryMessage[]; footer?: ReactNode }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Block body: scrollIntoView returns a promise in recent Chromium, which React would call as a cleanup.
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto" aria-live="polite">
        <div className="px-3 py-2 font-mono text-xs leading-[19px]">
          {messages.map((m, i) => (
            <div key={i} className="flex gap-3 px-1">
              <span className="w-[86px] shrink-0 select-none text-subtle tabular">{clock(m.at)}</span>
              <span className={cn('w-14 shrink-0 select-none text-2xs uppercase leading-[19px] tracking-wide', LEVEL_CLASS[m.level])}>{m.level}</span>
              <span className={cn('selectable min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]', m.level === 'error' ? 'text-danger' : 'text-fg')}>{m.text}</span>
            </div>
          ))}
          <div ref={end} />
        </div>
      </div>
      {footer}
    </div>
  )
}

export function MessagesView({ execution, dialect, onOpenResult }: MessagesViewProps) {
  const { messages, results } = execution
  if (messages.length === 0 && results.length === 0) {
    return <EmptyState size="compact" icon={MessageSquareText} title="No messages" description="The server sent no notices for this run." />
  }

  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="px-3 py-2 font-mono text-xs leading-[19px]">
        {messageEntries(execution).map((e, i) => {
          if (e.type === 'message') {
            const m = e.message
            return (
              <div key={i} className="flex gap-3 px-1">
                <span className="w-[86px] shrink-0 select-none text-subtle tabular">{clock(m.at)}</span>
                <span className={cn('w-14 shrink-0 select-none text-2xs uppercase leading-[19px] tracking-wide', LEVEL_CLASS[m.level])}>{m.level}</span>
                <span className={cn('selectable min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]', m.level === 'error' ? 'text-danger' : 'text-fg')}>{m.text}</span>
              </div>
            )
          }
          const r = results[e.index]!
          const { label, detail } = statementText(execution, e.index, dialect)
          return (
            <button
              key={i}
              type="button"
              title={`Open result ${e.index + 1}`}
              onClick={() => onOpenResult(e.index)}
              className="flex w-full gap-3 rounded-[4px] px-1 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
            >
              <span className="w-[86px] shrink-0 text-subtle tabular">{e.at !== undefined ? clock(e.at) : ''}</span>
              <span className={cn('w-14 shrink-0 text-2xs uppercase leading-[19px] tracking-wide', r.kind === 'error' ? 'text-danger' : 'text-success')}>
                {r.kind === 'error' ? 'failed' : 'done'}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted">
                <span className="text-fg">{label}</span>
                {detail && <> — {detail}</>}
              </span>
              <span className="shrink-0 text-subtle tabular">{formatDuration(r.durationMs)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
