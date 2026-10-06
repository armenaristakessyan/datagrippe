// Map a failed statement's error location (PostgreSQL character position, SQL Server line) back to a
// range in the console text.
import type { ExecutionResult, StatementResult } from '@shared/types'

export interface TextRange {
  start: number
  end: number
}

export interface MappedError extends TextRange {
  message: string
}

const IDENT_CHAR = /[\p{L}\p{N}_$@#]/u

/**
 * UTF-16 offset of the `index`-th code point of `text`. PostgreSQL counts error positions in
 * characters, so every astral character (emoji, some CJK) before the error is two UTF-16 units here.
 */
export function codePointOffset(text: string, index: number): number {
  let offset = 0
  for (let n = 0; n < index && offset < text.length; n++) {
    const code = text.codePointAt(offset)!
    offset += code > 0xffff ? 2 : 1
  }
  return offset
}

/** Where `result.sql` starts in `text`: at the recorded offset when unchanged, else the nearest copy. */
function locateStatement(text: string, sql: string, expected: number): number | null {
  if (expected >= 0 && text.startsWith(sql, expected)) return expected
  // The text was edited after the run: look for the statement nearby (closest occurrence).
  let best: number | null = null
  for (let i = text.indexOf(sql); i !== -1; i = text.indexOf(sql, i + 1)) {
    if (best === null || Math.abs(i - expected) < Math.abs(best - expected)) best = i
  }
  return best
}

/** Range of the token starting at `start` (an identifier, a quoted identifier, or a single character). */
function tokenRange(text: string, start: number, limit: number): TextRange {
  const s = Math.min(Math.max(start, 0), Math.max(limit - 1, 0))
  const ch = text[s]
  if (ch === undefined) return { start: s, end: s }
  if (ch === '"' || ch === '[' || ch === "'") {
    const close = ch === '[' ? ']' : ch
    const end = text.indexOf(close, s + 1)
    return { start: s, end: end === -1 || end >= limit ? Math.min(limit, s + 1) : end + 1 }
  }
  let e = s
  while (e < limit && IDENT_CHAR.test(text[e]!)) e++
  return { start: s, end: e > s ? e : s + 1 }
}

/** Absolute range of the error of `result`, or null when the error has no usable location. */
export function errorRange(text: string, executionOffset: number, result: Pick<StatementResult, 'sql' | 'offset' | 'error'>): MappedError | null {
  const error = result.error
  if (!error || (error.position === undefined && error.line === undefined)) return null
  const base = locateStatement(text, result.sql, executionOffset + result.offset)
  if (base === null) return null
  const limit = base + result.sql.length
  if (error.position !== undefined && error.position >= 1) {
    const rel = Math.min(codePointOffset(result.sql, error.position - 1), Math.max(result.sql.length - 1, 0))
    return { ...tokenRange(text, base + rel, limit), message: error.message }
  }
  if (error.line !== undefined && error.line >= 1) {
    const lines = result.sql.split('\n')
    const index = Math.min(error.line, lines.length) - 1
    let lineStart = 0
    for (let i = 0; i < index; i++) lineStart += lines[i]!.length + 1
    const line = lines[index]!
    const lead = line.length - line.trimStart().length
    const content = line.trim()
    const start = base + lineStart + lead
    return { start, end: start + Math.max(content.length, 1), message: error.message }
  }
  return null
}

/** The first mappable error of an execution. */
export function executionErrorRange(text: string, executionOffset: number, execution: ExecutionResult): MappedError | null {
  for (const r of execution.results) {
    if (r.kind !== 'error' && !r.error) continue
    const mapped = errorRange(text, executionOffset, r)
    if (mapped) return mapped
  }
  return null
}
