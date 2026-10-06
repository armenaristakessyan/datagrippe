// Structure of a table / view / materialized view: columns, keys, indexes, constraints, triggers.
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
import { DriverError } from '../errors'
import { RELKIND_TO_KIND } from './catalog'
import { bool, num, optNum, optStr, select, str, stringList, type Queryable, type Row } from './rows'

export interface RelationRef {
  oid: number
  relkind: string
  kind: ObjectKind
  comment?: string
}

const RELATION_SQL = `SELECT c.oid AS oid, c.relkind AS relkind, pg_catalog.obj_description(c.oid, 'pg_class') AS comment
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = ANY($3::"char"[])`

/** Find a relation by name; throws DriverError 'not-found'. */
export async function findRelation(
  q: Queryable,
  schema: string,
  name: string,
  relkinds: readonly string[] = ['r', 'p', 'v', 'm', 'f'],
): Promise<RelationRef> {
  const [row] = await select(q, RELATION_SQL, [schema, name, relkinds])
  const kind = row ? RELKIND_TO_KIND[str(row, 'relkind')] : undefined
  if (!row || !kind) throw DriverError.of('not-found', `Relation ${schema}.${name} does not exist`)
  return { oid: num(row, 'oid'), relkind: str(row, 'relkind'), kind, comment: optStr(row, 'comment') }
}

const COLUMNS_SQL = `SELECT a.attnum AS attnum, a.attname AS name,
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
  a.attnotnull AS not_null, a.attidentity AS identity, a.attgenerated AS generated,
  pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
  pg_catalog.col_description(a.attrelid, a.attnum) AS comment
FROM pg_catalog.pg_attribute a
LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`

/** Key columns of a constraint, in key order. */
const conColumns = (array: string, rel: string) => `(SELECT coalesce(json_agg(a.attname ORDER BY k.ord), '[]')
    FROM unnest(${array}) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = ${rel} AND a.attnum = k.attnum)`

const PRIMARY_KEY_SQL = `SELECT ${conColumns('con.conkey', 'con.conrelid')} AS columns
FROM pg_catalog.pg_constraint con WHERE con.conrelid = $1 AND con.contype = 'p'`

const INDEXES_SQL = `SELECT ic.relname AS name, i.indisunique AS is_unique, i.indisprimary AS is_primary,
  am.amname AS method, pg_catalog.pg_get_indexdef(i.indexrelid) AS definition,
  pg_catalog.pg_get_expr(i.indpred, i.indrelid, true) AS predicate,
  (SELECT json_agg(pg_catalog.pg_get_indexdef(i.indexrelid, k, true) ORDER BY k)
     FROM generate_series(1, i.indnkeyatts) AS k) AS columns,
  EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con
    WHERE con.conindid = i.indexrelid AND con.conrelid = i.indrelid AND con.contype IN ('p', 'u', 'x')) AS backs_constraint
FROM pg_catalog.pg_index i
JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
JOIN pg_catalog.pg_am am ON am.oid = ic.relam
WHERE i.indrelid = $1
ORDER BY i.indisprimary DESC, ic.relname`

const FOREIGN_KEYS_SQL = (side: 'conrelid' | 'confrelid') => `SELECT con.conname AS name,
  sn.nspname AS schema, sc.relname AS table_name, ${conColumns('con.conkey', 'con.conrelid')} AS columns,
  rn.nspname AS ref_schema, rc.relname AS ref_table, ${conColumns('con.confkey', 'con.confrelid')} AS ref_columns,
  con.confupdtype AS on_update, con.confdeltype AS on_delete
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class sc ON sc.oid = con.conrelid
JOIN pg_catalog.pg_namespace sn ON sn.oid = sc.relnamespace
JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
WHERE con.contype = 'f' AND con.${side} = $1 AND (con.conparentid = 0)
ORDER BY con.conname`

const CONSTRAINTS_SQL = `SELECT con.conname AS name, con.contype AS contype,
  ${conColumns('coalesce(con.conkey, ARRAY[]::int2[])', 'con.conrelid')} AS columns,
  pg_catalog.pg_get_constraintdef(con.oid, true) AS definition
FROM pg_catalog.pg_constraint con
WHERE con.conrelid = $1 AND con.contype IN ('p', 'u', 'c', 'x')
ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 ELSE 3 END, con.conname`

const TRIGGERS_SQL = `SELECT t.tgname AS name, t.tgtype AS tgtype, t.tgenabled AS enabled,
  pg_catalog.pg_get_triggerdef(t.oid, true) AS definition
FROM pg_catalog.pg_trigger t
WHERE t.tgrelid = $1 AND NOT t.tgisinternal
ORDER BY t.tgname`

// A partitioned table has no storage: size and rows are summed over every partition of its tree
// (sub-partitions included; intermediate partitioned partitions are empty and have reltuples -1).
const STATS_SQL = `SELECT CASE WHEN c.reltuples >= 0 AND c.relkind IN ('r', 'm', 'f') THEN c.reltuples::float8 END AS row_estimate,
  CASE WHEN c.relkind IN ('r', 'm') THEN pg_catalog.pg_total_relation_size(c.oid)::float8
       WHEN c.relkind = 'p' THEN (SELECT sum(pg_catalog.pg_total_relation_size(t.relid))::float8
                                 FROM pg_catalog.pg_partition_tree(c.oid) t WHERE t.level > 0) END AS size_bytes,
  CASE WHEN c.relkind = 'p' THEN (SELECT sum(greatest(pc.reltuples, 0))::float8 FROM pg_catalog.pg_partition_tree(c.oid) t
    JOIN pg_catalog.pg_class pc ON pc.oid = t.relid WHERE t.isleaf) END AS partition_rows
FROM pg_catalog.pg_class c WHERE c.oid = $1`

const FK_ACTIONS: Record<string, FkAction> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
}

const CONSTRAINT_TYPES: Record<string, ConstraintInfo['type']> = {
  p: 'primary-key',
  u: 'unique',
  c: 'check',
  x: 'exclusion',
}

// pg_trigger.tgtype bits (src/include/catalog/pg_trigger.h)
const TRIGGER_TYPE = { before: 1 << 1, insert: 1 << 2, delete: 1 << 3, update: 1 << 4, truncate: 1 << 5, instead: 1 << 6 }

export function decodeTriggerType(tgtype: number): { timing: string; events: string[] } {
  const timing = tgtype & TRIGGER_TYPE.instead ? 'INSTEAD OF' : tgtype & TRIGGER_TYPE.before ? 'BEFORE' : 'AFTER'
  const events: string[] = []
  if (tgtype & TRIGGER_TYPE.insert) events.push('INSERT')
  if (tgtype & TRIGGER_TYPE.update) events.push('UPDATE')
  if (tgtype & TRIGGER_TYPE.delete) events.push('DELETE')
  if (tgtype & TRIGGER_TYPE.truncate) events.push('TRUNCATE')
  return { timing, events }
}

function toForeignKey(row: Row): ForeignKeyInfo {
  return {
    name: str(row, 'name'),
    schema: str(row, 'schema'),
    table: str(row, 'table_name'),
    columns: stringList(row, 'columns'),
    refSchema: str(row, 'ref_schema'),
    refTable: str(row, 'ref_table'),
    refColumns: stringList(row, 'ref_columns'),
    onUpdate: FK_ACTIONS[str(row, 'on_update')] ?? 'NO ACTION',
    onDelete: FK_ACTIONS[str(row, 'on_delete')] ?? 'NO ACTION',
  }
}

export async function primaryKeyOf(q: Queryable, oid: number): Promise<string[]> {
  const [row] = await select(q, PRIMARY_KEY_SQL, [oid])
  return row ? stringList(row, 'columns') : []
}

export async function columnsOf(q: Queryable, oid: number, primaryKey: readonly string[]): Promise<ColumnInfo[]> {
  const rows = await select(q, COLUMNS_SQL, [oid])
  return rows.map((row, i) => {
    const defaultValue = optStr(row, 'default_expr') ?? null
    const identity = str(row, 'identity')
    const name = str(row, 'name')
    const column: ColumnInfo = {
      name,
      ordinal: i + 1,
      dataType: str(row, 'data_type'),
      nullable: !bool(row, 'not_null'),
      defaultValue,
      isPrimaryKey: primaryKey.includes(name),
      isIdentity: identity !== '' || (defaultValue?.startsWith('nextval(') ?? false),
      isGenerated: str(row, 'generated') !== '',
    }
    const comment = optStr(row, 'comment')
    if (comment !== undefined) column.comment = comment
    return column
  })
}

export async function tableDetails(q: Queryable, schema: string, name: string): Promise<TableDetails> {
  const relation = await findRelation(q, schema, name)
  const { oid } = relation
  const [primaryKey, indexRows, fkRows, refRows, constraintRows, triggerRows, [stats]] = await Promise.all([
    primaryKeyOf(q, oid),
    select(q, INDEXES_SQL, [oid]),
    select(q, FOREIGN_KEYS_SQL('conrelid'), [oid]),
    select(q, FOREIGN_KEYS_SQL('confrelid'), [oid]),
    select(q, CONSTRAINTS_SQL, [oid]),
    select(q, TRIGGERS_SQL, [oid]),
    select(q, STATS_SQL, [oid]),
  ])
  const columns = await columnsOf(q, oid, primaryKey)

  const indexes: IndexInfo[] = indexRows.map((row) => {
    const index: IndexInfo = {
      name: str(row, 'name'),
      columns: stringList(row, 'columns'),
      isUnique: bool(row, 'is_unique'),
      isPrimary: bool(row, 'is_primary'),
      method: optStr(row, 'method'),
      definition: optStr(row, 'definition'),
    }
    const predicate = optStr(row, 'predicate')
    if (predicate !== undefined) index.predicate = predicate
    return index
  })

  const constraints: ConstraintInfo[] = constraintRows.flatMap((row) => {
    const type = CONSTRAINT_TYPES[str(row, 'contype')]
    return type
      ? [{ name: str(row, 'name'), type, columns: stringList(row, 'columns'), definition: optStr(row, 'definition') }]
      : []
  })

  const triggers: TriggerInfo[] = triggerRows.map((row) => ({
    name: str(row, 'name'),
    ...decodeTriggerType(num(row, 'tgtype')),
    enabled: str(row, 'enabled') !== 'D',
    definition: optStr(row, 'definition'),
  }))

  const details: TableDetails = {
    schema,
    name,
    kind: relation.kind,
    columns,
    primaryKey,
    indexes,
    foreignKeys: fkRows.map(toForeignKey),
    referencedBy: refRows.map(toForeignKey),
    constraints,
    triggers,
  }
  if (relation.comment !== undefined) details.comment = relation.comment
  const rowEstimate = stats ? (optNum(stats, 'row_estimate') ?? optNum(stats, 'partition_rows')) : undefined
  if (rowEstimate !== undefined) details.rowEstimate = rowEstimate
  const sizeBytes = stats ? optNum(stats, 'size_bytes') : undefined
  if (sizeBytes !== undefined) details.sizeBytes = sizeBytes
  return details
}
