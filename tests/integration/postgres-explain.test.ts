// EXPLAIN must never change data nor break the user's transaction.
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { adminClient, withSession } from './helpers/pg'

let admin: pg.Client

describe('pg review: explain', () => {
  beforeAll(async () => {
    admin = adminClient()
    await admin.connect()
    await admin.query(`SET lock_timeout = '5s'`)
  })
  afterAll(async () => {
    await admin.query('DROP SCHEMA IF EXISTS rv_ex CASCADE')
    await admin.end()
  })
  beforeEach(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS rv_ex CASCADE; CREATE SCHEMA rv_ex;
      CREATE TABLE rv_ex.t (id int PRIMARY KEY); INSERT INTO rv_ex.t VALUES (1), (2), (3);
      CREATE FUNCTION rv_ex.purge() RETURNS int LANGUAGE sql AS $$ DELETE FROM rv_ex.t RETURNING 1 $$`)
  })

  it('EXPLAIN ANALYZE of a SELECT that calls a data-modifying function leaves data unchanged', async () => {
    await withSession(async (s) => {
      await s.explain('SELECT rv_ex.purge()', true)
    })
    // Before the fix: 0 — the rows were deleted for real by "explain analyze".
    expect(Number((await admin.query('SELECT count(*) AS n FROM rv_ex.t')).rows[0]?.n)).toBe(3)
  })

  it('a failing EXPLAIN inside an open manual transaction does not abort that transaction', async () => {
    await withSession(async (s) => {
      await s.setAutoCommit(false)
      await s.execute('INSERT INTO rv_ex.t VALUES (4)', { maxRows: 10 })
      await expect(s.explain('SELECT * FROM rv_ex.no_such_table', false)).rejects.toMatchObject({ info: { code: '42P01' } })
      const { results } = await s.execute('SELECT count(*)::int FROM rv_ex.t', {
        maxRows: 10,
      })
      // Before the fix: "current transaction is aborted, commands ignored until end of transaction block".
      expect(results[0]?.error?.message).toBeUndefined()
      expect(results[0]?.rows).toEqual([[4]])
      await s.rollback()
    })
  })
})
