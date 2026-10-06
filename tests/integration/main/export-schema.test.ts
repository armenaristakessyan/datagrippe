// "Export all rows" re-runs the console's statement on a fresh session, but the request cannot carry
// the console's current schema (search_path): unqualified names resolve elsewhere and the file
// silently contains another table's rows.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ExportQueryRequest } from '@shared/types'
import { exportQuery } from '../../../src/main/export/export-query'
import { connectionInput, createHarness } from './harness'

const h = createHarness()
afterAll(() => h.dispose())

describe('export uses the console schema', () => {
  it('exports the rows the console shows for an unqualified table name', async () => {
    const c = h.store.save(connectionInput('postgres', { name: 'export schema' }))
    const s = await h.manager.openSession({ connectionId: c.id })
    await h.manager.execute(
      s.sessionId,
      `drop schema if exists rv_a cascade; create schema rv_a;
       drop table if exists public.rv_dup; create table public.rv_dup(v text); insert into public.rv_dup values ('public');
       create table rv_a.rv_dup(v text); insert into rv_a.rv_dup values ('rv_a');`,
      { maxRows: 1 },
    )
    await h.manager.setSchema(s.sessionId, 'rv_a')
    const shown = await h.manager.execute(s.sessionId, 'select v from rv_dup', { maxRows: 10 })
    expect(shown.results[0].rows).toEqual([['rv_a']])

    const path = join(h.dir, 'dup.csv')
    const req = { connectionId: c.id, database: c.database, schema: 'rv_a', sql: 'select v from rv_dup', format: 'csv', defaultName: 'dup' }
    await exportQuery(req as ExportQueryRequest, { sessions: h.manager, chooseFile: async () => path })
    expect(readFileSync(path, 'utf8')).toBe('v\r\nrv_a\r\n')
  })
})

describe('export cancellation', () => {
  it('stops a long export, cancels the query and removes the partial file', async () => {
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { exportQuery } = await import('../../../src/main/export/export-query')
    const { createHarness, connectionInput } = await import('./harness')
    const h = createHarness()
    try {
      const c = h.store.save(connectionInput('postgres', { name: 'cancel export' }))
      const controller = new AbortController()
      const path = join(h.dir, 'big.csv')
      const progress: number[] = []
      const started = Date.now()
      const outcome = exportQuery(
        { connectionId: c.id, sql: 'select g, md5(g::text) from generate_series(1, 5000000) g', format: 'csv', defaultName: 'big' },
        {
          sessions: h.manager,
          chooseFile: async () => path,
          batchSize: 5000,
          signal: controller.signal,
          onProgress: (rows) => {
            progress.push(rows)
            if (rows >= 20_000) controller.abort()
          },
        },
      )
      await expect(outcome).rejects.toMatchObject({ info: { kind: 'cancelled' } })
      expect(Date.now() - started).toBeLessThan(20_000)
      expect(progress.at(-1)).toBeLessThan(5_000_000)
      expect(existsSync(path)).toBe(false)
    } finally {
      await h.dispose()
    }
  })
})
