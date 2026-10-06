// Column type classification from ColumnMeta.dataType (PostgreSQL typname / SQL Server type name).
// Drives cell rendering (alignment, glyphs), sorting and SQL literal rendering.
import type { CellValue, ColumnMeta, Dialect } from '@shared/types'

export type ColumnKind = 'number' | 'boolean' | 'json' | 'xml' | 'date' | 'binary' | 'uuid' | 'array' | 'text'

const NUMBER_TYPES = new Set([
  // postgres
  'int2', 'int4', 'int8', 'smallint', 'integer', 'bigint', 'float4', 'float8', 'real', 'double precision',
  'numeric', 'decimal', 'money', 'oid', 'xid', 'cid', 'smallserial', 'serial', 'bigserial',
  // sql server
  'tinyint', 'int', 'float', 'smallmoney',
])

const DATE_TYPES = new Set([
  'date', 'time', 'timetz', 'timestamp', 'timestamptz', 'interval', 'time with time zone', 'time without time zone',
  'timestamp with time zone', 'timestamp without time zone',
  'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset',
])

const BINARY_TYPES = new Set(['bytea', 'binary', 'varbinary', 'image', 'rowversion'])

/** Strip modifiers and array markers: "numeric(12,2)" → "numeric", "_int4" stays (arrays handled separately). */
function baseType(dataType: string): string {
  return dataType.trim().toLowerCase().replace(/\(.*\)$/, '').trim()
}

export function isArrayType(dataType: string): boolean {
  const t = dataType.trim()
  return t.endsWith('[]') || (t.startsWith('_') && t.length > 1)
}

/**
 * Kind of a column from its type name. SQL Server `timestamp` is rowversion (binary), PostgreSQL
 * `timestamp` is a date/time; SQL Server `bit` is a boolean, PostgreSQL `bit(n)` a bit string (text).
 * Pass the dialect when known (without it, `bit` columns are classified from their values).
 */
export function columnKind(dataType: string, dialect?: Dialect): ColumnKind {
  if (isArrayType(dataType)) return 'array'
  const t = baseType(dataType)
  if (t === 'timestamp' && dialect === 'mssql') return 'binary'
  if (NUMBER_TYPES.has(t)) return 'number'
  if (t === 'bool' || t === 'boolean') return 'boolean'
  // SQL Server bit is a boolean; PostgreSQL bit(n) / bit varying are bit strings ('1', '0', '101')
  if (t === 'bit' && dialect === 'mssql') return 'boolean'
  if (t === 'json' || t === 'jsonb') return 'json'
  if (t === 'xml') return 'xml'
  if (DATE_TYPES.has(t)) return 'date'
  if (BINARY_TYPES.has(t)) return 'binary'
  if (t === 'uuid' || t === 'uniqueidentifier') return 'uuid'
  return 'text'
}

/**
 * Kind refined with a sample of values: unknown types that only hold JS numbers / booleans are
 * treated as such (sql_variant, computed expressions typed as text by a driver, …).
 */
export function inferColumnKind(column: ColumnMeta, rows: readonly CellValue[][], col: number, dialect?: Dialect): ColumnKind {
  const kind = columnKind(column.dataType, dialect)
  if (kind !== 'text') return kind
  let numbers = 0
  let booleans = 0
  let others = 0
  const limit = Math.min(rows.length, 50)
  for (let r = 0; r < limit; r++) {
    const v = rows[r]?.[col]
    if (v === null || v === undefined) continue
    if (typeof v === 'number') numbers++
    else if (typeof v === 'boolean') booleans++
    else others++
  }
  if (others === 0 && numbers > 0 && booleans === 0) return 'number'
  if (others === 0 && booleans > 0 && numbers === 0) return 'boolean'
  if (others > 0 && numbers === 0 && booleans === 0 && dialect !== 'mssql') {
    // binary values from drivers that report an unusual type name
    let hex = 0
    for (let r = 0; r < limit; r++) {
      const v = rows[r]?.[col]
      if (typeof v === 'string' && /^\\x[0-9a-f]*$/i.test(v)) hex++
    }
    if (hex === others) return 'binary'
  }
  return 'text'
}

const NUMERIC_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i

/** A string-encoded number (bigint, numeric, money without currency symbol…). */
export function isNumericText(value: string): boolean {
  return NUMERIC_TEXT.test(value.trim())
}

/** Binary hex literal as produced by the drivers ("\\x…" on PostgreSQL, "0x…" on SQL Server). */
export function binaryHex(value: string): string | null {
  if (value.startsWith('\\x')) return value.slice(2)
  if (value.startsWith('0x') || value.startsWith('0X')) return value.slice(2)
  return null
}

/** Number of bytes represented by a binary hex value. */
export function binaryLength(value: string): number {
  const hex = binaryHex(value)
  return hex === null ? value.length : Math.floor(hex.length / 2)
}
