// "Explain" must never change data (the PG driver even promises it for ANALYZE).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectionInput, createHarness } from './harness'
import { prepareVictims, resetVictim, victimCount } from './fixtures'

const h = createHarness()
let pgAdmin = ''
let msAdmin = ''

beforeAll(async () => {
  const pg = h.store.save(connectionInput('postgres', { name: 'admin pg' }))
  const ms = h.store.save(connectionInput('mssql', { name: 'admin mssql' }))
  pgAdmin = (await h.manager.openSession({ connectionId: pg.id })).sessionId
  msAdmin = (await h.manager.openSession({ connectionId: ms.id })).sessionId
  await prepareVictims(h.manager, pgAdmin, msAdmin)
})
afterAll(() => h.dispose())

describe('explain side effects on a normal (read-write) connection', () => {
  it('PostgreSQL EXPLAIN ANALYZE of a SELECT calling a data-modifying function is not rolled back', async () => {
    await resetVictim(h.manager, pgAdmin, 'postgres')
    const c = h.store.save(connectionInput('postgres', { name: 'rw pg' }))
    const { sessionId } = await h.manager.openSession({ connectionId: c.id })
    await h.manager.explain(sessionId, 'select rv_wipe()', true)
    expect(await victimCount(h.manager, pgAdmin, 'postgres')).toBe(5)
  })

  it('SQL Server estimated plan runs a DELETE placed after a SET SHOWPLAN_XML OFF batch', async () => {
    await resetVictim(h.manager, msAdmin, 'mssql')
    const c = h.store.save(connectionInput('mssql', { name: 'rw mssql' }))
    const { sessionId } = await h.manager.openSession({ connectionId: c.id })
    await h.manager.explain(sessionId, 'SET SHOWPLAN_XML OFF\nGO\nDELETE FROM dbo.rv_victim', false).catch(() => undefined)
    expect(await victimCount(h.manager, msAdmin, 'mssql')).toBe(3)
  })
})
