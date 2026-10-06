// Small helpers to read catalog query rows (object rows, values already normalized by pgTypes).
import type { QueryConfig, QueryResult } from 'pg'
import { toDriverError } from './errors'

export interface Queryable {
  query(config: QueryConfig): Promise<QueryResult>
}

export type Row = Record<string, unknown>

/** Run a catalog query; failures become DriverErrors. */
export async function select(q: Queryable, text: string, values: unknown[] = []): Promise<Row[]> {
  try {
    const result = await q.query({ text, values })
    return result.rows
  } catch (error) {
    throw toDriverError(error)
  }
}

export function str(row: Row, key: string): string {
  const v = row[key]
  return v === null || v === undefined ? '' : String(v)
}

export function optStr(row: Row, key: string): string | undefined {
  const v = row[key]
  return v === null || v === undefined ? undefined : String(v)
}

export function num(row: Row, key: string): number {
  return Number(row[key] ?? 0)
}

export function optNum(row: Row, key: string): number | undefined {
  const v = row[key]
  if (v === null || v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function bool(row: Row, key: string): boolean {
  return row[key] === true
}

/** Columns produced with json_agg / to_json arrive as JSON text. */
export function jsonValue(row: Row, key: string): unknown {
  const v = row[key]
  if (typeof v !== 'string') return v ?? null
  return JSON.parse(v) as unknown
}

export function stringList(row: Row, key: string): string[] {
  const v = jsonValue(row, key)
  return Array.isArray(v) ? v.map((item) => String(item)) : []
}
