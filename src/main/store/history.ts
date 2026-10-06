// history.json — executed statements, newest first, capped in entries and in size.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isSignificant, tokenize } from '@shared/sql/lexer'
import type { Dialect, HistoryEntry, HistoryQuery } from '@shared/types'
import { isRecord, JsonFile } from './json-file'

export const HISTORY_MAX_ENTRIES = 2000
/** Longest SQL kept per entry; longer scripts are cut and flagged `truncated`. */
export const HISTORY_MAX_SQL_CHARS = 64 * 1024
/** Total SQL kept across entries (oldest dropped first), so history.json stays small to rewrite. */
export const HISTORY_MAX_TOTAL_CHARS = 4 * 1024 * 1024

const REDACTED = '********'
/** Keywords followed (optionally after "=") by a secret string literal. */
const SECRET_KEYWORDS = new Set(['PASSWORD', 'SECRET'])

/**
 * Replace string literals that follow PASSWORD / SECRET (ALTER ROLE … PASSWORD '…', CREATE LOGIN … WITH
 * PASSWORD = N'…', CREATE CREDENTIAL … SECRET = '…') so history.json never holds them in clear text.
 */
export function redactSecrets(sql: string, dialect: Dialect): string {
  if (!/password|secret/i.test(sql)) return sql
  const tokens = tokenize(sql, dialect).filter(isSignificant)
  const ranges: [number, number][] = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== 'word' || !SECRET_KEYWORDS.has(tokens[i].upper)) continue
    let j = i + 1
    if (tokens[j]?.kind === 'punct' && sql[tokens[j].start] === '=') j++
    const value = tokens[j]
    if (value?.kind === 'string') ranges.push([value.start, value.end])
  }
  if (ranges.length === 0) return sql
  let out = ''
  let at = 0
  for (const [start, end] of ranges) {
    out += sql.slice(at, start) + `'${REDACTED}'`
    at = end
  }
  return out + sql.slice(at)
}

/** SQL as stored in the history: secrets redacted, cut at HISTORY_MAX_SQL_CHARS. */
export function historySql(sql: string, dialect: Dialect): { sql: string; truncated?: true } {
  const clean = redactSecrets(sql, dialect)
  if (clean.length <= HISTORY_MAX_SQL_CHARS) return { sql: clean }
  return { sql: clean.slice(0, HISTORY_MAX_SQL_CHARS), truncated: true }
}

function sameStatement(a: Omit<HistoryEntry, 'id'>, b: HistoryEntry): boolean {
  return a.connectionId === b.connectionId && a.database === b.database && a.schema === b.schema && a.sql === b.sql
}

export class HistoryStore {
  private readonly file: JsonFile<HistoryEntry[]>
  private readonly max: number

  constructor(baseDir: string, options: { debounceMs?: number; max?: number; log?: Pick<Console, 'warn' | 'error'> } = {}) {
    this.max = options.max ?? HISTORY_MAX_ENTRIES
    this.file = new JsonFile<HistoryEntry[]>(join(baseDir, 'history.json'), {
      fallback: () => [],
      parse: (raw) => {
        if (!Array.isArray(raw)) throw new Error('expected an array')
        return raw.filter(isEntry).slice(0, this.max)
      },
      debounceMs: options.debounceMs ?? 1000,
      pretty: false,
      log: options.log,
    })
  }

  /**
   * Record an execution. Re-running the newest entry's statement replaces that entry (no run of
   * duplicates), SQL longer than HISTORY_MAX_SQL_CHARS is cut, and the oldest entries go once the total
   * SQL size passes HISTORY_MAX_TOTAL_CHARS.
   */
  add(entry: Omit<HistoryEntry, 'id'> & { id?: string }): HistoryEntry {
    const full: HistoryEntry = { ...entry, id: entry.id ?? randomUUID() }
    if (full.sql.length > HISTORY_MAX_SQL_CHARS) {
      full.sql = full.sql.slice(0, HISTORY_MAX_SQL_CHARS)
      full.truncated = true
    }
    const previous = this.file.get()
    const rest = previous.length > 0 && sameStatement(full, previous[0]) ? previous.slice(1) : previous
    const next: HistoryEntry[] = [full]
    let total = full.sql.length
    for (const e of rest) {
      if (next.length >= this.max) break
      total += e.sql.length
      if (total > HISTORY_MAX_TOTAL_CHARS) break
      next.push(e)
    }
    this.file.set(next)
    return full
  }

  list(query: HistoryQuery = {}): HistoryEntry[] {
    const search = query.search?.trim().toLowerCase()
    const limit = query.limit && query.limit > 0 ? query.limit : Infinity
    const out: HistoryEntry[] = []
    for (const entry of this.file.get()) {
      if (query.connectionId && entry.connectionId !== query.connectionId) continue
      if (search && !entry.sql.toLowerCase().includes(search)) continue
      out.push({ ...entry })
      if (out.length >= limit) break
    }
    return out
  }

  clear(connectionId?: string): void {
    this.file.set(connectionId ? this.file.get().filter((e) => e.connectionId !== connectionId) : [])
  }

  flush(): void {
    this.file.flush()
  }
}

function isEntry(raw: unknown): raw is HistoryEntry {
  return (
    isRecord(raw) &&
    typeof raw.id === 'string' &&
    typeof raw.connectionId === 'string' &&
    typeof raw.sql === 'string' &&
    typeof raw.executedAt === 'string' &&
    typeof raw.durationMs === 'number' &&
    typeof raw.success === 'boolean'
  )
}
