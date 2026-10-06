// The query history keeps the full text of every executed script (up to 2000 entries) and rewrites
// the whole file on each save: a few large scripts make history.json grow without bound.
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { HistoryStore } from '../../../src/main/store/history'
import { createHarness, quiet } from './harness'

const h = createHarness()
afterAll(() => h.dispose())

describe('history store size', () => {
  it('bounds the stored text of large scripts', () => {
    const history = new HistoryStore(h.dir, { debounceMs: 0, log: quiet })
    const script = `insert into t values ${Array.from({ length: 200_000 }, (_, i) => `(${i})`).join(',')};` // ~1.6 MB
    for (let i = 0; i < 20; i++) {
      history.add({ connectionId: 'c', sql: script, executedAt: new Date().toISOString(), durationMs: 1, success: true, rowCount: 1 })
    }
    // 20 runs of one 1.6 MB script: history.json should not hold 32 MB of copies.
    expect(statSync(join(h.dir, 'history.json')).size).toBeLessThan(5 * 1024 * 1024)
  })
})
