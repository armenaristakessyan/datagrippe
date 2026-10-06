// Table data editor support: paged SELECT, COUNT, and parameterized edits.

import { classifyStatement, qualifiedName, quoteIdent, splitStatements, sqlLiteral } from '@shared/sql'
import { isSignificant, tokenize } from '@shared/sql/lexer'
import type { CellValue, ColumnMeta, EditValue, RowChange, SortSpec } from '@shared/types'
import { DriverError } from '../errors'
import { findRelation, isGeneratedColumn, loadColumns, loadIndexes, primaryKeyOf, type CatalogColumn, type CatalogQuery } from './catalog'

const q = (name: string): string => quoteIdent(name, 'mssql')

export interface TableShape {
  objectId: number
  kind: 'table' | 'view'
  schema: string
  name: string
  columns: CatalogColumn[]
  primaryKey: string[]
}

export async function loadTableShape(query: CatalogQuery, db: string, schema: string, name: string): Promise<TableShape> {
  // A synonym is read and edited under its own name; its base object describes the columns.
  const object = await findRelation(query, db, schema, name)
  const [columns, indexes] = await Promise.all([
    loadColumns(query, object.db, object.columnsObjectId),
    loadIndexes(query, object.db, object.columnsObjectId),
  ])
  return {
    objectId: object.objectId,
    kind: object.kind === 'view' ? 'view' : 'table',
    schema: object.schema,
    name: object.name,
    columns,
    primaryKey: primaryKeyOf(indexes),
  }
}

/** [db].[schema].[name] with each part quoted when needed (db is already quoted). */
export function targetName(db: string, shape: Pick<TableShape, 'schema' | 'name'>): string {
  return `${db}.${qualifiedName(shape.schema, shape.name, 'mssql')}`
}

export function columnMetas(shape: TableShape): ColumnMeta[] {
  return shape.columns.map((column) => ({
    name: column.name,
    dataType: column.baseType,
    table: shape.name,
    nullable: column.nullable,
  }))
}

/**
 * Select list of the table editor: every column of the shape by name, so HIDDEN columns (temporal
 * periods) are not dropped as with SELECT *, and the rows line up with columnMetas(shape).
 * hierarchyid is read as its text form ('/1/2/'), which also converts back on edit.
 */
export function selectList(shape: TableShape): string {
  return shape.columns
    .map((column) => (column.baseType === 'hierarchyid' ? `${q(column.name)}.ToString() AS ${q(column.name)}` : q(column.name)))
    .join(', ')
}

export function orderByClause(shape: TableShape, orderBy: SortSpec[] | undefined): string {
  if (orderBy && orderBy.length > 0) {
    const known = new Set(shape.columns.map((column) => column.name))
    const parts = orderBy.map((sort) => {
      if (!known.has(sort.column)) throw DriverError.of('invalid-input', `Unknown column ${sort.column}`)
      return `${q(sort.column)} ${sort.direction === 'desc' ? 'DESC' : 'ASC'}`
    })
    return `ORDER BY ${parts.join(', ')}`
  }
  if (shape.primaryKey.length > 0) return `ORDER BY ${shape.primaryKey.map(q).join(', ')}`
  return 'ORDER BY (SELECT NULL)'
}

const INVALID_FILTER = 'The filter must be a single condition, like the text after WHERE'

/**
 * "WHERE (<filter>)". The filter is user text inlined into the paged SELECT / COUNT, so it must stay
 * one predicate: no ';', no GO, parentheses balanced without closing ours, nothing unterminated,
 * and the result a single read-only statement. Anything else could append statements to the batch.
 */
export function whereClause(where: string | undefined): string {
  const predicate = where?.trim()
  if (!predicate) return ''
  const tokens = tokenize(predicate, 'mssql')
  // A trailing line comment would swallow our closing parenthesis.
  const wrapped = tokens.some((token) => token.kind === 'line-comment') ? `(${predicate}\n)` : `(${predicate})`
  const significant = tokenize(wrapped, 'mssql').filter(isSignificant)
  let depth = 0
  for (let i = 0; i < significant.length; i++) {
    const token = significant[i]
    if (!token || token.kind !== 'punct') continue
    const ch = wrapped[token.start]
    if (ch === ';') throw DriverError.of('invalid-input', `${INVALID_FILTER} (";" is not allowed)`)
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0 && i !== significant.length - 1) throw DriverError.of('invalid-input', `${INVALID_FILTER} (unbalanced parentheses)`)
    }
  }
  const last = significant.at(-1)
  if (depth !== 0 || !last || last.start !== wrapped.length - 1) {
    throw DriverError.of('invalid-input', `${INVALID_FILTER} (unbalanced parentheses or an unterminated string or comment)`)
  }
  const probe = `SELECT 1 WHERE ${wrapped}`
  if (splitStatements(probe, 'mssql').length !== 1 || !classifyStatement(probe, 'mssql').readOnly) {
    throw DriverError.of('invalid-input', INVALID_FILTER)
  }
  return `WHERE ${wrapped}`
}

export function readOnlyReason(shape: TableShape, readOnlyConnection: boolean): string | undefined {
  if (readOnlyConnection) return 'The connection is read-only'
  if (shape.kind !== 'table') return 'Views are not editable'
  if (shape.primaryKey.length === 0) return 'The table has no primary key'
  return undefined
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/**
 * How a value is bound: nvarchar(max) text (SQL Server converts it to the column type), bit, int,
 * or nvarchar(4000) — sql_variant accepts no (n)varchar(max).
 */
export type ParamKind = 'text' | 'bit' | 'int' | 'text4000'

export interface StatementParam {
  name: string
  kind: ParamKind
  value: string | boolean | null
}

export interface EditStatement {
  /** Parameterized T-SQL (@p0…). */
  text: string
  params: StatementParam[]
  /** Same statement with literals inlined (display only). */
  preview: string
  /** UPDATE / DELETE: must affect exactly one row. */
  expectOne: boolean
  type: RowChange['type']
}

const BINARY_TYPES = new Set(['binary', 'varbinary', 'image', 'timestamp'])
const INT32 = /^[+-]?\d{1,10}$/
const DATE_TIME_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2})(:\d{2}(?:\.\d{1,7})?)?)?$/

/**
 * datetime / smalldatetime read 'YYYY-MM-DD hh:mm:ss' by the session's DATEFORMAT (French or German
 * logins read it as year-day-month). ISO 8601 with a 'T', or 'YYYYMMDD', is read the same everywhere.
 */
export function languageNeutralDateTime(text: string): string {
  const match = DATE_TIME_TEXT.exec(text.trim())
  if (!match) return text
  const [, year, month, day, hourMinute, seconds] = match
  if (!hourMinute) return `${year}${month}${day}`
  const fraction = seconds?.includes('.') ? seconds.slice(0, seconds.indexOf('.') + 4) : (seconds ?? ':00')
  return `${year}-${month}-${day}T${hourMinute}${fraction}`
}

function isDefault(value: EditValue): value is { $default: true } {
  return typeof value === 'object' && value !== null && '$default' in value
}

function toBit(value: CellValue): boolean | null {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const text = value.trim().toLowerCase()
  if (text === 'true' || text === '1') return true
  if (text === 'false' || text === '0') return false
  throw DriverError.of('invalid-input', `"${value}" is not a valid bit value`)
}

function toHexText(value: CellValue): string {
  const text = String(value).trim()
  if (/^0x[0-9a-f]*$/i.test(text)) return text
  if (/^[0-9a-f]*$/i.test(text) && text.length % 2 === 0) return `0x${text}`
  throw DriverError.of('invalid-input', `"${text}" is not a hexadecimal binary value (expected 0x…)`)
}

function formatTypeName(column: CatalogColumn): string {
  const { typeName, typeSchema, isUserDefined } = column.type
  return isUserDefined && typeSchema ? qualifiedName(typeSchema, typeName, 'mssql') : q(typeName)
}

class StatementBuilder {
  readonly params: StatementParam[] = []

  constructor(private readonly columns: Map<string, CatalogColumn>) {}

  column(name: string): CatalogColumn {
    const column = this.columns.get(name)
    if (!column) throw DriverError.of('invalid-input', `Unknown column ${name}`)
    return column
  }

  /** Expression and preview literal for a value bound to `column`. */
  value(column: CatalogColumn, value: CellValue): { expr: string; literal: string } {
    const name = `p${this.params.length}`
    if (value === null) {
      this.params.push({ name, kind: column.baseType === 'sql_variant' ? 'text4000' : 'text', value: null })
      // nvarchar → varbinary has no implicit conversion, even for NULL.
      const expr = BINARY_TYPES.has(column.baseType) ? `CONVERT(varbinary(max), @${name}, 1)` : `@${name}`
      return { expr, literal: 'NULL' }
    }
    if (column.baseType === 'bit') {
      const bit = toBit(value)
      this.params.push({ name, kind: 'bit', value: bit })
      return { expr: `@${name}`, literal: bit === null ? 'NULL' : bit ? '1' : '0' }
    }
    if (BINARY_TYPES.has(column.baseType)) {
      const hex = toHexText(value)
      this.params.push({ name, kind: 'text', value: hex })
      return { expr: `CONVERT(varbinary(max), @${name}, 1)`, literal: `CONVERT(varbinary(max), ${sqlLiteral(hex, 'mssql')}, 1)` }
    }
    let text = typeof value === 'boolean' ? (value ? '1' : '0') : String(value)
    if (column.baseType === 'datetime' || column.baseType === 'smalldatetime') {
      text = languageNeutralDateTime(text)
      this.params.push({ name, kind: 'text', value: text })
      return { expr: `@${name}`, literal: sqlLiteral(text, 'mssql') }
    }
    if (column.baseType === 'sql_variant') {
      // Keep integers numeric inside the variant; anything else is stored as nvarchar.
      const integer = text.trim()
      if (INT32.test(integer) && Math.abs(Number(integer)) <= 2_147_483_647) {
        this.params.push({ name, kind: 'int', value: String(Number(integer)) })
        return { expr: `@${name}`, literal: String(Number(integer)) }
      }
      this.params.push({ name, kind: 'text4000', value: text })
      return { expr: `@${name}`, literal: sqlLiteral(text, 'mssql') }
    }
    if (column.isAssemblyType && column.baseType !== 'hierarchyid') {
      // geometry / geography / CLR types are shown as their binary serialization (0x…).
      const hex = toHexText(value)
      const type = formatTypeName(column)
      this.params.push({ name, kind: 'text', value: hex })
      return {
        expr: `CAST(CONVERT(varbinary(max), @${name}, 1) AS ${type})`,
        literal: `CAST(CONVERT(varbinary(max), ${sqlLiteral(hex, 'mssql')}, 1) AS ${type})`,
      }
    }
    this.params.push({ name, kind: 'text', value: text })
    return { expr: `@${name}`, literal: sqlLiteral(value, 'mssql') }
  }

  /** "[a] = @p0 AND [b] IS NULL" for a primary-key match. */
  keyPredicate(key: Record<string, CellValue>, primaryKey: string[]): { text: string; preview: string } {
    const names = Object.keys(key)
    if (primaryKey.length === 0) throw DriverError.of('invalid-input', 'The table has no primary key')
    for (const pk of primaryKey) {
      if (!names.includes(pk)) throw DriverError.of('invalid-input', `Missing primary key column ${pk}`)
    }
    const text: string[] = []
    const preview: string[] = []
    for (const pk of primaryKey) {
      const column = this.column(pk)
      const value = key[pk] ?? null
      if (value === null) {
        text.push(`${q(pk)} IS NULL`)
        preview.push(`${q(pk)} IS NULL`)
        continue
      }
      const bound = this.value(column, value)
      text.push(`${q(pk)} = ${bound.expr}`)
      preview.push(`${q(pk)} = ${bound.literal}`)
    }
    return { text: text.join(' AND '), preview: preview.join(' AND ') }
  }
}

/** Build the statements applyChanges runs (and previewChanges shows). Updates without values are skipped. */
export function buildEditStatements(db: string, shape: TableShape, changes: RowChange[]): EditStatement[] {
  const columns = new Map(shape.columns.map((column) => [column.name, column]))
  const target = targetName(db, shape)
  const statements: EditStatement[] = []

  for (const change of changes) {
    const builder = new StatementBuilder(columns)
    if (change.type === 'insert') {
      const names: string[] = []
      const exprs: string[] = []
      const literals: string[] = []
      for (const [name, value] of Object.entries(change.values)) {
        const column = builder.column(name)
        if (column.isIdentity || isGeneratedColumn(column) || isDefault(value)) continue
        const bound = builder.value(column, value)
        names.push(q(name))
        exprs.push(bound.expr)
        literals.push(bound.literal)
      }
      const head = `INSERT INTO ${target}`
      statements.push(
        names.length === 0
          ? { type: 'insert', text: `${head} DEFAULT VALUES`, preview: `${head} DEFAULT VALUES`, params: [], expectOne: false }
          : {
              type: 'insert',
              text: `${head} (${names.join(', ')}) VALUES (${exprs.join(', ')})`,
              preview: `${head} (${names.join(', ')}) VALUES (${literals.join(', ')})`,
              params: builder.params,
              expectOne: false,
            },
      )
      continue
    }

    if (change.type === 'update') {
      const sets: string[] = []
      const previews: string[] = []
      for (const [name, value] of Object.entries(change.values)) {
        const column = builder.column(name)
        if (isGeneratedColumn(column)) throw DriverError.of('invalid-input', `Column ${name} is generated and cannot be modified`)
        if (column.isIdentity) throw DriverError.of('invalid-input', `Identity column ${name} cannot be modified`)
        const bound = builder.value(column, value)
        sets.push(`${q(name)} = ${bound.expr}`)
        previews.push(`${q(name)} = ${bound.literal}`)
      }
      if (sets.length === 0) continue
      const key = builder.keyPredicate(change.key, shape.primaryKey)
      statements.push({
        type: 'update',
        text: `UPDATE ${target} SET ${sets.join(', ')} WHERE ${key.text}`,
        preview: `UPDATE ${target} SET ${previews.join(', ')} WHERE ${key.preview}`,
        params: builder.params,
        expectOne: true,
      })
      continue
    }

    const key = builder.keyPredicate(change.key, shape.primaryKey)
    statements.push({
      type: 'delete',
      text: `DELETE FROM ${target} WHERE ${key.text}`,
      preview: `DELETE FROM ${target} WHERE ${key.preview}`,
      params: builder.params,
      expectOne: true,
    })
  }
  return statements
}
