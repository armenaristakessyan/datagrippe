// Column-aware SQL literals: the cell value plus its column type, so exported INSERT scripts can be
// replayed (SQL Server binary as 0x…, PostgreSQL bytea as '\x…'::bytea, string-encoded numerics unquoted).
import type { CellValue, Dialect } from '../types'
import { sqlLiteral } from './quote'

const NUMERIC_TYPES = new Set([
  'int2', 'int4', 'int8', 'smallint', 'integer', 'bigint', 'float4', 'float8', 'real', 'double precision',
  'numeric', 'decimal', 'oid', 'smallserial', 'serial', 'bigserial', 'tinyint', 'int', 'float', 'money', 'smallmoney',
])
const BINARY_TYPES = new Set(['bytea', 'binary', 'varbinary', 'image', 'rowversion'])
const NUMERIC_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i

/** "numeric(12,2)" → "numeric"; array types ("_int4", "int4[]") are kept as is. */
function baseType(dataType: string): string {
  return dataType.trim().toLowerCase().replace(/\(.*\)$/, '').trim()
}

export type LiteralKind = 'number' | 'binary' | 'other'

/** What matters about a column type for literals. SQL Server `timestamp` is rowversion (binary). */
export function literalKind(dataType: string, dialect: Dialect): LiteralKind {
  const t = baseType(dataType)
  if (t === 'timestamp' && dialect === 'mssql') return 'binary'
  // PostgreSQL money text carries a currency symbol ("$1.00"): only plain numeric text is unquoted below.
  if (NUMERIC_TYPES.has(t)) return 'number'
  if (BINARY_TYPES.has(t)) return 'binary'
  return 'other'
}

/** SQL literal of a cell using its column type (falls back to sqlLiteral). */
export function columnLiteral(value: CellValue, dataType: string, dialect: Dialect): string {
  if (typeof value === 'string') {
    const kind = literalKind(dataType, dialect)
    if (kind === 'number' && NUMERIC_TEXT.test(value.trim())) return value.trim()
    if (kind === 'binary' && dialect === 'mssql' && /^0x[0-9a-f]*$/i.test(value)) return value
    if (kind === 'binary' && dialect === 'postgres' && /^\\x[0-9a-f]*$/i.test(value)) return `'${value}'::bytea`
  }
  return sqlLiteral(value, dialect)
}
