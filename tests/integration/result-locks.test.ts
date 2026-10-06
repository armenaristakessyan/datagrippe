// Regression: a console that shows the first page of a large PostgreSQL result keeps the
// statement's implicit transaction (snapshot + AccessShareLock) open for as long as the result stays on
// screen, so DDL / TRUNCATE / VACUUM FULL from other sessions block indefinitely.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHarness, pgAdmin, type Harness } from './helpers/manager'

describe('PostgreSQL console result left on screen', () => {
  let h: Harness

  beforeAll(async () => {
    h = createHarness()
    const admin = await pgAdmin()
    await admin.query('drop table if exists public.rv_full_big')
    await admin.query('create table public.rv_full_big as select g as id, md5(g::text) as h from generate_series(1, 5000) g')
    await admin.end()
  })

  afterAll(async () => {
    await h.close()
    const admin = await pgAdmin()
    await admin.query('drop table if exists public.rv_full_big')
    await admin.end()
  })

  it('does not hold locks on the table once the first page is shown (auto-commit console)', async () => {
    const c = h.store.save(h.input('postgres'))
    const s = await h.manager.openSession({ connectionId: c.id })
    const exec = await h.manager.execute(s.sessionId, 'select * from public.rv_full_big', { maxRows: 500 })
    expect(exec.results[0]!.rows).toHaveLength(500)
    expect(exec.results[0]!.hasMore).toBe(true)
    // The UI says the console is idle and in auto-commit mode…
    expect(exec.transaction).toEqual({ autoCommit: true, inTransaction: false })

    // …yet a migration run by a colleague cannot get its lock while the result is on screen.
    const admin = await pgAdmin()
    try {
      await admin.query("set lock_timeout = '2s'")
      await expect(admin.query('alter table public.rv_full_big add column extra int')).resolves.toBeDefined()
    } finally {
      await admin.end()
      await h.manager.closeSession(s.sessionId)
    }
  })
})

// SQL Server: the first page of a large result is read from a paused tedious request (ASYNC_NETWORK_IO);
// the still-running SELECT keeps its Sch-S lock, so ALTER TABLE from another session blocks.
describe('SQL Server console result left on screen', () => {
  let h: Harness

  const admin = async () => {
    const mssql = (await import('mssql')).default
    const { TEST_MSSQL } = await import('../test-env')
    return mssql.connect({
      server: TEST_MSSQL.host,
      port: TEST_MSSQL.port,
      user: TEST_MSSQL.user,
      password: TEST_MSSQL.password,
      database: TEST_MSSQL.database,
      options: { encrypt: true, trustServerCertificate: true },
    })
  }

  beforeAll(async () => {
    h = createHarness()
    const pool = await admin()
    await pool.request().query(`if object_id('dbo.rv_full_big') is not null drop table dbo.rv_full_big;
      select top 300000 row_number() over (order by (select null)) as id, cast(newid() as nvarchar(50)) as h, replicate(N'x', 200) as pad
      into dbo.rv_full_big from sys.all_objects a cross join sys.all_objects b`)
    await pool.close()
  })

  afterAll(async () => {
    await h.close()
    const pool = await admin()
    await pool.request().query(`if object_id('dbo.rv_full_big') is not null drop table dbo.rv_full_big`)
    await pool.close()
  })

  it('does not block DDL from other sessions once the first page is shown', async () => {
    const c = h.store.save(h.input('mssql'))
    const s = await h.manager.openSession({ connectionId: c.id })
    const exec = await h.manager.execute(s.sessionId, 'select * from dbo.rv_full_big', { maxRows: 500 })
    expect(exec.results[0]!.hasMore).toBe(true)
    expect(exec.transaction.inTransaction).toBe(false)
    const pool = await admin()
    try {
      await expect(pool.request().query('set lock_timeout 3000; alter table dbo.rv_full_big add extra int')).resolves.toBeDefined()
    } finally {
      await pool.close()
      await h.manager.closeSession(s.sessionId)
    }
  })
})
