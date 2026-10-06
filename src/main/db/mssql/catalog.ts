// Catalog queries against [db].sys.* (three-part names, no context switch) and their mapping to
// the shared metadata types. Context-dependent functions (OBJECT_DEFINITION, SCHEMA_NAME(id)…)
// are avoided because they would read the pool connection's current database.

import type {
  ColumnInfo,
  ConstraintInfo,
  FkAction,
  ForeignKeyInfo,
  IndexInfo,
  ObjectKind,
  TableDetails,
  TriggerInfo,
} from '@shared/types'
import { qualifiedName, quoteIdent } from '@shared/sql'
import { DriverError } from '../errors'

export type Row = Record<string, unknown>
export type QueryParams = Record<string, string | number | boolean | null>
export interface CatalogQuery {
  (sql: string, params?: QueryParams): Promise<Row[]>
  /** Server major version (13 = 2016) when known; newer catalog columns are only read when present. */
  major?: number
}

/** sys.columns.is_hidden / generated_always_type and sys.periods exist from SQL Server 2016 (13). */
export function hasTemporalCatalog(query: CatalogQuery): boolean {
  return query.major === undefined || query.major >= 13
}

export function str(row: Row, key: string): string {
  const value = row[key]
  return value === null || value === undefined ? '' : String(value)
}

export function optStr(row: Row, key: string): string | undefined {
  const value = row[key]
  return value === null || value === undefined || value === '' ? undefined : String(value)
}

export function num(row: Row, key: string): number {
  const value = row[key]
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value !== '') return Number(value)
  if (typeof value === 'bigint') return Number(value)
  return 0
}

export function optNum(row: Row, key: string): number | undefined {
  const value = row[key]
  if (value === null || value === undefined || value === '') return undefined
  const n = num(row, key)
  return Number.isFinite(n) ? n : undefined
}

export function bool(row: Row, key: string): boolean {
  const value = row[key]
  return value === true || value === 1 || value === '1'
}

const q = (name: string): string => quoteIdent(name, 'mssql')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TypeSpec {
  typeName: string
  typeSchema?: string
  isUserDefined?: boolean
  maxLength: number
  precision: number
  scale: number
}

/** "nvarchar(255)", "varbinary(max)", "decimal(12,2)", "datetime2(7)"… */
export function formatType(spec: TypeSpec, qualifyUserTypes = false): string {
  const name = spec.typeName
  if (spec.isUserDefined) {
    return qualifyUserTypes && spec.typeSchema ? qualifiedName(spec.typeSchema, name, 'mssql') : name
  }
  switch (name) {
    case 'nvarchar':
    case 'nchar':
      return spec.maxLength === -1 ? `${name}(max)` : `${name}(${spec.maxLength / 2})`
    case 'varchar':
    case 'char':
    case 'varbinary':
    case 'binary':
      return spec.maxLength === -1 ? `${name}(max)` : `${name}(${spec.maxLength})`
    case 'decimal':
    case 'numeric':
      return `${name}(${spec.precision},${spec.scale})`
    case 'datetime2':
    case 'datetimeoffset':
    case 'time':
      return `${name}(${spec.scale})`
    case 'float':
      return spec.precision === 53 || spec.precision === 0 ? 'float' : `float(${spec.precision})`
    default:
      return name
  }
}

const TYPE_COLUMNS = `t.name AS type_name, t.is_user_defined, ts.name AS type_schema, bt.name AS base_type,
  c.max_length, c.precision, c.scale`

export function typeSpecOf(row: Row): TypeSpec {
  return {
    typeName: str(row, 'type_name'),
    typeSchema: optStr(row, 'type_schema'),
    isUserDefined: bool(row, 'is_user_defined'),
    maxLength: num(row, 'max_length'),
    precision: num(row, 'precision'),
    scale: num(row, 'scale'),
  }
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

export function kindOfType(type: string): ObjectKind | undefined {
  switch (type.trim()) {
    case 'U':
      return 'table'
    case 'V':
      return 'view'
    case 'P':
    case 'PC':
    case 'X':
      return 'procedure'
    case 'FN':
    case 'IF':
    case 'TF':
    case 'FS':
    case 'FT':
      return 'function'
    case 'SO':
      return 'sequence'
    case 'SN':
      // Synonyms are shown like the object they stand for; without a known base, as a view.
      return 'view'
    default:
      return undefined
  }
}

/** Explorer kind of a synonym from OBJECTPROPERTYEX(base, 'BaseType'). */
export function kindOfSynonymBase(baseType: string | undefined): ObjectKind {
  const kind = baseType ? kindOfType(baseType) : undefined
  return kind === undefined || kind === 'table' ? 'view' : kind
}

/**
 * Synonyms of `db` with what they point to, resolved in the database's own context (OBJECT_ID of a
 * one- or three-part base name depends on it). base_id is NULL for remote / missing objects.
 */
export async function loadSynonyms(query: CatalogQuery, db: string, objectId?: number): Promise<Row[]> {
  const filter = objectId === undefined ? '' : 'WHERE sn.object_id = @id'
  return query(
    `EXEC ${db}.sys.sp_executesql N'SELECT sn.object_id, SCHEMA_NAME(sn.schema_id) AS schema_name, sn.name,
       sn.base_object_name, PARSENAME(sn.base_object_name, 4) AS server_part, PARSENAME(sn.base_object_name, 3) AS db_part,
       OBJECT_ID(sn.base_object_name) AS base_id, CAST(OBJECTPROPERTYEX(OBJECT_ID(sn.base_object_name), ''BaseType'') AS nvarchar(8)) AS base_type,
       OBJECT_SCHEMA_NAME(OBJECT_ID(sn.base_object_name)) AS base_schema, OBJECT_NAME(OBJECT_ID(sn.base_object_name)) AS base_name
     FROM sys.synonyms sn ${filter}', N'@id int', @id = @objectId`,
    { objectId: objectId ?? 0 },
  )
}

/** A table or view, possibly reached through a synonym: columns live in `db` / `columnsObjectId`. */
export interface RelationRef extends ObjectRef {
  /** Database (quoted) holding the object whose columns, keys and indexes describe the relation. */
  db: string
  columnsObjectId: number
  /** base_object_name when the relation is a synonym. */
  synonymFor?: string
  /** Schema and name of the object holding the columns (the synonym's base, or the object itself). */
  baseSchema: string
  baseName: string
}

export async function findRelation(query: CatalogQuery, db: string, schema: string, name: string): Promise<RelationRef> {
  const object = await findObject(query, db, schema, name, ['U', 'V', 'SN'])
  if (object.type !== 'SN') return { ...object, db, columnsObjectId: object.objectId, baseSchema: object.schema, baseName: object.name }
  const row = (await loadSynonyms(query, db, object.objectId))[0]
  const base = row ? optStr(row, 'base_object_name') : undefined
  const baseType = row ? optStr(row, 'base_type')?.trim() : undefined
  const baseId = row ? optNum(row, 'base_id') : undefined
  if (!row || !base || optStr(row, 'server_part') || baseId === undefined || (baseType !== 'U' && baseType !== 'V')) {
    throw DriverError.of('not-found', `Synonym ${schema}.${name} does not point to a table or view of this server${base ? ` (${base})` : ''}`)
  }
  const dbPart = optStr(row, 'db_part')
  return {
    ...object,
    kind: baseType === 'U' ? 'table' : 'view',
    db: dbPart ? quoteIdent(dbPart, 'mssql') : db,
    columnsObjectId: baseId,
    synonymFor: base,
    baseSchema: optStr(row, 'base_schema') ?? object.schema,
    baseName: optStr(row, 'base_name') ?? object.name,
  }
}

export interface ObjectRef {
  objectId: number
  type: string
  kind: ObjectKind
  schema: string
  name: string
  comment?: string
}

/** Find a schema object by name (optionally restricted to types / an object_id). */
export async function findObject(
  query: CatalogQuery,
  db: string,
  schema: string,
  name: string,
  types: string[],
  identity?: string,
): Promise<ObjectRef> {
  const typeList = types.map((t) => `'${t}'`).join(', ')
  const rows = await query(
    `SELECT o.object_id, o.type, s.name AS schema_name, o.name, CAST(ep.value AS nvarchar(max)) AS comment
     FROM ${db}.sys.all_objects o
     JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
     LEFT JOIN ${db}.sys.extended_properties ep
       ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description'
     WHERE s.name = @schema AND o.name = @name AND o.type IN (${typeList})
       ${identity ? 'AND o.object_id = @identity' : ''}`,
    { schema, name, ...(identity ? { identity: Number(identity) } : {}) },
  )
  const row = rows[0]
  const kind = row ? kindOfType(str(row, 'type')) : undefined
  if (!row || !kind) throw DriverError.of('not-found', `Object ${schema}.${name} was not found`)
  const ref: ObjectRef = {
    objectId: num(row, 'object_id'),
    type: str(row, 'type').trim(),
    kind,
    schema: str(row, 'schema_name'),
    name: str(row, 'name'),
  }
  const comment = optStr(row, 'comment')
  if (comment) ref.comment = comment
  return ref
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export interface CatalogColumn {
  columnId: number
  name: string
  type: TypeSpec
  /** System base type (alias types resolved), lower case: "nvarchar", "timestamp"… */
  baseType: string
  /** Formatted type as shown to users. */
  dataType: string
  nullable: boolean
  isIdentity: boolean
  identitySeed?: string
  identityIncrement?: string
  isComputed: boolean
  computedDefinition?: string
  isPersisted: boolean
  defaultName?: string
  defaultDefinition?: string
  comment?: string
  /** sys.columns.generated_always_type: 1/2 = ROW START/END (temporal), 5–12 = ledger / transaction ids. */
  generatedAlwaysType?: number
  /** HIDDEN column (left out of SELECT *). */
  isHidden?: boolean
  collation?: string
  isSparse?: boolean
  isColumnSet?: boolean
  isRowGuidCol?: boolean
  /** IDENTITY … NOT FOR REPLICATION */
  identityNotForReplication?: boolean
  /** CLR user-defined type (hierarchyid, geometry, geography, assembly types). */
  isAssemblyType?: boolean
}

export async function loadColumns(query: CatalogQuery, db: string, objectId: number): Promise<CatalogColumn[]> {
  const temporal = hasTemporalCatalog(query)
    ? 'c.generated_always_type, c.is_hidden,'
    : 'CAST(0 AS tinyint) AS generated_always_type, CAST(0 AS bit) AS is_hidden,'
  const rows = await query(
    `SELECT c.column_id, c.name, ${TYPE_COLUMNS}, c.is_nullable, c.is_identity, c.is_computed,
       dc.name AS default_name, dc.definition AS default_definition,
       cc.definition AS computed_definition, cc.is_persisted,
       CAST(ic.seed_value AS nvarchar(64)) AS seed_value, CAST(ic.increment_value AS nvarchar(64)) AS increment_value,
       ic.is_not_for_replication AS identity_not_for_replication,
       ${temporal} c.collation_name, c.is_sparse, c.is_column_set, c.is_rowguidcol, t.is_assembly_type,
       CAST(ep.value AS nvarchar(max)) AS comment
     FROM ${db}.sys.all_columns c
     JOIN ${db}.sys.types t ON t.user_type_id = c.user_type_id
     JOIN ${db}.sys.schemas ts ON ts.schema_id = t.schema_id
     LEFT JOIN ${db}.sys.types bt ON bt.user_type_id = c.system_type_id
     LEFT JOIN ${db}.sys.default_constraints dc ON dc.object_id = c.default_object_id
     LEFT JOIN ${db}.sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
     LEFT JOIN ${db}.sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
     LEFT JOIN ${db}.sys.extended_properties ep
       ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = N'MS_Description'
     WHERE c.object_id = @objectId
     ORDER BY c.column_id`,
    { objectId },
  )
  return rows.map((row) => {
    const type = typeSpecOf(row)
    const column: CatalogColumn = {
      columnId: num(row, 'column_id'),
      name: str(row, 'name'),
      type,
      baseType: (optStr(row, 'base_type') ?? type.typeName).toLowerCase(),
      dataType: formatType(type),
      nullable: bool(row, 'is_nullable'),
      isIdentity: bool(row, 'is_identity'),
      isComputed: bool(row, 'is_computed'),
      isPersisted: bool(row, 'is_persisted'),
    }
    const flags: Partial<CatalogColumn> = {
      isHidden: bool(row, 'is_hidden'),
      isSparse: bool(row, 'is_sparse'),
      isColumnSet: bool(row, 'is_column_set'),
      isRowGuidCol: bool(row, 'is_rowguidcol'),
      identityNotForReplication: bool(row, 'identity_not_for_replication'),
      isAssemblyType: bool(row, 'is_assembly_type'),
    }
    for (const [key, value] of Object.entries(flags)) {
      if (value === true) Object.assign(column, { [key]: true })
    }
    const generated = num(row, 'generated_always_type')
    if (generated > 0) column.generatedAlwaysType = generated
    const optional: Partial<CatalogColumn> = {
      collation: optStr(row, 'collation_name'),
      identitySeed: optStr(row, 'seed_value'),
      identityIncrement: optStr(row, 'increment_value'),
      computedDefinition: optStr(row, 'computed_definition'),
      defaultName: optStr(row, 'default_name'),
      defaultDefinition: optStr(row, 'default_definition'),
      comment: optStr(row, 'comment'),
    }
    for (const [key, value] of Object.entries(optional)) {
      if (value !== undefined) Object.assign(column, { [key]: value })
    }
    return column
  })
}

/** Columns that can never be written (computed, rowversion, GENERATED ALWAYS period / ledger columns). */
export function isGeneratedColumn(column: CatalogColumn): boolean {
  return column.isComputed || column.baseType === 'timestamp' || (column.generatedAlwaysType ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

export interface CatalogIndex {
  name: string
  indexId: number
  typeDesc: string
  isUnique: boolean
  isPrimaryKey: boolean
  isUniqueConstraint: boolean
  filter?: string
  keys: { name: string; descending: boolean }[]
  included: string[]
  /** Index options that differ from the defaults are emitted in DDL (undefined: default). */
  fillFactor?: number
  isPadded?: boolean
  ignoreDupKey?: boolean
  allowRowLocks?: boolean
  allowPageLocks?: boolean
  /** data_compression_desc of the first partition (NONE, ROW, PAGE, COLUMNSTORE, COLUMNSTORE_ARCHIVE). */
  compression?: string
  isDisabled?: boolean
}

export async function loadIndexes(query: CatalogQuery, db: string, objectId: number): Promise<CatalogIndex[]> {
  const rows = await query(
    `SELECT i.name AS index_name, i.index_id, i.type_desc, i.is_unique, i.is_primary_key, i.is_unique_constraint,
       i.filter_definition, i.fill_factor, i.is_padded, i.ignore_dup_key, i.allow_row_locks, i.allow_page_locks,
       i.is_disabled,
       (SELECT TOP (1) p.data_compression_desc FROM ${db}.sys.partitions p
        WHERE p.object_id = i.object_id AND p.index_id = i.index_id ORDER BY p.partition_number) AS data_compression,
       c.name AS column_name, ic.key_ordinal, ic.is_included_column, ic.is_descending_key, ic.index_column_id
     FROM ${db}.sys.indexes i
     JOIN ${db}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
     JOIN ${db}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
     WHERE i.object_id = @objectId AND i.type > 0 AND i.is_hypothetical = 0
     ORDER BY i.index_id, ic.key_ordinal, ic.index_column_id`,
    { objectId },
  )
  const byId = new Map<number, CatalogIndex>()
  for (const row of rows) {
    const id = num(row, 'index_id')
    let index = byId.get(id)
    if (!index) {
      index = {
        name: str(row, 'index_name'),
        indexId: id,
        typeDesc: str(row, 'type_desc'),
        isUnique: bool(row, 'is_unique'),
        isPrimaryKey: bool(row, 'is_primary_key'),
        isUniqueConstraint: bool(row, 'is_unique_constraint'),
        keys: [],
        included: [],
      }
      const filter = optStr(row, 'filter_definition')
      if (filter) index.filter = filter
      const fillFactor = num(row, 'fill_factor')
      if (fillFactor > 0 && fillFactor < 100) index.fillFactor = fillFactor
      if (bool(row, 'is_padded')) index.isPadded = true
      if (bool(row, 'ignore_dup_key')) index.ignoreDupKey = true
      if (!bool(row, 'allow_row_locks')) index.allowRowLocks = false
      if (!bool(row, 'allow_page_locks')) index.allowPageLocks = false
      if (bool(row, 'is_disabled')) index.isDisabled = true
      const compression = optStr(row, 'data_compression')
      if (compression && compression !== 'NONE' && compression !== 'COLUMNSTORE') index.compression = compression
      byId.set(id, index)
    }
    const column = str(row, 'column_name')
    const columnstore = index.typeDesc.includes('COLUMNSTORE')
    if (bool(row, 'is_included_column') || (num(row, 'key_ordinal') === 0 && columnstore)) {
      index.included.push(column)
    } else if (num(row, 'key_ordinal') > 0) {
      index.keys.push({ name: column, descending: bool(row, 'is_descending_key') })
    }
  }
  return [...byId.values()]
}

const keyList = (keys: CatalogIndex['keys']): string =>
  keys.map((key) => `${q(key.name)} ${key.descending ? 'DESC' : 'ASC'}`).join(', ')

const kindKeyword = (index: CatalogIndex): string =>
  index.typeDesc.startsWith('CLUSTERED') ? 'CLUSTERED' : 'NONCLUSTERED'

/** " WITH (FILLFACTOR = 80, IGNORE_DUP_KEY = ON…)" for the options that differ from the defaults, or "". */
export function indexOptions(index: CatalogIndex): string {
  const options: string[] = []
  if (index.typeDesc.includes('COLUMNSTORE')) {
    if (index.compression === 'COLUMNSTORE_ARCHIVE') options.push('DATA_COMPRESSION = COLUMNSTORE_ARCHIVE')
  } else {
    if (index.isPadded) options.push('PAD_INDEX = ON')
    if (index.fillFactor !== undefined) options.push(`FILLFACTOR = ${index.fillFactor}`)
    if (index.ignoreDupKey) options.push('IGNORE_DUP_KEY = ON')
    if (index.allowRowLocks === false) options.push('ALLOW_ROW_LOCKS = OFF')
    if (index.allowPageLocks === false) options.push('ALLOW_PAGE_LOCKS = OFF')
    if (index.compression === 'ROW' || index.compression === 'PAGE') options.push(`DATA_COMPRESSION = ${index.compression}`)
  }
  return options.length > 0 ? ` WITH (${options.join(', ')})` : ''
}

/** "PRIMARY KEY CLUSTERED ([id] ASC)" / "UNIQUE NONCLUSTERED (…) WITH (FILLFACTOR = 80)" */
export function keyConstraintBody(index: CatalogIndex): string {
  return `${index.isPrimaryKey ? 'PRIMARY KEY' : 'UNIQUE'} ${kindKeyword(index)} (${keyList(index.keys)})${indexOptions(index)}`
}

export function createIndexStatement(index: CatalogIndex, schema: string, table: string): string {
  const target = qualifiedName(schema, table, 'mssql')
  if (index.typeDesc.includes('COLUMNSTORE')) {
    const clustered = index.typeDesc.startsWith('CLUSTERED')
    const columns = clustered ? '' : ` (${index.included.map(q).join(', ')})`
    return `CREATE ${clustered ? 'CLUSTERED' : 'NONCLUSTERED'} COLUMNSTORE INDEX ${q(index.name)} ON ${target}${columns}${indexOptions(index)}`
  }
  if (index.typeDesc === 'XML' || index.typeDesc === 'SPATIAL') {
    return `-- ${index.typeDesc} index ${q(index.name)} on ${target} (${index.keys.map((key) => q(key.name)).join(', ')})`
  }
  let sql = `CREATE ${index.isUnique ? 'UNIQUE ' : ''}${kindKeyword(index)} INDEX ${q(index.name)} ON ${target} (${keyList(index.keys)})`
  if (index.included.length > 0) sql += ` INCLUDE (${index.included.map(q).join(', ')})`
  if (index.filter) sql += ` WHERE ${index.filter}`
  return sql + indexOptions(index)
}

export function indexDefinition(index: CatalogIndex, schema: string, table: string): string {
  if (index.isPrimaryKey || index.isUniqueConstraint) {
    return `ALTER TABLE ${qualifiedName(schema, table, 'mssql')} ADD CONSTRAINT ${q(index.name)} ${keyConstraintBody(index)}`
  }
  return createIndexStatement(index, schema, table)
}

// ---------------------------------------------------------------------------
// Foreign keys, checks, triggers
// ---------------------------------------------------------------------------

export function fkAction(desc: string): FkAction {
  switch (desc) {
    case 'CASCADE':
      return 'CASCADE'
    case 'SET_NULL':
      return 'SET NULL'
    case 'SET_DEFAULT':
      return 'SET DEFAULT'
    default:
      return 'NO ACTION'
  }
}

export interface CatalogForeignKey extends ForeignKeyInfo {
  parentObjectId: number
  referencedObjectId: number
  isDisabled?: boolean
  isNotTrusted?: boolean
  notForReplication?: boolean
}

export async function loadForeignKeys(query: CatalogQuery, db: string, objectId: number): Promise<CatalogForeignKey[]> {
  const rows = await query(
    `SELECT fk.name, fk.parent_object_id, fk.referenced_object_id,
       ps.name AS schema_name, pt.name AS table_name, rs.name AS ref_schema, rt.name AS ref_table,
       fk.delete_referential_action_desc AS on_delete, fk.update_referential_action_desc AS on_update,
       fk.is_disabled, fk.is_not_trusted, fk.is_not_for_replication,
       pc.name AS column_name, rc.name AS ref_column, fkc.constraint_column_id
     FROM ${db}.sys.foreign_keys fk
     JOIN ${db}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
     JOIN ${db}.sys.objects pt ON pt.object_id = fk.parent_object_id
     JOIN ${db}.sys.schemas ps ON ps.schema_id = pt.schema_id
     JOIN ${db}.sys.objects rt ON rt.object_id = fk.referenced_object_id
     JOIN ${db}.sys.schemas rs ON rs.schema_id = rt.schema_id
     JOIN ${db}.sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
     JOIN ${db}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
     WHERE fk.parent_object_id = @objectId OR fk.referenced_object_id = @objectId
     ORDER BY fk.name, fkc.constraint_column_id`,
    { objectId },
  )
  const byName = new Map<string, CatalogForeignKey>()
  for (const row of rows) {
    const key = `${num(row, 'parent_object_id')}:${str(row, 'name')}`
    let fk = byName.get(key)
    if (!fk) {
      fk = {
        name: str(row, 'name'),
        schema: str(row, 'schema_name'),
        table: str(row, 'table_name'),
        columns: [],
        refSchema: str(row, 'ref_schema'),
        refTable: str(row, 'ref_table'),
        refColumns: [],
        onUpdate: fkAction(str(row, 'on_update')),
        onDelete: fkAction(str(row, 'on_delete')),
        parentObjectId: num(row, 'parent_object_id'),
        referencedObjectId: num(row, 'referenced_object_id'),
      }
      if (bool(row, 'is_disabled')) fk.isDisabled = true
      if (bool(row, 'is_not_trusted')) fk.isNotTrusted = true
      if (bool(row, 'is_not_for_replication')) fk.notForReplication = true
      byName.set(key, fk)
    }
    fk.columns.push(str(row, 'column_name'))
    fk.refColumns.push(str(row, 'ref_column'))
  }
  return [...byName.values()]
}

export function foreignKeyInfo(fk: CatalogForeignKey): ForeignKeyInfo {
  return {
    name: fk.name,
    schema: fk.schema,
    table: fk.table,
    columns: fk.columns,
    refSchema: fk.refSchema,
    refTable: fk.refTable,
    refColumns: fk.refColumns,
    onUpdate: fk.onUpdate,
    onDelete: fk.onDelete,
  }
}

export function foreignKeyStatement(fk: ForeignKeyInfo & Partial<Pick<CatalogForeignKey, 'isNotTrusted' | 'notForReplication'>>): string {
  let sql =
    `ALTER TABLE ${qualifiedName(fk.schema, fk.table, 'mssql')}${fk.isNotTrusted ? ' WITH NOCHECK' : ''} ADD CONSTRAINT ${q(fk.name)} ` +
    `FOREIGN KEY (${fk.columns.map(q).join(', ')}) ` +
    `REFERENCES ${qualifiedName(fk.refSchema, fk.refTable, 'mssql')} (${fk.refColumns.map(q).join(', ')})`
  if (fk.onDelete !== 'NO ACTION') sql += ` ON DELETE ${fk.onDelete}`
  if (fk.onUpdate !== 'NO ACTION') sql += ` ON UPDATE ${fk.onUpdate}`
  if (fk.notForReplication) sql += ' NOT FOR REPLICATION'
  return sql
}

export interface CatalogCheck {
  name: string
  definition: string
  column?: string
  isDisabled?: boolean
  isNotTrusted?: boolean
  notForReplication?: boolean
}

export async function loadChecks(query: CatalogQuery, db: string, objectId: number): Promise<CatalogCheck[]> {
  const rows = await query(
    `SELECT cc.name, cc.definition, cc.is_disabled, cc.is_not_trusted, cc.is_not_for_replication, c.name AS column_name
     FROM ${db}.sys.check_constraints cc
     LEFT JOIN ${db}.sys.columns c ON c.object_id = cc.parent_object_id AND c.column_id = cc.parent_column_id
     WHERE cc.parent_object_id = @objectId
     ORDER BY cc.name`,
    { objectId },
  )
  return rows.map((row) => {
    const check: CatalogCheck = { name: str(row, 'name'), definition: str(row, 'definition') }
    const column = optStr(row, 'column_name')
    if (column) check.column = column
    if (bool(row, 'is_disabled')) check.isDisabled = true
    if (bool(row, 'is_not_trusted')) check.isNotTrusted = true
    if (bool(row, 'is_not_for_replication')) check.notForReplication = true
    return check
  })
}

export async function loadTriggers(query: CatalogQuery, db: string, objectId: number): Promise<TriggerInfo[]> {
  const rows = await query(
    `SELECT tr.object_id, tr.name, tr.is_disabled, tr.is_instead_of_trigger, te.type_desc AS event, m.definition
     FROM ${db}.sys.triggers tr
     LEFT JOIN ${db}.sys.trigger_events te ON te.object_id = tr.object_id
     LEFT JOIN ${db}.sys.sql_modules m ON m.object_id = tr.object_id
     WHERE tr.parent_id = @objectId
     ORDER BY tr.name, te.type`,
    { objectId },
  )
  const byId = new Map<number, TriggerInfo>()
  for (const row of rows) {
    const id = num(row, 'object_id')
    let trigger = byId.get(id)
    if (!trigger) {
      trigger = {
        name: str(row, 'name'),
        timing: bool(row, 'is_instead_of_trigger') ? 'INSTEAD OF' : 'AFTER',
        events: [],
        enabled: !bool(row, 'is_disabled'),
      }
      const definition = optStr(row, 'definition')
      if (definition) trigger.definition = definition.trim()
      byId.set(id, trigger)
    }
    const event = optStr(row, 'event')
    if (event && !trigger.events.includes(event)) trigger.events.push(event)
  }
  return [...byId.values()]
}

export async function rowEstimate(query: CatalogQuery, db: string, objectId: number): Promise<number | undefined> {
  const rows = await query(
    `SELECT SUM(p.rows) AS row_estimate FROM ${db}.sys.partitions p WHERE p.object_id = @objectId AND p.index_id IN (0, 1)`,
    { objectId },
  )
  return rows[0] ? optNum(rows[0], 'row_estimate') : undefined
}

/** Used pages from sys.dm_db_partition_stats (needs VIEW DATABASE STATE); undefined when not permitted. */
export async function sizeBytes(query: CatalogQuery, db: string, objectId: number): Promise<number | undefined> {
  try {
    const rows = await query(
      `SELECT SUM(ps.used_page_count) * 8192 AS size_bytes FROM ${db}.sys.dm_db_partition_stats ps WHERE ps.object_id = @objectId`,
      { objectId },
    )
    return rows[0] ? optNum(rows[0], 'size_bytes') : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Table details
// ---------------------------------------------------------------------------

export function primaryKeyOf(indexes: CatalogIndex[]): string[] {
  return indexes.find((index) => index.isPrimaryKey)?.keys.map((key) => key.name) ?? []
}

export function toColumnInfo(column: CatalogColumn, primaryKey: string[]): ColumnInfo {
  const info: ColumnInfo = {
    name: column.name,
    ordinal: column.columnId,
    dataType: column.dataType,
    nullable: column.nullable,
    defaultValue: column.defaultDefinition ?? null,
    isPrimaryKey: primaryKey.includes(column.name),
    isIdentity: column.isIdentity,
    isGenerated: isGeneratedColumn(column),
  }
  if (column.comment) info.comment = column.comment
  return info
}

export async function loadTableDetails(
  query: CatalogQuery,
  db: string,
  schema: string,
  name: string,
): Promise<TableDetails> {
  const relation = await findRelation(query, db, schema, name)
  const { db: base, columnsObjectId: id } = relation
  const object = { ...relation, objectId: id }
  const [columns, indexes, foreignKeys, checks, triggers, rows, size] = await Promise.all([
    loadColumns(query, base, id),
    loadIndexes(query, base, id),
    loadForeignKeys(query, base, id),
    loadChecks(query, base, id),
    loadTriggers(query, base, id),
    rowEstimate(query, base, id),
    sizeBytes(query, base, id),
  ])
  const primaryKey = primaryKeyOf(indexes)

  const constraints: ConstraintInfo[] = []
  for (const index of indexes) {
    if (!index.isPrimaryKey && !index.isUniqueConstraint) continue
    constraints.push({
      name: index.name,
      type: index.isPrimaryKey ? 'primary-key' : 'unique',
      columns: index.keys.map((key) => key.name),
      definition: keyConstraintBody(index),
    })
  }
  for (const check of checks) {
    constraints.push({
      name: check.name,
      type: 'check',
      columns: check.column ? [check.column] : [],
      definition: `CHECK ${check.definition}`,
    })
  }
  for (const column of columns) {
    if (!column.defaultName || !column.defaultDefinition) continue
    constraints.push({
      name: column.defaultName,
      type: 'default',
      columns: [column.name],
      definition: `DEFAULT ${column.defaultDefinition}`,
    })
  }

  const indexInfos: IndexInfo[] = indexes.map((index) => {
    const info: IndexInfo = {
      name: index.name,
      columns: index.keys.length > 0 ? index.keys.map((key) => key.name) : index.included,
      isUnique: index.isUnique,
      isPrimary: index.isPrimaryKey,
      method: index.typeDesc,
      definition: indexDefinition(index, relation.baseSchema, relation.baseName),
    }
    if (index.filter) info.predicate = index.filter
    return info
  })

  const details: TableDetails = {
    schema: object.schema,
    name: object.name,
    kind: object.kind,
    columns: columns.map((column) => toColumnInfo(column, primaryKey)),
    primaryKey,
    indexes: indexInfos,
    foreignKeys: foreignKeys
      .filter((fk) => fk.parentObjectId === object.objectId)
      .map(foreignKeyInfo),
    referencedBy: foreignKeys
      .filter((fk) => fk.referencedObjectId === object.objectId)
      .map(foreignKeyInfo),
    constraints,
    triggers,
  }
  const comment = relation.synonymFor ? [`Synonym for ${relation.synonymFor}`, object.comment].filter(Boolean).join(' — ') : object.comment
  if (comment) details.comment = comment
  if (rows !== undefined && object.kind === 'table') details.rowEstimate = rows
  if (size !== undefined) details.sizeBytes = size
  return details
}
