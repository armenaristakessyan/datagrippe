// What the explorer's properties cards show, from the TableDetails cache. Pure.
// - columnProperties: a column plus every key, index, foreign key and check of its table that involves it.
// - detailProperties: a key / index / foreign key / trigger row of the Keys, Indexes… folders.
import type { ColumnInfo, FkAction, TableDetails } from '@shared/types'
import type { DetailFolder } from './tree'

export interface ColumnKey {
  name: string
  /** The other columns of a composite key. */
  with: string[]
}

export interface ColumnReference {
  name: string
  /** "schema.table.column" (schema left out when it is the column's own). */
  target: string
  /** Non-default referential actions, e.g. "ON DELETE CASCADE". */
  actions: string[]
}

export interface ColumnIndex {
  name: string
  unique: boolean
  primary: boolean
  method?: string
  /** The other columns of a multi-column index. */
  with: string[]
}

export interface ColumnProperties {
  column: ColumnInfo
  primaryKey?: ColumnKey
  unique: ColumnKey[]
  /** Foreign keys of this column. */
  references: ColumnReference[]
  /** Foreign keys of other tables pointing at this column. */
  referencedBy: ColumnReference[]
  indexes: ColumnIndex[]
  checks: { name: string; definition?: string }[]
}

/**
 * Column of an index entry: PostgreSQL quotes the names that need it ("AccountId"); anything else
 * (lower(name)…) is an expression and stays as is.
 */
export function indexColumnName(entry: string): string {
  const quoted = /^"((?:[^"]|"")*)"$/.exec(entry)
  return quoted ? quoted[1]!.replaceAll('""', '"') : entry
}

const indexColumns = (columns: string[]) => columns.map(indexColumnName)

const others = (columns: string[], name: string) => columns.filter((c) => c !== name)

const qualify = (schema: string, table: string, column: string | undefined, ownSchema: string) =>
  `${schema === ownSchema ? '' : `${schema}.`}${table}${column ? `.${column}` : ''}`

function actionsOf(onDelete: FkAction, onUpdate: FkAction): string[] {
  const out: string[] = []
  if (onDelete !== 'NO ACTION') out.push(`ON DELETE ${onDelete}`)
  if (onUpdate !== 'NO ACTION') out.push(`ON UPDATE ${onUpdate}`)
  return out
}

/**
 * Properties of `column`. Without details (not loaded) only the column's own fields are known; the
 * primary key then comes from `column.isPrimaryKey`.
 */
export function columnProperties(column: ColumnInfo, details: TableDetails | undefined): ColumnProperties {
  const name = column.name
  if (!details) {
    return {
      column,
      primaryKey: column.isPrimaryKey ? { name: '', with: [] } : undefined,
      unique: [],
      references: [],
      referencedBy: [],
      indexes: [],
      checks: [],
    }
  }
  const schema = details.schema
  const constraints = details.constraints.filter((c) => c.columns.includes(name))
  const pk = constraints.find((c) => c.type === 'primary-key')
  const primaryKey: ColumnKey | undefined = pk
    ? { name: pk.name, with: others(pk.columns, name) }
    : details.primaryKey.includes(name) || column.isPrimaryKey
      ? { name: '', with: others(details.primaryKey, name) }
      : undefined

  const unique = constraints.filter((c) => c.type === 'unique').map((c) => ({ name: c.name, with: others(c.columns, name) }))
  // The index backing a primary key / unique constraint has its name: it is already listed.
  const keyNames = new Set([...(primaryKey?.name ? [primaryKey.name] : []), ...unique.map((u) => u.name)])

  return {
    column,
    primaryKey,
    unique,
    references: details.foreignKeys
      .filter((fk) => fk.columns.includes(name))
      .map((fk) => ({
        name: fk.name,
        target: qualify(fk.refSchema, fk.refTable, fk.refColumns[fk.columns.indexOf(name)], schema),
        actions: actionsOf(fk.onDelete, fk.onUpdate),
      })),
    referencedBy: details.referencedBy
      .filter((fk) => fk.refColumns.includes(name))
      .map((fk) => ({
        name: fk.name,
        target: qualify(fk.schema, fk.table, fk.columns[fk.refColumns.indexOf(name)], schema),
        actions: actionsOf(fk.onDelete, fk.onUpdate),
      })),
    indexes: details.indexes
      .map((i) => ({ index: i, columns: indexColumns(i.columns) }))
      .filter(({ index, columns }) => columns.includes(name) && !keyNames.has(index.name))
      .map(({ index: i, columns }) => ({ name: i.name, unique: i.isUnique, primary: i.isPrimary, method: i.method, with: others(columns, name) })),
    checks: constraints.filter((c) => c.type === 'check').map((c) => ({ name: c.name, definition: c.definition })),
  }
}

// ---------------------------------------------------------------------------
// Keys, indexes, foreign keys, triggers
// ---------------------------------------------------------------------------

/** A column of a key / index, with its type when it is a plain column of the table. */
export interface KeyColumn {
  name: string
  dataType?: string
}

export type DetailProperties =
  | { kind: 'key'; name: string; primary: boolean; columns: KeyColumn[]; method?: string; definition?: string }
  | { kind: 'index'; name: string; primary: boolean; unique: boolean; columns: KeyColumn[]; method?: string; predicate?: string; definition?: string }
  | {
      kind: 'foreign-key'
      name: string
      /** Referenced table ("schema." left out when it is the table's own). */
      target: string
      /** Local column → referenced column, in key order. */
      pairs: { column: string; dataType?: string; refColumn: string }[]
      onDelete: FkAction
      onUpdate: FkAction
    }
  | { kind: 'trigger'; name: string; timing: string; events: string[]; enabled: boolean; definition?: string }

/** Properties of the item `name` of a Keys / Indexes / Foreign keys / Triggers folder; undefined when gone. */
export function detailProperties(folder: DetailFolder, name: string, details: TableDetails | undefined): DetailProperties | undefined {
  if (!details) return undefined
  const typeOf = new Map(details.columns.map((c) => [c.name, c.dataType]))
  const keyColumns = (columns: string[]): KeyColumn[] => columns.map((c) => ({ name: c, dataType: typeOf.get(c) }))
  switch (folder) {
    case 'keys': {
      const key = details.constraints.find((c) => c.name === name && (c.type === 'primary-key' || c.type === 'unique'))
      if (!key) return undefined
      const index = details.indexes.find((i) => i.name === name)
      return {
        kind: 'key',
        name,
        primary: key.type === 'primary-key',
        columns: keyColumns(key.columns),
        method: index?.method,
        definition: key.definition ?? index?.definition,
      }
    }
    case 'indexes': {
      const index = details.indexes.find((i) => i.name === name)
      if (!index) return undefined
      return {
        kind: 'index',
        name,
        primary: index.isPrimary,
        unique: index.isUnique,
        columns: keyColumns(indexColumns(index.columns)),
        method: index.method,
        predicate: index.predicate,
        definition: index.definition,
      }
    }
    case 'foreign-keys': {
      const fk = details.foreignKeys.find((f) => f.name === name)
      if (!fk) return undefined
      return {
        kind: 'foreign-key',
        name,
        target: qualify(fk.refSchema, fk.refTable, undefined, details.schema),
        pairs: fk.columns.map((column, i) => ({ column, dataType: typeOf.get(column), refColumn: fk.refColumns[i] ?? '?' })),
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      }
    }
    case 'triggers': {
      const trigger = details.triggers.find((t) => t.name === name)
      if (!trigger) return undefined
      return { kind: 'trigger', name, timing: trigger.timing, events: trigger.events, enabled: trigger.enabled, definition: trigger.definition }
    }
  }
}
