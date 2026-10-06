// DDL reconstruction. Callers run these queries with search_path = pg_catalog so every
// server-side deparser (format_type, pg_get_expr, pg_get_*def) schema-qualifies user objects.
import { qualifiedName, quoteIdent, sqlLiteral } from '@shared/sql'
import type { ObjectKind } from '@shared/types'
import { DriverError } from '../errors'
import { findRelation, type RelationRef } from './details'
import { jsonValue, num, optStr, select, str, stringList, type Queryable, type Row } from './rows'

const q = (name: string) => quoteIdent(name, 'postgres')
const qn = (schema: string, name: string) => qualifiedName(schema, name, 'postgres')
const lit = (value: string) => sqlLiteral(value, 'postgres')

const INDENT = '    '

const DDL_COLUMNS_SQL = `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
  a.atttypid AS type_oid, a.attnotnull AS not_null, a.attidentity AS identity, a.attgenerated AS generated,
  pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
  CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN
    (SELECT pg_catalog.quote_ident(cn.nspname) || '.' || pg_catalog.quote_ident(co.collname)
       FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
      WHERE co.oid = a.attcollation) END AS collation,
  pg_catalog.pg_get_serial_sequence(a.attrelid::regclass::text, a.attname) AS serial_sequence,
  CASE WHEN a.attidentity <> '' THEN (
    SELECT json_build_object('start', s.seqstart::text, 'increment', s.seqincrement::text, 'min', s.seqmin::text,
      'max', s.seqmax::text, 'cache', s.seqcache::text, 'cycle', s.seqcycle)
      FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_sequence s ON s.seqrelid = d.objid
     WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.refclassid = 'pg_catalog.pg_class'::regclass
       AND d.refobjid = a.attrelid AND d.refobjsubid = a.attnum AND d.deptype = 'i'
     LIMIT 1) END AS identity_options,
  pg_catalog.col_description(a.attrelid, a.attnum) AS comment
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped AND (a.attislocal OR NOT $2)
ORDER BY a.attnum`

const TABLE_INFO_SQL = `SELECT c.relpersistence AS persistence, c.relispartition AS is_partition,
  c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security,
  CASE WHEN c.reloftype <> 0 THEN pg_catalog.format_type(c.reloftype, NULL) END AS of_type,
  CASE WHEN c.relkind = 'p' THEN pg_catalog.pg_get_partkeydef(c.oid) END AS partition_key,
  array_to_string(c.reloptions, ', ') AS options,
  ft.srvname AS server,
  (SELECT string_agg(pg_catalog.quote_ident(o.option_name) || ' ' || pg_catalog.quote_literal(o.option_value), ', ')
     FROM pg_catalog.pg_options_to_table(f.ftoptions) o) AS server_options
FROM pg_catalog.pg_class c
LEFT JOIN pg_catalog.pg_foreign_table f ON f.ftrelid = c.oid
LEFT JOIN pg_catalog.pg_foreign_server ft ON ft.oid = f.ftserver
WHERE c.oid = $1`

const DDL_CONSTRAINTS_SQL = `SELECT con.conname AS name, pg_catalog.pg_get_constraintdef(con.oid) AS definition,
  con.convalidated AS validated
FROM pg_catalog.pg_constraint con
WHERE con.conrelid = $1 AND con.contype IN ('p', 'u', 'c', 'x', 'f') AND con.conislocal AND con.conparentid = 0
ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'x' THEN 3 ELSE 4 END, con.conname`

// Indexes attached to an index of the parent (pg_inherits) are created with the partition itself.
const DDL_INDEXES_SQL = `SELECT pg_catalog.pg_get_indexdef(i.indexrelid) AS definition
FROM pg_catalog.pg_index i
JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
WHERE i.indrelid = $1
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con
    WHERE con.conindid = i.indexrelid AND con.conrelid = i.indrelid AND con.contype IN ('p', 'u', 'x'))
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits ii WHERE ii.inhrelid = i.indexrelid)
ORDER BY ic.relname`

const DDL_TRIGGERS_SQL = `SELECT t.tgname AS name, t.tgenabled AS enabled, pg_catalog.pg_get_triggerdef(t.oid) AS definition
FROM pg_catalog.pg_trigger t
WHERE t.tgrelid = $1 AND NOT t.tgisinternal AND t.tgparentid = 0
ORDER BY t.tgname`

/** Every partition below a partitioned table, at any depth (sub-partitions included). */
const PARTITIONS_SQL = `SELECT c.oid AS oid, n.nspname AS schema, c.relname AS name, c.relkind AS relkind,
  t.parentrelid::oid AS parent_oid,
  pg_catalog.pg_get_expr(c.relpartbound, c.oid) AS bound,
  CASE WHEN c.relkind = 'p' THEN pg_catalog.pg_get_partkeydef(c.oid) END AS partition_key,
  pg_catalog.obj_description(c.oid, 'pg_class') AS comment
FROM pg_catalog.pg_partition_tree($1::oid::regclass) t
JOIN pg_catalog.pg_class c ON c.oid = t.relid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE t.level > 0
ORDER BY n.nspname, c.relname`

/** Parents of a table created with INHERITS (not partitions), in declaration order. */
const INHERITS_SQL = `SELECT n.nspname AS schema, p.relname AS name
FROM pg_catalog.pg_inherits i
JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
JOIN pg_catalog.pg_namespace n ON n.oid = p.relnamespace
WHERE i.inhrelid = $1
ORDER BY i.inhseqno`

const POLICIES_SQL = `SELECT pol.polname AS name, pol.polpermissive AS permissive, pol.polcmd AS cmd,
  CASE WHEN 0 = ANY (pol.polroles) THEN NULL ELSE
    (SELECT string_agg(pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(r.oid)), ', ' ORDER BY r.ord)
       FROM unnest(pol.polroles) WITH ORDINALITY AS r(oid, ord)) END AS roles,
  pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,
  pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr
FROM pg_catalog.pg_policy pol
WHERE pol.polrelid = $1
ORDER BY pol.polname`

const PARENT_SQL = `SELECT n.nspname AS schema, p.relname AS name, pg_catalog.pg_get_expr(c.relpartbound, c.oid) AS bound
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid
JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
JOIN pg_catalog.pg_namespace n ON n.oid = p.relnamespace
WHERE c.oid = $1`

const INTEGER_SERIALS: Record<number, string> = { 21: 'smallserial', 23: 'serial', 20: 'bigserial' }

/** Bounds of the integer types an identity sequence can have (by column type OID). */
const INTEGER_BOUNDS: Record<number, { min: bigint; max: bigint }> = {
  21: { min: -(2n ** 15n), max: 2n ** 15n - 1n },
  23: { min: -(2n ** 31n), max: 2n ** 31n - 1n },
  20: { min: -(2n ** 63n), max: 2n ** 63n - 1n },
}

function bigintOf(value: unknown): bigint | null {
  try {
    return typeof value === 'string' || typeof value === 'number' ? BigInt(value) : null
  } catch {
    return null
  }
}

/** "(START WITH 100 INCREMENT BY 5)" for the identity sequence options that differ from the defaults. */
export function identityOptions(options: unknown, typeOid: number): string {
  if (typeof options !== 'object' || options === null) return ''
  const o = options as Record<string, unknown>
  const increment = bigintOf(o.increment) ?? 1n
  const min = bigintOf(o.min)
  const max = bigintOf(o.max)
  const start = bigintOf(o.start)
  const cache = bigintOf(o.cache) ?? 1n
  const bounds = INTEGER_BOUNDS[typeOid] ?? INTEGER_BOUNDS[20]
  if (!bounds) return ''
  const ascending = increment > 0n
  const defaultMin = ascending ? 1n : bounds.min
  const defaultMax = ascending ? bounds.max : -1n
  const parts: string[] = []
  // START defaults to MINVALUE (ascending) or MAXVALUE (descending), whatever they were set to.
  if (start !== null && start !== (ascending ? (min ?? defaultMin) : (max ?? defaultMax))) parts.push(`START WITH ${start}`)
  if (increment !== 1n) parts.push(`INCREMENT BY ${increment}`)
  if (min !== null && min !== defaultMin) parts.push(`MINVALUE ${min}`)
  if (max !== null && max !== defaultMax) parts.push(`MAXVALUE ${max}`)
  if (cache !== 1n) parts.push(`CACHE ${cache}`)
  if (o.cycle === true) parts.push('CYCLE')
  return parts.length > 0 ? ` (${parts.join(' ')})` : ''
}

function columnDefinition(row: Row, forForeignTable: boolean): string {
  const parts = [q(str(row, 'name'))]
  const defaultExpr = optStr(row, 'default_expr')
  const identity = str(row, 'identity')
  const generated = str(row, 'generated')
  const serialSequence = optStr(row, 'serial_sequence')
  const serialType = INTEGER_SERIALS[num(row, 'type_oid')]
  const isSerial =
    !forForeignTable &&
    identity === '' &&
    serialType !== undefined &&
    serialSequence !== undefined &&
    defaultExpr === `nextval(${lit(serialSequence)}::regclass)`

  parts.push(isSerial && serialType ? serialType : str(row, 'data_type'))
  const collation = optStr(row, 'collation')
  if (collation) parts.push(`COLLATE ${collation}`)
  if (identity === 'a' || identity === 'd') {
    const options = identityOptions(jsonValue(row, 'identity_options'), num(row, 'type_oid'))
    parts.push(`GENERATED ${identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY${options}`)
  }
  else if (generated !== '' && defaultExpr !== undefined) {
    parts.push(`GENERATED ALWAYS AS (${defaultExpr}) ${generated === 'v' ? 'VIRTUAL' : 'STORED'}`)
  } else if (defaultExpr !== undefined && !isSerial) parts.push(`DEFAULT ${defaultExpr}`)
  if (row.not_null === true && identity === '') parts.push('NOT NULL')
  return parts.join(' ')
}

function commentStatements(kindKeyword: string, target: string, comment: string | undefined): string[] {
  return comment === undefined ? [] : [`COMMENT ON ${kindKeyword} ${target} IS ${lit(comment)};`]
}

async function columnComments(db: Queryable, oid: number, target: string): Promise<string[]> {
  const rows = await select(db, DDL_COLUMNS_SQL, [oid, false])
  return rows.flatMap((row) => commentStatements('COLUMN', `${target}.${q(str(row, 'name'))}`, optStr(row, 'comment')))
}

async function indexStatements(db: Queryable, oid: number, partitioned: boolean): Promise<string[]> {
  const rows = await select(db, DDL_INDEXES_SQL, [oid])
  // Indexes on a partitioned table deparse as "ON ONLY", which would not cascade to partitions.
  return rows.map((row) => {
    const definition = str(row, 'definition')
    return `${partitioned ? definition.replace(' ON ONLY ', ' ON ') : definition};`
  })
}

const POLICY_COMMANDS: Record<string, string> = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE' }

/** ENABLE / FORCE ROW LEVEL SECURITY and one CREATE POLICY per policy. */
async function rowSecurityStatements(db: Queryable, oid: number, target: string, info: Row | undefined): Promise<string[]> {
  const statements: string[] = []
  if (info?.row_security === true) statements.push(`ALTER TABLE ${target} ENABLE ROW LEVEL SECURITY;`)
  if (info?.force_row_security === true) statements.push(`ALTER TABLE ${target} FORCE ROW LEVEL SECURITY;`)
  for (const row of await select(db, POLICIES_SQL, [oid])) {
    let policy = `CREATE POLICY ${q(str(row, 'name'))} ON ${target}`
    if (row.permissive === false) policy += ' AS RESTRICTIVE'
    const command = POLICY_COMMANDS[str(row, 'cmd')]
    if (command) policy += ` FOR ${command}`
    const roles = optStr(row, 'roles')
    if (roles) policy += ` TO ${roles}`
    const using = optStr(row, 'using_expr')
    if (using) policy += `\n${INDENT}USING (${using})`
    const check = optStr(row, 'check_expr')
    if (check) policy += `\n${INDENT}WITH CHECK (${check})`
    statements.push(`${policy};`)
  }
  return statements
}

/** Statements that follow a CREATE TABLE: indexes, unvalidated constraints, comments, triggers. */
async function tableExtras(
  db: Queryable,
  oid: number,
  target: string,
  options: { foreign: boolean; partitioned: boolean; comment: string | undefined; deferredConstraints: Row[]; columnRows: Row[] },
): Promise<string[]> {
  const statements: string[] = []
  // NOT VALID is ignored on constraints declared inside CREATE TABLE: add them afterwards.
  for (const row of options.deferredConstraints) {
    statements.push(`ALTER ${options.foreign ? 'FOREIGN TABLE' : 'TABLE'} ${target} ADD CONSTRAINT ${q(str(row, 'name'))} ${str(row, 'definition')};`)
  }
  if (!options.foreign) statements.push(...(await indexStatements(db, oid, options.partitioned)))
  statements.push(...commentStatements(options.foreign ? 'FOREIGN TABLE' : 'TABLE', target, options.comment))
  statements.push(
    ...options.columnRows.flatMap((row) => commentStatements('COLUMN', `${target}.${q(str(row, 'name'))}`, optStr(row, 'comment'))),
  )
  for (const row of await select(db, DDL_TRIGGERS_SQL, [oid])) {
    statements.push(`${str(row, 'definition')};`)
    if (str(row, 'enabled') === 'D') statements.push(`ALTER TABLE ${target} DISABLE TRIGGER ${q(str(row, 'name'))};`)
  }
  return statements
}

function splitConstraints(rows: Row[]): { inline: string[]; deferred: Row[] } {
  const inline: string[] = []
  const deferred: Row[] = []
  for (const row of rows) {
    if (row.validated === false) deferred.push(row)
    else inline.push(`CONSTRAINT ${q(str(row, 'name'))} ${str(row, 'definition')}`)
  }
  return { inline, deferred }
}

const body = (lines: string[]) => (lines.length > 0 ? ` (\n${lines.map((l) => INDENT + l).join(',\n')}\n)` : '')

/**
 * The partitions below a partitioned table, depth first (each partition right after its parent): a
 * CREATE TABLE … PARTITION OF per partition, followed by what is local to it (constraints, indexes, triggers).
 */
async function partitionStatements(db: Queryable, rootOid: number, rootTarget: string): Promise<string[]> {
  const rows = await select(db, PARTITIONS_SQL, [rootOid])
  const children = new Map<number, Row[]>()
  for (const row of rows) {
    const parent = num(row, 'parent_oid')
    const list = children.get(parent) ?? []
    list.push(row)
    children.set(parent, list)
  }
  const statements: string[] = []
  const visit = async (parentOid: number, parentTarget: string): Promise<void> => {
    for (const part of children.get(parentOid) ?? []) {
      const oid = num(part, 'oid')
      const target = qn(str(part, 'schema'), str(part, 'name'))
      const partitioned = str(part, 'relkind') === 'p'
      const { inline, deferred } = splitConstraints(await select(db, DDL_CONSTRAINTS_SQL, [oid]))
      const key = optStr(part, 'partition_key')
      statements.push(
        `CREATE TABLE ${target} PARTITION OF ${parentTarget}${body(inline)}\n${INDENT}${str(part, 'bound')}${key ? `\nPARTITION BY ${key}` : ''};`,
      )
      statements.push(
        ...(await tableExtras(db, oid, target, {
          foreign: str(part, 'relkind') === 'f',
          partitioned,
          comment: optStr(part, 'comment'),
          deferredConstraints: deferred,
          columnRows: [],
        })),
      )
      if (partitioned) await visit(oid, target)
    }
  }
  await visit(rootOid, rootTarget)
  return statements
}

/** Column line of a typed table: only the options added to the type's column (WITH OPTIONS …). */
function typedColumnDefinition(row: Row): string | null {
  const parts: string[] = []
  const defaultExpr = optStr(row, 'default_expr')
  if (defaultExpr !== undefined) parts.push(`DEFAULT ${defaultExpr}`)
  if (row.not_null === true) parts.push('NOT NULL')
  return parts.length > 0 ? `${q(str(row, 'name'))} WITH OPTIONS ${parts.join(' ')}` : null
}

async function tableDdl(db: Queryable, schema: string, name: string, relation: RelationRef): Promise<string> {
  const target = qn(schema, name)
  const foreign = relation.relkind === 'f'
  const partitioned = relation.relkind === 'p'
  // One client: queries run sequentially (pg deprecates overlapping client.query calls).
  const [info] = await select(db, TABLE_INFO_SQL, [relation.oid])
  const isPartition = info?.is_partition === true
  const parents = isPartition ? [] : await select(db, INHERITS_SQL, [relation.oid])
  const ofType = info ? optStr(info, 'of_type') : undefined
  const { inline, deferred } = splitConstraints(await select(db, DDL_CONSTRAINTS_SQL, [relation.oid]))
  // Partitions and inheritance children only declare their own columns; the rest comes from the parent.
  const columnRows = await select(db, DDL_COLUMNS_SQL, [relation.oid, isPartition || parents.length > 0])
  const statements: string[] = []

  const columnLines = ofType
    ? columnRows.flatMap((row) => typedColumnDefinition(row) ?? [])
    : columnRows.map((row) => columnDefinition(row, foreign))
  const lines = [...columnLines, ...inline]
  const unlogged = info && str(info, 'persistence') === 'u' ? 'UNLOGGED ' : ''
  let create: string
  if (isPartition) {
    const [parent] = await select(db, PARENT_SQL, [relation.oid])
    create = `CREATE ${unlogged}TABLE ${target} PARTITION OF ${parent ? qn(str(parent, 'schema'), str(parent, 'name')) : '?'}${body(lines)}\n${INDENT}${parent ? str(parent, 'bound') : ''}`
  } else if (ofType) {
    create = `CREATE ${unlogged}TABLE ${target} OF ${ofType}${body(lines)}`
  } else {
    create = `CREATE ${unlogged}${foreign ? 'FOREIGN ' : ''}TABLE ${target} (\n${lines.map((l) => INDENT + l).join(',\n')}\n)`
    if (parents.length > 0) create += `\nINHERITS (${parents.map((p) => qn(str(p, 'schema'), str(p, 'name'))).join(', ')})`
  }
  const partitionKey = info ? optStr(info, 'partition_key') : undefined
  if (partitionKey) create += `\nPARTITION BY ${partitionKey}`
  const server = info ? optStr(info, 'server') : undefined
  if (foreign && server) {
    create += `\nSERVER ${q(server)}`
    const serverOptions = info ? optStr(info, 'server_options') : undefined
    if (serverOptions) create += `\nOPTIONS (${serverOptions})`
  }
  const options = info ? optStr(info, 'options') : undefined
  if (options) create += `\nWITH (${options})`
  statements.push(`${create};`)

  if (partitioned) statements.push(...(await partitionStatements(db, relation.oid, target)))
  statements.push(
    ...(await tableExtras(db, relation.oid, target, {
      foreign,
      partitioned,
      comment: relation.comment,
      deferredConstraints: deferred,
      columnRows,
    })),
  )
  statements.push(...(await rowSecurityStatements(db, relation.oid, target, info)))
  return statements.join('\n\n')
}

const VIEW_SQL = `SELECT pg_catalog.pg_get_viewdef(c.oid, true) AS definition, array_to_string(c.reloptions, ', ') AS options,
  c.relispopulated AS populated
FROM pg_catalog.pg_class c WHERE c.oid = $1`

function viewBody(definition: string): string {
  return definition.trim().replace(/;\s*$/, '')
}

async function viewDdl(db: Queryable, schema: string, name: string, relation: RelationRef): Promise<string> {
  const target = qn(schema, name)
  const [row] = await select(db, VIEW_SQL, [relation.oid])
  if (!row) throw DriverError.of('not-found', `View ${schema}.${name} does not exist`)
  const options = optStr(row, 'options')
  const body = viewBody(str(row, 'definition'))
  const statements: string[] = []
  if (relation.relkind === 'm') {
    statements.push(
      `CREATE MATERIALIZED VIEW ${target}${options ? ` WITH (${options})` : ''} AS\n${body}\nWITH ${row.populated === true ? '' : 'NO '}DATA;`,
    )
    statements.push(...(await indexStatements(db, relation.oid, false)))
    statements.push(...commentStatements('MATERIALIZED VIEW', target, relation.comment))
  } else {
    statements.push(`CREATE OR REPLACE VIEW ${target}${options ? ` WITH (${options})` : ''} AS\n${body};`)
    statements.push(...commentStatements('VIEW', target, relation.comment))
  }
  statements.push(...(await columnComments(db, relation.oid, target)))
  return statements.join('\n\n')
}

const SEQUENCE_SQL = `SELECT pg_catalog.format_type(s.seqtypid, NULL) AS data_type, s.seqstart::text AS start_value,
  s.seqincrement::text AS increment, s.seqmin::text AS min_value, s.seqmax::text AS max_value,
  s.seqcache::text AS cache, s.seqcycle AS cycle,
  (SELECT pg_catalog.quote_ident(tn.nspname) || '.' || pg_catalog.quote_ident(t.relname) || '.' || pg_catalog.quote_ident(a.attname)
     FROM pg_catalog.pg_depend d
     JOIN pg_catalog.pg_class t ON t.oid = d.refobjid
     JOIN pg_catalog.pg_namespace tn ON tn.oid = t.relnamespace
     JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
    WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = s.seqrelid AND d.deptype = 'a'
      AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjsubid > 0
    LIMIT 1) AS owned_by
FROM pg_catalog.pg_sequence s WHERE s.seqrelid = $1`

async function sequenceDdl(db: Queryable, schema: string, name: string, relation: RelationRef): Promise<string> {
  const target = qn(schema, name)
  const [row] = await select(db, SEQUENCE_SQL, [relation.oid])
  if (!row) throw DriverError.of('not-found', `Sequence ${schema}.${name} does not exist`)
  const lines = [
    `CREATE SEQUENCE ${target}`,
    `AS ${str(row, 'data_type')}`,
    `INCREMENT BY ${str(row, 'increment')}`,
    `MINVALUE ${str(row, 'min_value')}`,
    `MAXVALUE ${str(row, 'max_value')}`,
    `START WITH ${str(row, 'start_value')}`,
    `CACHE ${str(row, 'cache')}`,
    row.cycle === true ? 'CYCLE' : 'NO CYCLE',
  ]
  const statements = [`${lines.join(`\n${INDENT}`)};`]
  const ownedBy = optStr(row, 'owned_by')
  if (ownedBy) statements.push(`ALTER SEQUENCE ${target} OWNED BY ${ownedBy};`)
  statements.push(...commentStatements('SEQUENCE', target, relation.comment))
  return statements.join('\n\n')
}

const ROUTINE_BY_OID_SQL = `SELECT p.oid AS oid, pg_catalog.pg_get_functiondef(p.oid) AS definition, p.prokind AS prokind,
  pg_catalog.pg_get_function_identity_arguments(p.oid) AS args, pg_catalog.obj_description(p.oid, 'pg_proc') AS comment
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE p.oid = $1::oid AND n.nspname = $2 AND p.proname = $3 AND p.prokind IN ('f', 'p')`

const ROUTINE_BY_NAME_SQL = `SELECT p.oid AS oid, pg_catalog.pg_get_functiondef(p.oid) AS definition, p.prokind AS prokind,
  pg_catalog.pg_get_function_identity_arguments(p.oid) AS args, pg_catalog.obj_description(p.oid, 'pg_proc') AS comment
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = ANY($3::"char"[])
ORDER BY p.oid LIMIT 1`

async function routineDdl(db: Queryable, schema: string, name: string, kind: ObjectKind, identity?: string): Promise<string> {
  let row: Row | undefined
  if (identity && /^\d+$/.test(identity)) [row] = await select(db, ROUTINE_BY_OID_SQL, [identity, schema, name])
  if (!row) [row] = await select(db, ROUTINE_BY_NAME_SQL, [schema, name, kind === 'procedure' ? ['p'] : ['f', 'p']])
  if (!row) throw DriverError.of('not-found', `Routine ${schema}.${name} does not exist`)
  const statements = [`${str(row, 'definition').trim()};`]
  const keyword = str(row, 'prokind') === 'p' ? 'PROCEDURE' : 'FUNCTION'
  statements.push(...commentStatements(keyword, `${qn(schema, name)}(${str(row, 'args')})`, optStr(row, 'comment')))
  return statements.join('\n\n')
}

const TYPE_BY_OID_SQL = `SELECT t.oid AS oid, t.typtype AS typtype FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE t.oid = $1::oid AND n.nspname = $2 AND t.typname = $3`

const TYPE_BY_NAME_SQL = `SELECT t.oid AS oid, t.typtype AS typtype FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = $2`

const TYPE_DETAILS_SQL = `SELECT t.typtype AS typtype, t.typrelid AS relid, t.typnotnull AS not_null, t.typdefault AS default_value,
  pg_catalog.format_type(t.typbasetype, t.typtypmod) AS base_type,
  CASE WHEN t.typcollation <> 0 AND t.typcollation <> bt.typcollation THEN
    (SELECT pg_catalog.quote_ident(cn.nspname) || '.' || pg_catalog.quote_ident(co.collname)
       FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
      WHERE co.oid = t.typcollation) END AS collation,
  (SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid) AS labels,
  (SELECT json_build_object(
      'subtype', pg_catalog.format_type(r.rngsubtype, NULL),
      'opclass', CASE WHEN NOT opc.opcdefault THEN pg_catalog.quote_ident(opcn.nspname) || '.' || pg_catalog.quote_ident(opc.opcname) END,
      'collation', CASE WHEN r.rngcollation <> 0 AND r.rngcollation <> st.typcollation THEN
        (SELECT pg_catalog.quote_ident(cn.nspname) || '.' || pg_catalog.quote_ident(co.collname)
           FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
          WHERE co.oid = r.rngcollation) END,
      'canonical', CASE WHEN r.rngcanonical <> 0 THEN r.rngcanonical::regproc::text END,
      'subtype_diff', CASE WHEN r.rngsubdiff <> 0 THEN r.rngsubdiff::regproc::text END,
      -- rngmultitypid exists from PostgreSQL 14 on: read through to_jsonb so older servers parse the query.
      'multirange', (SELECT pg_catalog.quote_ident(mn.nspname) || '.' || pg_catalog.quote_ident(mt.typname)
           FROM pg_catalog.pg_type mt JOIN pg_catalog.pg_namespace mn ON mn.oid = mt.typnamespace
          WHERE mt.oid = (to_jsonb(r) ->> 'rngmultitypid')::oid),
      'multirange_name', (SELECT mt.typname FROM pg_catalog.pg_type mt WHERE mt.oid = (to_jsonb(r) ->> 'rngmultitypid')::oid),
      'multirange_same_schema', (SELECT mt.typnamespace = t.typnamespace FROM pg_catalog.pg_type mt
          WHERE mt.oid = (to_jsonb(r) ->> 'rngmultitypid')::oid))
     FROM pg_catalog.pg_range r
     JOIN pg_catalog.pg_type st ON st.oid = r.rngsubtype
     JOIN pg_catalog.pg_opclass opc ON opc.oid = r.rngsubopc
     JOIN pg_catalog.pg_namespace opcn ON opcn.oid = opc.opcnamespace
    WHERE r.rngtypid = t.oid) AS range_info,
  pg_catalog.obj_description(t.oid, 'pg_type') AS comment
FROM pg_catalog.pg_type t
LEFT JOIN pg_catalog.pg_type bt ON bt.oid = t.typbasetype
WHERE t.oid = $1`

const DOMAIN_CONSTRAINTS_SQL = `SELECT con.conname AS name, pg_catalog.pg_get_constraintdef(con.oid) AS definition
FROM pg_catalog.pg_constraint con WHERE con.contypid = $1 AND con.contype = 'c' ORDER BY con.conname`

const COMPOSITE_ATTRIBUTES_SQL = `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type
FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`

/** Default multirange name PostgreSQL derives from a range name ("floatrange" → "floatmultirange", "fr" → "fr_multirange"). */
export function defaultMultirangeName(rangeName: string): string {
  const at = rangeName.indexOf('range')
  return at === -1 ? `${rangeName}_multirange` : `${rangeName.slice(0, at)}multi${rangeName.slice(at)}`
}

/** CREATE TYPE … AS RANGE options: SUBTYPE, then every option that differs from its default. */
export function rangeOptions(info: unknown, rangeName: string): string[] {
  const r = typeof info === 'object' && info !== null ? (info as Record<string, unknown>) : {}
  const text = (key: string) => (typeof r[key] === 'string' && r[key] !== '' ? (r[key] as string) : undefined)
  const options = [`SUBTYPE = ${text('subtype') ?? '?'}`]
  const opclass = text('opclass')
  if (opclass) options.push(`SUBTYPE_OPCLASS = ${opclass}`)
  const collation = text('collation')
  if (collation) options.push(`COLLATION = ${collation}`)
  const canonical = text('canonical')
  if (canonical) options.push(`CANONICAL = ${canonical}`)
  const diff = text('subtype_diff')
  if (diff) options.push(`SUBTYPE_DIFF = ${diff}`)
  const multirange = text('multirange')
  if (multirange && (text('multirange_name') !== defaultMultirangeName(rangeName) || r.multirange_same_schema === false)) {
    options.push(`MULTIRANGE_TYPE_NAME = ${multirange}`)
  }
  return options
}

async function typeDdl(db: Queryable, schema: string, name: string, identity?: string): Promise<string> {
  let ref: Row | undefined
  if (identity && /^\d+$/.test(identity)) [ref] = await select(db, TYPE_BY_OID_SQL, [identity, schema, name])
  if (!ref) [ref] = await select(db, TYPE_BY_NAME_SQL, [schema, name])
  if (!ref) throw DriverError.of('not-found', `Type ${schema}.${name} does not exist`)
  const oid = num(ref, 'oid')
  const [row] = await select(db, TYPE_DETAILS_SQL, [oid])
  if (!row) throw DriverError.of('not-found', `Type ${schema}.${name} does not exist`)
  const target = qn(schema, name)
  const comment = optStr(row, 'comment')
  const typtype = str(row, 'typtype')

  switch (typtype) {
    case 'e': {
      const labels = stringList(row, 'labels').map(lit)
      return [
        `CREATE TYPE ${target} AS ENUM (\n${labels.map((l) => INDENT + l).join(',\n')}\n);`,
        ...commentStatements('TYPE', target, comment),
      ].join('\n\n')
    }
    case 'd': {
      const parts = [`CREATE DOMAIN ${target} AS ${str(row, 'base_type')}`]
      const collation = optStr(row, 'collation')
      if (collation) parts.push(`COLLATE ${collation}`)
      const defaultValue = optStr(row, 'default_value')
      if (defaultValue !== undefined) parts.push(`DEFAULT ${defaultValue}`)
      if (row.not_null === true) parts.push('NOT NULL')
      for (const con of await select(db, DOMAIN_CONSTRAINTS_SQL, [oid])) {
        parts.push(`CONSTRAINT ${q(str(con, 'name'))} ${str(con, 'definition')}`)
      }
      return [`${parts.join(`\n${INDENT}`)};`, ...commentStatements('DOMAIN', target, comment)].join('\n\n')
    }
    case 'c': {
      const attributes = await select(db, COMPOSITE_ATTRIBUTES_SQL, [num(row, 'relid')])
      const lines = attributes.map((a) => `${INDENT}${q(str(a, 'name'))} ${str(a, 'data_type')}`)
      return [`CREATE TYPE ${target} AS (\n${lines.join(',\n')}\n);`, ...commentStatements('TYPE', target, comment)].join(
        '\n\n',
      )
    }
    case 'r':
      return [
        `CREATE TYPE ${target} AS RANGE (\n${rangeOptions(jsonValue(row, 'range_info'), name)
          .map((o) => INDENT + o)
          .join(',\n')}\n);`,
        ...commentStatements('TYPE', target, comment),
      ].join('\n\n')
    default:
      throw DriverError.of('not-found', `DDL is not available for base type ${schema}.${name}`)
  }
}

const RELATION_KINDS: Partial<Record<ObjectKind, string[]>> = {
  table: ['r', 'p', 'f', 'v', 'm'],
  view: ['v', 'm', 'r', 'p', 'f'],
  'materialized-view': ['m', 'v', 'r', 'p', 'f'],
  'foreign-table': ['f', 'r', 'p', 'v', 'm'],
  sequence: ['S'],
}

export async function getDdl(db: Queryable, schema: string, name: string, kind: ObjectKind, identity?: string): Promise<string> {
  if (kind === 'function' || kind === 'procedure') return routineDdl(db, schema, name, kind, identity)
  if (kind === 'type') return typeDdl(db, schema, name, identity)
  const relation = await findRelation(db, schema, name, RELATION_KINDS[kind] ?? ['r'])
  switch (relation.relkind) {
    case 'v':
    case 'm':
      return viewDdl(db, schema, name, relation)
    case 'S':
      return sequenceDdl(db, schema, name, relation)
    default:
      return tableDdl(db, schema, name, relation)
  }
}
