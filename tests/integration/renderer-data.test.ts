// Driver facts the renderer's data helpers rely on, checked against real PostgreSQL results. The
// renderer logic itself is unit-tested next to it (src/renderer/src/components/{grid,results}); this
// file only imports main/shared code so it type-checks in the node project.
//  - result-meta.errorLocation: error.position counts characters (code points), not UTF-16 units.
//  - result-meta.inferTableName: ColumnMeta.table may be the bare relname, so a schema-qualified
//    FROM must win over it.
//  - column-types.columnKind: bit(n) / bit varying values are bit strings ('1', '0110'), submitted as
//    text — a JS boolean would be rejected ('"f" is not a valid binary digit').
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postgresDriver } from '../../src/main/db/postgres'
import type { DriverSession, MetadataProvider } from '../../src/main/db/types'
import { testPgConnection } from '../setup/postgres'
import { TEST_PG } from '../test-env'

describe('PostgreSQL results as the renderer data helpers expect them', () => {
  let session: DriverSession
  let metadata: MetadataProvider
  const bits = { connectionId: 'rd', database: TEST_PG.database, schema: 'public', name: 'rd_bits' }

  beforeAll(async () => {
    session = await postgresDriver.openSession(testPgConnection(), TEST_PG.database)
    metadata = await postgresDriver.openMetadata(testPgConnection())
    await session.execute("DROP TABLE IF EXISTS public.rd_bits; CREATE TABLE public.rd_bits (id int PRIMARY KEY, b bit(1), v bit varying(8)); INSERT INTO public.rd_bits VALUES (1, B'1', B'101')", {
      maxRows: 10,
    })
  })

  afterAll(async () => {
    await session?.execute('DROP TABLE IF EXISTS public.rd_bits', { maxRows: 10 })
    await session?.close()
    await metadata?.close()
  })

  it('reports error positions in characters (astral characters count once)', async () => {
    const sql = "SELECT '😀😀😀' AS e, nope FROM public.customers"
    const { results } = await session.execute(sql, { maxRows: 10 })
    const failed = results.find((r) => r.kind === 'error')
    // 'nope' starts at character 24 (1-based); in UTF-16 units it would be 27
    expect(failed?.error?.position).toBe([...sql.slice(0, sql.indexOf('nope'))].length + 1)
  })

  it('reports a column source table without its schema', async () => {
    const { results } = await session.execute('SELECT * FROM sales.orders', { maxRows: 5 })
    const result = results[0]!
    expect(result.kind).toBe('rows')
    const tables = new Set(result.columns.map((c) => c.table))
    expect(tables.size).toBe(1)
    // bare or qualified, it names the orders table; the renderer qualifies it from the SQL text
    expect([...tables][0]).toMatch(/^(sales\.)?orders$/)
  })

  it('returns bit strings for bit(n) / bit varying and accepts typed bit strings back', async () => {
    const page = await metadata.fetchTableData({ table: bits, offset: 0, limit: 10 }, false)
    expect(page.rows[0]).toEqual([1, '1', '101'])
    // what the grid submits for a typed '0' / '0110' (text, never a JS boolean)
    await metadata.applyChanges(bits, [{ type: 'update', key: { id: 1 }, values: { b: '0', v: '0110' } }])
    const after = await metadata.fetchTableData({ table: bits, offset: 0, limit: 10 }, false)
    expect(after.rows[0]).toEqual([1, '0', '0110'])
  })
})
