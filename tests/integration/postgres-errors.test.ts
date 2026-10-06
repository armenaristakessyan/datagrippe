// Error / value mapping of the PostgreSQL console session.
import { describe, expect, it } from 'vitest'
import { withSession } from './helpers/pg'

describe('pg review: error mapping and values', () => {
  it('a statement failing with SQLSTATE 3D000 is a statement error, not a lost connection', async () => {
    await withSession(async (s) => {
      // Before the fix: execute() throws DriverError{kind:'connection', code:'3D000'} although the session is fine;
      // the renderer then forgets the session id (consoles.ts) and the backend connection leaks.
      const outcome = await s.execute('DROP DATABASE dg_rv_pg_does_not_exist', {
        maxRows: 10,
      })
      expect(outcome.results[0]?.kind).toBe('error')
      expect(outcome.results[0]?.error).toMatchObject({
        code: '3D000',
        kind: 'database',
      })
    })
  })

  it('an 08xxx SQLSTATE raised by user code (dblink / fdw / RAISE) is a statement error', async () => {
    await withSession(async (s) => {
      const outcome = await s.execute(`DO $$ BEGIN RAISE EXCEPTION 'remote failed' USING ERRCODE = '08001'; END $$`, {
        maxRows: 10,
      })
      expect(outcome.results[0]?.error).toMatchObject({
        code: '08001',
        kind: 'database',
      })
    })
  })

  it('keeps the PL/pgSQL context of an error raised inside a function', async () => {
    await withSession(async (s) => {
      await s.execute(`CREATE FUNCTION pg_temp.boom() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1 / 0; END $$`, {
        maxRows: 10,
      })
      const { results } = await s.execute('SELECT pg_temp.boom()', {
        maxRows: 10,
      })
      expect(results[0]?.error?.code).toBe('22012')
      // Before the fix, the server "where" field (PL/pgSQL function pg_temp_N.boom() line 1 at RETURN) is dropped.
      expect(JSON.stringify(results[0]?.error)).toContain('PL/pgSQL function')
    })
  })

  it('COPY to a server-side file whose name contains "stdout" is not rejected as COPY TO STDOUT', async () => {
    await withSession(async (s) => {
      const { results } = await s.execute(`COPY (SELECT 1) TO '/tmp/stdout.csv'`, { maxRows: 10 })
      // Before the fix: rejected client-side with "COPY FROM STDIN / TO STDOUT is not supported in the console".
      expect(results[0]?.error?.kind).not.toBe('invalid-input')
      expect(results[0]?.kind).toBe('command')
    })
  })

  it('names int2vector / oidvector columns by their own type, not as arrays', async () => {
    await withSession(async (s) => {
      const { results } = await s.execute(`SELECT '1 2'::int2vector AS iv, '1 2'::oidvector AS ov`, { maxRows: 10 })
      expect(results[0]?.rows).toEqual([['1 2', '1 2']])
      // Before the fix: 'int2[]' / 'oid[]' although the value is not in array syntax.
      expect(results[0]?.columns.map((c) => c.dataType)).toEqual(['int2vector', 'oidvector'])
    })
  })
})
