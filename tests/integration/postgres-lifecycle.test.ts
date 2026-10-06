// PostgreSQL console session: result portals, implicit transactions, session settings, cancel, and the
// table editor's isolation from the explorer (regressions of the pg-driver review).
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DriverError } from '../../src/main/db/errors'
import { postgresDriver } from '../../src/main/db/postgres'
import { backendKeyOf, sendCancelRequest } from '../../src/main/db/postgres/cancel'
import { RESULT_POLICY } from '../../src/main/db/postgres/session'
import { TABLE_DATA_POLICY } from '../../src/main/db/postgres/table-data'
import type { DriverSession, MetadataProvider } from '../../src/main/db/types'
import { testPgConnection } from '../setup/postgres'
import { TEST_PG } from '../test-env'

const S = 'lc_pg'
const DEFAULT_POLICY = { ...RESULT_POLICY }

function adminClient(): pg.Client {
  const client = new pg.Client({ host: TEST_PG.host, port: TEST_PG.port, user: TEST_PG.user, password: TEST_PG.password, database: TEST_PG.database })
  client.on('error', () => undefined)
  return client
}

const open = (overrides: Parameters<typeof testPgConnection>[0] = {}): Promise<DriverSession> =>
  postgresDriver.openSession(testPgConnection(overrides), TEST_PG.database)

async function rejection(promise: Promise<unknown>): Promise<DriverError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(DriverError)
  return error as DriverError
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('postgres session lifecycle', () => {
  let admin: pg.Client
  const sessions: DriverSession[] = []
  const session = async (overrides: Parameters<typeof testPgConnection>[0] = {}) => {
    const s = await open(overrides)
    sessions.push(s)
    return s
  }
  const count = async (sql: string) => Number((await admin.query(sql)).rows[0]?.n)
  /** DDL from "another user" that needs an AccessExclusiveLock on the table. */
  const alterFromElsewhere = () => admin.query(`SET lock_timeout = '1s'; ALTER TABLE ${S}.t ADD COLUMN IF NOT EXISTS extra int; RESET lock_timeout`)

  beforeAll(async () => {
    admin = adminClient()
    await admin.connect()
  })
  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`)
    await admin.end()
  })
  beforeEach(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S};
      CREATE TABLE ${S}.t AS SELECT g AS id, 'a'::text AS kind FROM generate_series(1, 300) g;
      ALTER TABLE ${S}.t ADD PRIMARY KEY (id);
      CREATE TABLE ${S}.log (n int);
      CREATE FUNCTION ${S}.logged(n int) RETURNS int LANGUAGE sql AS $$ INSERT INTO ${S}.log VALUES (n) RETURNING n $$`)
  })
  afterEach(async () => {
    Object.assign(RESULT_POLICY, DEFAULT_POLICY)
    await Promise.all(sessions.splice(0).map((s) => s.close()))
  })

  describe('auto-commit results larger than maxRows', () => {
    it('commits a data-modifying statement right away and keeps every returned row', async () => {
      const s = await session()
      const { results } = await s.execute(`UPDATE ${S}.t SET kind = 'b' RETURNING id`, { maxRows: 10 })
      expect(results[0]).toMatchObject({ kind: 'rows', hasMore: true, rowCount: 10 })
      expect(await count(`SELECT count(*) AS n FROM ${S}.t WHERE kind = 'b'`)).toBe(300)
      await alterFromElsewhere()
      const rest = await s.fetchMore(results[0]?.cursorId ?? '', 1000)
      expect(rest).toMatchObject({ hasMore: false })
      expect(rest.rows).toHaveLength(290)
    })

    it('commits a writing CTE as well', async () => {
      const s = await session()
      await s.execute(`WITH d AS (DELETE FROM ${S}.t WHERE id > 100 RETURNING id) SELECT id FROM d`, { maxRows: 5 })
      expect(await count(`SELECT count(*) AS n FROM ${S}.t`)).toBe(100)
    })

    it('reports the rows of a huge RETURNING it could not keep instead of ending silently', async () => {
      RESULT_POLICY.writeResultRows = 50
      const s = await session()
      const { results } = await s.execute(`UPDATE ${S}.t SET kind = 'c' RETURNING id`, { maxRows: 10 })
      expect(await count(`SELECT count(*) AS n FROM ${S}.t WHERE kind = 'c'`)).toBe(300)
      const cursorId = results[0]?.cursorId ?? ''
      const page = await s.fetchMore(cursorId, 1000)
      expect(page.rows).toHaveLength(50)
      expect(page.hasMore).toBe(true)
      const error = await rejection(s.fetchMore(cursorId, 1000))
      expect(error.info.kind).toBe('not-found')
      expect(error.message).toContain('changes are committed')
    })

    it('reads a SELECT ahead so no lock is held while the first page is shown', async () => {
      const s = await session()
      const { results } = await s.execute(`SELECT * FROM ${S}.t ORDER BY id`, { maxRows: 10 })
      expect(results[0]).toMatchObject({ hasMore: true, rowCount: 10 })
      expect(s.transactionState()).toEqual({ autoCommit: true, inTransaction: false })
      await alterFromElsewhere()
      const rest = await s.fetchMore(results[0]?.cursorId ?? '', 1000)
      expect(rest.rows.map((r) => r[0])).toEqual(Array.from({ length: 290 }, (_, i) => i + 11))
      expect(rest.hasMore).toBe(false)
    })

    it('releases a portal left idle beyond the read-ahead, then says the rest is gone', async () => {
      Object.assign(RESULT_POLICY, { readAheadRows: 20, idleReleaseMs: 1_500 })
      const s = await session()
      const { results } = await s.execute(`SELECT * FROM ${S}.t ORDER BY id`, { maxRows: 10 })
      const cursorId = results[0]?.cursorId ?? ''
      // Reading keeps the portal alive (each fetch re-arms the idle timer)…
      expect((await s.fetchMore(cursorId, 5)).rows.map((r) => r[0])).toEqual([11, 12, 13, 14, 15])
      await expect(alterFromElsewhere()).rejects.toMatchObject({ code: '55P03' })
      // …until nobody reads from it for idleReleaseMs.
      await sleep(1_200)
      await alterFromElsewhere()
      const buffered = await s.fetchMore(cursorId, 1000)
      expect(buffered.rows.length).toBeGreaterThan(0)
      expect(buffered.hasMore).toBe(true)
      const error = await rejection(s.fetchMore(cursorId, 1000))
      expect(error.info.kind).toBe('not-found')
      expect(error.message).toContain('Run the query again')
      expect((await s.execute('SELECT 1', { maxRows: 10 })).results[0]?.rows).toEqual([[1]])
    })

    it('reports a failure met while reading ahead when the rows before it have been fetched', async () => {
      const s = await session()
      const { results } = await s.execute('SELECT 1 / (g - 600) AS x FROM generate_series(1, 1000) g', { maxRows: 100 })
      expect(results[0]).toMatchObject({ kind: 'rows', rowCount: 100, hasMore: true })
      const cursorId = results[0]?.cursorId ?? ''
      // The rows read before the failure are served first, then the failure itself.
      const rest = await s.fetchMore(cursorId, 10_000)
      expect(rest.hasMore).toBe(true)
      expect(rest.rows.length).toBeLessThan(500)
      const error = await rejection(s.fetchMore(cursorId, 10))
      expect(error.info).toMatchObject({ kind: 'database', code: '22012' })
      expect((await s.execute('SELECT 1', { maxRows: 10 })).results[0]?.rows).toEqual([[1]])
    })

    it('commits what the statement did when the console closes with its portal open', async () => {
      RESULT_POLICY.readAheadRows = 20
      const s = await open()
      await s.execute(`SELECT ${S}.logged(g) FROM generate_series(1, 1000) g`, { maxRows: 10 })
      await s.close()
      // 11 rows for the first page, 19 read ahead: executed, and committed rather than rolled back by the disconnect.
      expect(await count(`SELECT count(*) AS n FROM ${S}.log`)).toBeGreaterThanOrEqual(30)
    })

    it('keeps the portal inside a transaction block (manual commit) and reads through it', async () => {
      const s = await session()
      await s.setAutoCommit(false)
      const { results } = await s.execute(`SELECT id FROM ${S}.t ORDER BY id`, { maxRows: 100 })
      expect(s.transactionState().inTransaction).toBe(true)
      const rest = await s.fetchMore(results[0]?.cursorId ?? '', 1000)
      expect(rest.rows).toHaveLength(200)
      await s.rollback()
    })
  })

  describe('transactions and session settings', () => {
    it('runs no-transaction-block commands in manual-commit mode and refuses them inside an open block', async () => {
      const s = await session()
      await s.setAutoCommit(false)
      expect((await s.execute(`VACUUM ${S}.t`, { maxRows: 10 })).results[0]).toMatchObject({ kind: 'command', command: 'VACUUM' })
      expect(s.transactionState().inTransaction).toBe(false)
      await s.execute(`INSERT INTO ${S}.t VALUES (1000, 'z')`, { maxRows: 10 })
      const refused = (await s.execute(`CREATE INDEX CONCURRENTLY t_kind ON ${S}.t (kind)`, { maxRows: 10 })).results[0]
      expect(refused?.error).toMatchObject({ code: '25001', kind: 'invalid-input' })
      // The user's transaction is intact.
      expect((await s.execute(`SELECT count(*)::int FROM ${S}.t`, { maxRows: 10 })).results[0]?.rows).toEqual([[301]])
      await s.rollback()
      expect((await s.execute(`CREATE INDEX CONCURRENTLY t_kind ON ${S}.t (kind)`, { maxRows: 10 })).results[0]?.kind).toBe('command')
    })

    it('setReadOnly(true) inside an open transaction also protects the rest of it', async () => {
      const s = await session()
      await s.setAutoCommit(false)
      await s.execute('SELECT 1', { maxRows: 10 })
      await s.setReadOnly(true)
      const { results } = await s.execute(`DELETE FROM ${S}.t`, { maxRows: 10 })
      expect(results[0]?.error?.code).toBe('25006')
      await s.rollback()
      expect((await s.execute('SHOW default_transaction_read_only', { maxRows: 10 })).results[0]?.rows).toEqual([['on']])
      await s.setReadOnly(false)
      expect(await count(`SELECT count(*) AS n FROM ${S}.t`)).toBe(300)
    })

    it('re-applies the schema after a ROLLBACK typed in the script itself', async () => {
      const s = await session()
      await s.execute('BEGIN', { maxRows: 10 })
      await s.setSchema(S)
      const { results } = await s.execute('ROLLBACK; SHOW search_path', { maxRows: 10 })
      expect(results[1]?.rows).toEqual([[`${S}, public`]])
    })

    it('EXPLAIN refuses an aborted transaction and never changes data', async () => {
      const s = await session()
      await s.explain(`SELECT ${S}.logged(1)`, true)
      expect(await count(`SELECT count(*) AS n FROM ${S}.log`)).toBe(0)
      // Inside the user's transaction: a savepoint, rolled back.
      await s.setAutoCommit(false)
      await s.execute(`INSERT INTO ${S}.log VALUES (7)`, { maxRows: 10 })
      await s.explain(`SELECT ${S}.logged(2)`, true)
      expect((await s.execute(`SELECT n FROM ${S}.log`, { maxRows: 10 })).results[0]?.rows).toEqual([[7]])
      await s.rollback()
      await s.execute('SELECT 1 / 0', { maxRows: 10 })
      const error = await rejection(s.explain('SELECT 1', false))
      expect(error.info.kind).toBe('invalid-input')
      await s.rollback()
    })
  })

  describe('cancel', () => {
    it('cancels with a protocol CancelRequest, without a second login', async () => {
      const victim = adminClient()
      await victim.connect()
      try {
        const key = backendKeyOf(victim)
        expect(key).not.toBeNull()
        const running = victim.query('SELECT pg_sleep(30)').then(
          () => null,
          (e: { code?: string }) => e.code,
        )
        await sleep(200)
        if (key) await sendCancelRequest(TEST_PG.host, TEST_PG.port, key)
        expect(await running).toBe('57014')
      } finally {
        await victim.end()
      }
    })

    it('rejects when the server cannot be reached', async () => {
      await expect(sendCancelRequest('127.0.0.1', 1, { processId: 1, secretKey: 1 }, 2_000)).rejects.toThrow()
    })
  })

  describe('connection options', () => {
    it('applies the session time zone option', async () => {
      // ConnectionOptions.timeZone is optional in the settings contract: read structurally by the driver.
      const options = { applicationName: 'DataGrippe', timeZone: 'America/New_York' }
      const s = await session({ options })
      expect((await s.execute('SHOW TimeZone', { maxRows: 10 })).results[0]?.rows).toEqual([['America/New_York']])
    })
  })
})

describe('postgres table editor isolation', () => {
  let admin: pg.Client
  let md: MetadataProvider
  const ref = (name: string) => ({ connectionId: 'lc', database: TEST_PG.database, schema: 'lc_td', name })

  beforeAll(async () => {
    admin = adminClient()
    await admin.connect()
    await admin.query(`DROP SCHEMA IF EXISTS lc_td CASCADE; CREATE SCHEMA lc_td;
      CREATE TABLE lc_td.small (id int PRIMARY KEY); INSERT INTO lc_td.small VALUES (1), (2)`)
    md = await postgresDriver.openMetadata(testPgConnection())
  })
  afterAll(async () => {
    TABLE_DATA_POLICY.timeoutMs = 60_000
    await md.close()
    await admin.query('DROP SCHEMA IF EXISTS lc_td CASCADE')
    await admin.end()
  })

  it('stops slow table-editor queries after the table-editor timeout, with a hint', async () => {
    TABLE_DATA_POLICY.timeoutMs = 300
    const started = Date.now()
    const error = await rejection(md.countTableData({ table: ref('small'), where: 'pg_sleep(5) IS NOT NULL' }))
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(error.info).toMatchObject({ code: '57014', kind: 'database' })
    expect(error.info.hint).toContain('table editor')
    TABLE_DATA_POLICY.timeoutMs = 60_000
  })

  it('reports filter errors relative to the filter, with a leading space and a trailing comment', async () => {
    const error = await rejection(md.fetchTableData({ table: ref('small'), offset: 0, limit: 5, where: '  id >> 5 x -- note' }, false))
    expect(error.info.position).toBe(11)
    const page = await md.fetchTableData({ table: ref('small'), offset: 0, limit: 5, where: 'id > 1; -- only the last;' }, false)
    expect(page.rows).toEqual([[2]])
    const unterminated = await rejection(md.fetchTableData({ table: ref('small'), offset: 0, limit: 5, where: 'id > 1 /* oops' }, false))
    expect(unterminated.info.kind).toBe('invalid-input')
  })
})
