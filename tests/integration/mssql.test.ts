// SQL Server driver: connection test, script execution, cursors, messages, errors, cancellation,
// session state, transactions, value normalization and execution plans.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CellValue, QueryMessage, StatementResult } from '@shared/types'
import { DriverError } from '../../src/main/db/errors'
import { mssqlDriver } from '../../src/main/db/mssql'
import type { DriverSession } from '../../src/main/db/types'
import { TEST_MSSQL } from '../test-env'
import { mssqlTestConnection as mssqlConnection } from '../setup/mssql'

const TEST_DB = TEST_MSSQL.database
const only = process.env.DATAGRIPPE_TEST_DB
const suite = !only || only === 'mssql' ? describe : describe.skip

async function caught(promise: Promise<unknown>): Promise<DriverError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof DriverError) return error
    throw error
  }
  throw new Error('Expected the promise to reject')
}

function rowsOf(result: StatementResult | undefined): CellValue[][] {
  if (!result) throw new Error('missing result')
  expect(result.kind, JSON.stringify(result.error)).toBe('rows')
  return result.rows
}

suite('mssql driver — connection test', () => {
  it('returns server info', async () => {
    const info = await mssqlDriver.test(mssqlConnection())
    expect(info.dialect).toBe('mssql')
    expect(info.version).toMatch(/Microsoft SQL Server/)
    expect(info.versionShort).toMatch(/^\d+\.\d+\.\d+/)
    expect(info.currentDatabase).toBe(TEST_DB)
    expect(info.currentUser).toBe('sa')
    expect(info.currentSchema).toBe('dbo')
  })

  it('maps login failures to connection errors with the server error number', async () => {
    const error = await caught(mssqlDriver.test(mssqlConnection({}, 'wrong-password')))
    expect(error.info.kind).toBe('connection')
    expect(error.info.code).toBe('18456')
    expect(error.info.message).toMatch(/Login failed/)
  })

  it('maps unreachable servers to connection errors', async () => {
    const error = await caught(mssqlDriver.test(mssqlConnection({ port: 1, options: { connectTimeoutMs: 3000 } })))
    expect(error.info.kind).toBe('connection')
    expect(error.info.code).toBeDefined()
  })
})

suite('mssql driver — session', () => {
  let session: DriverSession

  beforeAll(async () => {
    session = await mssqlDriver.openSession(mssqlConnection(), TEST_DB)
  })

  afterAll(async () => {
    await session?.close()
  })

  it('reports the database, schema and server info', async () => {
    expect(session.dialect).toBe('mssql')
    expect(session.database).toBe(TEST_DB)
    expect(session.schema).toBe('dbo')
    const info = await session.serverInfo()
    expect(info.currentDatabase).toBe(TEST_DB)
    expect(session.transactionState()).toEqual({ autoCommit: true, inTransaction: false })
  })

  it('returns every recordset and row count of a single batch', async () => {
    const sql = [
      'CREATE TABLE #multi (id int);',
      'INSERT INTO #multi VALUES (1), (2), (3);',
      'SELECT id FROM #multi ORDER BY id;',
      'UPDATE #multi SET id = id + 10 WHERE id > 1;',
      'SELECT COUNT(*) AS n FROM #multi;',
      'DROP TABLE #multi;',
    ].join('\n')
    const { results, cancelled } = await session.execute(sql, { maxRows: 100 })
    expect(cancelled).toBe(false)
    expect(results.map((r) => r.kind)).toEqual(['command', 'rows', 'command', 'rows'])
    expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3])
    expect(results[0]).toMatchObject({ rowCount: 3, command: 'INSERT', sql, offset: 0 })
    expect(rowsOf(results[1])).toEqual([[1], [2], [3]])
    expect(results[1]?.columns).toEqual([{ name: 'id', dataType: 'int', nullable: true }])
    expect(results[2]).toMatchObject({ rowCount: 2, command: 'UPDATE' })
    expect(rowsOf(results[3])).toEqual([[3]])
    for (const result of results) expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('reports a command result for batches without output', async () => {
    const { results } = await session.execute('CREATE TABLE #nothing (a int)', { maxRows: 10 })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ kind: 'command', rowCount: null, hasMore: false })
    expect(results[0]?.command).toMatch(/^CREATE/)
    await session.execute('DROP TABLE #nothing', { maxRows: 10 })
  })

  it('splits GO batches and reports their offsets', async () => {
    const script = 'SELECT 1 AS a\nGO\n\n  SELECT 2 AS b -- second\nGO\n'
    const { results } = await session.execute(script, { maxRows: 10 })
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ sql: 'SELECT 1 AS a', offset: 0 })
    expect(results[1]?.sql).toBe('SELECT 2 AS b')
    expect(results[1]?.offset).toBe(script.indexOf('SELECT 2'))
    expect(rowsOf(results[1])).toEqual([[2]])
  })

  it('repeats a batch for GO n', async () => {
    const script = 'CREATE TABLE #rep (n int)\nGO\nINSERT INTO #rep VALUES (1)\nGO 3\nSELECT COUNT(*) AS c FROM #rep\nGO\nDROP TABLE #rep'
    const { results } = await session.execute(script, { maxRows: 10 })
    const inserts = results.filter((r) => r.command === 'INSERT')
    expect(inserts).toHaveLength(3)
    for (const insert of inserts) expect(insert).toMatchObject({ kind: 'command', rowCount: 1 })
    expect(rowsOf(results.find((r) => r.kind === 'rows'))).toEqual([[3]])
  })

  it('keeps a cursor open for a single SELECT and fetches the rest', async () => {
    const { results } = await session.execute('SELECT id FROM dbo.events ORDER BY id', { maxRows: 100 })
    expect(results).toHaveLength(1)
    const first = results[0]
    expect(first).toMatchObject({ kind: 'rows', rowCount: 100, hasMore: true })
    expect(first?.cursorId).toBeTypeOf('string')
    expect(rowsOf(first)[0]).toEqual([1])
    expect(rowsOf(first)[99]).toEqual([100])

    const cursorId = first?.cursorId ?? ''
    const page = await session.fetchMore(cursorId, 250)
    expect(page.rows).toHaveLength(250)
    expect(page.rows[0]).toEqual([101])
    expect(page.rows[249]).toEqual([350])
    expect(page.hasMore).toBe(true)

    const rest = await session.fetchMore(cursorId, 20_000)
    expect(rest.rows).toHaveLength(10_000 - 350)
    expect(rest.rows.at(-1)).toEqual([10_000])
    expect(rest.hasMore).toBe(false)

    const closed = await caught(session.fetchMore(cursorId, 10))
    expect(closed.info.kind).toBe('not-found')
    expect(rowsOf((await session.execute('SELECT 1 AS ok', { maxRows: 10 })).results[0])).toEqual([[1]])
  })

  it('reports hasMore false without a cursor when the result fits exactly', async () => {
    const { results } = await session.execute('SELECT TOP (5) id FROM dbo.events ORDER BY id', { maxRows: 5 })
    expect(results[0]).toMatchObject({ rowCount: 5, hasMore: false })
    expect(results[0]?.cursorId).toBeUndefined()
  })

  it('abandons the open cursor when a new statement runs', async () => {
    const first = await session.execute('SELECT id FROM dbo.events', { maxRows: 10 })
    const cursorId = first.results[0]?.cursorId
    expect(cursorId).toBeTypeOf('string')
    const next = await session.execute('SELECT 42 AS answer', { maxRows: 10 })
    expect(rowsOf(next.results[0])).toEqual([[42]])
    const error = await caught(session.fetchMore(cursorId ?? '', 10))
    expect(error.info.kind).toBe('not-found')
  })

  it('drains truncated recordsets of multi-statement batches so later statements still run', async () => {
    const sql = [
      'CREATE TABLE #drain (x int);',
      'SELECT id FROM dbo.events ORDER BY id;',
      'INSERT INTO #drain SELECT id FROM dbo.events WHERE id <= 7;',
      'SELECT COUNT(*) AS c FROM #drain;',
    ].join('\n')
    const { results } = await session.execute(sql, { maxRows: 5 })
    expect(results.map((r) => r.kind)).toEqual(['rows', 'command', 'rows'])
    expect(results[0]).toMatchObject({ rowCount: 5, hasMore: true })
    expect(results[0]?.cursorId).toBeUndefined()
    expect(results[1]).toMatchObject({ rowCount: 7, command: 'INSERT' })
    expect(rowsOf(results[2])).toEqual([[7]])
    await session.execute('DROP TABLE #drain', { maxRows: 1 })
  })

  it('only keeps a cursor for the last batch of a script', async () => {
    const { results } = await session.execute('SELECT id FROM dbo.events\nGO\nSELECT 1 AS one', { maxRows: 3 })
    expect(results[0]).toMatchObject({ rowCount: 3, hasMore: true })
    expect(results[0]?.cursorId).toBeUndefined()
    expect(rowsOf(results[1])).toEqual([[1]])
  })

  it('delivers PRINT and low-severity RAISERROR as messages', async () => {
    const received: QueryMessage[] = []
    const { results, messages } = await session.execute(
      "PRINT 'hello from print'; RAISERROR('careful: %d', 10, 1, 42); SELECT 1 AS one",
      { maxRows: 10, onMessage: (message) => received.push(message) },
    )
    expect(messages.map((m) => m.text)).toEqual(['hello from print', 'careful: 42'])
    expect(received).toEqual(messages)
    for (const message of messages) expect(message.level).toBe('info')
    expect(results).toHaveLength(1)
    expect(rowsOf(results[0])).toEqual([[1]])
  })

  it('reports SQL errors with number, severity and line, and continues the batch like SQL Server', async () => {
    const { results } = await session.execute('SELECT 1 AS ok\nSELECT 1/0 AS boom\nSELECT 2 AS after', { maxRows: 10 })
    expect(results.map((r) => r.kind)).toEqual(['rows', 'error', 'rows'])
    expect(results[1]?.error).toMatchObject({ kind: 'database', code: '8134', severity: '16', line: 2 })
    expect(results[1]?.error?.message).toMatch(/Divide by zero/)
    expect(rowsOf(results[2])).toEqual([[2]])
  })

  it('collects every error of a batch and stops the script after it', async () => {
    const script = "RAISERROR('first', 16, 1); RAISERROR('second', 16, 2);\nGO\nSELECT 3 AS never"
    const { results } = await session.execute(script, { maxRows: 10 })
    expect(results.map((r) => r.error?.message)).toEqual(['first', 'second'])
    expect(results.every((r) => r.kind === 'error')).toBe(true)

    const continued = await session.execute(script, { maxRows: 10, stopOnError: false })
    expect(continued.results.map((r) => r.kind)).toEqual(['error', 'error', 'rows'])
  })

  it('stops at a compile error of a batch', async () => {
    const { results } = await session.execute('SELECT * FROM dbo.does_not_exist\nGO\nSELECT 1', { maxRows: 10 })
    expect(results).toHaveLength(1)
    expect(results[0]?.error).toMatchObject({ code: '208', line: 1 })
  })

  it('names the procedure in error details', async () => {
    const { results } = await session.execute(
      'CREATE PROCEDURE #fails AS BEGIN\n  SELECT 1/0\nEND\nGO\nEXEC #fails\nGO\nDROP PROCEDURE #fails',
      { maxRows: 10, stopOnError: false },
    )
    const error = results.find((r) => r.kind === 'error')?.error
    // Line 2 of the procedure, not of the calling batch: no editor line, the detail says where.
    expect(error).toMatchObject({ code: '8134' })
    expect(error?.line).toBeUndefined()
    expect(error?.detail).toMatch(/^Line 2 of #fails/)
  })

  it('cancels a running statement', async () => {
    const started = Date.now()
    const running = session.execute("WAITFOR DELAY '00:00:30'; SELECT 1 AS never", { maxRows: 10 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await session.cancel()
    const { cancelled, results } = await running
    expect(Date.now() - started).toBeLessThan(3000)
    expect(cancelled).toBe(true)
    expect(results.some((r) => r.kind === 'rows')).toBe(false)
    expect(rowsOf((await session.execute('SELECT 5 AS alive', { maxRows: 1 })).results[0])).toEqual([[5]])
  })

  it('applies the per-statement timeout', async () => {
    const { results } = await session.execute("WAITFOR DELAY '00:00:10'", { maxRows: 1, timeoutMs: 500 })
    expect(results[0]?.kind).toBe('error')
    expect(results[0]?.error?.code).toBe('ETIMEOUT')
    expect(rowsOf((await session.execute('SELECT 6 AS alive', { maxRows: 1 })).results[0])).toEqual([[6]])
  })

  it('keeps temp tables and SET options across executions', async () => {
    await session.execute('CREATE TABLE #persist (v int); INSERT INTO #persist VALUES (7);', { maxRows: 1 })
    await session.execute('SET LOCK_TIMEOUT 1234; SET DATEFORMAT dmy;', { maxRows: 1 })
    const { results } = await session.execute(
      "SELECT v, @@LOCK_TIMEOUT AS lock_timeout, CAST('13/01/2024' AS date) AS d FROM #persist",
      { maxRows: 10 },
    )
    expect(rowsOf(results[0])).toEqual([[7, 1234, '2024-01-13']])
    await session.execute('DROP TABLE #persist; SET LOCK_TIMEOUT -1; SET DATEFORMAT mdy;', { maxRows: 1 })
  })

  it('switches databases with useDatabase and USE', async () => {
    expect(await session.useDatabase('master')).toBe(true)
    expect(session.database).toBe('master')
    expect(rowsOf((await session.execute('SELECT DB_NAME() AS db', { maxRows: 1 })).results[0])).toEqual([['master']])
    const { messages } = await session.execute(`USE ${TEST_DB}`, { maxRows: 1 })
    expect(session.database).toBe(TEST_DB)
    expect(messages.some((m) => /Changed database context/.test(m.text))).toBe(true)
    expect((await session.serverInfo()).currentDatabase).toBe(TEST_DB)
    const error = await caught(session.useDatabase('no_such_database'))
    expect(error.info.kind).toBe('database')
    expect(session.database).toBe(TEST_DB)
  })

  it('runs in implicit-transaction mode when auto-commit is off', async () => {
    expect(await session.setAutoCommit(false)).toEqual({ autoCommit: false, inTransaction: false })
    await session.execute('UPDATE dbo.[Mixed Case Table] SET [order] = 99 WHERE [Id] = 1', { maxRows: 1 })
    expect(session.transactionState()).toEqual({ autoCommit: false, inTransaction: true })
    expect(rowsOf((await session.execute('SELECT @@TRANCOUNT AS tc', { maxRows: 1 })).results[0])).toEqual([[1]])

    const refused = await caught(session.setAutoCommit(true))
    expect(refused.info.kind).toBe('invalid-input')

    expect(await session.rollback()).toEqual({ autoCommit: false, inTransaction: false })
    const { results } = await session.execute('SELECT [order] FROM dbo.[Mixed Case Table] WHERE [Id] = 1', { maxRows: 1 })
    expect(rowsOf(results[0])).toEqual([[10]])
    // the SELECT itself opened an implicit transaction
    expect(session.transactionState().inTransaction).toBe(true)
    await session.commit()
    expect(await session.setAutoCommit(true)).toEqual({ autoCommit: true, inTransaction: false })
  })

  it('tracks explicit transactions in auto-commit mode', async () => {
    await session.execute('BEGIN TRANSACTION; UPDATE dbo.[Mixed Case Table] SET [order] = 11 WHERE [Id] = 1', { maxRows: 1 })
    expect(session.transactionState()).toEqual({ autoCommit: true, inTransaction: true })
    expect(await session.rollback()).toEqual({ autoCommit: true, inTransaction: false })
    expect(await session.commit()).toEqual({ autoCommit: true, inTransaction: false })
  })

  it('normalizes values to exact CellValues', async () => {
    const { results } = await session.execute(
      'SELECT id, big, exact, amount, small_amount, ratio, single, tiny, small, legacy_dt, small_dt, fixed_bin, variant FROM dbo.big_numbers ORDER BY id;' +
        'SELECT id, is_active, credit_limit, balance, created_at, last_seen, birth_date, preferred_time, external_id, avatar, profile, settings FROM dbo.customers ORDER BY id;' +
        'SELECT row_version FROM dbo.audit_log;' +
        "SELECT CAST(NULL AS int) AS n, CAST('2024-01-01 00:00:00.12' AS datetime2(2)) AS d2, CAST('12:34:56' AS time(0)) AS t0," +
        " CAST('abc' AS text) AS tx, CAST(N'déjà' AS ntext) AS nt, CAST(0x0A0B AS image) AS img, CAST('2024-02-29 23:59:59.5 -00:30' AS datetimeoffset(1)) AS dto1," +
        " CAST('0001-01-01' AS date) AS d_min, CAST('9999-12-31 23:59:59.9999999' AS datetime2) AS d_max, CAST(0.5 AS decimal(5,4)) AS frac",
      { maxRows: 100 },
    )
    const numbers = rowsOf(results[0])
    expect(numbers[0]).toEqual([
      1,
      '9223372036854775807',
      '1234567890123456789012345678.1234567891',
      '922337203685477.5807',
      '214748.3647',
      0.1,
      1.5,
      255,
      32767,
      '2024-05-06 07:08:09.997',
      '2024-05-06 07:08:00',
      '0xDEADBEEF',
      '42',
    ])
    expect(numbers[1]?.slice(0, 5)).toEqual([2, '-9223372036854775808', '-0.0000000001', '-922337203685477.5808', '-214748.3648'])
    expect(numbers[1]?.[9]).toBe('1753-01-01 00:00:00.000')
    expect(numbers[1]?.[12]).toBe('text')
    expect(numbers[2]?.slice(0, 5)).toEqual([3, '0', '0.0000000000', '0.0000', '0.0000'])
    expect(results[0]?.columns.map((c) => c.dataType)).toEqual([
      'int', 'bigint', 'decimal', 'money', 'smallmoney', 'float', 'real', 'tinyint', 'smallint', 'datetime', 'smalldatetime', 'binary', 'sql_variant',
    ])

    const customers = rowsOf(results[1])
    expect(customers[0]).toEqual([
      1,
      true,
      '1500.50',
      '1234.5678',
      '2024-01-15 10:30:00.1234567',
      '2024-01-15 10:30:00.1234567 +02:00',
      '1815-12-10',
      '08:15:30.1234567',
      '6F9619FF-8B86-D011-B42D-00C04FC964FF',
      '0x0102ABCDEF',
      '<profile><lang>en</lang></profile>',
      '{"theme":"dark","beta":true}',
    ])
    expect(customers[1]?.slice(0, 6)).toEqual([2, true, '99999.99', '-42.0001', '2023-06-01 00:00:00.0000000', null])
    expect(customers[2]?.slice(0, 2)).toEqual([3, false])
    expect(customers[2]?.[5]).toBe('2022-02-02 23:30:00.0000000 -05:30')
    expect(customers[2]?.[7]).toBe('23:59:59.9999999')
    expect(customers[2]?.[9]).toBe('0x')
    expect(results[1]?.columns.map((c) => c.dataType)).toEqual([
      'int', 'bit', 'decimal', 'money', 'datetime2', 'datetimeoffset', 'date', 'time', 'uniqueidentifier', 'varbinary', 'xml', 'nvarchar',
    ])

    expect(results[2]?.columns[0]?.dataType).toBe('timestamp')
    for (const [version] of rowsOf(results[2])) expect(version).toMatch(/^0x[0-9A-F]{16}$/)

    expect(rowsOf(results[3])[0]).toEqual([
      null,
      '2024-01-01 00:00:00.12',
      '12:34:56',
      'abc',
      'déjà',
      '0x0A0B',
      '2024-02-29 23:59:59.5 -00:30',
      '0001-01-01',
      '9999-12-31 23:59:59.9999999',
      '0.5000',
    ])
  })

  it('explains a query with the estimated plan', async () => {
    const plan = await session.explain(
      'SELECT c.email, o.total FROM dbo.customers c JOIN sales.orders o ON o.customer_id = c.id WHERE c.id = 1',
      false,
    )
    expect(plan.format).toBe('mssql-xml')
    expect(plan.raw).toMatch(/<ShowPlanXML/)
    expect(plan.root).not.toBeNull()
    const nodes = flatten(plan.root)
    expect(nodes.some((node) => node.relation?.startsWith('dbo.customers'))).toBe(true)
    expect(nodes.some((node) => node.details.some((detail) => detail.startsWith('Seek:')))).toBe(true)
    expect(plan.root?.estimatedRows).toBeTypeOf('number')
    expect(plan.root?.estimatedCost).toBeTypeOf('number')
    expect(plan.root?.actualRows).toBeUndefined()
    // SHOWPLAN is off again: statements execute normally
    expect(rowsOf((await session.execute('SELECT 9 AS n', { maxRows: 1 })).results[0])).toEqual([[9]])
  })

  it('explains with actual statistics and leaves data unchanged', async () => {
    const select = await session.explain('SELECT id FROM dbo.events WHERE id <= 25', true)
    expect(select.root?.actualRows).toBe(25)
    expect(select.root?.loops).toBeGreaterThanOrEqual(1)
    expect(select.totalTimeMs).toBeTypeOf('number')

    const update = await session.explain('UPDATE sales.orders SET total = total + 1 WHERE id = 1000', true)
    expect(update.root).not.toBeNull()
    expect(flatten(update.root).some((node) => node.actualRows !== undefined)).toBe(true)
    const { results } = await session.execute('SELECT total FROM sales.orders WHERE id = 1000', { maxRows: 1 })
    expect(rowsOf(results[0])).toEqual([['120.00']])
    expect(session.transactionState()).toEqual({ autoCommit: true, inTransaction: false })
    expect(rowsOf((await session.execute('SELECT 10 AS n', { maxRows: 1 })).results[0])).toEqual([[10]])
  })

  it('reports plan errors as DriverError', async () => {
    const error = await caught(session.explain('SELECT * FROM dbo.nope', false))
    expect(error.info).toMatchObject({ kind: 'database', code: '208' })
    expect(rowsOf((await session.execute('SELECT 11 AS n', { maxRows: 1 })).results[0])).toEqual([[11]])
  })
})

suite('mssql driver — session lifecycle', () => {
  it('reports unexpected disconnects', async () => {
    const victim = await mssqlDriver.openSession(mssqlConnection(), TEST_DB)
    const killer = await mssqlDriver.openSession(mssqlConnection(), TEST_DB)
    try {
      const spid = rowsOf((await victim.execute('SELECT @@SPID', { maxRows: 1 })).results[0])[0]?.[0]
      const closed = new Promise<string>((resolve) => victim.onUnexpectedClose(resolve))
      await killer.execute(`KILL ${String(spid)}`, { maxRows: 1 })
      // The server only notices the dead session on the next round trip.
      await victim.execute('SELECT 1', { maxRows: 1 }).catch(() => undefined)
      await expect(closed).resolves.toBeTypeOf('string')
    } finally {
      await victim.close()
      await killer.close()
    }
  })

  it('does not report a normal close', async () => {
    const session = await mssqlDriver.openSession(mssqlConnection(), TEST_DB)
    let reported = false
    session.onUnexpectedClose(() => {
      reported = true
    })
    await session.close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(reported).toBe(false)
    const error = await caught(session.execute('SELECT 1', { maxRows: 1 }))
    expect(error.info.kind).toBe('connection')
  })

  it('opens on the login default database when none is given', async () => {
    const session = await mssqlDriver.openSession(mssqlConnection({ database: '' }), '')
    try {
      expect(session.database).toBe('master')
    } finally {
      await session.close()
    }
  })
})

type Plan = NonNullable<Awaited<ReturnType<DriverSession['explain']>>['root']>

function flatten(node: Plan | null | undefined): Plan[] {
  if (!node) return []
  return [node, ...node.children.flatMap(flatten)]
}
