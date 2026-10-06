// What the drivers report about where an error is, which the editor maps onto the console text
// (src/renderer/src/components/editor/error-mapping.ts, unit-tested with these facts):
// - PostgreSQL counts `position` in characters (code points), not UTF-16 units: an emoji before the error
//   must not shift the marker.
// - SQL Server: an error raised inside a procedure carries the procedure's line, which must not be
//   reported as a line of the calling batch.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mssqlDriver } from '../../src/main/db/mssql'
import { postgresDriver } from '../../src/main/db/postgres'
import type { DriverSession } from '../../src/main/db/types'
import { mssqlTestConnection } from '../setup/mssql'
import { testPgConnection } from '../setup/postgres'
import { TEST_MSSQL, TEST_PG } from '../test-env'

const only = process.env.DATAGRIPPE_TEST_DB
const pgSuite = !only || only === 'postgres' ? describe : describe.skip
const msSuite = !only || only === 'mssql' ? describe : describe.skip

pgSuite('PostgreSQL error position', () => {
  let session: DriverSession
  beforeAll(async () => {
    session = await postgresDriver.openSession(testPgConnection(), TEST_PG.database)
  })
  afterAll(async () => {
    await session?.close()
  })

  it('counts code points, so astral characters before the error do not shift it', async () => {
    const text = "SELECT '🚀🚀🚀' AS rockets, no_such_column FROM sales.orders"
    const execution = await session.execute(text, { maxRows: 10 })
    const error = execution.results[0]?.error
    expect(error?.message).toMatch(/no_such_column/)
    // 1-based position in code points
    expect(error?.position).toBe([...text.slice(0, text.indexOf('no_such_column'))].length + 1)
  })
})

msSuite('SQL Server error inside a procedure', () => {
  let session: DriverSession
  beforeAll(async () => {
    session = await mssqlDriver.openSession(mssqlTestConnection(), TEST_MSSQL.database)
    await session.execute(
      'CREATE OR ALTER PROCEDURE dbo.dg_error_line_fails AS\nBEGIN\n  SET NOCOUNT ON\n  DECLARE @x int = 1\n  SELECT 1 / 0 AS boom\nEND',
      { maxRows: 10 },
    )
  })
  afterAll(async () => {
    await session?.execute('DROP PROCEDURE IF EXISTS dbo.dg_error_line_fails', { maxRows: 10 })
    await session?.close()
  })

  it('reports the line inside the procedure, not as a line of the calling batch', async () => {
    const text = 'SELECT 1 AS first_line\nSELECT 2 AS second_line\nEXEC dbo.dg_error_line_fails\nSELECT 4 AS last_line'
    const execution = await session.execute(text, { maxRows: 10 })
    const failed = execution.results.find((r) => r.kind === 'error')
    expect(failed?.error?.message).toMatch(/Divide by zero/)
    // No batch line that would underline an unrelated statement (or the EXEC line itself).
    expect([undefined, 3]).toContain(failed?.error?.line)
    expect(failed?.error?.detail ?? '').toMatch(/dg_error_line_fails/)
  })
})
