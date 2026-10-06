// SQL Server value → CellValue normalization (see CellValue in @shared/types).

import type { CellValue } from '@shared/types'
import { float32Number, formatTimeOfDay, plainNumber } from './exact-values'

/** Column type information common to tedious result metadata and catalog columns. */
export interface SqlTypeInfo {
  /** SQL Server type name, lower case: "int", "nvarchar", "datetime2", "timestamp"… */
  name: string
  /** Fractional-second digits (time, datetime2, datetimeoffset) or decimal scale. */
  scale?: number
}

/** Shape of the tedious column metadata fields we read. */
export interface TediousColumnLike {
  type: { name: string }
  dataLength?: number
  scale?: number
  userType?: number
  udtInfo?: { typeName: string }
}

const TIMESTAMP_USER_TYPE = 80

const FIXED_NAMES: Record<string, string> = {
  Bit: 'bit',
  BitN: 'bit',
  TinyInt: 'tinyint',
  SmallInt: 'smallint',
  Int: 'int',
  BigInt: 'bigint',
  Real: 'real',
  Float: 'float',
  Money: 'money',
  SmallMoney: 'smallmoney',
  Decimal: 'decimal',
  DecimalN: 'decimal',
  Numeric: 'numeric',
  NumericN: 'numeric',
  Date: 'date',
  Time: 'time',
  DateTime: 'datetime',
  SmallDateTime: 'smalldatetime',
  DateTime2: 'datetime2',
  DateTimeOffset: 'datetimeoffset',
  UniqueIdentifier: 'uniqueidentifier',
  Char: 'char',
  NChar: 'nchar',
  VarChar: 'varchar',
  NVarChar: 'nvarchar',
  Text: 'text',
  NText: 'ntext',
  VarBinary: 'varbinary',
  Image: 'image',
  Xml: 'xml',
  Variant: 'sql_variant',
}

export function typeInfoFromTedious(column: TediousColumnLike): SqlTypeInfo {
  const { name } = column.type
  const length = column.dataLength
  const scale = column.scale
  switch (name) {
    case 'IntN':
      return { name: length === 1 ? 'tinyint' : length === 2 ? 'smallint' : length === 8 ? 'bigint' : 'int' }
    case 'FloatN':
      return { name: length === 4 ? 'real' : 'float' }
    case 'MoneyN':
      return { name: length === 4 ? 'smallmoney' : 'money' }
    case 'DateTimeN':
      return { name: length === 4 ? 'smalldatetime' : 'datetime' }
    case 'Binary':
      return { name: column.userType === TIMESTAMP_USER_TYPE ? 'timestamp' : 'binary' }
    case 'UDT':
      return { name: column.udtInfo?.typeName.toLowerCase() ?? 'udt' }
    default:
      return { name: FIXED_NAMES[name] ?? name.toLowerCase(), scale }
  }
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0')

function hasNanoseconds(value: Date): value is Date & { nanosecondsDelta: number } {
  return typeof (value as Date & { nanosecondsDelta?: unknown }).nanosecondsDelta === 'number'
}

function formatDatePart(value: Date): string {
  return `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1, 2)}-${pad(value.getUTCDate(), 2)}`
}

/** 100 ns ticks since midnight (UTC parts), including tedious' sub-millisecond nanosecondsDelta. */
function ticksOfDay(value: Date): number {
  const ms =
    ((value.getUTCHours() * 60 + value.getUTCMinutes()) * 60 + value.getUTCSeconds()) * 1000 + value.getUTCMilliseconds()
  const extra = hasNanoseconds(value) ? Math.round(value.nanosecondsDelta * 1e7) : 0
  return ms * 10_000 + extra
}

function formatDate(value: Date, type: SqlTypeInfo): string {
  switch (type.name) {
    case 'date':
      return formatDatePart(value)
    case 'time':
      return formatTimeOfDay(ticksOfDay(value), type.scale ?? 7)
    case 'smalldatetime':
      return `${formatDatePart(value)} ${formatTimeOfDay(ticksOfDay(value), 0)}`
    case 'datetime':
      return `${formatDatePart(value)} ${formatTimeOfDay(ticksOfDay(value), 3)}`
    case 'datetimeoffset':
      // Only reached when the exact decoder is unavailable: tedious keeps the instant, not the offset.
      return `${formatDatePart(value)} ${formatTimeOfDay(ticksOfDay(value), type.scale ?? 7)} +00:00`
    case 'datetime2':
      return `${formatDatePart(value)} ${formatTimeOfDay(ticksOfDay(value), type.scale ?? 7)}`
    default:
      return `${formatDatePart(value)} ${formatTimeOfDay(ticksOfDay(value), 3)}`
  }
}

const EXACT_NUMERIC = new Set(['decimal', 'numeric', 'money', 'smallmoney'])

export function toHex(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex').toUpperCase()
}

export function normalizeValue(value: unknown, type: SqlTypeInfo): CellValue {
  if (value === null || value === undefined) return null
  if (type.name === 'sql_variant' && (typeof value === 'number' || typeof value === 'boolean')) {
    return typeof value === 'boolean' ? (value ? '1' : '0') : plainNumber(value)
  }
  switch (typeof value) {
    case 'boolean':
      return value
    case 'number':
      if (EXACT_NUMERIC.has(type.name)) {
        return plainNumber(value, type.name === 'money' || type.name === 'smallmoney' ? 4 : type.scale)
      }
      if (type.name === 'bigint') return plainNumber(value)
      if (type.name === 'real') return float32Number(value)
      return value
    case 'bigint':
      return value.toString()
    case 'string':
      return type.name === 'uniqueidentifier' ? value.toUpperCase() : value
    case 'object':
      if (value instanceof Date) return formatDate(value, type)
      if (value instanceof Uint8Array) return toHex(value)
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    default:
      return String(value)
  }
}
