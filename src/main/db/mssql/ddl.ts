// DDL reconstruction: tables, sequences and user-defined types are rebuilt from the catalog;
// modules (views, routines, triggers) come from sys.sql_modules. Batches are separated by GO.

import { qualifiedName, quoteIdent } from '@shared/sql'
import type { ObjectKind } from '@shared/types'
import { DriverError } from '../errors'
import {
  bool,
  createIndexStatement,
  findObject,
  foreignKeyInfo,
  foreignKeyStatement,
  formatType,
  keyConstraintBody,
  loadChecks,
  loadColumns,
  hasTemporalCatalog,
  loadForeignKeys,
  loadIndexes,
  loadTriggers,
  num,
  optStr,
  str,
  type CatalogColumn,
  type CatalogQuery,
  type CatalogCheck,
  type CatalogIndex,
} from './catalog'

const q = (name: string): string => quoteIdent(name, 'mssql')

export function joinBatches(batches: string[]): string {
  return batches.map((batch) => `${batch.trimEnd()}\nGO`).join('\n\n') + '\n'
}

/** Column definition as SQL Server accepts it in CREATE TABLE (attribute order matters). */
function columnDefinition(column: CatalogColumn, defaultCollation: string | undefined): string {
  if (column.isComputed && column.computedDefinition) {
    let computed = `${q(column.name)} AS ${column.computedDefinition}`
    if (column.isPersisted) computed += column.nullable ? ' PERSISTED' : ' PERSISTED NOT NULL'
    return computed
  }
  let sql = `${q(column.name)} ${formatType(column.type, true)}`
  if (column.isColumnSet) return `${sql} COLUMN_SET FOR ALL_SPARSE_COLUMNS`
  if (column.collation && defaultCollation && column.collation !== defaultCollation) sql += ` COLLATE ${column.collation}`
  if (column.isSparse) sql += ' SPARSE'
  if (column.isIdentity) {
    sql += ` IDENTITY(${column.identitySeed ?? '1'},${column.identityIncrement ?? '1'})`
    if (column.identityNotForReplication) sql += ' NOT FOR REPLICATION'
  }
  const generated = column.generatedAlwaysType ? GENERATED_ALWAYS[column.generatedAlwaysType] : undefined
  if (generated) sql += ` GENERATED ALWAYS AS ${generated}${column.isHidden ? ' HIDDEN' : ''}`
  sql += column.nullable ? ' NULL' : ' NOT NULL'
  if (column.isRowGuidCol) sql += ' ROWGUIDCOL'
  if (column.defaultDefinition) {
    sql += column.defaultName
      ? ` CONSTRAINT ${q(column.defaultName)} DEFAULT ${column.defaultDefinition}`
      : ` DEFAULT ${column.defaultDefinition}`
  }
  return sql
}

/** sys.columns.generated_always_type → GENERATED ALWAYS AS … */
const GENERATED_ALWAYS: Record<number, string> = {
  1: 'ROW START',
  2: 'ROW END',
  5: 'TRANSACTION_ID START',
  6: 'TRANSACTION_ID END',
  7: 'SEQUENCE_NUMBER START',
  8: 'SEQUENCE_NUMBER END',
}

function checkClause(check: CatalogCheck): string {
  return `CHECK${check.notForReplication ? ' NOT FOR REPLICATION' : ''} ${check.definition}`
}

/** Checks created inside CREATE TABLE are trusted; untrusted / disabled ones are added WITH NOCHECK. */
function isPlainCheck(check: CatalogCheck): boolean {
  return !check.isNotTrusted && !check.isDisabled
}

interface TableBodyExtras {
  defaultCollation?: string
  /** PERIOD FOR SYSTEM_TIME columns. */
  period?: { start: string; end: string }
}

/** Body lines of CREATE TABLE / CREATE TYPE … AS TABLE. */
function tableBody(
  columns: CatalogColumn[],
  indexes: CatalogIndex[],
  checks: CatalogCheck[],
  named: boolean,
  extras: TableBodyExtras = {},
): string {
  const lines = columns.map((column) => columnDefinition(column, extras.defaultCollation))
  if (extras.period) lines.push(`PERIOD FOR SYSTEM_TIME (${q(extras.period.start)}, ${q(extras.period.end)})`)
  for (const index of indexes) {
    if (!index.isPrimaryKey && !index.isUniqueConstraint) continue
    lines.push(named ? `CONSTRAINT ${q(index.name)} ${keyConstraintBody(index)}` : keyConstraintBody(index))
  }
  for (const check of checks) {
    if (named && !isPlainCheck(check)) continue
    lines.push(named ? `CONSTRAINT ${q(check.name)} ${checkClause(check)}` : checkClause(check))
  }
  return `(\n    ${lines.join(',\n    ')}\n)`
}

interface TemporalInfo {
  period?: { start: string; end: string }
  /** System-versioned: the history table it writes to. */
  history?: { schema: string; name: string }
}

async function temporalInfo(query: CatalogQuery, db: string, objectId: number): Promise<TemporalInfo> {
  if (!hasTemporalCatalog(query)) return {}
  const rows = await query(
    `SELECT t.temporal_type, hs.name AS history_schema, ht.name AS history_table,
       sc.name AS period_start, ec.name AS period_end
     FROM ${db}.sys.tables t
     LEFT JOIN ${db}.sys.tables ht ON ht.object_id = t.history_table_id
     LEFT JOIN ${db}.sys.schemas hs ON hs.schema_id = ht.schema_id
     LEFT JOIN ${db}.sys.periods p ON p.object_id = t.object_id
     LEFT JOIN ${db}.sys.columns sc ON sc.object_id = p.object_id AND sc.column_id = p.start_column_id
     LEFT JOIN ${db}.sys.columns ec ON ec.object_id = p.object_id AND ec.column_id = p.end_column_id
     WHERE t.object_id = @objectId`,
    { objectId },
  )
  const row = rows[0]
  if (!row) return {}
  const info: TemporalInfo = {}
  const start = optStr(row, 'period_start')
  const end = optStr(row, 'period_end')
  if (start && end) info.period = { start, end }
  const historySchema = optStr(row, 'history_schema')
  const historyTable = optStr(row, 'history_table')
  if (num(row, 'temporal_type') === 2 && historySchema && historyTable) info.history = { schema: historySchema, name: historyTable }
  return info
}

/** Default collation of database `db` (quoted or not); columns using it need no COLLATE clause. */
async function databaseCollation(query: CatalogQuery, db: string): Promise<string | undefined> {
  const name = db.startsWith('[') && db.endsWith(']') ? db.slice(1, -1).replace(/]]/g, ']') : db
  const rows = await query('SELECT collation_name FROM sys.databases WHERE name = @name', { name })
  return rows[0] ? optStr(rows[0], 'collation_name') : undefined
}

async function tableDdl(query: CatalogQuery, db: string, schema: string, name: string, identity?: string): Promise<string> {
  const object = await findObject(query, db, schema, name, ['U'], identity)
  const [columns, indexes, checks, foreignKeys, triggers, temporal, defaultCollation] = await Promise.all([
    loadColumns(query, db, object.objectId),
    loadIndexes(query, db, object.objectId),
    loadChecks(query, db, object.objectId),
    loadForeignKeys(query, db, object.objectId),
    loadTriggers(query, db, object.objectId),
    temporalInfo(query, db, object.objectId),
    databaseCollation(query, db),
  ])
  const target = qualifiedName(object.schema, object.name, 'mssql')
  let create = `CREATE TABLE ${target} ${tableBody(columns, indexes, checks, true, { defaultCollation, period: temporal.period })}`
  if (temporal.history) {
    create += ` WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = ${qualifiedName(temporal.history.schema, temporal.history.name, 'mssql')}))`
  }
  const batches = [`${create};`]
  for (const check of checks) {
    if (isPlainCheck(check)) continue
    batches.push(`ALTER TABLE ${target} WITH NOCHECK ADD CONSTRAINT ${q(check.name)} ${checkClause(check)};`)
    if (check.isDisabled) batches.push(`ALTER TABLE ${target} NOCHECK CONSTRAINT ${q(check.name)};`)
  }
  for (const fk of foreignKeys) {
    if (fk.parentObjectId !== object.objectId) continue
    batches.push(`${foreignKeyStatement({ ...foreignKeyInfo(fk), isNotTrusted: fk.isNotTrusted, notForReplication: fk.notForReplication })};`)
    if (fk.isDisabled) batches.push(`ALTER TABLE ${target} NOCHECK CONSTRAINT ${q(fk.name)};`)
  }
  for (const index of indexes) {
    if (!index.isPrimaryKey && !index.isUniqueConstraint) batches.push(`${createIndexStatement(index, object.schema, object.name)};`)
  }
  for (const index of indexes) {
    if (index.isDisabled) batches.push(`ALTER INDEX ${q(index.name)} ON ${target} DISABLE;`)
  }
  // DML triggers belong to the table: each CREATE TRIGGER must be alone in its batch.
  for (const trigger of triggers) {
    if (!trigger.definition) {
      batches.push(`-- The definition of trigger ${q(trigger.name)} is encrypted or not visible to you.`)
      continue
    }
    batches.push(trigger.definition)
    if (!trigger.enabled) batches.push(`DISABLE TRIGGER ${qualifiedName(object.schema, trigger.name, 'mssql')} ON ${target};`)
  }
  return joinBatches(batches)
}

async function moduleDdl(
  query: CatalogQuery,
  db: string,
  schema: string,
  name: string,
  kind: ObjectKind,
  identity?: string,
): Promise<string> {
  const types = kind === 'view' ? ['V'] : kind === 'procedure' ? ['P', 'PC', 'X'] : ['FN', 'IF', 'TF', 'FS', 'FT']
  const object = await findObject(query, db, schema, name, types, identity)
  const rows = await query(`SELECT m.definition FROM ${db}.sys.all_sql_modules m WHERE m.object_id = @objectId`, {
    objectId: object.objectId,
  })
  const definition = rows[0] ? optStr(rows[0], 'definition') : undefined
  if (!definition) {
    return `-- The definition of ${qualifiedName(object.schema, object.name, 'mssql')} is encrypted or not visible to you.\n`
  }
  const batches = [definition.trim()]
  if (kind === 'view') {
    // Triggers defined on the view (INSTEAD OF) belong to its DDL.
    const triggers = await query(
      `SELECT m.definition FROM ${db}.sys.triggers tr JOIN ${db}.sys.sql_modules m ON m.object_id = tr.object_id
       WHERE tr.parent_id = @objectId ORDER BY tr.name`,
      { objectId: object.objectId },
    )
    for (const trigger of triggers) {
      const text = optStr(trigger, 'definition')
      if (text) batches.push(text.trim())
    }
  }
  return joinBatches(batches)
}

async function sequenceDdl(query: CatalogQuery, db: string, schema: string, name: string, identity?: string): Promise<string> {
  const object = await findObject(query, db, schema, name, ['SO'], identity)
  const rows = await query(
    `SELECT t.name AS type_name, sq.precision, sq.scale,
       CAST(sq.start_value AS nvarchar(64)) AS start_value, CAST(sq.increment AS nvarchar(64)) AS increment,
       CAST(sq.minimum_value AS nvarchar(64)) AS minimum_value, CAST(sq.maximum_value AS nvarchar(64)) AS maximum_value,
       sq.is_cycling, sq.is_cached, sq.cache_size
     FROM ${db}.sys.sequences sq JOIN ${db}.sys.types t ON t.user_type_id = sq.user_type_id
     WHERE sq.object_id = @objectId`,
    { objectId: object.objectId },
  )
  const row = rows[0]
  if (!row) throw DriverError.of('not-found', `Sequence ${schema}.${name} was not found`)
  const typeName = str(row, 'type_name')
  const type =
    typeName === 'decimal' || typeName === 'numeric' ? `${typeName}(${num(row, 'precision')},${num(row, 'scale')})` : typeName
  const lines = [
    `CREATE SEQUENCE ${qualifiedName(object.schema, object.name, 'mssql')}`,
    `    AS ${type}`,
    `    START WITH ${str(row, 'start_value')}`,
    `    INCREMENT BY ${str(row, 'increment')}`,
    `    MINVALUE ${str(row, 'minimum_value')}`,
    `    MAXVALUE ${str(row, 'maximum_value')}`,
    `    ${bool(row, 'is_cycling') ? 'CYCLE' : 'NO CYCLE'}`,
  ]
  const cacheSize = optStr(row, 'cache_size')
  lines.push(bool(row, 'is_cached') ? (cacheSize ? `    CACHE ${cacheSize}` : '    CACHE') : '    NO CACHE')
  return joinBatches([`${lines.join('\n')};`])
}

async function typeDdl(query: CatalogQuery, db: string, schema: string, name: string): Promise<string> {
  const rows = await query(
    `SELECT t.user_type_id, t.name, s.name AS schema_name, t.is_table_type, t.is_nullable, t.max_length, t.precision,
       t.scale, bt.name AS base_type, tt.type_table_object_id
     FROM ${db}.sys.types t
     JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id
     LEFT JOIN ${db}.sys.types bt ON bt.user_type_id = t.system_type_id
     LEFT JOIN ${db}.sys.table_types tt ON tt.user_type_id = t.user_type_id
     WHERE t.is_user_defined = 1 AND s.name = @schema AND t.name = @name`,
    { schema, name },
  )
  const row = rows[0]
  if (!row) throw DriverError.of('not-found', `Type ${schema}.${name} was not found`)
  const target = qualifiedName(str(row, 'schema_name'), str(row, 'name'), 'mssql')
  if (bool(row, 'is_table_type')) {
    const objectId = num(row, 'type_table_object_id')
    const [columns, indexes, checks] = await Promise.all([
      loadColumns(query, db, objectId),
      loadIndexes(query, db, objectId),
      loadChecks(query, db, objectId),
    ])
    return joinBatches([`CREATE TYPE ${target} AS TABLE ${tableBody(columns, indexes, checks, false)};`])
  }
  const base = formatType({
    typeName: str(row, 'base_type'),
    maxLength: num(row, 'max_length'),
    precision: num(row, 'precision'),
    scale: num(row, 'scale'),
  })
  return joinBatches([`CREATE TYPE ${target} FROM ${base}${bool(row, 'is_nullable') ? ' NULL' : ' NOT NULL'};`])
}

/** CREATE SYNONYM … FOR … when schema.name is a synonym (listed under the kind of its base). */
async function synonymDdl(
  query: CatalogQuery,
  db: string,
  schema: string,
  name: string,
  identity?: string,
): Promise<string | undefined> {
  const rows = await query(
    `SELECT sn.object_id, s.name AS schema_name, sn.name, sn.base_object_name
     FROM ${db}.sys.synonyms sn JOIN ${db}.sys.schemas s ON s.schema_id = sn.schema_id
     WHERE s.name = @schema AND sn.name = @name ${identity ? 'AND sn.object_id = @identity' : ''}`,
    { schema, name, ...(identity ? { identity: Number(identity) } : {}) },
  )
  const row = rows[0]
  if (!row) return undefined
  return joinBatches([
    `CREATE SYNONYM ${qualifiedName(str(row, 'schema_name'), str(row, 'name'), 'mssql')} FOR ${str(row, 'base_object_name')};`,
  ])
}

export async function getDdl(
  query: CatalogQuery,
  db: string,
  schema: string,
  name: string,
  kind: ObjectKind,
  identity?: string,
): Promise<string> {
  const synonym = await synonymDdl(query, db, schema, name, identity)
  if (synonym !== undefined) return synonym
  switch (kind) {
    case 'table':
      return tableDdl(query, db, schema, name, identity)
    case 'view':
    case 'procedure':
    case 'function':
      return moduleDdl(query, db, schema, name, kind, identity)
    case 'sequence':
      return sequenceDdl(query, db, schema, name, identity)
    case 'type':
      return typeDdl(query, db, schema, name)
    default:
      throw DriverError.of('invalid-input', `SQL Server has no ${kind} objects`)
  }
}
