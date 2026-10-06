// Example WHERE clause for the filter box, built from the table's own columns.
import type { ColumnMeta, Dialect } from '@shared/types'
import { quoteIdent } from '@shared/sql'

const NUMERIC = /^(int|integer|smallint|bigint|tinyint|int[248]|serial|numeric|decimal|float[48]?|real|double|money|smallmoney)\b/i
const TEXT = /(char|text|string|citext)/i

export function filterPlaceholder(columns: readonly ColumnMeta[] | undefined, dialect: Dialect): string {
  const number = columns?.find((c) => NUMERIC.test(c.dataType))
  const text = columns?.find((c) => TEXT.test(c.dataType))
  const literal = dialect === 'mssql' ? "N'A%'" : "'A%'"
  const parts: string[] = []
  if (number) parts.push(`${quoteIdent(number.name, dialect)} > 100`)
  if (text) parts.push(`${quoteIdent(text.name, dialect)} LIKE ${literal}`)
  return parts.length > 0 ? parts.join(' AND ') : `name LIKE ${literal}`
}
