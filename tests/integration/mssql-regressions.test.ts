// SQL Server driver regressions found in review: paging without held locks, multi-recordset batches,
// FOR JSON / XML, sql_variant / real values, row-count labels, message order, explain safety,
// table editor (HIDDEN / GENERATED ALWAYS columns, filter validation, variant / hierarchyid /
// datetime edits, triggers returning rows), faithful table DDL, synonyms and login errors.
// Every object is created in the rg / rg_copy schemas or as dbo.rg_* and dropped afterwards.
import sql from 'mssql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionConfig, TableRef } from '@shared/types'
import { DriverError } from '../../src/main/db/errors'
import { mssqlDriver } from '../../src/main/db/mssql'
import { resolveOptions } from '../../src/main/db/mssql/config'
import type { OrderedQueryMessage } from '../../src/main/db/mssql/session'
import { isAuthenticationError } from '../../src/main/db/session-manager'
import type { DriverSession, MetadataProvider } from '../../src/main/db/types'
import { TEST_MSSQL } from '../test-env'
import { mssqlTestConnection } from '../setup/mssql'

const only = process.env.DATAGRIPPE_TEST_DB
const suite = !only || only === 'mssql' ? describe : describe.skip
const DB = TEST_MSSQL.database
const ref = (schema: string, name: string): TableRef => ({ connectionId: 'mssql-test', database: DB, schema, name })

async function caught(promise: Promise<unknown>): Promise<DriverError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof DriverError) return error
    throw error
  }
  throw new Error('Expected the promise to reject')
}

async function adminPool(): Promise<sql.ConnectionPool> {
  const pool = new sql.ConnectionPool({
    server: TEST_MSSQL.host,
    port: TEST_MSSQL.port,
    user: TEST_MSSQL.user,
    password: TEST_MSSQL.password,
    database: DB,
    options: { encrypt: false, trustServerCertificate: true },
  })
  pool.on('error', () => undefined)
  await pool.connect()
  return pool
}

/** Drop the rg / rg_copy schemas and dbo.rg_* tables (system versioning off first). */
const CLEANUP = `
DECLARE @sql nvarchar(max) = N'';
SELECT @sql += N'ALTER TABLE ' + QUOTENAME(SCHEMA_NAME(schema_id)) + N'.' + QUOTENAME(name) + N' SET (SYSTEM_VERSIONING = OFF);'
FROM sys.tables WHERE temporal_type = 2 AND SCHEMA_NAME(schema_id) IN (N'rg', N'rg_copy');
SELECT @sql += N'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(parent_object_id)) + N'.' + QUOTENAME(OBJECT_NAME(parent_object_id)) +
  N' DROP CONSTRAINT ' + QUOTENAME(name) + N';'
FROM sys.foreign_keys WHERE OBJECT_SCHEMA_NAME(parent_object_id) IN (N'rg', N'rg_copy');
SELECT @sql += N'DROP ' + CASE type WHEN 'SN' THEN N'SYNONYM ' WHEN 'V' THEN N'VIEW ' WHEN 'P' THEN N'PROCEDURE ' ELSE N'TABLE ' END +
  QUOTENAME(SCHEMA_NAME(schema_id)) + N'.' + QUOTENAME(name) + N';'
FROM sys.objects WHERE type IN ('U', 'SN', 'V', 'P') AND (SCHEMA_NAME(schema_id) IN (N'rg', N'rg_copy') OR (schema_id = 1 AND name LIKE N'rg[_]%'));
EXEC (@sql);
IF SCHEMA_ID(N'rg_copy') IS NOT NULL EXEC (N'DROP SCHEMA rg_copy');
IF SCHEMA_ID(N'rg') IS NOT NULL EXEC (N'DROP SCHEMA rg');`

const SETUP = `CREATE SCHEMA rg
GO
CREATE SCHEMA rg_copy
GO
CREATE TABLE rg.temporal (
  id int NOT NULL CONSTRAINT PK_rg_temporal PRIMARY KEY,
  name nvarchar(50) NULL,
  valid_from datetime2 GENERATED ALWAYS AS ROW START HIDDEN NOT NULL,
  valid_to datetime2 GENERATED ALWAYS AS ROW END HIDDEN NOT NULL,
  note nvarchar(50) NULL,
  PERIOD FOR SYSTEM_TIME (valid_from, valid_to)
) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = rg.temporal_history))
GO
INSERT rg.temporal (id, name, note) VALUES (1, N'alpha', N'n1')
CREATE TABLE rg.victim (id int PRIMARY KEY)
INSERT rg.victim VALUES (1), (2)
CREATE TABLE rg.variant_tbl (id int PRIMARY KEY, sv sql_variant NULL)
INSERT rg.variant_tbl VALUES (1, 5)
CREATE TABLE rg.dt_tbl (id int PRIMARY KEY, dt datetime NULL)
INSERT rg.dt_tbl VALUES (1, '2024-01-15T10:11:12.997')
CREATE TABLE rg.tree (id int PRIMARY KEY, node hierarchyid NULL)
INSERT rg.tree VALUES (1, hierarchyid::Parse('/1/2/'))
CREATE TABLE rg.trg_tbl (id int PRIMARY KEY, v int NULL)
INSERT rg.trg_tbl VALUES (1, 1)
GO
CREATE TRIGGER rg.trg_debug ON rg.trg_tbl AFTER UPDATE AS SELECT 'debug' AS msg
GO
DISABLE TRIGGER rg.trg_debug ON rg.trg_tbl
GO
CREATE TABLE rg.parent (id int NOT NULL CONSTRAINT PK_rg_parent PRIMARY KEY NONCLUSTERED WITH (FILLFACTOR = 80),
  code char(3) COLLATE Latin1_General_CS_AS NOT NULL,
  rg uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT DF_rg_parent_rg DEFAULT NEWSEQUENTIALID(),
  seq int IDENTITY(5,2) NOT FOR REPLICATION NOT NULL,
  sp int SPARSE NULL,
  qty int NULL)
CREATE UNIQUE INDEX UX_rg_parent_rg ON rg.parent (rg) WITH (IGNORE_DUP_KEY = ON, ALLOW_PAGE_LOCKS = OFF)
ALTER TABLE rg.parent WITH NOCHECK ADD CONSTRAINT CK_rg_parent_qty CHECK (qty > 0)
ALTER TABLE rg.parent NOCHECK CONSTRAINT CK_rg_parent_qty
CREATE TABLE rg.child (id int CONSTRAINT PK_rg_child PRIMARY KEY, parent_id int NULL)
ALTER TABLE rg.child WITH NOCHECK ADD CONSTRAINT FK_rg_child_parent FOREIGN KEY (parent_id) REFERENCES rg.parent (id)
ALTER TABLE rg.child NOCHECK CONSTRAINT FK_rg_child_parent
CREATE INDEX IX_rg_child_parent ON rg.child (parent_id) WITH (DATA_COMPRESSION = PAGE)
CREATE SYNONYM rg.syn_victim FOR rg.victim
CREATE SYNONYM rg.syn_remote FOR other_server.some_db.dbo.t
GO`

/** Column / index / constraint properties that a faithful DDL must reproduce. */
const FINGERPRINT = `
SELECT p FROM (
SELECT CAST(t.name + '.' + c.name + '|' + ISNULL(c.collation_name, '') + '|' + CAST(c.is_sparse AS varchar) + '|' +
  CAST(c.is_rowguidcol AS varchar) + '|' + ISNULL(CAST(ic.is_not_for_replication AS varchar), '-') + '|' +
  CAST(c.generated_always_type AS varchar) + '|' + CAST(c.is_hidden AS varchar) AS nvarchar(400)) COLLATE DATABASE_DEFAULT AS p
FROM sys.tables t JOIN sys.columns c ON c.object_id = t.object_id
LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
WHERE t.schema_id = SCHEMA_ID(@s) AND t.name IN ('parent', 'child', 'temporal')
UNION ALL
SELECT CAST(t.name + '.' + i.name + '|' + CAST(i.ignore_dup_key AS varchar) + '|' + CAST(i.fill_factor AS varchar) + '|' +
  CAST(i.allow_page_locks AS varchar) + '|' + p.data_compression_desc AS nvarchar(400)) COLLATE DATABASE_DEFAULT
FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id
JOIN sys.partitions p ON p.object_id = i.object_id AND p.index_id = i.index_id
WHERE t.schema_id = SCHEMA_ID(@s) AND t.name IN ('parent', 'child', 'temporal') AND i.index_id > 0
UNION ALL
SELECT CAST('fk|' + CAST(is_disabled AS varchar) + CAST(is_not_trusted AS varchar) AS nvarchar(400)) COLLATE DATABASE_DEFAULT
FROM sys.foreign_keys WHERE schema_id = SCHEMA_ID(@s)
UNION ALL
SELECT CAST('ck|' + name + '|' + CAST(is_disabled AS varchar) + CAST(is_not_trusted AS varchar) AS nvarchar(400)) COLLATE DATABASE_DEFAULT
FROM sys.check_constraints WHERE schema_id = SCHEMA_ID(@s)
UNION ALL
SELECT CAST('temporal|' + name + '|' + CAST(temporal_type AS varchar) AS nvarchar(400)) COLLATE DATABASE_DEFAULT
FROM sys.tables WHERE schema_id = SCHEMA_ID(@s) AND temporal_type > 0
) x ORDER BY p`

suite('mssql regressions — session', () => {
  let session: DriverSession

  beforeAll(async () => {
    session = await mssqlDriver.openSession(mssqlTestConnection(), DB)
  })
  afterAll(async () => {
    await session?.execute(
      "IF OBJECT_ID(N'dbo.rg_explain_victim') IS NOT NULL DROP TABLE dbo.rg_explain_victim; IF OBJECT_ID(N'dbo.rg_paging') IS NOT NULL DROP TABLE dbo.rg_paging",
      { maxRows: 1 },
    )
    await session?.close()
  })

  it('returns every SELECT of a batch whose first SELECT exceeds maxRows, even without ";"', async () => {
    const { results } = await session.execute("SELECT TOP 20 id FROM dbo.events ORDER BY id\nSELECT 'second' AS x", { maxRows: 5 })
    expect(results.map((r) => [r.kind, r.rowCount, r.hasMore])).toEqual([
      ['rows', 5, true],
      ['rows', 1, false],
    ])
    expect(results[0]?.cursorId).toBeUndefined()
    expect(results[1]?.rows).toEqual([['second']])
  })

  it('reports the open transaction when a script ends with a paged SELECT', async () => {
    const { results } = await session.execute('BEGIN TRAN\nGO\nSELECT id FROM dbo.events', { maxRows: 5 })
    expect(results.at(-1)?.cursorId).toBeTypeOf('string')
    const state = session.transactionState()
    await session.rollback()
    expect(state).toEqual({ autoCommit: true, inTransaction: true })
  })

  it('keeps no request open on the server while a partial result is shown, and still loads more', async () => {
    const spid = (await session.execute('SELECT @@SPID AS spid', { maxRows: 1 })).results[0]?.rows[0]?.[0]
    const { results } = await session.execute('SELECT id FROM dbo.events ORDER BY id', { maxRows: 100 })
    const cursorId = results[0]?.cursorId ?? ''
    expect(cursorId).not.toBe('')
    const pool = await adminPool()
    try {
      const running = await pool.request().input('spid', sql.Int, spid).query('SELECT COUNT(*) AS n FROM sys.dm_exec_requests WHERE session_id = @spid')
      expect(running.recordset[0]?.n).toBe(0)
      // DDL from another session is not blocked by the result on screen.
      await pool.request().batch(`SET LOCK_TIMEOUT 3000;
        ALTER TABLE dbo.events ADD rg_extra int NULL;
        ALTER TABLE dbo.events DROP COLUMN rg_extra;`)
    } finally {
      await pool.close()
    }
    // A schema change is not a data change: the rows shown are still the same, the next page follows.
    const page = await session.fetchMore(cursorId, 50)
    expect(page.rows.map((r) => r[0])).toEqual(Array.from({ length: 50 }, (_, i) => i + 101))
    expect(page.hasMore).toBe(true)
  })

  it('refuses to continue a result whose rows already shown have changed', async () => {
    await session.execute(
      "IF OBJECT_ID(N'dbo.rg_paging') IS NOT NULL DROP TABLE dbo.rg_paging; CREATE TABLE dbo.rg_paging (id int PRIMARY KEY); INSERT dbo.rg_paging SELECT TOP (30) id FROM dbo.events ORDER BY id",
      { maxRows: 1 },
    )
    const { results } = await session.execute('SELECT id FROM dbo.rg_paging ORDER BY id', { maxRows: 10 })
    const cursorId = results[0]?.cursorId ?? ''
    const pool = await adminPool()
    try {
      // Rows added after the ones shown do not matter…
      await pool.request().batch('INSERT dbo.rg_paging VALUES (1000)')
      expect((await session.fetchMore(cursorId, 5)).rows.map((r) => r[0])).toEqual([11, 12, 13, 14, 15])
      // …but a row removed from the part already shown would shift the next page: refused.
      await pool.request().batch('DELETE FROM dbo.rg_paging WHERE id = 3')
    } finally {
      await pool.close()
    }
    const changed = await caught(session.fetchMore(cursorId, 5))
    expect(changed.info).toMatchObject({ kind: 'invalid-input' })
    expect(changed.info.message).toMatch(/result changed/)
    expect((await caught(session.fetchMore(cursorId, 5))).info.kind).toBe('not-found')
    await session.execute('DROP TABLE dbo.rg_paging', { maxRows: 1 })
  })

  it('does not roll back an XACT_ABORT transaction when paging a result', async () => {
    await session.execute('SET XACT_ABORT ON; BEGIN TRAN; CREATE TABLE #xa (i int); INSERT #xa VALUES (1)', { maxRows: 1 })
    const { results } = await session.execute('SELECT id FROM dbo.events ORDER BY id', { maxRows: 10 })
    expect(results[0]).toMatchObject({ rowCount: 10, hasMore: true })
    const page = await session.fetchMore(results[0]?.cursorId ?? '', 10)
    expect(page.rows[0]).toEqual([11])
    expect(session.transactionState().inTransaction).toBe(true)
    const { results: check } = await session.execute('SELECT @@TRANCOUNT AS tc, COUNT(*) AS n FROM #xa', { maxRows: 1 })
    expect(check[0]?.rows).toEqual([[1, 1]])
    await session.rollback()
    await session.execute("SET XACT_ABORT OFF; IF OBJECT_ID('tempdb..#xa') IS NOT NULL DROP TABLE #xa", { maxRows: 1 })
  })

  it('reports a fetchMore interrupted by cancel as cancelled and keeps the result loadable', async () => {
    // MAXDOP 1: a parallel plan returns an unordered CROSS JOIN in a different order on every run.
    const { results } = await session.execute('SELECT a.id, b.id AS id2 FROM dbo.events a CROSS JOIN dbo.events b OPTION (MAXDOP 1)', { maxRows: 10 })
    const cursorId = results[0]?.cursorId ?? ''
    const pending = session.fetchMore(cursorId, 100_000)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await session.cancel()
    let outcome: number | 'cancelled'
    try {
      outcome = (await pending).rows.length
    } catch (error) {
      outcome = error instanceof DriverError && error.info.kind === 'cancelled' ? 'cancelled' : -1
    }
    expect(outcome === 'cancelled' || outcome === 100_000).toBe(true)
    expect((await session.fetchMore(cursorId, 5)).rows).toHaveLength(5)
  })

  it('returns FOR JSON / FOR XML output as one value instead of 2033-character fragments', async () => {
    const json = await session.execute('SELECT TOP 200 id, kind, payload FROM dbo.events FOR JSON PATH', { maxRows: 2 })
    expect(json.results[0]?.rows).toHaveLength(1)
    expect(json.results[0]?.hasMore).toBe(false)
    expect(JSON.parse(String(json.results[0]?.rows[0]?.[0]))).toHaveLength(200)
    const xml = await session.execute('SELECT TOP 200 id, kind FROM dbo.events FOR XML PATH', { maxRows: 500 })
    expect(xml.results[0]?.rows).toHaveLength(1)
    expect(String(xml.results[0]?.rows[0]?.[0]).match(/<row>/g)).toHaveLength(200)
  })

  it('normalizes sql_variant values exactly, by their base type', async () => {
    const { results } = await session.execute(
      `SELECT CAST(CAST(12345678901234567890.1234567891 AS decimal(38,10)) AS sql_variant) AS d,
         CAST(CAST('2024-01-02 03:04:05.1234567' AS datetime2(7)) AS sql_variant) AS dt2,
         CAST(CAST('2024-01-02 03:04:05.1234567 +02:00' AS datetimeoffset(7)) AS sql_variant) AS dto,
         CAST(CAST('2024-01-02' AS date) AS sql_variant) AS dd,
         CAST(CAST('12:34:56.1234567' AS time(7)) AS sql_variant) AS tm,
         CAST(CAST('2024-01-02T03:04:05.997' AS datetime) AS sql_variant) AS dt,
         CAST(CAST('2024-01-02T03:04:00' AS smalldatetime) AS sql_variant) AS sdt,
         CAST(CAST(12.5 AS money) AS sql_variant) AS m,
         CAST(CAST(0.1 AS real) AS sql_variant) AS r,
         CAST(42 AS sql_variant) AS i, CAST(N'text' AS sql_variant) AS s`,
      { maxRows: 5 },
    )
    expect(results[0]?.rows[0]).toEqual([
      '12345678901234567890.1234567891',
      '2024-01-02 03:04:05.1234567',
      '2024-01-02 03:04:05.1234567 +02:00',
      '2024-01-02',
      '12:34:56.1234567',
      '2024-01-02 03:04:05.997',
      '2024-01-02 03:04:00',
      '12.5000',
      '0.1',
      '42',
      'text',
    ])
  })

  it('renders real values with float32 precision', async () => {
    const { results } = await session.execute('SELECT CAST(0.1 AS real) AS r, CAST(3.3 AS real) AS r2, CAST(0.1 AS float) AS f', { maxRows: 5 })
    expect(results[0]?.rows[0]).toEqual([0.1, 3.3, 0.1])
  })

  it('labels row counts with their own command when the batch also assigns variables', async () => {
    const { results } = await session.execute(
      'CREATE TABLE #l (i int); INSERT INTO #l VALUES (1); DECLARE @v int; SELECT @v = COUNT(*) FROM #l; UPDATE #l SET i = 2; DELETE FROM #l; DROP TABLE #l',
      { maxRows: 5 },
    )
    expect(results.map((r) => r.command)).toEqual(['INSERT', 'SELECT', 'UPDATE', 'DELETE'])
  })

  it('places each server message after the results that preceded it', async () => {
    const outcome = await session.execute("PRINT 'p1'; SELECT 1 AS a; PRINT 'p2'; SELECT 2 AS b; PRINT 'p3'\nGO\nPRINT 'p4'", { maxRows: 5 })
    const positions = (outcome.messages as OrderedQueryMessage[]).map((m) => [m.text, m.resultsBefore])
    expect(positions).toEqual([
      ['p1', 0],
      ['p2', 1],
      ['p3', 2],
      ['p4', 2],
    ])
    expect(outcome.results.map((r) => r.kind)).toEqual(['rows', 'rows', 'command'])
  })

  it('never executes statements during an estimated explain (SET SHOWPLAN_XML OFF batch)', async () => {
    await session.execute('CREATE TABLE dbo.rg_explain_victim (id int); INSERT dbo.rg_explain_victim VALUES (1), (2)', { maxRows: 1 })
    const scripts = [
      'SET SHOWPLAN_XML OFF\nGO\nDELETE FROM dbo.rg_explain_victim\nGO\nSELECT 1 FROM dbo.rg_explain_victim',
      'SET NOEXEC OFF; DELETE FROM dbo.rg_explain_victim',
      'set showplan_all, showplan_xml off\nGO\nDELETE FROM dbo.rg_explain_victim',
    ]
    for (const script of scripts) {
      const error = await caught(session.explain(script, false))
      expect(error.info.kind, script).toBe('invalid-input')
    }
    const { results } = await session.execute('SELECT COUNT(*) FROM dbo.rg_explain_victim', { maxRows: 1 })
    expect(results[0]?.rows).toEqual([[2]])
    // Names in strings / comments are fine.
    const plan = await session.explain("SELECT 'SET SHOWPLAN_XML OFF' AS s /* SET NOEXEC ON */", false)
    expect(plan.root).toBeDefined()
  })
})

suite('mssql regressions — metadata', () => {
  let meta: MetadataProvider
  let session: DriverSession

  beforeAll(async () => {
    meta = await mssqlDriver.openMetadata(mssqlTestConnection({ database: 'master' }))
    session = await mssqlDriver.openSession(mssqlTestConnection(), DB)
    await session.execute(CLEANUP, { maxRows: 1 })
    const { results } = await session.execute(SETUP, { maxRows: 1 })
    const errors = results.filter((r) => r.kind === 'error').map((r) => r.error?.message)
    if (errors.length > 0) throw new Error(`setup failed: ${errors.join('; ')}`)
  })
  afterAll(async () => {
    await session?.execute(CLEANUP, { maxRows: 1 })
    await session?.close()
    await meta?.close()
  })

  it('keeps table data aligned with its columns for temporal tables with HIDDEN period columns', async () => {
    const page = await meta.fetchTableData({ table: ref('rg', 'temporal'), offset: 0, limit: 10 }, false)
    expect(page.columns.map((c) => c.name)).toEqual(['id', 'name', 'valid_from', 'valid_to', 'note'])
    const row = page.rows[0] ?? []
    expect(row).toHaveLength(5)
    expect(row[4]).toBe('n1')
    expect(String(row[2])).toMatch(/^\d{4}-\d{2}-\d{2} /)
  })

  it('treats GENERATED ALWAYS (temporal period) columns as generated and edits around them', async () => {
    const details = await meta.tableDetails(DB, 'rg', 'temporal')
    expect(details.columns.filter((c) => c.isGenerated).map((c) => c.name)).toEqual(['valid_from', 'valid_to'])
    const inserted = await meta.applyChanges(ref('rg', 'temporal'), [
      { type: 'insert', values: { id: 2, name: 'beta', valid_from: '2024-01-01 00:00:00', valid_to: '9999-12-31 23:59:59', note: null } },
    ])
    expect(inserted.affected).toBe(1)
    const refused = await caught(meta.applyChanges(ref('rg', 'temporal'), [{ type: 'update', key: { id: 2 }, values: { valid_from: '2024-01-01' } }]))
    expect(refused.info.kind).toBe('invalid-input')
  })

  it('rejects table-data filters that add statements, on every connection', async () => {
    const where = `1=1); DELETE FROM ${DB}.rg.victim; SELECT * FROM ${DB}.rg.victim WHERE (1=1`
    for (const readOnly of [true, false]) {
      const error = await caught(meta.fetchTableData({ table: ref('rg', 'victim'), offset: 0, limit: 10, where }, readOnly))
      expect(error.info.kind).toBe('invalid-input')
    }
    const count = await caught(
      meta.countTableData({ table: ref('rg', 'victim'), where: `1=1); INSERT ${DB}.rg.victim VALUES (99); SELECT COUNT_BIG(*) AS total FROM ${DB}.rg.victim WHERE (1=1` }),
    )
    expect(count.info.kind).toBe('invalid-input')
    await caught(meta.countTableData({ table: ref('rg', 'victim'), where: '1=1); DELETE FROM rg.victim; --' }))
    const { results } = await session.execute('SELECT id FROM rg.victim ORDER BY id', { maxRows: 10 })
    expect(results[0]?.rows).toEqual([[1], [2]])
    // Ordinary filters, comments and subqueries keep working.
    expect(await meta.countTableData({ table: ref('rg', 'victim'), where: 'id IN (SELECT 2) -- two' })).toBe(1)
  })

  it('edits sql_variant columns', async () => {
    for (const value of ['42', 'hello', null]) {
      const result = await meta.applyChanges(ref('rg', 'variant_tbl'), [{ type: 'update', key: { id: 1 }, values: { sv: value } }])
      expect(result.affected).toBe(1)
    }
    const { results } = await session.execute("UPDATE rg.variant_tbl SET sv = 42; SELECT SQL_VARIANT_PROPERTY(sv, 'BaseType') FROM rg.variant_tbl", {
      maxRows: 1,
    })
    expect(results.at(-1)?.rows).toEqual([['int']])
  })

  it('binds datetime edits in a language-independent format', async () => {
    const [statement] = await meta.previewChanges(ref('rg', 'dt_tbl'), [
      { type: 'update', key: { id: 1 }, values: { dt: '2024-01-15 10:11:12.997' } },
    ])
    // Logins whose default language is French / German… use DATEFORMAT dmy: the same text must still convert.
    const { results } = await session.execute(`SET LANGUAGE French;\n${statement};\nSET LANGUAGE us_english;`, { maxRows: 1 })
    expect(results.filter((r) => r.kind === 'error').map((r) => r.error?.message)).toEqual([])
  })

  it('shows hierarchyid values as text and round-trips them', async () => {
    const page = await meta.fetchTableData({ table: ref('rg', 'tree'), offset: 0, limit: 10 }, false)
    expect(page.rows[0]).toEqual([1, '/1/2/'])
    const result = await meta.applyChanges(ref('rg', 'tree'), [{ type: 'update', key: { id: 1 }, values: { node: '/1/3/' } }])
    expect(result.affected).toBe(1)
    expect((await meta.fetchTableData({ table: ref('rg', 'tree'), offset: 0, limit: 10 }, false)).rows[0]).toEqual([1, '/1/3/'])
  })

  it('counts the edited row even when a trigger returns a result set', async () => {
    await session.execute('ENABLE TRIGGER rg.trg_debug ON rg.trg_tbl', { maxRows: 1 })
    try {
      const result = await meta.applyChanges(ref('rg', 'trg_tbl'), [{ type: 'update', key: { id: 1 }, values: { v: 2 } }])
      expect(result.affected).toBe(1)
    } finally {
      await session.execute('DISABLE TRIGGER rg.trg_debug ON rg.trg_tbl', { maxRows: 1 })
    }
  })

  it('includes the triggers of a table in its DDL, disabled ones disabled', async () => {
    expect(await meta.getDdl(DB, 'sales', 'orders', 'table')).toMatch(/\nCREATE TRIGGER sales\.trg_orders_touch ON sales\.orders AFTER UPDATE AS/)
    const ddl = await meta.getDdl(DB, 'rg', 'trg_tbl', 'table')
    expect(ddl).toContain("CREATE TRIGGER rg.trg_debug ON rg.trg_tbl AFTER UPDATE AS SELECT 'debug' AS msg\nGO\n\nDISABLE TRIGGER rg.trg_debug ON rg.trg_tbl;\nGO\n")
  })

  it('reproduces collation, SPARSE, ROWGUIDCOL, NOT FOR REPLICATION, index options, untrusted constraints and system versioning', async () => {
    for (const table of ['parent', 'child', 'temporal']) {
      const ddl = await meta.getDdl(DB, 'rg', table, 'table')
      const copy = ddl.split('rg.').join('rg_copy.').replace(/(PK|DF|UX|IX|FK|CK)_rg_/g, '$1_rgc_')
      const { results } = await session.execute(copy, { maxRows: 1 })
      expect(results.filter((r) => r.kind === 'error').map((r) => r.error?.message), copy).toEqual([])
    }
    const print = async (schema: string): Promise<string[]> => {
      const { results } = await session.execute(`DECLARE @s sysname = N'${schema}';${FINGERPRINT}`, { maxRows: 100 })
      expect(results.filter((r) => r.kind === 'error').map((r) => r.error?.message)).toEqual([])
      return (results.find((r) => r.kind === 'rows')?.rows ?? []).map((row) => String(row[0]).replace(/_rgc_/g, '_rg_'))
    }
    const original = await print('rg')
    expect(original.some((line) => line.startsWith('temporal|temporal|2'))).toBe(true)
    expect(await print('rg_copy')).toEqual(original)
  })

  it('lists synonyms like their base object and reads data through them', async () => {
    const objects = await meta.listObjects(DB, 'rg')
    const synonym = objects.find((o) => o.name === 'syn_victim')
    expect(synonym).toMatchObject({ kind: 'view', comment: 'Synonym for [rg].[victim]' })
    expect(objects.find((o) => o.name === 'syn_remote')).toMatchObject({ kind: 'view' })
    const page = await meta.fetchTableData({ table: ref('rg', 'syn_victim'), offset: 0, limit: 10 }, false)
    expect(page.rows).toEqual([[1], [2]])
    expect(page.primaryKey).toEqual(['id'])
    expect(page.sql).toContain('FROM ' + `${DB}.rg.syn_victim`)
    const details = await meta.tableDetails(DB, 'rg', 'syn_victim')
    expect(details.columns.map((c) => c.name)).toEqual(['id'])
    expect(details.comment).toBe('Synonym for [rg].[victim]')
    expect(await meta.getDdl(DB, 'rg', 'syn_victim', 'view')).toBe('CREATE SYNONYM rg.syn_victim FOR [rg].[victim];\nGO\n')
    expect((await caught(meta.tableDetails(DB, 'rg', 'syn_remote'))).info.kind).toBe('not-found')
    const catalog = await meta.completionCatalog(DB, false)
    const completion = catalog.schemas.find((s) => s.name === 'rg')?.objects.find((o) => o.name === 'syn_victim')
    expect(completion).toEqual({ name: 'syn_victim', kind: 'view', columns: [{ name: 'id', dataType: 'int' }] })
  })

  it('reports a missing / inaccessible login database as such, not as a bad password', async () => {
    for (const attempt of [
      () => mssqlDriver.openMetadata(mssqlTestConnection({ database: 'rg_no_such_database' })),
      () => mssqlDriver.openSession(mssqlTestConnection(), 'rg_no_such_database'),
      () => mssqlDriver.test(mssqlTestConnection({ database: 'rg_no_such_database' })),
    ]) {
      const error = await caught(attempt())
      expect(error.info).toMatchObject({ kind: 'connection', code: '4060' })
      expect(error.info.message).toMatch(/^Cannot open database "rg_no_such_database" requested by the login\./)
      expect(isAuthenticationError(error)).toBe(false)
    }
    // A wrong password is still a credential problem.
    const bad = await caught(mssqlDriver.openMetadata(mssqlTestConnection({}, 'wrong-password')))
    expect(bad.info.code).toBe('18456')
    expect(isAuthenticationError(bad)).toBe(true)
  })
})

suite('mssql regressions — config', () => {
  it('dials the tunnel port (not SQL Browser) for a named instance when the database host is 127.0.0.1 behind SSH', async () => {
    const config: ConnectionConfig = {
      ...mssqlTestConnection().config,
      host: '127.0.0.1',
      port: 1433,
      ssh: { enabled: true, host: 'bastion.example.com', port: 22, username: 'u', authMethod: 'password' },
      options: { instanceName: 'SQLEXPRESS' },
    }
    const options = await resolveOptions({ config, secrets: { password: 'pw' }, host: '127.0.0.1', port: 40000 })
    expect(options).toMatchObject({ server: '127.0.0.1', port: 40000, instanceName: undefined })
  })
})
