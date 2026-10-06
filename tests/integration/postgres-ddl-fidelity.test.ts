// DDL fidelity and catalog listing defects (metadata provider).
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postgresDriver } from '../../src/main/db/postgres'
import type { MetadataProvider } from '../../src/main/db/types'
import { testPgConnection } from '../setup/postgres'
import { TEST_PG } from '../test-env'
import { adminClient } from './helpers/pg'

const DB = TEST_PG.database
const S = 'rv_ddl'

const FIXTURE = `
CREATE SCHEMA ${S};
CREATE TYPE ${S}.pair AS (x int, y text);
CREATE FUNCTION ${S}.f8diff(a float8, b float8) RETURNS float8 LANGUAGE sql IMMUTABLE AS 'SELECT a - b';
CREATE TYPE ${S}.fr AS RANGE (SUBTYPE = float8, SUBTYPE_DIFF = ${S}.f8diff);
CREATE TABLE ${S}.parent (id int GENERATED ALWAYS AS IDENTITY (START WITH 100 INCREMENT BY 5) PRIMARY KEY, note text);
CREATE TABLE ${S}.child (extra int) INHERITS (${S}.parent);
ALTER TABLE ${S}.child ADD CONSTRAINT child_extra CHECK (extra > 0) NOT VALID;
CREATE TABLE ${S}.typed OF ${S}.pair (PRIMARY KEY (x));
CREATE TABLE ${S}.secured (id int PRIMARY KEY, owner text);
ALTER TABLE ${S}.secured ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON ${S}.secured USING (owner = current_user);
CREATE TABLE ${S}.pl (k text, v int, d date) PARTITION BY LIST (k);
CREATE TABLE ${S}.pl_a PARTITION OF ${S}.pl FOR VALUES IN ('a') PARTITION BY RANGE (d);
CREATE TABLE ${S}.pl_a_2024 PARTITION OF ${S}.pl_a FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE ${S}.pl_def PARTITION OF ${S}.pl DEFAULT;
CREATE INDEX pl_def_v ON ${S}.pl_def (v);
INSERT INTO ${S}.pl SELECT 'a', g, date '2024-01-01' + g FROM generate_series(1, 300) g;
ANALYZE ${S}.pl_a_2024;
`

describe('pg review: DDL fidelity', () => {
  let admin: pg.Client
  let md: MetadataProvider
  const ddl = (name: string, kind: Parameters<MetadataProvider['getDdl']>[3] = 'table') => md.getDdl(DB, S, name, kind)

  beforeAll(async () => {
    admin = adminClient()
    await admin.connect()
    await admin.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; DROP SCHEMA IF EXISTS ${S}_copy CASCADE`)
    await admin.query(FIXTURE)
    md = await postgresDriver.openMetadata(testPgConnection())
  })
  afterAll(async () => {
    await md.close()
    await admin.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; DROP SCHEMA IF EXISTS ${S}_copy CASCADE`)
    await admin.end()
  })

  it('keeps table inheritance (INHERITS)', async () => {
    // Before the fix, the child comes out as a standalone table (inherited columns copied, no INHERITS clause).
    expect(await ddl('child')).toMatch(/INHERITS \(rv_ddl\.parent\)/)
  })

  it('keeps typed tables (OF type)', async () => {
    // Before the fix: a plain CREATE TABLE rv_ddl.typed (x integer NOT NULL, y text, ...).
    expect(await ddl('typed')).toMatch(/CREATE TABLE rv_ddl\.typed OF rv_ddl\.pair/)
  })

  it('keeps row level security and its policies', async () => {
    const text = await ddl('secured')
    expect(text).toContain('ENABLE ROW LEVEL SECURITY')
    expect(text).toMatch(/CREATE POLICY own_rows ON rv_ddl\.secured/)
  })

  it('keeps identity sequence options', async () => {
    const text = await ddl('parent')
    // Before the fix: "id integer GENERATED ALWAYS AS IDENTITY" — START WITH 100 INCREMENT BY 5 is lost.
    expect(text).toMatch(/GENERATED ALWAYS AS IDENTITY \(.*START WITH 100.*\)/s)
    expect(text).toMatch(/INCREMENT BY 5/)
  })

  it('a NOT VALID check constraint stays NOT VALID when the DDL is replayed', async () => {
    const copy = `${S}_copy`
    await admin.query(`CREATE SCHEMA ${copy}`)
    const moved = (text: string) => text.replace(/\brv_ddl\./g, `${copy}.`)
    await admin.query(moved(await ddl('parent')))
    await admin.query(moved(await ddl('child')))
    const { rows } = await admin.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'child_extra' AND connamespace = '${copy}'::regnamespace`,
    )
    // Before the fix: the constraint is emitted inline in CREATE TABLE, where NOT VALID is silently ignored.
    expect(rows).toEqual([{ convalidated: false }])
  })

  it('a partitioned table DDL includes sub-partitions and partition-local indexes', async () => {
    const text = await ddl('pl')
    expect(text).toContain('rv_ddl.pl_a_2024')
    expect(text).toContain('pl_def_v')
  })

  it('range type DDL keeps SUBTYPE_DIFF', async () => {
    expect(await ddl('fr', 'type')).toMatch(/SUBTYPE_DIFF = rv_ddl\.f8diff/)
  })

  it('does not list identity sequences or range constructor functions as user objects', async () => {
    const names = (await md.listObjects(DB, S)).map((o) => `${o.kind}:${o.name}`)
    // Before the fix: sequence:parent_id_seq, function:fr (x2) and function:fr_multirange (x3) are listed.
    expect(names).not.toContain('sequence:parent_id_seq')
    expect(names).not.toContain('function:fr')
    expect(names).not.toContain('function:fr_multirange')
  })

  it('size and row estimate of a multi-level partitioned table include sub-partitions', async () => {
    const details = await md.tableDetails(DB, S, 'pl')
    const { rows } = await admin.query(`SELECT pg_total_relation_size('${S}.pl_a_2024')::float8 AS size`)
    // Before the fix: rowEstimate 0 and only the direct partitions' size (pl_a is itself partitioned and empty).
    expect(details.rowEstimate).toBe(300)
    expect(details.sizeBytes ?? 0).toBeGreaterThanOrEqual(Number(rows[0]?.size))
  })
})
