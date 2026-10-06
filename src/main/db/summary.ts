// One-line, human-readable summaries of statement results for the Output/messages panel.
import type { QueryMessage, StatementResult } from '@shared/types'

const ROW_COUNT_COMMANDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY', 'MOVE', 'FETCH', 'SELECT INTO', 'CREATE TABLE AS'])

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds === 60 ? `${minutes + 1} min` : `${minutes} min ${seconds} s`
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? singular : plural}`
}

const TWO_WORD_COMMANDS = new Set(['CREATE', 'ALTER', 'DROP'])

/** Leading command of the statement, ignoring comments (fallback when the driver gives no command tag). */
export function leadingKeyword(sql: string): string | undefined {
  const stripped = sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '')
  const words = stripped.match(/^[A-Za-z_]+(?:\s+[A-Za-z_]+){0,3}/)?.[0].toUpperCase().split(/\s+/)
  if (!words?.length) return undefined
  const [first] = words
  if (!TWO_WORD_COMMANDS.has(first)) return first
  const rest = words.slice(1)
  if (rest[0] === 'OR' && (rest[1] === 'REPLACE' || rest[1] === 'ALTER')) rest.splice(0, 2)
  if (rest[0] === 'UNIQUE' || rest[0] === 'CLUSTERED' || rest[0] === 'NONCLUSTERED') rest.shift()
  return rest[0] ? `${first} ${rest[0]}` : first
}

export function summarizeResult(result: StatementResult): { level: 'info' | 'error'; text: string } {
  const duration = formatDuration(result.durationMs)
  if (result.kind === 'error') {
    return { level: 'error', text: result.error?.message ?? 'Statement failed' }
  }
  const command = (result.command?.trim() || leadingKeyword(result.sql) || 'Statement').toUpperCase()
  if (result.kind === 'rows') {
    const fetched = result.rows.length
    const rows = result.hasMore ? `first ${count(fetched, 'row')}` : count(result.rowCount ?? fetched, 'row')
    return { level: 'info', text: `${command} · ${rows} · ${duration}` }
  }
  const showCount =
    result.rowCount !== null && result.rowCount !== undefined && (ROW_COUNT_COMMANDS.has(command) || !result.command)
  if (showCount && result.rowCount !== null) {
    return { level: 'info', text: `${command} · ${count(result.rowCount, 'row')} affected · ${duration}` }
  }
  return { level: 'info', text: `${command} · ${duration}` }
}

/**
 * Server messages + one summary per result, in stream order. A message that carries `resultsBefore`
 * (the driver knows how many results came before it) goes right after the summary of that many results.
 * Other messages are placed by time: result i is considered done at startedAt + Σ durations[0..i], and a
 * summary sorts after server messages with the same timestamp.
 */
export function buildMessages(results: StatementResult[], serverMessages: QueryMessage[], startedAt: number): QueryMessage[] {
  const summaries: QueryMessage[] = []
  const doneAt: number[] = []
  let at = startedAt
  for (const result of results) {
    at += Math.max(0, result.durationMs)
    const summary = summarizeResult(result)
    doneAt.push(Math.round(at))
    summaries.push({ level: summary.level, text: summary.text, at: Math.round(at) })
  }
  // Each message gets a slot: the number of summaries that precede it.
  const slotted = serverMessages.map((message, seq) => {
    let slot: number
    if (typeof message.resultsBefore === 'number' && Number.isFinite(message.resultsBefore)) {
      slot = Math.max(0, Math.min(results.length, Math.floor(message.resultsBefore)))
    } else {
      slot = 0
      while (slot < doneAt.length && doneAt[slot] < message.at) slot++
    }
    return { message, slot, seq }
  })
  slotted.sort((a, b) => a.slot - b.slot || a.seq - b.seq)
  const out: QueryMessage[] = []
  let next = 0
  for (let i = 0; i <= summaries.length; i++) {
    while (next < slotted.length && slotted[next].slot === i) out.push(slotted[next++].message)
    if (i < summaries.length) out.push(summaries[i])
  }
  return out
}
