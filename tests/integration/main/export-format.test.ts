// files:exportQuery output fidelity.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { exportQuery } from '../../../src/main/export/export-query'
import { connectionInput, createHarness } from './harness'

const h = createHarness()
afterAll(() => h.dispose())

describe('JSON export', () => {
  it('keeps a column named __proto__', async () => {
    const c = h.store.save(connectionInput('postgres', { name: 'export' }))
    const path = join(h.dir, 'proto.json')
    await exportQuery(
      { connectionId: c.id, sql: 'select 1 as "__proto__", 2 as b', format: 'json', defaultName: 'proto' },
      { sessions: h.manager, chooseFile: async () => path },
    )
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>[]
    expect(Object.keys(parsed[0])).toEqual(['__proto__', 'b'])
  })
})

describe('SQL INSERT export', () => {
  it('SQL Server varbinary values are exported as binary literals that can be re-inserted', async () => {
    const c = h.store.save(connectionInput('mssql', { name: 'export mssql' }))
    const s = await h.manager.openSession({ connectionId: c.id })
    await h.manager.execute(
      s.sessionId,
      "if object_id('dbo.rv_bin') is not null drop table dbo.rv_bin; create table dbo.rv_bin(id int, b varbinary(16)); insert into dbo.rv_bin values (1, 0xDEADBEEF)",
      { maxRows: 1 },
    )
    const path = join(h.dir, 'bin.sql')
    await exportQuery(
      { connectionId: c.id, sql: 'select id, b from dbo.rv_bin', format: 'sql', tableName: 'dbo.rv_bin', defaultName: 'bin' },
      { sessions: h.manager, chooseFile: async () => path },
    )
    const script = readFileSync(path, 'utf8')
    await h.manager.execute(s.sessionId, 'delete from dbo.rv_bin', { maxRows: 1 })
    const replay = await h.manager.execute(s.sessionId, script, { maxRows: 1 })
    expect(replay.results.filter((r) => r.kind === 'error').map((r) => r.error?.message)).toEqual([])
  })
})
