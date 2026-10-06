// Table data editor: paged SELECT, COUNT and transactional row changes.
import type { ClientBase } from 'pg'
import { qualifiedName, quoteIdent } from '@shared/sql'
import { isPunct, isSignificant, tokenize } from '@shared/sql/lexer'
import type {
  ApplyChangesResult,
  ColumnMeta,
  RowChange,
  TableDataPage,
  TableDataRequest,
  TableRef,
} from '@shared/types'
import { DriverError } from '../errors'
import { buildChange, referencedColumns } from './changes'
import { extendedQuery } from './cursor'
import { findRelation, primaryKeyOf, type RelationRef } from './details'
import { isServerError, toDriverError } from './errors'
import { bool, num, select, str } from './rows'
import type { TypeNameCache } from './type-names'
import { toCellRow } from './values'

const ATTRIBUTES_SQL = `SELECT a.attnum AS attnum, a.attname AS name, a.attnotnull AS not_null
FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped`

interface Attribute {
  attnum: number
  name: string
  notNull: boolean
}

async function attributesOf(client: ClientBase, oid: number): Promise<Attribute[]> {
  const rows = await select(client, ATTRIBUTES_SQL, [oid])
  return rows.map((row) => ({ attnum: num(row, 'attnum'), name: str(row, 'name'), notNull: bool(row, 'not_null') }))
}

export const TABLE_DATA_POLICY = {
  /** Table-editor SELECT / COUNT queries are stopped after this long (user filters, huge tables, lock waits). */
  timeoutMs: 60_000,
}
const QUERY_CANCELED = '57014'
const WHERE_OPEN = ' WHERE ('

/** The user filter without surrounding whitespace and trailing ';' (a ';' inside a trailing comment stays). */
function filterPredicate(where: string | undefined): string {
  let text = where?.trim() ?? ''
  for (;;) {
    const last = tokenize(text, 'postgres').filter(isSignificant).pop()
    if (!last || !isPunct(text, last, ';')) return text
    text = `${text.slice(0, last.start)}${text.slice(last.end)}`.trim()
  }
}

/**
 * ` WHERE (<filter>)`. A filter ending with a line comment gets its closing parenthesis on the next line
 * (otherwise the comment would swallow it and the ORDER BY / LIMIT that follow).
 */
function whereClause(predicate: string): string {
  if (!predicate) return ''
  const last = tokenize(predicate, 'postgres').pop()
  if (last?.kind === 'block-comment' && !(last.end - last.start >= 4 && predicate.endsWith('*/'))) {
    throw DriverError.of('invalid-input', 'The filter has an unterminated /* comment.')
  }
  return `${WHERE_OPEN}${predicate}${last?.kind === 'line-comment' ? '\n' : ''})`
}

/** Where the user filter sits inside a generated statement, to report error positions relative to it. */
interface FilterSpan {
  /** 0-based offset of the filter inside the statement. */
  start: number
  length: number
  /** Whitespace trimmed from the start of the filter as typed. */
  lead: number
}

function filterSpan(prefix: string, where: string | undefined, predicate: string): FilterSpan | null {
  if (!predicate || where === undefined) return null
  return { start: prefix.length + WHERE_OPEN.length, length: predicate.length, lead: where.length - where.trimStart().length }
}

/**
 * A server error of a generated statement: its position becomes relative to the filter the user typed (it is
 * dropped when the error lies outside the filter), and a table-editor timeout explains itself.
 */
function tableDataError(error: unknown, span: FilterSpan | null): Error {
  const driverError = toDriverError(error)
  if (!isServerError(error)) return driverError
  const info = { ...driverError.info }
  if (info.position !== undefined) {
    const offset = info.position - 1 - (span?.start ?? 0)
    if (span && offset >= 0 && offset <= span.length) info.position = offset + 1 + span.lead
    else delete info.position
  }
  if (info.code === QUERY_CANCELED) {
    info.hint = `The table editor stops queries after ${Math.round(TABLE_DATA_POLICY.timeoutMs / 1000)} s. Narrow the filter, or run the query in a console.`
  }
  return new DriverError(info)
}

async function limitDuration(client: ClientBase): Promise<void> {
  // SET LOCAL: the caller's transaction ends with this request, the pooled connection keeps its default.
  await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.round(TABLE_DATA_POLICY.timeoutMs))}`)
}

function checkPaging(offset: number, limit: number): void {
  if (!Number.isInteger(offset) || offset < 0) throw DriverError.of('invalid-input', 'Offset must be a non-negative integer')
  if (!Number.isInteger(limit) || limit < 1) throw DriverError.of('invalid-input', 'Limit must be a positive integer')
}

function readOnlyReason(relation: RelationRef, primaryKey: string[], readOnlyConnection: boolean): string | undefined {
  if (readOnlyConnection) return 'Read-only connection'
  switch (relation.relkind) {
    case 'v':
      return 'Views are read-only'
    case 'm':
      return 'Materialized views are read-only'
    case 'f':
      return 'Foreign tables are read-only'
  }
  if (primaryKey.length === 0) return 'Table has no primary key'
  return undefined
}

const selectPrefix = (table: TableRef) => `SELECT * FROM ${qualifiedName(table.schema, table.name, 'postgres')}`
const countPrefix = (table: TableRef) => `SELECT count(*) FROM ${qualifiedName(table.schema, table.name, 'postgres')}`

/** Without an explicit sort, pages follow the primary key so paging and edits keep rows in place. */
export function selectPageSql(request: TableDataRequest, primaryKey: readonly string[] = []): string {
  const { table, offset, limit, where, orderBy } = request
  let sql = `${selectPrefix(table)}${whereClause(filterPredicate(where))}`
  if (orderBy && orderBy.length > 0) {
    const keys = orderBy.map((s) => `${quoteIdent(s.column, 'postgres')} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`)
    sql += ` ORDER BY ${keys.join(', ')}`
  } else if (primaryKey.length > 0) {
    sql += ` ORDER BY ${primaryKey.map((c) => quoteIdent(c, 'postgres')).join(', ')}`
  }
  return `${sql} LIMIT ${limit + 1} OFFSET ${offset}`
}

/** Runs inside a READ ONLY transaction (the caller's), so a user WHERE clause cannot write. */
export async function fetchTableData(
  client: ClientBase,
  types: TypeNameCache,
  request: TableDataRequest,
  readOnlyConnection: boolean,
): Promise<TableDataPage> {
  const { table, offset, limit } = request
  checkPaging(offset, limit)
  const relation = await findRelation(client, table.schema, table.name)
  const primaryKey = await primaryKeyOf(client, relation.oid)
  const attributes = await attributesOf(client, relation.oid)
  const sql = selectPageSql(request, primaryKey)
  const span = filterSpan(selectPrefix(table), request.where, filterPredicate(request.where))

  await limitDuration(client)
  const started = performance.now()
  let read
  try {
    read = await extendedQuery(client, sql, undefined, limit + 1)
  } catch (error) {
    throw tableDataError(error, span)
  }
  const durationMs = Math.round((performance.now() - started) * 100) / 100

  await types.resolve(client, types.missing(read.fields))
  const byAttnum = new Map(attributes.map((a) => [a.attnum, a]))
  const columns: ColumnMeta[] = read.fields.map((field) => {
    const column: ColumnMeta = { name: field.name, dataType: types.name(field.dataTypeID) }
    const attribute = field.tableID === relation.oid ? byAttnum.get(field.columnID) : undefined
    if (attribute) {
      column.table = table.name
      column.nullable = !attribute.notNull
    }
    return column
  })
  const rows = read.rows.map(toCellRow)
  const hasMore = rows.length > limit
  const reason = readOnlyReason(relation, primaryKey, readOnlyConnection)
  const page: TableDataPage = {
    columns,
    rows: hasMore ? rows.slice(0, limit) : rows,
    offset,
    hasMore,
    primaryKey,
    editable: reason === undefined,
    sql,
    durationMs,
  }
  if (reason) page.readOnlyReason = reason
  return page
}

export async function countTableData(
  client: ClientBase,
  request: Omit<TableDataRequest, 'offset' | 'limit' | 'orderBy'>,
): Promise<number> {
  const { table, where } = request
  await findRelation(client, table.schema, table.name)
  const predicate = filterPredicate(where)
  const sql = `${countPrefix(table)}${whereClause(predicate)}`
  await limitDuration(client)
  try {
    const { rows } = await extendedQuery(client, sql)
    return Number(rows[0]?.[0] ?? 0)
  } catch (error) {
    throw tableDataError(error, filterSpan(countPrefix(table), where, predicate))
  }
}

export function previewChanges(table: TableRef, changes: readonly RowChange[]): string[] {
  return changes.flatMap((change) => {
    const built = buildChange(table.schema, table.name, change)
    return built ? [built.display] : []
  })
}

/** Runs inside the caller's transaction; throwing makes the caller roll everything back. */
export async function applyChanges(
  client: ClientBase,
  table: TableRef,
  changes: readonly RowChange[],
): Promise<ApplyChangesResult> {
  const relation = await findRelation(client, table.schema, table.name)
  const known = new Set((await attributesOf(client, relation.oid)).map((a) => a.name))
  const unknown = [...referencedColumns(changes)].filter((c) => !known.has(c))
  if (unknown.length > 0) {
    throw DriverError.of('invalid-input', `Unknown column${unknown.length > 1 ? 's' : ''} in ${table.name}: ${unknown.join(', ')}`)
  }

  let affected = 0
  const statements: string[] = []
  for (const change of changes) {
    const built = buildChange(table.schema, table.name, change)
    if (!built) continue
    let rowCount: number
    try {
      const result = await client.query({ text: built.text, values: built.values })
      rowCount = result.rowCount ?? 0
    } catch (error) {
      throw toDriverError(error)
    }
    if (built.type !== 'insert' && rowCount !== 1) {
      const what = rowCount === 0 ? 'no longer exists' : `matches ${rowCount} rows`
      throw DriverError.of(
        'invalid-input',
        `The row with ${built.keyLabel ?? 'this key'} ${what}; no changes were applied`,
      )
    }
    affected += rowCount
    statements.push(built.display)
  }
  return { affected, statements }
}
