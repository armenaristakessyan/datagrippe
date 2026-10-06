// Session lifecycle: switching database must keep the console's transaction mode.
import { afterAll, describe, expect, it } from 'vitest'
import { connectionInput, createHarness } from './harness'

const h = createHarness()
afterAll(() => h.dispose())

describe('PostgreSQL session:setDatabase', () => {
  it('keeps manual-commit mode after switching database', async () => {
    const c = h.store.save(connectionInput('postgres', { name: 'manual commit' }))
    const s = await h.manager.openSession({ connectionId: c.id })
    await h.manager.setAutoCommit(s.sessionId, false)
    const info = await h.manager.setDatabase(s.sessionId, 'postgres')
    // The user chose manual commit; the reopened session silently auto-commits every following statement.
    expect(info.transaction.autoCommit).toBe(false)
  })

  it('refuses (or keeps) an open transaction instead of silently rolling it back', async () => {
    const c = h.store.save(connectionInput('postgres', { name: 'open tx' }))
    const s = await h.manager.openSession({ connectionId: c.id })
    await h.manager.setAutoCommit(s.sessionId, false)
    await h.manager.execute(s.sessionId, 'create temp table rv_tx_probe(id int); insert into rv_tx_probe values (1)', { maxRows: 1 })
    expect(h.manager.sessionInfo(s.sessionId).transaction.inTransaction).toBe(true)
    await expect(h.manager.setDatabase(s.sessionId, 'postgres')).rejects.toBeTruthy()
  })
})
