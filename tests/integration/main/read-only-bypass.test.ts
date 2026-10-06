// Read-only connections must never change data. Each case below deletes rows today.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectionInput, createHarness } from './harness'
import { prepareVictims, resetVictim, victimCount } from './fixtures'

const h = createHarness()
let pgAdmin = ''
let msAdmin = ''

async function roSession(dialect: 'postgres' | 'mssql') {
  const c = h.store.save(connectionInput(dialect, { name: `ro ${dialect}`, readOnly: true }))
  const s = await h.manager.openSession({ connectionId: c.id })
  return { c, sessionId: s.sessionId }
}

/** Run and swallow a read-only rejection: what matters is whether rows survived. */
async function attempt(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch {
    // blocked: good
  }
}

beforeAll(async () => {
  const pg = h.store.save(connectionInput('postgres', { name: 'admin pg' }))
  const ms = h.store.save(connectionInput('mssql', { name: 'admin mssql' }))
  pgAdmin = (await h.manager.openSession({ connectionId: pg.id })).sessionId
  msAdmin = (await h.manager.openSession({ connectionId: ms.id })).sessionId
  await prepareVictims(h.manager, pgAdmin, msAdmin)
})
afterAll(() => h.dispose())

describe('PostgreSQL read-only session can be switched back to read-write by the user SQL', () => {
  it.each([
    'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE; select rv_wipe()',
    'SET default_transaction_read_only = off; select rv_wipe()',
    'RESET ALL; select rv_wipe()',
    'DISCARD ALL; select rv_wipe()',
    'BEGIN READ WRITE; select rv_wipe(); COMMIT',
    'START TRANSACTION READ WRITE; select rv_wipe(); COMMIT',
  ])('%s', async (sql) => {
    await resetVictim(h.manager, pgAdmin, 'postgres')
    const { sessionId } = await roSession('postgres')
    await attempt(() => h.manager.execute(sessionId, sql, { maxRows: 10 }))
    expect(await victimCount(h.manager, pgAdmin, 'postgres')).toBe(5)
  })

  it("select set_config('default_transaction_read_only','off',false) then a writing function", async () => {
    await resetVictim(h.manager, pgAdmin, 'postgres')
    const { sessionId } = await roSession('postgres')
    await attempt(() => h.manager.execute(sessionId, "select set_config('default_transaction_read_only', 'off', false)", { maxRows: 10 }))
    await attempt(() => h.manager.execute(sessionId, 'select rv_wipe()', { maxRows: 10 }))
    expect(await victimCount(h.manager, pgAdmin, 'postgres')).toBe(5)
  })
})

describe('PostgreSQL read-only guard is re-asserted', () => {
  it('a function that turns default_transaction_read_only off cannot make the next run writable', async () => {
    await resetVictim(h.manager, pgAdmin, 'postgres')
    await h.manager.execute(
      pgAdmin,
      `create or replace function rv_unlock() returns int language plpgsql as $$ begin perform set_config('default_transaction_read_only', 'off', false); return 1; end $$`,
      { maxRows: 1 },
    )
    const { sessionId } = await roSession('postgres')
    // The classifier cannot see inside the function: the server-side layer must still hold next time.
    await attempt(() => h.manager.execute(sessionId, 'select rv_unlock()', { maxRows: 10 }))
    await attempt(() => h.manager.execute(sessionId, 'select rv_wipe()', { maxRows: 10 }))
    expect(await victimCount(h.manager, pgAdmin, 'postgres')).toBe(5)
  })

  it('a function that turns it off cannot make a later statement of the same script writable', async () => {
    await resetVictim(h.manager, pgAdmin, 'postgres')
    const { sessionId } = await roSession('postgres')
    await attempt(() => h.manager.execute(sessionId, 'select rv_unlock(); select rv_wipe()', { maxRows: 10 }))
    expect(await victimCount(h.manager, pgAdmin, 'postgres')).toBe(5)
  })

  it.each([
    "SET LOCAL transaction_read_only = off; select rv_wipe()",
    "select pg_catalog.set_config('transaction_read_only', 'off', true), rv_wipe()",
    'SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ WRITE; select rv_wipe()',
  ])('%s', async (sql) => {
    await resetVictim(h.manager, pgAdmin, 'postgres')
    const { sessionId } = await roSession('postgres')
    await expect(h.manager.execute(sessionId, sql, { maxRows: 10 })).rejects.toMatchObject({ info: { kind: 'read-only' } })
    expect(await victimCount(h.manager, pgAdmin, 'postgres')).toBe(5)
  })

  it('read-only statements still run, including in manual-commit mode', async () => {
    const { sessionId } = await roSession('postgres')
    await h.manager.setAutoCommit(sessionId, false)
    const r = await h.manager.execute(sessionId, "select count(*) from rv_victim; select set_config('search_path', 'public', false)", { maxRows: 10 })
    expect(r.results.map((x) => x.kind)).toEqual(['rows', 'rows'])
    await h.manager.execute(sessionId, 'select 1', { maxRows: 1 })
    await h.manager.rollback(sessionId)
  })
})

describe('SQL Server separators the classifier must see', () => {
  it.each([
    ['U+2028', 'select 1\u2028delete from dbo.rv_victim'],
    ['U+200B', 'select 1 as a\u200bdelete from dbo.rv_victim'],
    ['U+0085', 'select 1\u0085delete from dbo.rv_victim'],
    ['control character', 'select 1\u0001delete from dbo.rv_victim'],
    ['lone CR after a comment', 'select 1 -- note\rdelete from dbo.rv_victim'],
  ])('%s', async (_name, sql) => {
    await resetVictim(h.manager, msAdmin, 'mssql')
    const { sessionId } = await roSession('mssql')
    await expect(h.manager.execute(sessionId, sql, { maxRows: 10 })).rejects.toMatchObject({ info: { kind: 'read-only' } })
    expect(await victimCount(h.manager, msAdmin, 'mssql')).toBe(3)
  })
})

describe('SQL Server classifier misses a write statement after a column alias named AFTER/BEFORE/INSTEAD', () => {
  it.each([
    'select 1 as after delete from dbo.rv_victim',
    'select 1 after delete from dbo.rv_victim',
    'select 1 as before delete from dbo.rv_victim',
    'select 1 as instead delete from dbo.rv_victim',
  ])('%s', async (sql) => {
    await resetVictim(h.manager, msAdmin, 'mssql')
    const { sessionId } = await roSession('mssql')
    await attempt(() => h.manager.execute(sessionId, sql, { maxRows: 10 }))
    expect(await victimCount(h.manager, msAdmin, 'mssql')).toBe(3)
  })
})

describe('SQL Server table editor WHERE filter breaks out of the SELECT on a read-only connection', () => {
  const where = '1=1); DELETE FROM dbo.rv_victim; --'
  it('data:fetch', async () => {
    await resetVictim(h.manager, msAdmin, 'mssql')
    const { c } = await roSession('mssql')
    const table = { connectionId: c.id, database: c.database, schema: 'dbo', name: 'rv_victim' }
    await attempt(() => h.manager.fetchTableData({ table, offset: 0, limit: 10, where }))
    expect(await victimCount(h.manager, msAdmin, 'mssql')).toBe(3)
  })
  it('data:count', async () => {
    await resetVictim(h.manager, msAdmin, 'mssql')
    const { c } = await roSession('mssql')
    const table = { connectionId: c.id, database: c.database, schema: 'dbo', name: 'rv_victim' }
    await attempt(() => h.manager.countTableData({ table, where }))
    expect(await victimCount(h.manager, msAdmin, 'mssql')).toBe(3)
  })
})

describe('SQL Server estimated plan (explain without analyze) executes batches after SET SHOWPLAN_XML OFF', () => {
  it('on a read-only connection', async () => {
    await resetVictim(h.manager, msAdmin, 'mssql')
    const { sessionId } = await roSession('mssql')
    await attempt(() => h.manager.explain(sessionId, 'SET SHOWPLAN_XML OFF\nGO\nDELETE FROM dbo.rv_victim', false))
    expect(await victimCount(h.manager, msAdmin, 'mssql')).toBe(3)
  })
})
