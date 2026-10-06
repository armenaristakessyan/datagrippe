// Explorer listings and the autocompletion catalog, from pg_catalog (fast on large catalogs).
import type {
  CompletionCatalog,
  CompletionObject,
  CompletionSchema,
  DatabaseInfo,
  DbObjectInfo,
  ObjectKind,
  SchemaInfo,
} from '@shared/types'
import { jsonValue, optNum, optStr, select, str, bool, type Queryable } from './rows'

export function isSystemSchema(name: string): boolean {
  return (
    name === 'pg_catalog' ||
    name === 'information_schema' ||
    name.startsWith('pg_toast') ||
    name.startsWith('pg_temp_')
  )
}

export const RELKIND_TO_KIND: Record<string, ObjectKind> = {
  r: 'table',
  p: 'table',
  v: 'view',
  m: 'materialized-view',
  f: 'foreign-table',
  S: 'sequence',
}

const KIND_ORDER: ObjectKind[] = [
  'table',
  'view',
  'materialized-view',
  'foreign-table',
  'function',
  'procedure',
  'sequence',
  'type',
]

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function compareObjects(a: DbObjectInfo, b: DbObjectInfo): number {
  return (
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
    compareText(a.name, b.name) ||
    compareText(a.signature ?? '', b.signature ?? '')
  )
}

/** Objects that belong to an extension (pg_depend deptype 'e'). */
const NOT_EXTENSION_MEMBER = (catalog: string, alias: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
    WHERE d.classid = '${catalog}'::regclass AND d.objid = ${alias}.oid AND d.deptype = 'e')`

/**
 * Objects PostgreSQL created and owns internally (pg_depend deptype 'i'): identity sequences, the
 * constructor functions of range and multirange types. They are not user objects and cannot be dropped alone.
 */
const NOT_INTERNAL = (catalog: string, alias: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
    WHERE d.classid = '${catalog}'::regclass AND d.objid = ${alias}.oid AND d.deptype = 'i')`

const DATABASES_SQL = `SELECT d.datname AS name, d.datistemplate AS is_template,
  CASE WHEN has_database_privilege(d.oid, 'CONNECT') THEN pg_database_size(d.oid)::float8 END AS size
FROM pg_catalog.pg_database d
WHERE d.datallowconn AND (NOT d.datistemplate OR $1)
ORDER BY d.datname`

export async function listDatabases(q: Queryable, showSystem: boolean): Promise<DatabaseInfo[]> {
  const rows = await select(q, DATABASES_SQL, [showSystem])
  return rows.map((row) => ({
    name: str(row, 'name'),
    isSystem: bool(row, 'is_template'),
    sizeBytes: optNum(row, 'size'),
  }))
}

const SCHEMAS_SQL = `SELECT n.nspname AS name, pg_catalog.pg_get_userbyid(n.nspowner) AS owner
FROM pg_catalog.pg_namespace n ORDER BY n.nspname`

export async function listSchemas(q: Queryable, showSystem: boolean): Promise<SchemaInfo[]> {
  const rows = await select(q, SCHEMAS_SQL)
  return rows
    .map((row) => {
      const name = str(row, 'name')
      return { name, isSystem: isSystemSchema(name), owner: optStr(row, 'owner') }
    })
    .filter((schema) => showSystem || !schema.isSystem)
    .sort((a, b) => Number(a.isSystem) - Number(b.isSystem) || compareText(a.name, b.name))
}

const RELATIONS_SQL = `SELECT c.oid::int8::text AS identity, c.relname AS name, c.relkind AS relkind,
  pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
  CASE WHEN c.relkind IN ('r', 'm', 'f') AND c.reltuples >= 0 THEN c.reltuples::float8 END AS row_estimate
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND NOT c.relispartition
  AND (c.relkind <> 'S' OR ${NOT_INTERNAL('pg_catalog.pg_class', 'c')})`

const ROUTINES_SQL = `SELECT p.oid::int8::text AS identity, p.proname AS name, p.prokind AS prokind,
  pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
  CASE WHEN p.prokind = 'f' THEN pg_catalog.pg_get_function_result(p.oid) END AS result,
  pg_catalog.obj_description(p.oid, 'pg_proc') AS comment
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_proc', 'p')}
  AND ${NOT_INTERNAL('pg_catalog.pg_proc', 'p')}`

const TYPES_SQL = `SELECT t.oid::int8::text AS identity, t.typname AS name,
  pg_catalog.obj_description(t.oid, 'pg_type') AS comment
FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = $1
  AND (t.typtype IN ('e', 'd', 'r')
    OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c')))
  AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_type', 't')}`

export async function listObjects(q: Queryable, schema: string): Promise<DbObjectInfo[]> {
  const [relations, routines, types] = await Promise.all([
    select(q, RELATIONS_SQL, [schema]),
    select(q, ROUTINES_SQL, [schema]),
    select(q, TYPES_SQL, [schema]),
  ])
  const objects: DbObjectInfo[] = []
  for (const row of relations) {
    const kind = RELKIND_TO_KIND[str(row, 'relkind')]
    if (!kind) continue
    objects.push({
      schema,
      name: str(row, 'name'),
      kind,
      comment: optStr(row, 'comment'),
      rowEstimate: optNum(row, 'row_estimate'),
      identity: str(row, 'identity'),
    })
  }
  for (const row of routines) {
    objects.push({
      schema,
      name: str(row, 'name'),
      kind: str(row, 'prokind') === 'p' ? 'procedure' : 'function',
      comment: optStr(row, 'comment'),
      signature: `(${str(row, 'args')})`,
      returnType: optStr(row, 'result'),
      identity: str(row, 'identity'),
    })
  }
  for (const row of types) {
    objects.push({ schema, name: str(row, 'name'), kind: 'type', comment: optStr(row, 'comment'), identity: str(row, 'identity') })
  }
  return objects.sort(compareObjects)
}

const SCHEMA_FILTER = (alias: string) => `($1 OR ${alias}.nspname NOT IN ('pg_catalog', 'information_schema'))
    AND ${alias}.nspname NOT LIKE 'pg\\_toast%' AND ${alias}.nspname NOT LIKE 'pg\\_temp\\_%'`

const COMPLETION_SQL = `WITH rels AS (
  SELECT n.nspname AS s, c.relname AS o, c.relkind AS k,
    (SELECT json_agg(json_build_array(a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum)
       FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS cols
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND NOT c.relispartition AND ${SCHEMA_FILTER('n')}
    AND (c.relkind <> 'S' OR ${NOT_INTERNAL('pg_catalog.pg_class', 'c')})
), routines AS (
  SELECT n.nspname AS s, p.proname AS o, p.prokind AS k, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prokind IN ('f', 'p') AND ${SCHEMA_FILTER('n')} AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_proc', 'p')}
    AND ${NOT_INTERNAL('pg_catalog.pg_proc', 'p')}
), schemas AS (
  SELECT n.nspname AS s FROM pg_catalog.pg_namespace n WHERE ${SCHEMA_FILTER('n')}
)
SELECT coalesce(current_schema(), 'public') AS default_schema,
  (SELECT coalesce(json_agg(s ORDER BY s), '[]') FROM schemas) AS schemas,
  (SELECT coalesce(json_agg(json_build_array(s, o, k, cols) ORDER BY s, o), '[]') FROM rels) AS rels,
  (SELECT coalesce(json_agg(json_build_array(s, o, k, args) ORDER BY s, o), '[]') FROM routines) AS routines`

function tuples(value: unknown): unknown[][] {
  return Array.isArray(value) ? value.filter((item): item is unknown[] => Array.isArray(item)) : []
}

export async function completionCatalog(q: Queryable, database: string, showSystem: boolean): Promise<CompletionCatalog> {
  const [row] = await select(q, COMPLETION_SQL, [showSystem])
  const bySchema = new Map<string, CompletionObject[]>()
  const schemaNames = row ? jsonValue(row, 'schemas') : []
  if (Array.isArray(schemaNames)) for (const name of schemaNames) bySchema.set(String(name), [])
  const objectsOf = (schema: string): CompletionObject[] => {
    let list = bySchema.get(schema)
    if (!list) {
      list = []
      bySchema.set(schema, list)
    }
    return list
  }
  for (const [s, o, k, cols] of tuples(row ? jsonValue(row, 'rels') : [])) {
    const kind = RELKIND_TO_KIND[String(k)]
    if (!kind) continue
    const object: CompletionObject = { name: String(o), kind }
    if (kind !== 'sequence') {
      object.columns = tuples(cols).map(([name, dataType]) => ({ name: String(name), dataType: String(dataType) }))
    }
    objectsOf(String(s)).push(object)
  }
  for (const [s, o, k, args] of tuples(row ? jsonValue(row, 'routines') : [])) {
    objectsOf(String(s)).push({ name: String(o), kind: k === 'p' ? 'procedure' : 'function', signature: `(${String(args)})` })
  }
  const schemas: CompletionSchema[] = [...bySchema.entries()].map(([name, objects]) => ({ name, objects }))
  return { database, defaultSchema: row ? str(row, 'default_schema') : 'public', schemas }
}
