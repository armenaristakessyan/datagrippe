import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DriverError } from '../../src/main/db/errors'
import { postgresDriver } from '../../src/main/db/postgres'
import type { DriverSession, MetadataProvider } from '../../src/main/db/types'
import type { QueryMessage, StatementResult } from '../../src/shared/types'
import { testPgConnection } from '../setup/postgres'
import { TEST_PG } from '../test-env'

const MAX = 500

async function expectDriverError(promise: Promise<unknown>, kind: string, code?: string): Promise<DriverError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(DriverError)
  const driverError = error as DriverError
  expect(driverError.info.kind).toBe(kind)
  if (code) expect(driverError.info.code).toBe(code)
  return driverError
}

function only(results: StatementResult[]): StatementResult {
  expect(results).toHaveLength(1)
  const [result] = results
  if (!result) throw new Error('no result')
  return result
}

describe('postgres driver: connection', () => {
  it('test() returns server info', async () => {
    const info = await postgresDriver.test(testPgConnection())
    expect(info.dialect).toBe('postgres')
    expect(info.version).toMatch(/^PostgreSQL \d+/)
    expect(info.versionShort).toMatch(/^\d+\.\d+$/)
    expect(info.currentDatabase).toBe(TEST_PG.database)
    expect(info.currentUser).toBe(TEST_PG.user)
    expect(info.currentSchema).toBe('public')
  })

  it('maps authentication failures to connection errors with SQLSTATE', async () => {
    await expectDriverError(postgresDriver.test(testPgConnection({}, 'wrong-password')), 'connection', '28P01')
  })

  it('maps unknown databases to connection errors', async () => {
    await expectDriverError(postgresDriver.test(testPgConnection({ database: 'no_such_db' })), 'connection', '3D000')
  })

  it('maps refused connections to connection errors', async () => {
    const connection = testPgConnection()
    connection.port = 1
    await expectDriverError(postgresDriver.test(connection), 'connection', 'ECONNREFUSED')
  })

  it('reports a missing password as a connection error', async () => {
    await expectDriverError(postgresDriver.test(testPgConnection({}, null)), 'connection')
  })

  it('sslmode=prefer falls back to plain TCP when the server has no TLS', async () => {
    const info = await postgresDriver.test(testPgConnection({ ssl: { mode: 'prefer' } }))
    expect(info.currentDatabase).toBe(TEST_PG.database)
    const metadata = await postgresDriver.openMetadata(testPgConnection({ ssl: { mode: 'prefer' } }))
    expect((await metadata.serverInfo()).dialect).toBe('postgres')
    await metadata.close()
  })

  it('sslmode=require fails against a server without TLS', async () => {
    await expectDriverError(postgresDriver.test(testPgConnection({ ssl: { mode: 'require' } })), 'connection')
  })

  it('sets application_name', async () => {
    const session = await postgresDriver.openSession(testPgConnection({ options: { applicationName: 'dg-test' } }), TEST_PG.database)
    const { results } = await session.execute(`SELECT current_setting('application_name')`, { maxRows: MAX })
    expect(only(results).rows).toEqual([['dg-test']])
    await session.close()
  })
})

describe('postgres driver: session', () => {
  let session: DriverSession
  let other: DriverSession
  let metadata: MetadataProvider

  beforeAll(async () => {
    session = await postgresDriver.openSession(testPgConnection(), TEST_PG.database)
    other = await postgresDriver.openSession(testPgConnection(), TEST_PG.database)
    metadata = await postgresDriver.openMetadata(testPgConnection())
    await other.execute(
      'DROP TABLE IF EXISTS public.session_scratch; CREATE TABLE public.session_scratch (id serial PRIMARY KEY, note text)',
      { maxRows: MAX },
    )
  })

  afterAll(async () => {
    await other.execute('DROP TABLE IF EXISTS public.session_scratch', { maxRows: MAX })
    await session.close()
    await other.close()
    await metadata.close()
  })

  async function scratchCount(): Promise<number> {
    const { results } = await other.execute('SELECT count(*)::int FROM public.session_scratch', { maxRows: MAX })
    return Number(only(results).rows[0]?.[0])
  }

  it('exposes dialect, database and schema', async () => {
    expect(session.dialect).toBe('postgres')
    expect(session.database).toBe(TEST_PG.database)
    expect(session.schema).toBe('public')
    expect((await session.serverInfo()).currentDatabase).toBe(TEST_PG.database)
    expect(await session.useDatabase('postgres')).toBe(false)
  })

  it('executes a single statement', async () => {
    const result = only((await session.execute('SELECT 1 AS one, 2::int8 AS two', { maxRows: MAX })).results)
    expect(result).toMatchObject({
      index: 0,
      offset: 0,
      kind: 'rows',
      rows: [[1, '2']],
      rowCount: 1,
      hasMore: false,
      command: 'SELECT',
    })
    expect(result.columns).toEqual([
      { name: 'one', dataType: 'int4' },
      { name: 'two', dataType: 'int8' },
    ])
    expect(result.cursorId).toBeUndefined()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('executes several statements with offsets and command tags', async () => {
    const sql = [
      'SELECT 1;',
      '  -- comment',
      '  UPDATE public.big_numbers SET tiny = tiny WHERE id IN (1, 2);',
      'CREATE TEMP TABLE tmp_multi (x int);',
      'INSERT INTO tmp_multi VALUES (1), (2), (3);',
      'SELECT * FROM tmp_multi WHERE false',
    ].join('\n')
    const { results, cancelled } = await session.execute(sql, { maxRows: MAX })
    expect(cancelled).toBe(false)
    expect(results.map((r) => r.kind)).toEqual(['rows', 'command', 'command', 'command', 'rows'])
    for (const r of results) expect(sql.slice(r.offset, r.offset + r.sql.length)).toBe(r.sql)
    expect(results[1]).toMatchObject({ command: 'UPDATE', rowCount: 2 })
    expect(results[2]).toMatchObject({ command: 'CREATE TABLE', rowCount: null })
    expect(results[3]).toMatchObject({ command: 'INSERT', rowCount: 3 })
    expect(results[4]).toMatchObject({ rows: [], rowCount: 0, columns: [{ name: 'x', dataType: 'int4' }] })
    expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4])
  })

  it('fetches more rows until the cursor is exhausted', async () => {
    const result = only((await session.execute('SELECT id FROM public.events ORDER BY id', { maxRows: 100 })).results)
    expect(result.rows).toHaveLength(100)
    expect(result.hasMore).toBe(true)
    expect(result.cursorId).toEqual(expect.any(String))
    const ids = result.rows.map((r) => r[0])
    let hasMore = true
    while (hasMore) {
      const page = await session.fetchMore(result.cursorId ?? '', 3000)
      expect(page.rows.length).toBeLessThanOrEqual(3000)
      ids.push(...page.rows.map((r) => r[0]))
      hasMore = page.hasMore
    }
    expect(ids).toHaveLength(10_000)
    expect(ids[0]).toBe('1')
    expect(ids[9999]).toBe('10000')
    await expectDriverError(session.fetchMore(result.cursorId ?? '', 10), 'not-found')
  })

  it('detects hasMore exactly at the maxRows boundary', async () => {
    const exact = only((await session.execute('SELECT g FROM generate_series(1, 100) g', { maxRows: 100 })).results)
    expect(exact.hasMore).toBe(false)
    expect(exact.cursorId).toBeUndefined()

    const over = only((await session.execute('SELECT g FROM generate_series(1, 100) g', { maxRows: 99 })).results)
    expect(over.hasMore).toBe(true)
    const rest = await session.fetchMore(over.cursorId ?? '', 1)
    expect(rest).toEqual({ rows: [[100]], hasMore: false })
  })

  it('keeps only the last cursor and truncates earlier results', async () => {
    const { results } = await session.execute('SELECT id FROM public.events; SELECT g FROM generate_series(1, 50) g', {
      maxRows: 10,
    })
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ hasMore: true, rowCount: 10 })
    expect(results[0]?.cursorId).toBeUndefined()
    expect(results[1]).toMatchObject({ hasMore: true })
    const cursorId = results[1]?.cursorId ?? ''
    expect(cursorId).not.toBe('')
    expect((await session.fetchMore(cursorId, 5)).rows).toEqual([[11], [12], [13], [14], [15]])

    // Any new execution discards the open cursor.
    await session.execute('SELECT 1', { maxRows: MAX })
    await expectDriverError(session.fetchMore(cursorId, 5), 'not-found')
  })

  it('reports SQL errors as results with a statement-relative position', async () => {
    const sql = 'SELECT 1;\nSELECT nope FROM public.customers;\nSELECT 2'
    const { results } = await session.execute(sql, { maxRows: MAX })
    expect(results).toHaveLength(2)
    const failed = results[1]
    expect(failed?.kind).toBe('error')
    expect(failed?.offset).toBe(sql.indexOf('SELECT nope'))
    expect(failed?.error).toMatchObject({ code: '42703', kind: 'database', severity: 'ERROR', position: 8 })
    expect(failed?.error?.message).toMatch(/nope/)

    const all = await session.execute(sql, { maxRows: MAX, stopOnError: false })
    expect(all.results.map((r) => r.kind)).toEqual(['rows', 'error', 'rows'])
  })

  it('reports error details and hints', async () => {
    const { results } = await session.execute(`INSERT INTO public.big_numbers (id) VALUES (1)`, { maxRows: MAX })
    expect(only(results).error).toMatchObject({ code: '23505', kind: 'database' })
    expect(only(results).error?.detail).toMatch(/already exists/)
  })

  it('collects notices and warnings', async () => {
    const seen: QueryMessage[] = []
    const { results, messages } = await session.execute(
      `DO $$ BEGIN RAISE NOTICE 'hello %', 42; RAISE WARNING 'careful'; RAISE INFO 'fyi'; END $$`,
      { maxRows: MAX, onMessage: (m) => seen.push(m) },
    )
    expect(only(results)).toMatchObject({ kind: 'command', command: 'DO' })
    expect(messages.map((m) => [m.level, m.text])).toEqual([
      ['notice', 'hello 42'],
      ['warning', 'careful'],
      ['info', 'fyi'],
    ])
    expect(seen).toEqual(messages)
  })

  it('rejects COPY to the client', async () => {
    const result = only((await session.execute('COPY public.customers TO STDOUT', { maxRows: MAX })).results)
    expect(result.kind).toBe('error')
    expect(result.error?.kind).toBe('invalid-input')
    expect(only((await session.execute('SELECT 1', { maxRows: MAX })).results).rows).toEqual([[1]])
  })

  it('cancels a running statement quickly', async () => {
    const started = Date.now()
    const running = session.execute('SELECT 1; SELECT pg_sleep(30); SELECT 2', { maxRows: MAX })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await session.cancel()
    const { results, cancelled } = await running
    expect(Date.now() - started).toBeLessThan(3000)
    expect(cancelled).toBe(true)
    expect(results).toHaveLength(2)
    expect(results[1]?.error?.kind).toBe('cancelled')
    expect(session.transactionState().inTransaction).toBe(false)
    expect(only((await session.execute('SELECT 3', { maxRows: MAX })).results).rows).toEqual([[3]])
  })

  it('cancel() is a no-op when idle', async () => {
    await session.cancel()
    expect(only((await session.execute('SELECT 4', { maxRows: MAX })).results).rows).toEqual([[4]])
  })

  it('applies a per-statement timeout and restores the previous value', async () => {
    const { results, cancelled } = await session.execute('SELECT pg_sleep(2)', { maxRows: MAX, timeoutMs: 200 })
    expect(cancelled).toBe(false)
    expect(only(results).error).toMatchObject({ code: '57014', kind: 'database' })
    const show = only((await session.execute('SHOW statement_timeout', { maxRows: MAX })).results)
    expect(show.rows).toEqual([['0']])
  })

  it('restores the timeout even when the execution leaves a transaction open', async () => {
    const show = async () => only((await session.execute('SHOW statement_timeout', { maxRows: MAX })).results).rows
    await session.execute('BEGIN; SELECT 1', { maxRows: MAX, timeoutMs: 700 })
    expect(session.transactionState().inTransaction).toBe(true)
    expect(await show()).toEqual([['0']])
    await session.rollback()
    expect(await show()).toEqual([['0']])

    await session.setAutoCommit(false)
    await session.execute('SELECT 1', { maxRows: MAX, timeoutMs: 700 })
    expect(session.transactionState().inTransaction).toBe(true)
    await session.rollback()
    expect(await show()).toEqual([['0']])
    await session.rollback()
    await session.setAutoCommit(true)

    await session.execute('BEGIN', { maxRows: MAX })
    const failed = await session.execute('SELECT pg_sleep(1)', { maxRows: MAX, timeoutMs: 100 })
    expect(only(failed.results).error?.code).toBe('57014')
    await session.rollback()
    expect(await show()).toEqual([['0']])
  })

  it('runs manual transactions with commit and rollback', async () => {
    expect(session.transactionState()).toEqual({ autoCommit: true, inTransaction: false })
    expect(await session.setAutoCommit(false)).toEqual({ autoCommit: false, inTransaction: false })

    await session.execute(`INSERT INTO public.session_scratch (note) VALUES ('rolled back')`, { maxRows: MAX })
    expect(session.transactionState()).toEqual({ autoCommit: false, inTransaction: true })
    expect(await scratchCount()).toBe(0)
    await expectDriverError(session.setAutoCommit(true), 'invalid-input')
    expect(await session.rollback()).toEqual({ autoCommit: false, inTransaction: false })
    expect(await scratchCount()).toBe(0)

    await session.execute(`INSERT INTO public.session_scratch (note) VALUES ('kept')`, { maxRows: MAX })
    expect(await session.commit()).toEqual({ autoCommit: false, inTransaction: false })
    expect(await scratchCount()).toBe(1)

    // Failed transaction: every statement fails until rollback.
    const failed = await session.execute('SELECT 1 / 0', { maxRows: MAX })
    expect(only(failed.results).error?.code).toBe('22012')
    expect(session.transactionState().inTransaction).toBe(true)
    const blocked = await session.execute('SELECT 1', { maxRows: MAX })
    expect(only(blocked.results).error?.code).toBe('25P02')
    expect(await session.rollback()).toEqual({ autoCommit: false, inTransaction: false })

    // COMMIT / ROLLBACK typed by the user do not get an implicit BEGIN.
    const typed = await session.execute('ROLLBACK', { maxRows: MAX })
    expect(typed.messages.map((m) => m.text)).toEqual(['there is no transaction in progress'])

    expect(await session.setAutoCommit(true)).toEqual({ autoCommit: true, inTransaction: false })
    expect(await session.commit()).toEqual({ autoCommit: true, inTransaction: false })
  })

  it('tracks explicit BEGIN in auto-commit mode', async () => {
    await session.execute('BEGIN', { maxRows: MAX })
    expect(session.transactionState()).toEqual({ autoCommit: true, inTransaction: true })
    await session.execute(`INSERT INTO public.session_scratch (note) VALUES ('explicit')`, { maxRows: MAX })
    expect(await session.rollback()).toEqual({ autoCommit: true, inTransaction: false })
    expect(await scratchCount()).toBe(1)
  })

  it('read-only sessions reject writes', async () => {
    await session.setReadOnly(true)
    const { results } = await session.execute(`INSERT INTO public.session_scratch (note) VALUES ('nope')`, { maxRows: MAX })
    expect(only(results).error?.code).toBe('25006')
    await session.setReadOnly(false)
    const ok = await session.execute(`INSERT INTO public.session_scratch (note) VALUES ('yes')`, { maxRows: MAX })
    expect(only(ok.results)).toMatchObject({ kind: 'command', rowCount: 1 })
    expect(await scratchCount()).toBe(2)
  })

  it('explains a query', async () => {
    const plan = await session.explain('SELECT c.name, o.total FROM public.customers c LEFT JOIN sales.orders o ON o.customer_id = c.id WHERE c.id > 1', false)
    expect(plan.format).toBe('postgres-json')
    expect(plan.root).not.toBeNull()
    expect(plan.root?.estimatedRows).toEqual(expect.any(Number))
    expect(plan.root?.estimatedCost).toEqual(expect.any(Number))
    expect(plan.root?.actualRows).toBeUndefined()
    expect(JSON.parse(plan.raw)).toEqual(expect.any(Array))
    const flatten = (n: NonNullable<typeof plan.root>): NonNullable<typeof plan.root>[] => [n, ...n.children.flatMap(flatten)]
    const nodes = plan.root ? flatten(plan.root) : []
    expect(nodes.some((n) => n.relation === 'public.customers c')).toBe(true)
    expect(nodes.some((n) => /Join/.test(n.operation))).toBe(true)
  })

  it('explain analyze of an UPDATE leaves data unchanged', async () => {
    const before = await session.execute('SELECT sum(credit_limit)::text FROM public.customers', { maxRows: MAX })
    const plan = await session.explain('UPDATE public.customers SET credit_limit = credit_limit + 1', true)
    expect(plan.root?.operation).toBe('Update')
    expect(plan.root?.actualTimeMs).toEqual(expect.any(Number))
    expect(plan.totalTimeMs).toEqual(expect.any(Number))
    expect(plan.planningTimeMs).toEqual(expect.any(Number))
    expect(plan.root?.children[0]?.actualRows).toBe(5)
    expect(plan.root?.children[0]?.loops).toBe(1)
    const after = await session.execute('SELECT sum(credit_limit)::text FROM public.customers', { maxRows: MAX })
    expect(only(after.results).rows).toEqual(only(before.results).rows)
    expect(session.transactionState().inTransaction).toBe(false)
  })

  it('explain analyze inside an open transaction uses a savepoint', async () => {
    await session.execute('BEGIN', { maxRows: MAX })
    await session.execute(`INSERT INTO public.session_scratch (note) VALUES ('in tx')`, { maxRows: MAX })
    await session.explain('DELETE FROM public.session_scratch', true)
    expect(session.transactionState().inTransaction).toBe(true)
    const inside = await session.execute('SELECT count(*)::int FROM public.session_scratch', { maxRows: MAX })
    expect(only(inside.results).rows).toEqual([[3]])
    await session.rollback()
  })

  it('explain requires exactly one statement and reports SQL errors', async () => {
    await expectDriverError(session.explain('SELECT 1; SELECT 2', false), 'invalid-input')
    await expectDriverError(session.explain('SELECT nope FROM public.customers', false), 'database', '42703')
  })

  it('normalizes values without precision loss', async () => {
    const { results } = await session.execute(
      'SELECT big, exact, ratio, small_real, tiny FROM public.big_numbers ORDER BY id',
      { maxRows: MAX },
    )
    const result = only(results)
    expect(result.columns.map((c) => c.dataType)).toEqual(['int8', 'numeric', 'float8', 'float4', 'int2'])
    expect(result.rows).toEqual([
      ['9223372036854775807', '1234567890123456789012345678.0123456789', 'NaN', 1.5, 32767],
      ['-9223372036854775808', '-0.0000000001', 'Infinity', -2.25, -32768],
      ['9007199254740993', '0.1000000000', '-Infinity', 3.25, 0],
      [null, null, 0.1, null, null],
    ])
  })

  it('keeps text for dates, json, bytea, arrays and other types', async () => {
    await session.execute(`SET TIME ZONE 'UTC'`, { maxRows: MAX })
    const { results } = await session.execute(
      `SELECT created_at, birth_date, preferences, avatar, tags, external_id, last_ip, is_active, email,
              interval '1 day 02:03:04' AS iv, ARRAY[1, 2, 3] AS ints, NULL::text AS nothing, money '12.34' AS cash,
              int4range(1, 10) AS r, '<a>x</a>'::xml AS doc, time '10:11:12' AS t, false AS f
       FROM public.customers WHERE id = 1`,
      { maxRows: MAX },
    )
    const result = only(results)
    expect(result.rows[0]).toEqual([
      '2024-01-15 09:30:00+00',
      '1815-12-10',
      '{"theme": "dark", "newsletter": true}',
      '\\xdeadbeef',
      '{vip,early-adopter}',
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      '192.168.1.10',
      true,
      'ada@example.com',
      '1 day 02:03:04',
      '{1,2,3}',
      null,
      '$12.34',
      '[1,10)',
      '<a>x</a>',
      '10:11:12',
      false,
    ])
    expect(result.columns.map((c) => c.dataType)).toEqual([
      'timestamptz',
      'date',
      'jsonb',
      'bytea',
      'text[]',
      'uuid',
      'inet',
      'bool',
      'varchar',
      'interval',
      'int4[]',
      'text',
      'money',
      'int4range',
      'xml',
      'time',
      'bool',
    ])
  })

  it('resolves user-defined type names, also while a cursor stays open', async () => {
    const closed = only((await session.execute('SELECT status FROM sales.orders ORDER BY id', { maxRows: MAX })).results)
    expect(closed.columns).toEqual([{ name: 'status', dataType: 'order_status', table: 'orders' }])
    expect(closed.rows[0]).toEqual(['paid'])

    await session.execute('CREATE TYPE pg_temp.mood AS ENUM (\'ok\', \'meh\')', { maxRows: MAX })
    const open = only(
      (await session.execute(`SELECT 'ok'::pg_temp.mood AS m, (ARRAY['meh'])::pg_temp.mood[] AS ms FROM generate_series(1, 20)`, {
        maxRows: 5,
      })).results,
    )
    expect(open.hasMore).toBe(true)
    // A temporary type is invisible to the side connection: falls back to the OID, never fails.
    expect(open.columns[0]?.dataType).toMatch(/^(mood|\d+)$/)
    const enumOpen = only((await session.execute('SELECT status FROM sales.orders, generate_series(1, 20)', { maxRows: 5 })).results)
    expect(enumOpen.hasMore).toBe(true)
    expect(enumOpen.columns).toEqual([{ name: 'status', dataType: 'order_status', table: 'orders' }])
  })

  it('names the source table of result columns', async () => {
    const result = only(
      (await session.execute('SELECT o.id, c.name, 1 AS one FROM sales.orders o JOIN customers c ON c.id = o.customer_id LIMIT 1', {
        maxRows: MAX,
      })).results,
    )
    expect(result.columns.map((c) => c.table)).toEqual(['orders', 'customers', undefined])
  })

  it('setSchema changes how unqualified names resolve', async () => {
    const failing = await session.execute('SELECT count(*) FROM orders', { maxRows: MAX })
    expect(only(failing.results).error?.code).toBe('42P01')
    await session.setSchema('sales')
    expect(session.schema).toBe('sales')
    expect((await session.serverInfo()).currentSchema).toBe('sales')
    const orders = await session.execute('SELECT count(*) FROM orders', { maxRows: MAX })
    expect(only(orders.results).rows).toEqual([['5']])
    const customers = await session.execute('SELECT count(*) FROM customers', { maxRows: MAX })
    expect(only(customers.results).rows).toEqual([['5']])
    await session.setSchema('public')
    expect(session.schema).toBe('public')
  })

  it('opens on the configured default schema', async () => {
    const s = await postgresDriver.openSession(testPgConnection({ options: { defaultSchema: 'sales' } }), TEST_PG.database)
    expect(s.schema).toBe('sales')
    const { results } = await s.execute('SELECT count(*) FROM order_items', { maxRows: MAX })
    expect(only(results).rows).toEqual([['6']])
    await s.close()
  })

  it('serializes concurrent operations', async () => {
    const [a, b, c] = await Promise.all([
      session.execute('SELECT pg_sleep(0.2), 1', { maxRows: MAX }),
      session.execute('SELECT 2', { maxRows: MAX }),
      session.execute('SELECT 3', { maxRows: MAX }),
    ])
    expect(only(a.results).rows[0]?.[1]).toBe(1)
    expect(only(b.results).rows).toEqual([[2]])
    expect(only(c.results).rows).toEqual([[3]])
  })

  it('notifies an unexpected disconnect', async () => {
    const s = await postgresDriver.openSession(testPgConnection(), TEST_PG.database)
    const pid = only((await s.execute('SELECT pg_backend_pid()', { maxRows: MAX })).results).rows[0]?.[0]
    const reason = new Promise<string>((resolve) => s.onUnexpectedClose(resolve))
    await other.execute(`SELECT pg_terminate_backend(${Number(pid)})`, { maxRows: MAX })
    await expect(reason).resolves.toEqual(expect.any(String))
    await s.close()
  })

  it('close() does not report an unexpected disconnect', async () => {
    const s = await postgresDriver.openSession(testPgConnection(), TEST_PG.database)
    let reported = false
    s.onUnexpectedClose(() => {
      reported = true
    })
    await s.close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(reported).toBe(false)
    await expectDriverError(s.execute('SELECT 1', { maxRows: MAX }), 'connection')
  })
})
