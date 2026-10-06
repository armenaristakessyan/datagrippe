// Value normalization for PostgreSQL results (see CellValue in @shared/types).
// Only booleans and types that fit a JS number exactly are converted; everything else keeps
// the server's text representation. Parsers are per client/query — pg's global registry is untouched.
import type { CustomTypesConfig } from 'pg'
import type { CellValue } from '@shared/types'

export const OID = {
  bool: 16,
  int8: 20,
  int2: 21,
  int4: 23,
  oid: 26,
  float4: 700,
  float8: 701,
} as const

const identity = (value: string): string => value

const parseBool = (value: string): boolean => value === 't' || value === 'true'

const parseInteger = (value: string): number => Number.parseInt(value, 10)

/** Floats become numbers unless the value is NaN / ±Infinity, which keep their text. */
const parseFloatValue = (value: string): CellValue => {
  const n = Number(value)
  return Number.isFinite(n) ? n : value
}

const TEXT_PARSERS = new Map<number, (value: string) => CellValue>([
  [OID.bool, parseBool],
  [OID.int2, parseInteger],
  [OID.int4, parseInteger],
  [OID.oid, parseInteger],
  [OID.float4, parseFloatValue],
  [OID.float8, parseFloatValue],
])

/** Binary-format results are never requested; keep a safe fallback that does not throw. */
const binaryFallback = (value: unknown): CellValue => (Buffer.isBuffer(value) ? `\\x${value.toString('hex')}` : String(value))

function getTypeParser(oid: number, format?: 'text' | 'binary'): (value: string) => CellValue {
  if (format === 'binary') return binaryFallback
  return TEXT_PARSERS.get(oid) ?? identity
}

/** Pass as `types` to pg.Client / pg.Pool / Cursor configs. */
export const pgTypes: CustomTypesConfig = {
  // pg-types' getTypeParser is an overloaded generic; our implementation satisfies it for text values.
  getTypeParser: getTypeParser as CustomTypesConfig['getTypeParser'],
}

/** Narrow a parsed value (unknown at the library boundary) to CellValue. */
export function toCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return String(value)
}

export function toCellRow(row: unknown): CellValue[] {
  return Array.isArray(row) ? row.map(toCell) : []
}
