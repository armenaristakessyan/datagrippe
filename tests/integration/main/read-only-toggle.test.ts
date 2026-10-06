// Turning "Read-only" on for a connected PostgreSQL connection does not protect a console that is
// inside a transaction: SET SESSION CHARACTERISTICS only applies to the next transaction.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectionInput, createHarness } from './harness'
import { prepareVictims, victimCount } from './fixtures'

const h = createHarness()
let pgAdmin = ''
beforeAll(async () => {
  const pg = h.store.save(connectionInput('postgres', { name: 'admin pg' }))
  pgAdmin = (await h.manager.openSession({ connectionId: pg.id })).sessionId
  await prepareVictims(h.manager, pgAdmin, null)
})
afterAll(() => h.dispose())

describe('read-only flag switched on while a console transaction is open', () => {
  it('blocks a data-modifying function in the already open transaction', async () => {
    const input = connectionInput('postgres', { name: 'toggled' })
    const c = h.store.save(input)
    const s = await h.manager.openSession({ connectionId: c.id })
    await h.manager.setAutoCommit(s.sessionId, false)
    await h.manager.execute(s.sessionId, 'select 1', { maxRows: 1 }) // transaction now open
    const before = h.store.get(c.id)
    const after = h.store.save({ ...input, id: c.id, readOnly: true, secrets: undefined })
    await h.manager.connectionSaved(before, after, false)
    await h.manager.execute(s.sessionId, 'select rv_wipe()', { maxRows: 1 }).catch(() => undefined)
    await h.manager.commit(s.sessionId).catch(() => undefined)
    expect(await victimCount(h.manager, pgAdmin, 'postgres')).toBe(5)
  })
})
