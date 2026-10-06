// Transaction / portal lifecycle defects of the PostgreSQL console session.
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { adminClient, openSession, withSession } from './helpers/pg'

let admin: pg.Client
const count = async (sql: string): Promise<number> => Number((await admin.query(sql)).rows[0]?.n)

describe('pg review: transactions and portals', () => {
  beforeAll(async () => {
    admin = adminClient()
    await admin.connect()
    await admin.query(`SET lock_timeout = '5s'`)
  })
  afterAll(async () => {
    await admin.query('DROP SCHEMA IF EXISTS rv_tx CASCADE')
    await admin.end()
  })
  beforeEach(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS rv_tx CASCADE; CREATE SCHEMA rv_tx;
      CREATE TABLE rv_tx.t AS SELECT g AS id, 'a'::text AS kind FROM generate_series(1, 100) g;
      ALTER TABLE rv_tx.t ADD PRIMARY KEY (id)`)
  })

  it('auto-commit: an UPDATE ... RETURNING with more rows than maxRows is committed', async () => {
    const s = await openSession()
    let visibleWhileOpen = -1
    try {
      const { results } = await s.execute(`UPDATE rv_tx.t SET kind = 'b' RETURNING id`, { maxRows: 10 })
      expect(results[0]?.kind).toBe('rows')
      expect(results[0]?.hasMore).toBe(true)
      expect(s.transactionState()).toEqual({
        autoCommit: true,
        inTransaction: false,
      })
      visibleWhileOpen = await count(`SELECT count(*) AS n FROM rv_tx.t WHERE kind = 'b'`)
    } finally {
      await s.close()
    }
    // Auto-commit: the change must survive closing the console (before the fix: 0 — silently rolled back)…
    expect(await count(`SELECT count(*) AS n FROM rv_tx.t WHERE kind = 'b'`)).toBe(100)
    // …and be visible to other connections as soon as the statement returned (before the fix: 0).
    expect(visibleWhileOpen).toBe(100)
  })

  it('auto-commit: an open result does not keep locks that block DDL from other connections', async () => {
    const s = await openSession()
    const { results } = await s.execute('SELECT * FROM rv_tx.t', {
      maxRows: 10,
    })
    expect(results[0]?.hasMore).toBe(true)
    await admin.query(`SET lock_timeout = '1s'`)
    try {
      // Before the fix: "canceling statement due to lock timeout" — the suspended portal holds AccessShareLock.
      await expect(admin.query('ALTER TABLE rv_tx.t ADD COLUMN x int')).resolves.toBeDefined()
    } finally {
      await admin.query('RESET lock_timeout')
      await s.close()
    }
  })

  it('manual commit: VACUUM / CREATE INDEX CONCURRENTLY are not wrapped in an implicit BEGIN', async () => {
    await withSession(async (s) => {
      await s.setAutoCommit(false)
      const vacuum = await s.execute('VACUUM rv_tx.t', { maxRows: 10 })
      expect(vacuum.results[0]?.error?.message).toBeUndefined()
      expect(vacuum.results[0]?.kind).toBe('command')
      const cic = await s.execute('CREATE INDEX CONCURRENTLY t_kind_idx ON rv_tx.t (kind)', { maxRows: 10 })
      expect(cic.results[0]?.error?.message).toBeUndefined()
    })
  })

  it('setSchema / setReadOnly during an open transaction survive a ROLLBACK', async () => {
    await withSession(async (s) => {
      await s.setAutoCommit(false)
      await s.execute('SELECT 1', { maxRows: 10 })
      expect(s.transactionState().inTransaction).toBe(true)
      await s.setSchema('rv_tx')
      await s.setReadOnly(true)
      await s.rollback()
      const { results } = await s.execute('SHOW search_path; SHOW default_transaction_read_only', { maxRows: 10 })
      expect(s.schema).toBe('rv_tx')
      // Before the fix: search_path is back to "$user", public and read-only is off, while the session reports rv_tx.
      expect(results[0]?.rows).toEqual([['rv_tx, public']])
      expect(results[1]?.rows).toEqual([['on']])
    })
  })
})
