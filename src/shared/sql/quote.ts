import type { CellValue, Dialect } from '../types'
import { MSSQL_RESERVED, POSTGRES_RESERVED } from './keywords'

const PG_BARE = /^[a-z_][a-z0-9_$]*$/
const MSSQL_BARE = /^[A-Za-z_][A-Za-z0-9_@#$]*$/

export function quoteIdent(name: string, dialect: Dialect): string {
  if (dialect === 'postgres') {
    if (PG_BARE.test(name) && !POSTGRES_RESERVED.has(name)) return name
    return `"${name.replaceAll('"', '""')}"`
  }
  if (MSSQL_BARE.test(name) && !MSSQL_RESERVED.has(name.toUpperCase())) return name
  return `[${name.replaceAll(']', ']]')}]`
}

export function qualifiedName(schema: string, name: string, dialect: Dialect): string {
  return `${quoteIdent(schema, dialect)}.${quoteIdent(name, dialect)}`
}

function stringLiteral(value: string, dialect: Dialect): string {
  const body = value.replaceAll("'", "''")
  return dialect === 'mssql' ? `N'${body}'` : `'${body}'`
}

export function sqlLiteral(value: CellValue, dialect: Dialect): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') {
    if (dialect === 'mssql') return value ? '1' : '0'
    return value ? 'TRUE' : 'FALSE'
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return stringLiteral(String(value), dialect)
    return Object.is(value, -0) ? '0' : String(value)
  }
  return stringLiteral(value, dialect)
}
