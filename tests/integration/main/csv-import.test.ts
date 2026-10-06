// Import data from CSV: streamed into a table in one transaction, values converted by the server, with
// progress, cancellation and an all-or-nothing failure mode. PostgreSQL and SQL Server.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Dialect, ImportCsvRequest } from '@shared/types'
import { importCsv, previewCsvFile } from '../../../src/main/import/import-csv'
import { connectionInput, createHarness } from './harness'

const h = createHarness()
afterAll(() => h.dispose())

const DDL: Record<Dialect, string> = {
  postgres: `drop table if exists rv_import; create table rv_import(id int primary key, name text, amount numeric(10,2), payload bytea, flag boolean, note text default 'none')`,
  mssql: `if object_id('dbo.rv_import') is not null drop table dbo.rv_import; create table dbo.rv_import(id int primary key, name nvarchar(200), amount decimal(10,2), payload varbinary(16), flag bit, note nvarchar(20) default 'none')`,
}

const CSV = [
  'id;label;amount;bytes;flag',
  '1;plain;12.50;BYTES1;true',
  '2;"semi; colon ""quoted""";-3;BYTES2;false',
  '3;"two\r\nlines \\ backslash";;;',
  "4;O'Brien ✓;0.01;BYTES1;true",
  '',
].join('\r\n')

describe.each(['postgres', 'mssql'] as const)('CSV import (%s)', (dialect) => {
  let connectionId = ''
  let admin = ''
  const schema = dialect === 'postgres' ? 'public' : 'dbo'
  const bytes = dialect === 'postgres' ? { BYTES1: '\\xdeadbeef', BYTES2: '\\x00ff' } : { BYTES1: '0xDEADBEEF', BYTES2: '0x00FF' }
  const file = (name: string, text: string) => {
    const path = join(h.dir, `${dialect}-${name}`)
    writeFileSync(path, text)
    return path
  }
  const request = (path: string, extra: Partial<ImportCsvRequest> = {}): ImportCsvRequest => ({
    importId: `imp-${Math.random()}`,
    table: { connectionId, database: h.store.get(connectionId)!.database, schema, name: 'rv_import' },
    path,
    options: { delimiter: ';' },
    mapping: [
      { source: 0, column: 'id' },
      { source: 1, column: 'name' },
      { source: 2, column: 'amount' },
      { source: 3, column: 'payload' },
      { source: 4, column: 'flag' },
    ],
    ...extra,
  })
  const count = async () => Number((await h.manager.execute(admin, `select count(*) from ${schema}.rv_import`, { maxRows: 1 })).results[0].rows[0][0])

  beforeAll(async () => {
    connectionId = h.store.save(connectionInput(dialect, { name: `import ${dialect}` })).id
    admin = (await h.manager.openSession({ connectionId })).sessionId
    await h.manager.execute(admin, DDL[dialect], { maxRows: 1 })
  })

  it('previews with the detected delimiter and header', async () => {
    const preview = await previewCsvFile(file('a.csv', CSV.replaceAll('BYTES1', bytes.BYTES1).replaceAll('BYTES2', bytes.BYTES2)))
    expect(preview.options).toMatchObject({ delimiter: ';', header: true })
    expect(preview.headers).toEqual(['id', 'label', 'amount', 'bytes', 'flag'])
    expect(preview.rows[1]).toEqual(['2', 'semi; colon "quoted"', '-3', bytes.BYTES2, 'false'])
    expect(preview.rows[2]).toEqual(['3', 'two\r\nlines \\ backslash', null, null, null])
  })

  it('inserts every record with server-side conversion, reporting progress', async () => {
    await h.manager.execute(admin, `delete from ${schema}.rv_import`, { maxRows: 1 })
    const path = file('ok.csv', CSV.replaceAll('BYTES1', bytes.BYTES1).replaceAll('BYTES2', bytes.BYTES2))
    const progress: number[] = []
    const result = await importCsv(request(path, { batchSize: 2 }), { sessions: h.manager, onProgress: (p) => progress.push(p.rows) })
    expect(result.rows).toBe(4)
    expect(progress).toEqual([2, 4])
    const hex = dialect === 'postgres' ? `encode(payload, 'hex')` : `convert(varchar(40), payload, 2)`
    const flag = dialect === 'postgres' ? 'flag::text' : 'cast(flag as varchar(5))'
    const rows = (await h.manager.execute(admin, `select id, name, cast(amount as varchar(20)), ${hex}, ${flag}, note from ${schema}.rv_import order by id`, { maxRows: 10 }))
      .results[0].rows
    const t = dialect === 'postgres' ? ['true', 'false'] : ['1', '0']
    expect(rows).toEqual([
      [1, 'plain', '12.50', dialect === 'postgres' ? 'deadbeef' : 'DEADBEEF', t[0], 'none'],
      [2, 'semi; colon "quoted"', '-3.00', dialect === 'postgres' ? '00ff' : '00FF', t[1], 'none'],
      [3, 'two\r\nlines \\ backslash', null, null, null, 'none'],
      [4, "O'Brien ✓", '0.01', dialect === 'postgres' ? 'deadbeef' : 'DEADBEEF', t[0], 'none'],
    ])
  })

  it('rolls everything back when a batch fails', async () => {
    await h.manager.execute(admin, `delete from ${schema}.rv_import`, { maxRows: 1 })
    const lines = ['id;label', '10;a', '11;b', '12;c', '10;duplicate']
    const path = file('dup.csv', lines.join('\n'))
    const req = request(path, { batchSize: 2, mapping: [{ source: 0, column: 'id' }, { source: 1, column: 'name' }] })
    await expect(importCsv(req, { sessions: h.manager })).rejects.toMatchObject({ info: { kind: 'database', message: expect.stringMatching(/^Rows 3–4 could not be inserted/) } })
    expect(await count()).toBe(0)
  })

  it('stops and rolls back when cancelled', async () => {
    await h.manager.execute(admin, `delete from ${schema}.rv_import`, { maxRows: 1 })
    const lines = ['id;label', ...Array.from({ length: 2000 }, (_, i) => `${i + 1};row ${i + 1}`)]
    const path = file('big.csv', lines.join('\n'))
    const controller = new AbortController()
    const req = request(path, { batchSize: 100, mapping: [{ source: 0, column: 'id' }, { source: 1, column: 'name' }] })
    const outcome = importCsv(req, {
      sessions: h.manager,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.rows >= 300) controller.abort()
      },
    })
    await expect(outcome).rejects.toMatchObject({ info: { kind: 'cancelled' } })
    expect(await count()).toBe(0)
  })

  it('validates the mapping and refuses read-only connections', async () => {
    const path = file('v.csv', 'id\n1\n')
    await expect(importCsv(request(path, { mapping: [{ source: 0, column: 'missing' }] }), { sessions: h.manager })).rejects.toMatchObject({
      info: { kind: 'invalid-input', message: expect.stringMatching(/does not exist/) },
    })
    await expect(
      importCsv(request(path, { mapping: [{ source: 0, column: 'id' }, { source: 0, column: 'id' }] }), { sessions: h.manager }),
    ).rejects.toMatchObject({ info: { kind: 'invalid-input', message: expect.stringMatching(/mapped twice/) } })
    const ro = h.store.save(connectionInput(dialect, { name: `ro import ${dialect}`, readOnly: true }))
    await expect(
      importCsv({ ...request(path), table: { ...request(path).table, connectionId: ro.id } }, { sessions: h.manager }),
    ).rejects.toMatchObject({ info: { kind: 'read-only' } })
  })
})
