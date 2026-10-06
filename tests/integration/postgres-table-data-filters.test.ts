// Table data editor (metadata pool) defects.
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postgresDriver } from '../../src/main/db/postgres'
import type { MetadataProvider } from '../../src/main/db/types'
import type { TableRef } from '../../src/shared/types'
import { testPgConnection } from '../setup/postgres'
import { TEST_PG } from '../test-env'
import { adminClient } from './helpers/pg'

const ref = (name: string): TableRef => ({
  connectionId: 'review',
  database: TEST_PG.database,
  schema: 'rv_td',
  name,
})

describe('pg review: table data', () => {
  let admin: pg.Client
  let md: MetadataProvider
  beforeAll(async () => {
    admin = adminClient()
    await admin.connect()
    await admin.query(`DROP SCHEMA IF EXISTS rv_td CASCADE; CREATE SCHEMA rv_td;
      CREATE TABLE rv_td.big AS SELECT g AS id FROM generate_series(1, 100) g; ALTER TABLE rv_td.big ADD PRIMARY KEY (id);
      CREATE TABLE rv_td.small (id int PRIMARY KEY); INSERT INTO rv_td.small VALUES (1), (2)`)
    md = await postgresDriver.openMetadata(testPgConnection())
  })
  afterAll(async () => {
    await md.close()
    await admin.query('DROP SCHEMA IF EXISTS rv_td CASCADE')
    await admin.end()
  })

  it('a filter ending with a line comment works', async () => {
    // Before the fix: "syntax error at end of input" — the comment swallows ") ORDER BY … LIMIT … OFFSET …".
    const page = await md.fetchTableData(
      {
        table: ref('big'),
        offset: 0,
        limit: 5,
        where: 'id > 95 -- the last ones',
      },
      false,
    )
    expect(page.rows.map((r) => r[0])).toEqual([96, 97, 98, 99, 100])
    expect(
      await md.countTableData({
        table: ref('big'),
        where: 'id > 95 -- the last ones',
      }),
    ).toBe(5)
  })

  it('reports filter error positions relative to the filter text', async () => {
    const error = await md.fetchTableData({ table: ref('big'), offset: 0, limit: 5, where: 'id >> 5 x' }, false).then(
      () => null,
      (e: { info: { position?: number } }) => e,
    )
    // "x" is the 9th character of the filter; before the fix the position was 38 (offset inside the generated SELECT),
    // which ErrorDetail shows verbatim as "position 38".
    expect(error?.info.position === undefined || error.info.position === 9).toBe(true)
  })

  it('slow table-editor queries do not starve the explorer', async () => {
    const slow = Array.from({ length: 4 }, () =>
      md
        .fetchTableData(
          {
            table: ref('small'),
            offset: 0,
            limit: 10,
            where: 'pg_sleep(1) IS NOT NULL',
          },
          false,
        )
        .catch(() => undefined),
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    const started = Date.now()
    await md.listObjects(TEST_PG.database, 'public')
    const waited = Date.now() - started
    await Promise.all(slow)
    // Before the fix ≈ 1.9 s: all POOL_MAX (4) connections are held by the filters, which have no timeout and no cancel.
    expect(waited).toBeLessThan(500)
  })
})
