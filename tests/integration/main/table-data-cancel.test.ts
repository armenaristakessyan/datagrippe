// data:cancel stops a slow table-editor page or count (and the connection keeps working afterwards).
import { afterAll, describe, expect, it } from 'vitest'
import type { Dialect } from '@shared/types'
import { connectionInput, createHarness, envOf } from './harness'

const h = createHarness()
afterAll(() => h.dispose())

const SLOW: Record<Dialect, string> = {
  // evaluated once per row, read-only: passes the filter validation
  postgres: 'pg_sleep(0.5) IS NOT NULL',
  // correlated: a cross join counted again for every row
  mssql: 'id < (SELECT COUNT_BIG(*) FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c WHERE CAST(a.object_id AS bigint) + b.object_id + c.object_id <> id)',
}

describe.each(['postgres', 'mssql'] as const)('%s table data cancel', (dialect) => {
  it('cancels a running page fetch and a count', async () => {
    const c = h.store.save(connectionInput(dialect, { name: `cancel ${dialect}` }))
    const schema = dialect === 'postgres' ? 'public' : 'dbo'
    const table = { connectionId: c.id, database: envOf(dialect).database, schema, name: 'customers' }

    const started = Date.now()
    const fetch = h.manager.fetchTableData({ table, offset: 0, limit: 100, where: SLOW[dialect], requestId: 'f1' })
    setTimeout(() => h.manager.cancelTableData('f1'), 400)
    await expect(fetch).rejects.toMatchObject({ info: { kind: 'cancelled' } })
    expect(Date.now() - started).toBeLessThan(4_000)

    const count = h.manager.countTableData({ table, where: SLOW[dialect], requestId: 'c1' })
    setTimeout(() => h.manager.cancelTableData('c1'), 400)
    await expect(count).rejects.toMatchObject({ info: { kind: 'cancelled' } })

    // The pool is still usable.
    const page = await h.manager.fetchTableData({ table, offset: 0, limit: 5 })
    expect(page.rows.length).toBeGreaterThan(0)
    // Cancelling an id that is done is a no-op.
    h.manager.cancelTableData('f1')
  }, 30_000)
})
