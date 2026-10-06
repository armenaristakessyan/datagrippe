import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DriverError } from '../../src/main/db/errors'
import { postgresDriver } from '../../src/main/db/postgres'
import type { MetadataProvider } from '../../src/main/db/types'
import type { RowChange, TableRef } from '../../src/shared/types'
import { testPgConnection } from '../setup/postgres'
import { TEST_PG } from '../test-env'

const ref = (schema: string, name: string): TableRef => ({ connectionId: 'test-pg', database: TEST_PG.database, schema, name })

async function driverError(promise: Promise<unknown>): Promise<DriverError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(DriverError)
  return error as DriverError
}

describe('postgres driver: table data', () => {
  let metadata: MetadataProvider

  beforeAll(async () => {
    metadata = await postgresDriver.openMetadata(testPgConnection())
  })

  afterAll(async () => {
    await metadata.close()
  })

  it('orders by the primary key when no sort is given', async () => {
    await metadata.applyChanges(ref('public', 'customers'), [{ type: 'update', key: { id: 1 }, values: { name: 'Ada Lovelace' } }])
    const page = await metadata.fetchTableData({ table: ref('public', 'customers'), offset: 0, limit: 10 }, false)
    expect(page.sql).toBe('SELECT * FROM public.customers ORDER BY id LIMIT 11 OFFSET 0')
    expect(page.rows.map((r) => r[0])).toEqual([1, 2, 3, 4, 5])
  })

  it('pages through a table with ordering', async () => {
    const page = await metadata.fetchTableData(
      { table: ref('public', 'events'), offset: 0, limit: 100, orderBy: [{ column: 'id', direction: 'desc' }] },
      false,
    )
    expect(page.rows).toHaveLength(100)
    expect(page.rows[0]?.[0]).toBe('10000')
    expect(page.rows[99]?.[0]).toBe('9901')
    expect(page).toMatchObject({ offset: 0, hasMore: true, primaryKey: ['id'], editable: true })
    expect(page.readOnlyReason).toBeUndefined()
    expect(page.sql).toBe('SELECT * FROM public.events ORDER BY id DESC LIMIT 101 OFFSET 0')
    expect(page.columns).toEqual([
      { name: 'id', dataType: 'int8', table: 'events', nullable: false },
      { name: 'kind', dataType: 'text', table: 'events', nullable: false },
      { name: 'occurred_at', dataType: 'timestamptz', table: 'events', nullable: false },
      { name: 'value', dataType: 'int4', table: 'events', nullable: true },
    ])
    expect(page.durationMs).toBeGreaterThanOrEqual(0)

    const last = await metadata.fetchTableData({ table: ref('public', 'events'), offset: 9950, limit: 100, orderBy: [{ column: 'id', direction: 'asc' }] }, false)
    expect(last.rows).toHaveLength(50)
    expect(last.hasMore).toBe(false)
    expect(last.rows[49]?.[0]).toBe('10000')
  })

  it('filters with a WHERE clause and counts', async () => {
    const request = { table: ref('public', 'events'), where: "kind = 'click'" }
    expect(await metadata.countTableData(request)).toBe(3333)
    expect(await metadata.countTableData({ table: ref('public', 'events') })).toBe(10_000)
    const page = await metadata.fetchTableData({ ...request, offset: 3300, limit: 100, orderBy: [{ column: 'value', direction: 'asc' }] }, false)
    expect(page.rows).toHaveLength(33)
    expect(page.hasMore).toBe(false)
    expect(page.rows.every((r) => r[1] === 'click')).toBe(true)
    expect(page.sql).toBe("SELECT * FROM public.events WHERE (kind = 'click') ORDER BY value ASC LIMIT 101 OFFSET 3300")
  })

  it('reports SQL errors in the WHERE clause', async () => {
    const error = await driverError(metadata.fetchTableData({ table: ref('public', 'events'), offset: 0, limit: 10, where: 'nope = 1' }, false))
    expect(error.info).toMatchObject({ kind: 'database', code: '42703' })
    const countError = await driverError(metadata.countTableData({ table: ref('public', 'events'), where: 'nope = 1' }))
    expect(countError.info.code).toBe('42703')
  })

  it('a WHERE clause cannot write or smuggle statements', async () => {
    const before = await metadata.countTableData({ table: ref('public', 'audit_log') })
    const smuggled = await driverError(
      metadata.fetchTableData({ table: ref('public', 'audit_log'), offset: 0, limit: 10, where: 'true); DELETE FROM public.audit_log; SELECT (true' }, true),
    )
    expect(smuggled.info.kind).toBe('database')
    const writing = await driverError(
      metadata.fetchTableData({ table: ref('public', 'audit_log'), offset: 0, limit: 10, where: "nextval('public.invoice_seq') > 0" }, true),
    )
    expect(writing.info.code).toBe('25006')
    expect(await metadata.countTableData({ table: ref('public', 'audit_log') })).toBe(before)
  })

  it('explains why a page is not editable', async () => {
    const view = await metadata.fetchTableData({ table: ref('public', 'active_customers'), offset: 0, limit: 10 }, false)
    expect(view).toMatchObject({ editable: false, readOnlyReason: 'Views are read-only', primaryKey: [] })
    expect(view.rows).toHaveLength(4)

    const matview = await metadata.fetchTableData({ table: ref('sales', 'monthly_totals'), offset: 0, limit: 10 }, false)
    expect(matview).toMatchObject({ editable: false, readOnlyReason: 'Materialized views are read-only' })

    const noKey = await metadata.fetchTableData({ table: ref('public', 'audit_log'), offset: 0, limit: 10 }, false)
    expect(noKey).toMatchObject({ editable: false, readOnlyReason: 'Table has no primary key' })
    expect(noKey.columns.find((c) => c.name === 'payload')?.dataType).toBe('json')

    const readOnly = await metadata.fetchTableData({ table: ref('public', 'customers'), offset: 0, limit: 10 }, true)
    expect(readOnly).toMatchObject({ editable: false, readOnlyReason: 'Read-only connection', primaryKey: ['id'] })

    const partitioned = await metadata.fetchTableData({ table: ref('public', 'measurements'), offset: 0, limit: 5 }, false)
    expect(partitioned).toMatchObject({ editable: true, primaryKey: ['sensor_id', 'measured_on'], hasMore: true })

    const composite = await metadata.fetchTableData({ table: ref('sales', 'order_items'), offset: 0, limit: 50 }, false)
    expect(composite.primaryKey).toEqual(['order_id', 'line_no'])
    expect(composite.columns.find((c) => c.name === 'status')).toBeUndefined()
  })

  it('validates paging and unknown tables', async () => {
    expect((await driverError(metadata.fetchTableData({ table: ref('public', 'events'), offset: -1, limit: 10 }, false))).info.kind).toBe(
      'invalid-input',
    )
    expect((await driverError(metadata.fetchTableData({ table: ref('public', 'events'), offset: 0, limit: 0 }, false))).info.kind).toBe(
      'invalid-input',
    )
    expect((await driverError(metadata.fetchTableData({ table: ref('public', 'nope'), offset: 0, limit: 10 }, false))).info.kind).toBe(
      'not-found',
    )
  })

  it('quotes mixed-case and reserved identifiers', async () => {
    const page = await metadata.fetchTableData(
      { table: ref('public', 'Mixed Case Table'), offset: 0, limit: 10, where: '"Weird Column" IS NOT NULL', orderBy: [{ column: 'order', direction: 'desc' }] },
      false,
    )
    expect(page.sql).toBe(
      'SELECT * FROM public."Mixed Case Table" WHERE ("Weird Column" IS NOT NULL) ORDER BY "order" DESC LIMIT 11 OFFSET 0',
    )
    expect(page.columns.map((c) => c.name)).toEqual(['id', 'Weird Column', 'order'])
    expect(page.rows).toEqual([
      [2, "it's quoted", 2],
      [1, 'first', 1],
    ])
    expect(page.editable).toBe(true)
  })

  it('applies inserts, updates and deletes in one transaction', async () => {
    const table = ref('public', 'Mixed Case Table')
    const changes: RowChange[] = [
      { type: 'insert', values: { id: { $default: true }, 'Weird Column': 'new row', order: 10 } },
      { type: 'insert', values: { id: { $default: true }, 'Weird Column': { $default: true }, order: { $default: true } } },
      { type: 'update', key: { id: 1 }, values: { 'Weird Column': "it's changed", order: 100 } },
      { type: 'delete', key: { id: 3 } },
    ]
    const preview = await metadata.previewChanges(table, changes)
    expect(preview).toEqual([
      `INSERT INTO public."Mixed Case Table" ("Weird Column", "order") VALUES ('new row', 10);`,
      'INSERT INTO public."Mixed Case Table" DEFAULT VALUES;',
      `UPDATE public."Mixed Case Table" SET "Weird Column" = 'it''s changed', "order" = 100 WHERE id = 1;`,
      'DELETE FROM public."Mixed Case Table" WHERE id = 3;',
    ])
    const result = await metadata.applyChanges(table, changes)
    expect(result).toEqual({ affected: 4, statements: preview })

    const page = await metadata.fetchTableData({ table, offset: 0, limit: 10, orderBy: [{ column: 'id', direction: 'asc' }] }, false)
    expect(page.rows).toEqual([
      [1, "it's changed", 100],
      [2, "it's quoted", 2],
      [4, 'new row', 10],
      [5, null, null],
    ])
  })

  it('rolls everything back when a key matches no row', async () => {
    const table = ref('public', 'Mixed Case Table')
    const before = await metadata.countTableData({ table })
    const error = await driverError(
      metadata.applyChanges(table, [
        { type: 'insert', values: { 'Weird Column': 'should vanish' } },
        { type: 'update', key: { id: 1 }, values: { order: -1 } },
        { type: 'delete', key: { id: 99999 } },
      ]),
    )
    expect(error.info.kind).toBe('invalid-input')
    expect(error.info.message).toContain('id = 99999')
    expect(await metadata.countTableData({ table })).toBe(before)
    expect(await metadata.countTableData({ table, where: `"Weird Column" = 'should vanish' OR "order" = -1` })).toBe(0)
  })

  it('rejects unknown columns, missing keys and failing statements', async () => {
    const table = ref('public', 'Mixed Case Table')
    const unknown = await driverError(metadata.applyChanges(table, [{ type: 'update', key: { id: 1 }, values: { nope: 1 } }]))
    expect(unknown.info).toMatchObject({ kind: 'invalid-input' })
    expect(unknown.info.message).toContain('nope')
    const noKey = await driverError(metadata.applyChanges(table, [{ type: 'delete', key: {} }]))
    expect(noKey.info.kind).toBe('invalid-input')
    const failing = await driverError(metadata.applyChanges(ref('public', 'big_numbers'), [{ type: 'insert', values: { id: 1 } }]))
    expect(failing.info).toMatchObject({ kind: 'database', code: '23505' })
  })

  it('round-trips exact numeric, bigint, json, bytea and array values', async () => {
    const table = ref('public', 'big_numbers')
    await metadata.applyChanges(table, [
      { type: 'update', key: { id: 4 }, values: { big: '9223372036854775806', exact: '12345678901234567890.0123456789', ratio: 'NaN', tiny: 7 } },
    ])
    const page = await metadata.fetchTableData({ table, offset: 0, limit: 10, where: 'id = 4' }, false)
    expect(page.rows).toEqual([[4, '9223372036854775806', '12345678901234567890.0123456789', 'NaN', null, 7]])
    await metadata.applyChanges(table, [{ type: 'update', key: { id: 4 }, values: { big: null, exact: null, ratio: 0.1, tiny: null } }])

    const customers = ref('public', 'customers')
    await metadata.applyChanges(customers, [
      { type: 'update', key: { id: 4 }, values: { preferences: '{"a": [1, 2]}', avatar: '\\x0102', tags: '{x,"y z"}', is_active: false } },
    ])
    const row = await metadata.fetchTableData({ table: customers, offset: 0, limit: 1, where: 'id = 4' }, false)
    const value = (name: string) => row.rows[0]?.[row.columns.findIndex((c) => c.name === name)]
    expect(value('preferences')).toBe('{"a": [1, 2]}')
    expect(value('avatar')).toBe('\\x0102')
    expect(value('tags')).toBe('{x,"y z"}')
    expect(value('is_active')).toBe(false)
    await metadata.applyChanges(customers, [
      { type: 'update', key: { id: 4 }, values: { preferences: null, avatar: '\\x00ff', tags: null, is_active: true } },
    ])
  })

  it('applies changes on composite keys', async () => {
    const table = ref('sales', 'order_items')
    const result = await metadata.applyChanges(table, [
      { type: 'update', key: { order_id: 1, line_no: 2 }, values: { quantity: 3 } },
    ])
    expect(result.statements).toEqual(['UPDATE sales.order_items SET quantity = 3 WHERE order_id = 1 AND line_no = 2;'])
    const page = await metadata.fetchTableData({ table, offset: 0, limit: 1, where: 'order_id = 1 AND line_no = 2' }, false)
    expect(page.rows[0]?.slice(3, 6)).toEqual([3, '10.00', '30.00'])
    await metadata.applyChanges(table, [{ type: 'update', key: { order_id: 1, line_no: 2 }, values: { quantity: 2 } }])
  })
})
