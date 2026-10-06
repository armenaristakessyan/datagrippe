import { format } from 'sql-formatter'
import type { Dialect } from '../types'
import { tokenize } from './lexer'
import { findGoLines } from './split'
import type { FormatOptions } from './types'

function formatPart(sql: string, dialect: Dialect, options: FormatOptions): string {
  return format(sql, {
    language: dialect === 'postgres' ? 'postgresql' : 'transactsql',
    keywordCase: options.keywordCase,
    tabWidth: Math.max(1, Math.trunc(options.tabWidth) || 2),
  })
}

/** SQL Server: GO is not T-SQL, so each batch is formatted on its own and GO lines are kept verbatim. */
function formatMssql(sql: string, options: FormatOptions): string {
  const tokens = tokenize(sql, 'mssql')
  const lines: string[] = []
  let from = 0
  const append = (text: string): void => {
    if (text) lines.push(text)
  }
  for (const go of findGoLines(sql, tokens)) {
    const batch = sql.slice(from, tokens[go.first].start).trim()
    if (batch) append(formatPart(batch, 'mssql', options))
    append(sql.slice(tokens[go.first].start, tokens[go.last].end).trim())
    from = tokens[go.last].end
  }
  const rest = sql.slice(from).trim()
  if (rest) append(formatPart(rest, 'mssql', options))
  return lines.join('\n')
}

export function formatSql(sql: string, dialect: Dialect, options: FormatOptions): string {
  if (!sql.trim()) return sql
  try {
    const formatted = dialect === 'mssql' ? formatMssql(sql, options) : formatPart(sql, dialect, options)
    return /\n\s*$/.test(sql) ? `${formatted}\n` : formatted
  } catch {
    return sql
  }
}
