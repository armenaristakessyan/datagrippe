// SQL Server metadata provider: explorer listings, structure, DDL, completion and the data editor.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TableRef } from '@shared/types'
import { DriverError } from '../../src/main/db/errors'
import { mssqlDriver } from '../../src/main/db/mssql'
import type { DriverSession, MetadataProvider } from '../../src/main/db/types'
import { TEST_MSSQL } from '../test-env'
import { mssqlTestConnection as mssqlConnection } from '../setup/mssql'

const DB = TEST_MSSQL.database

const TEST_DB = TEST_MSSQL.database
const only = process.env.DATAGRIPPE_TEST_DB
const suite = !only || only === 'mssql' ? describe : describe.skip

const SCRATCH = 'scratch_ddl'

async function caught(promise: Promise<unknown>): Promise<DriverError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof DriverError) return error
    throw error
  }
  throw new Error('Expected the promise to reject')
}

const ref = (schema: string, name: string): TableRef => ({ connectionId: 'mssql-test', database: TEST_DB, schema, name })

suite('mssql metadata', () => {
  let meta: MetadataProvider
  let session: DriverSession

  beforeAll(async () => {
    // Metadata connects to master: every catalog read must target the requested database explicitly.
    meta = await mssqlDriver.openMetadata(mssqlConnection({ database: 'master' }))
    session = await mssqlDriver.openSession(mssqlConnection(), TEST_DB)
  })

  afterAll(async () => {
    await session?.execute(
      `DECLARE @sql nvarchar(max) = N'';
       SELECT @sql += N'ALTER TABLE ' + QUOTENAME(s.name) + N'.' + QUOTENAME(t.name) + N' DROP CONSTRAINT ' + QUOTENAME(fk.name) + N';'
       FROM sys.foreign_keys fk JOIN sys.tables t ON t.object_id = fk.parent_object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
       WHERE s.name = N'${SCRATCH}';
       SELECT @sql += N'DROP TABLE ' + QUOTENAME(s.name) + N'.' + QUOTENAME(t.name) + N';'
       FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = N'${SCRATCH}';
       SELECT @sql += N'DROP SEQUENCE ' + QUOTENAME(s.name) + N'.' + QUOTENAME(o.name) + N';'
       FROM sys.sequences o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = N'${SCRATCH}';
       SELECT @sql += N'DROP TYPE ' + QUOTENAME(s.name) + N'.' + QUOTENAME(t.name) + N';'
       FROM sys.types t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE t.is_user_defined = 1 AND s.name = N'${SCRATCH}';
       EXEC (@sql);
       IF SCHEMA_ID(N'${SCRATCH}') IS NOT NULL EXEC (N'DROP SCHEMA ${SCRATCH}');`,
      { maxRows: 1 },
    )
    await session?.close()
    await meta?.close()
  })

  it('reports server info', async () => {
    const info = await meta.serverInfo()
    expect(info.dialect).toBe('mssql')
    expect(info.currentDatabase).toBe('master')
    expect(info.versionShort).toMatch(/^\d+\./)
  })

  it('lists databases, hiding system databases unless asked', async () => {
    const user = await meta.listDatabases(false)
    expect(user.map((db) => db.name)).toContain(TEST_DB)
    expect(user.some((db) => db.name === 'master')).toBe(false)
    expect(user.find((db) => db.name === TEST_DB)?.sizeBytes).toBeGreaterThan(0)

    const all = await meta.listDatabases(true)
    for (const name of ['master', 'tempdb', 'model', 'msdb']) {
      expect(all.find((db) => db.name === name)?.isSystem).toBe(true)
    }
    expect(all.find((db) => db.name === TEST_DB)?.isSystem).toBe(false)
  })

  it('lists schemas, hiding system and fixed role schemas unless asked', async () => {
    const user = await meta.listSchemas(TEST_DB, false)
    expect(user.map((s) => s.name)).toEqual(['dbo', 'sales'])
    expect(user[0]?.owner).toBe('dbo')

    const all = await meta.listSchemas(TEST_DB, true)
    const names = all.map((s) => s.name)
    for (const name of ['sys', 'INFORMATION_SCHEMA', 'guest', 'db_owner', 'db_datareader']) {
      expect(names).toContain(name)
      expect(all.find((s) => s.name === name)?.isSystem).toBe(true)
    }
    expect(all.find((s) => s.name === 'dbo')?.isSystem).toBe(false)
  })

  it('rejects unknown databases', async () => {
    const error = await caught(meta.listSchemas('no_such_db', false))
    expect(error.info.kind).toBe('not-found')
  })

  it('lists objects of every kind sorted by kind then name', async () => {
    const dbo = await meta.listObjects(TEST_DB, 'dbo')
    expect(dbo.map((o) => `${o.kind}:${o.name}`)).toEqual([
      'table:audit_log',
      'table:big_numbers',
      'table:customers',
      'table:events',
      'table:Mixed Case Table',
      'view:active_customers',
      'sequence:invoice_seq',
      'type:email_address',
      'type:id_list',
    ])
    const customers = dbo.find((o) => o.name === 'customers')
    expect(customers).toMatchObject({ schema: 'dbo', comment: 'People who buy things', rowEstimate: 3 })
    expect(customers?.identity).toMatch(/^\d+$/)
    expect(dbo.find((o) => o.name === 'events')?.rowEstimate).toBe(10_000)

    const sales = await meta.listObjects(TEST_DB, 'sales')
    expect(sales.map((o) => `${o.kind}:${o.name}`)).toEqual([
      'table:order_items',
      'table:orders',
      'function:customer_total',
      'function:orders_since',
      'procedure:archive_orders',
    ])
    expect(sales.find((o) => o.name === 'customer_total')).toMatchObject({
      signature: '(@customer_id int)',
      returnType: 'decimal(14,2)',
    })
    expect(sales.find((o) => o.name === 'orders_since')).toMatchObject({
      signature: '(@since datetime2(7))',
      returnType: 'TABLE',
    })
    expect(sales.find((o) => o.name === 'archive_orders')?.signature).toBe(
      '(@before datetime2(7), @dry_run bit, @archived int OUTPUT)',
    )
  })

  it('describes a table with columns, keys, indexes, constraints and size', async () => {
    const details = await meta.tableDetails(TEST_DB, 'dbo', 'customers')
    expect(details).toMatchObject({ schema: 'dbo', name: 'customers', kind: 'table', comment: 'People who buy things' })
    expect(details.rowEstimate).toBe(3)
    expect(details.sizeBytes).toBeGreaterThan(0)
    expect(details.primaryKey).toEqual(['id'])

    const column = (name: string) => details.columns.find((c) => c.name === name)
    expect(column('id')).toMatchObject({ ordinal: 1, dataType: 'int', nullable: false, isPrimaryKey: true, isIdentity: true })
    expect(column('email')).toMatchObject({ dataType: 'nvarchar(255)', comment: 'Login e-mail, unique', isPrimaryKey: false })
    expect(column('full_name')?.dataType).toBe('varchar(100)')
    expect(column('is_active')).toMatchObject({ dataType: 'bit', defaultValue: '((1))' })
    expect(column('credit_limit')).toMatchObject({ dataType: 'decimal(12,2)', nullable: true })
    expect(column('created_at')?.dataType).toBe('datetime2(7)')
    expect(column('last_seen')?.dataType).toBe('datetimeoffset(7)')
    expect(column('preferred_time')?.dataType).toBe('time(7)')
    expect(column('external_id')).toMatchObject({ dataType: 'uniqueidentifier', defaultValue: '(newid())' })
    expect(column('avatar')?.dataType).toBe('varbinary(max)')
    expect(column('settings')?.dataType).toBe('nvarchar(max)')
    expect(column('display_name')).toMatchObject({ isGenerated: true, isIdentity: false })

    expect(details.indexes.map((i) => [i.name, i.method, i.isUnique, i.isPrimary, i.columns])).toEqual([
      ['PK_customers', 'CLUSTERED', true, true, ['id']],
      ['UQ_customers_email', 'NONCLUSTERED', true, false, ['email']],
    ])
    expect(details.indexes[0]?.definition).toBe('ALTER TABLE dbo.customers ADD CONSTRAINT PK_customers PRIMARY KEY CLUSTERED (id ASC)')

    const constraints = details.constraints.map((c) => `${c.type}:${c.name}`)
    expect(constraints).toEqual(
      expect.arrayContaining([
        'primary-key:PK_customers',
        'unique:UQ_customers_email',
        'check:CK_customers_settings_json',
        'default:DF_customers_is_active',
        'default:DF_customers_created_at',
        'default:DF_customers_external_id',
      ]),
    )
    expect(details.constraints.find((c) => c.name === 'CK_customers_settings_json')?.definition).toMatch(/^CHECK \(.*isjson/i)
    expect(details.foreignKeys).toEqual([])
    expect(details.referencedBy).toEqual([
      {
        name: 'FK_orders_customers',
        schema: 'sales',
        table: 'orders',
        columns: ['customer_id'],
        refSchema: 'dbo',
        refTable: 'customers',
        refColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE',
      },
    ])
    expect(details.triggers).toEqual([])
  })

  it('describes foreign keys, filtered indexes and triggers', async () => {
    const orders = await meta.tableDetails(TEST_DB, 'sales', 'orders')
    expect(orders.foreignKeys.map((fk) => [fk.name, fk.refTable, fk.onDelete])).toEqual([['FK_orders_customers', 'customers', 'CASCADE']])
    expect(orders.referencedBy.map((fk) => [fk.name, fk.schema, fk.table])).toEqual([['FK_order_items_orders', 'sales', 'order_items']])
    const index = orders.indexes.find((i) => i.name === 'IX_orders_customer')
    expect(index).toMatchObject({ method: 'NONCLUSTERED', isUnique: false, columns: ['customer_id', 'ordered_at'] })
    expect(index?.predicate).toBe("([status]<>'cancelled')")
    expect(index?.definition).toBe(
      "CREATE NONCLUSTERED INDEX IX_orders_customer ON sales.orders (customer_id ASC, ordered_at DESC) INCLUDE (total, status) WHERE ([status]<>'cancelled')",
    )
    expect(orders.triggers).toHaveLength(1)
    expect(orders.triggers[0]).toMatchObject({ name: 'trg_orders_touch', timing: 'AFTER', events: ['UPDATE'], enabled: true })
    expect(orders.triggers[0]?.definition).toMatch(/CREATE TRIGGER sales\.trg_orders_touch ON sales\.orders AFTER UPDATE/)
    expect(orders.constraints.filter((c) => c.type === 'check').map((c) => c.name)).toEqual(['CK_orders_status', 'CK_orders_total'])

    const items = await meta.tableDetails(TEST_DB, 'sales', 'order_items')
    expect(items.primaryKey).toEqual(['order_id', 'line_no'])
  })

  it('describes heaps, alias types, rowversion and views', async () => {
    const audit = await meta.tableDetails(TEST_DB, 'dbo', 'audit_log')
    expect(audit.primaryKey).toEqual([])
    expect(audit.indexes).toEqual([])
    expect(audit.columns.find((c) => c.name === 'actor')?.dataType).toBe('email_address')
    expect(audit.columns.find((c) => c.name === 'row_version')).toMatchObject({ dataType: 'timestamp', isGenerated: true })

    const view = await meta.tableDetails(TEST_DB, 'dbo', 'active_customers')
    expect(view.kind).toBe('view')
    expect(view.columns.map((c) => c.name)).toEqual(['id', 'email', 'full_name', 'credit_limit'])
    expect(view.rowEstimate).toBeUndefined()

    const mixed = await meta.tableDetails(TEST_DB, 'dbo', 'Mixed Case Table')
    expect(mixed.columns.map((c) => c.name)).toEqual(['Id', 'Weird Column', 'order'])
    expect(mixed.primaryKey).toEqual(['Id'])

    const missing = await caught(meta.tableDetails(TEST_DB, 'dbo', 'nope'))
    expect(missing.info.kind).toBe('not-found')
  })

  it('returns module definitions as DDL', async () => {
    expect(await meta.getDdl(TEST_DB, 'dbo', 'active_customers', 'view')).toMatch(/^CREATE VIEW dbo\.active_customers AS[\s\S]*\nGO\n$/)
    expect(await meta.getDdl(TEST_DB, 'sales', 'archive_orders', 'procedure')).toMatch(/^CREATE PROCEDURE sales\.archive_orders/)
    expect(await meta.getDdl(TEST_DB, 'sales', 'customer_total', 'function')).toMatch(/^CREATE FUNCTION sales\.customer_total/)
    const objects = await meta.listObjects(TEST_DB, 'sales')
    const tvf = objects.find((o) => o.name === 'orders_since')
    expect(await meta.getDdl(TEST_DB, 'sales', 'orders_since', 'function', tvf?.identity)).toMatch(/RETURNS TABLE/)
    const missing = await caught(meta.getDdl(TEST_DB, 'dbo', 'nope', 'view'))
    expect(missing.info.kind).toBe('not-found')
  })

  it('reconstructs table DDL that re-executes into another schema', async () => {
    const tables: [string, string][] = [
      ['dbo', 'customers'],
      ['sales', 'orders'],
      ['sales', 'order_items'],
      ['dbo', 'audit_log'],
      ['dbo', 'big_numbers'],
      ['dbo', 'events'],
      ['dbo', 'Mixed Case Table'],
    ]
    const names = new Map(tables.map(([schema, name]) => [name, schema]))
    const retarget = (ddl: string): string => {
      let text = ddl
      for (const [name, schema] of names) {
        const quoted = /^[A-Za-z_]\w*$/.test(name) && name !== 'order' ? name : `[${name}]`
        text = text.split(`${schema}.${quoted}`).join(`${SCRATCH}.${quoted}`)
      }
      // Table DDL carries the table's triggers, which live in the table's schema.
      return text.replace(/CREATE TRIGGER \w+\./g, `CREATE TRIGGER ${SCRATCH}.`)
    }

    const customersDdl = await meta.getDdl(TEST_DB, 'dbo', 'customers', 'table')
    expect(customersDdl).toContain('CREATE TABLE dbo.customers (')
    expect(customersDdl).toContain('id int IDENTITY(1,1) NOT NULL')
    expect(customersDdl).toContain('display_name AS (coalesce([full_name],CONVERT([varchar](100),[email])))')
    expect(customersDdl).toContain('external_id uniqueidentifier NOT NULL CONSTRAINT DF_customers_external_id DEFAULT (newid())')
    expect(customersDdl).toContain('CONSTRAINT PK_customers PRIMARY KEY CLUSTERED (id ASC)')
    expect(customersDdl).toContain('CONSTRAINT UQ_customers_email UNIQUE NONCLUSTERED (email ASC)')
    expect(customersDdl).toContain('CONSTRAINT CK_customers_settings_json CHECK')

    const ordersDdl = await meta.getDdl(TEST_DB, 'sales', 'orders', 'table')
    expect(ordersDdl).toContain(
      'ALTER TABLE sales.orders ADD CONSTRAINT FK_orders_customers FOREIGN KEY (customer_id) REFERENCES dbo.customers (id) ON DELETE CASCADE;',
    )
    expect(ordersDdl).toContain('CREATE NONCLUSTERED INDEX IX_orders_customer ON sales.orders')
    expect((await meta.getDdl(TEST_DB, 'dbo', 'audit_log', 'table'))).toContain('actor dbo.email_address NULL')

    const setup = await session.execute(`CREATE SCHEMA ${SCRATCH}`, { maxRows: 1 })
    expect(setup.results[0]?.kind).toBe('command')
    for (const [schema, name] of tables) {
      const ddl = retarget(await meta.getDdl(TEST_DB, schema, name, 'table'))
      const { results } = await session.execute(ddl, { maxRows: 1 })
      const errors = results.filter((r) => r.kind === 'error')
      expect(errors.map((r) => r.error?.message), ddl).toEqual([])

      const original = await meta.tableDetails(TEST_DB, schema, name)
      const copy = await meta.tableDetails(TEST_DB, SCRATCH, name)
      const shape = (d: typeof original) =>
        d.columns.map((c) => [c.name, c.dataType, c.nullable, c.isIdentity, c.isGenerated, c.defaultValue, c.isPrimaryKey])
      expect(shape(copy)).toEqual(shape(original))
      const indexShape = (d: typeof original) => d.indexes.map((i) => [i.name, i.method, i.isUnique, i.columns, i.predicate])
      expect(indexShape(copy)).toEqual(indexShape(original))
      expect(copy.constraints.map((c) => [c.type, c.name, c.definition])).toEqual(
        original.constraints.map((c) => [c.type, c.name, c.definition]),
      )
      expect(copy.triggers.map((t) => [t.name, t.timing, t.events, t.enabled])).toEqual(
        original.triggers.map((t) => [t.name, t.timing, t.events, t.enabled]),
      )
      expect(copy.foreignKeys.map((fk) => [fk.name, fk.columns, fk.refTable, fk.onDelete])).toEqual(
        original.foreignKeys.map((fk) => [fk.name, fk.columns, fk.refTable, fk.onDelete]),
      )
    }
  })

  it('reconstructs sequence and type DDL', async () => {
    const sequence = await meta.getDdl(TEST_DB, 'dbo', 'invoice_seq', 'sequence')
    expect(sequence).toBe(
      'CREATE SEQUENCE dbo.invoice_seq\n    AS bigint\n    START WITH 1000\n    INCREMENT BY 10\n    MINVALUE 1000\n    MAXVALUE 999999999\n    NO CYCLE\n    CACHE 20;\nGO\n',
    )
    expect(await meta.getDdl(TEST_DB, 'dbo', 'email_address', 'type')).toBe('CREATE TYPE dbo.email_address FROM nvarchar(320) NOT NULL;\nGO\n')
    const tableType = await meta.getDdl(TEST_DB, 'dbo', 'id_list', 'type')
    expect(tableType).toMatch(/^CREATE TYPE dbo\.id_list AS TABLE \(\n {4}id int NOT NULL,\n {4}note nvarchar\(50\) NULL,\n {4}PRIMARY KEY CLUSTERED \(id ASC\)\n\);\nGO\n$/)

    await session.execute(`IF SCHEMA_ID(N'${SCRATCH}') IS NULL EXEC (N'CREATE SCHEMA ${SCRATCH}')`, { maxRows: 1 })
    for (const ddl of [sequence, tableType, await meta.getDdl(TEST_DB, 'dbo', 'email_address', 'type')]) {
      const { results } = await session.execute(ddl.split('dbo.').join(`${SCRATCH}.`), { maxRows: 1 })
      expect(results.filter((r) => r.kind === 'error').map((r) => r.error?.message)).toEqual([])
    }
  })

  it('builds the completion catalog', async () => {
    const catalog = await meta.completionCatalog(TEST_DB, false)
    expect(catalog.database).toBe(TEST_DB)
    expect(catalog.defaultSchema).toBe('dbo')
    expect(catalog.schemas.map((s) => s.name)).toEqual(expect.arrayContaining(['dbo', 'sales']))
    expect(catalog.schemas.some((s) => s.name === 'sys')).toBe(false)
    const dbo = catalog.schemas.find((s) => s.name === 'dbo')
    const customers = dbo?.objects.find((o) => o.name === 'customers')
    expect(customers?.kind).toBe('table')
    expect(customers?.columns?.slice(0, 2)).toEqual([
      { name: 'id', dataType: 'int' },
      { name: 'email', dataType: 'nvarchar(255)' },
    ])
    expect(dbo?.objects.find((o) => o.name === 'active_customers')?.kind).toBe('view')
    const sales = catalog.schemas.find((s) => s.name === 'sales')
    expect(sales?.objects.find((o) => o.name === 'customer_total')).toMatchObject({ kind: 'function', signature: '(@customer_id int)' })
    expect(sales?.objects.find((o) => o.name === 'archive_orders')?.kind).toBe('procedure')
  })

  it('pages table data with where and order by', async () => {
    const first = await meta.fetchTableData({ table: ref('dbo', 'events'), offset: 0, limit: 50 }, false)
    expect(first.rows).toHaveLength(50)
    expect(first.hasMore).toBe(true)
    expect(first.primaryKey).toEqual(['id'])
    expect(first.editable).toBe(true)
    expect(first.rows[0]?.[0]).toBe(1)
    expect(first.columns.map((c) => c.dataType)).toEqual(['int', 'varchar', 'nvarchar', 'datetime2'])
    expect(first.rows[0]?.[3]).toBe('2024-01-01 00:00:01')
    expect(first.sql).toBe(`SELECT id, kind, payload, created_at FROM ${TEST_DB}.dbo.events ORDER BY id OFFSET 0 ROWS FETCH NEXT 51 ROWS ONLY`)

    const last = await meta.fetchTableData({ table: ref('dbo', 'events'), offset: 9990, limit: 50 }, false)
    expect(last.rows).toHaveLength(10)
    expect(last.hasMore).toBe(false)
    expect(last.offset).toBe(9990)

    const filtered = await meta.fetchTableData(
      { table: ref('dbo', 'events'), offset: 0, limit: 3, where: "kind = 'click'", orderBy: [{ column: 'id', direction: 'desc' }] },
      false,
    )
    expect(filtered.rows.map((r) => r[0])).toEqual([9999, 9996, 9993])

    expect(await meta.countTableData({ table: ref('dbo', 'events') })).toBe(10_000)
    expect(await meta.countTableData({ table: ref('dbo', 'events'), where: "kind = 'click'" })).toBe(3333)

    const badColumn = await caught(
      meta.fetchTableData({ table: ref('dbo', 'events'), offset: 0, limit: 1, orderBy: [{ column: 'nope', direction: 'asc' }] }, false),
    )
    expect(badColumn.info.kind).toBe('invalid-input')
    const badWhere = await caught(meta.fetchTableData({ table: ref('dbo', 'events'), offset: 0, limit: 1, where: 'nope = 1' }, false))
    expect(badWhere.info).toMatchObject({ kind: 'database', code: '207' })
  })

  it('normalizes table data values and reports editability', async () => {
    const customers = await meta.fetchTableData({ table: ref('dbo', 'customers'), offset: 0, limit: 10 }, false)
    const columns = customers.columns.map((c) => c.name)
    const ada = customers.rows[0] ?? []
    const value = (name: string) => ada[columns.indexOf(name)]
    expect(value('credit_limit')).toBe('1500.50')
    expect(value('balance')).toBe('1234.5678')
    expect(value('created_at')).toBe('2024-01-15 10:30:00.1234567')
    expect(value('last_seen')).toBe('2024-01-15 10:30:00.1234567 +02:00')
    expect(value('external_id')).toBe('6F9619FF-8B86-D011-B42D-00C04FC964FF')
    expect(value('avatar')).toBe('0x0102ABCDEF')
    expect(value('is_active')).toBe(true)
    expect(customers.columns.find((c) => c.name === 'email')).toMatchObject({ dataType: 'nvarchar', table: 'customers', nullable: false })

    const big = await meta.fetchTableData({ table: ref('dbo', 'big_numbers'), offset: 0, limit: 1 }, false)
    expect(big.rows[0]?.slice(0, 3)).toEqual([1, '9223372036854775807', '1234567890123456789012345678.1234567891'])

    const heap = await meta.fetchTableData({ table: ref('dbo', 'audit_log'), offset: 0, limit: 10 }, false)
    expect(heap).toMatchObject({ editable: false, readOnlyReason: 'The table has no primary key', primaryKey: [] })
    expect(heap.sql).toContain('ORDER BY (SELECT NULL)')
    expect(heap.columns.find((c) => c.name === 'actor')?.dataType).toBe('nvarchar')
    expect(heap.rows[0]?.[5]).toMatch(/^0x[0-9A-F]{16}$/)

    const view = await meta.fetchTableData({ table: ref('dbo', 'active_customers'), offset: 0, limit: 10 }, false)
    expect(view).toMatchObject({ editable: false, readOnlyReason: 'Views are not editable' })
    expect(view.rows).toHaveLength(2)

    const readOnly = await meta.fetchTableData({ table: ref('dbo', 'events'), offset: 0, limit: 1 }, true)
    expect(readOnly).toMatchObject({ editable: false, readOnlyReason: 'The connection is read-only' })

    const mixed = await meta.fetchTableData(
      { table: ref('dbo', 'Mixed Case Table'), offset: 0, limit: 10, orderBy: [{ column: 'order', direction: 'desc' }] },
      false,
    )
    expect(mixed.columns.map((c) => c.name)).toEqual(['Id', 'Weird Column', 'order'])
    expect(mixed.rows).toEqual([
      [2, 'second', 20],
      [1, 'first', 10],
      [3, null, null],
    ])
    expect(mixed.sql).toContain(`FROM ${DB}.dbo.[Mixed Case Table] ORDER BY [order] DESC`)
    expect(await meta.countTableData({ table: ref('dbo', 'Mixed Case Table'), where: '[order] >= 10' })).toBe(2)
  })

  it('previews changes with inlined literals', async () => {
    const statements = await meta.previewChanges(ref('dbo', 'Mixed Case Table'), [
      { type: 'insert', values: { Id: 50, 'Weird Column': "it's", order: null } },
      { type: 'update', key: { Id: 1 }, values: { 'Weird Column': 'x' } },
      { type: 'delete', key: { Id: 2 } },
    ])
    expect(statements).toEqual([
      `INSERT INTO ${DB}.dbo.[Mixed Case Table] (Id, [Weird Column], [order]) VALUES (50, N'it''s', NULL)`,
      `UPDATE ${DB}.dbo.[Mixed Case Table] SET [Weird Column] = N'x' WHERE Id = 1`,
      `DELETE FROM ${DB}.dbo.[Mixed Case Table] WHERE Id = 2`,
    ])
    const defaults = await meta.previewChanges(ref('dbo', 'audit_log'), [{ type: 'insert', values: { id: 5, action: { $default: true } } }])
    expect(defaults).toEqual([`INSERT INTO ${DB}.dbo.audit_log DEFAULT VALUES`])
    const binary = await meta.previewChanges(ref('dbo', 'customers'), [
      { type: 'update', key: { id: 1 }, values: { avatar: '0xCAFE', is_active: false } },
    ])
    expect(binary).toEqual([
      `UPDATE ${DB}.dbo.customers SET avatar = CONVERT(varbinary(max), N'0xCAFE', 1), is_active = 0 WHERE id = 1`,
    ])
  })

  it('applies inserts, updates and deletes in one transaction', async () => {
    const mixed = ref('dbo', 'Mixed Case Table')
    const inserted = await meta.applyChanges(mixed, [
      { type: 'insert', values: { Id: 10, 'Weird Column': 'ten', order: 100 } },
      { type: 'insert', values: { Id: 11, 'Weird Column': null, order: '110' } },
    ])
    expect(inserted.affected).toBe(2)
    expect(inserted.statements).toHaveLength(2)

    const updated = await meta.applyChanges(mixed, [{ type: 'update', key: { Id: 10 }, values: { 'Weird Column': 'TEN', order: 101 } }])
    expect(updated.affected).toBe(1)
    let page = await meta.fetchTableData({ table: mixed, offset: 0, limit: 10, where: 'Id >= 10' }, false)
    expect(page.rows).toEqual([
      [10, 'TEN', 101],
      [11, null, 110],
    ])

    const deleted = await meta.applyChanges(mixed, [
      { type: 'delete', key: { Id: 10 } },
      { type: 'delete', key: { Id: 11 } },
    ])
    expect(deleted.affected).toBe(2)
    page = await meta.fetchTableData({ table: mixed, offset: 0, limit: 10, where: 'Id >= 10' }, false)
    expect(page.rows).toEqual([])
  })

  it('omits identity, computed and default columns on insert and binds bit/binary values', async () => {
    const customers = ref('dbo', 'customers')
    const result = await meta.applyChanges(customers, [
      {
        type: 'insert',
        values: {
          id: 999,
          email: 'new@example.com',
          is_active: { $default: true },
          external_id: { $default: true },
          created_at: '2024-07-01 12:00:00.1234567',
          credit_limit: '12.34',
          avatar: '0xCAFE',
          display_name: 'ignored',
          last_seen: '2024-07-01 12:00:00.5 +01:00',
        },
      },
    ])
    expect(result.affected).toBe(1)
    let page = await meta.fetchTableData({ table: customers, offset: 0, limit: 10, where: "email = N'new@example.com'" }, false)
    const columns = page.columns.map((c) => c.name)
    let row = page.rows[0] ?? []
    const id = row[columns.indexOf('id')]
    expect(id).toBe(4)
    expect(row[columns.indexOf('is_active')]).toBe(true)
    expect(row[columns.indexOf('external_id')]).toMatch(/^[0-9A-F-]{36}$/)
    expect(row[columns.indexOf('avatar')]).toBe('0xCAFE')
    expect(row[columns.indexOf('credit_limit')]).toBe('12.34')
    expect(row[columns.indexOf('last_seen')]).toBe('2024-07-01 12:00:00.5000000 +01:00')
    expect(row[columns.indexOf('display_name')]).toBe('new@example.com')

    await meta.applyChanges(customers, [{ type: 'update', key: { id: 4 }, values: { is_active: false, avatar: null, full_name: 'New' } }])
    page = await meta.fetchTableData({ table: customers, offset: 0, limit: 10, where: 'id = 4' }, false)
    row = page.rows[0] ?? []
    expect(row[columns.indexOf('is_active')]).toBe(false)
    expect(row[columns.indexOf('avatar')]).toBeNull()
    expect(row[columns.indexOf('display_name')]).toBe('New')

    expect((await meta.applyChanges(customers, [{ type: 'delete', key: { id: 4 } }])).affected).toBe(1)
  })

  it('counts only the edited row when triggers touch rows too', async () => {
    const orders = ref('sales', 'orders')
    const result = await meta.applyChanges(orders, [{ type: 'update', key: { id: 1002 }, values: { status: 'paid' } }])
    expect(result.affected).toBe(1)
    const page = await meta.fetchTableData({ table: orders, offset: 0, limit: 1, where: 'id = 1002' }, false)
    const columns = page.columns.map((c) => c.name)
    expect(page.rows[0]?.[columns.indexOf('status')]).toBe('paid')
    expect(page.rows[0]?.[columns.indexOf('updated_at')]).not.toBeNull()
    await meta.applyChanges(orders, [{ type: 'update', key: { id: 1002 }, values: { status: 'new' } }])
  })

  it('rolls everything back when a keyed change does not match exactly one row', async () => {
    const mixed = ref('dbo', 'Mixed Case Table')
    const error = await caught(
      meta.applyChanges(mixed, [
        { type: 'insert', values: { Id: 20, 'Weird Column': 'twenty', order: 200 } },
        { type: 'update', key: { Id: 404 }, values: { 'Weird Column': 'missing' } },
      ]),
    )
    expect(error.info.kind).toBe('invalid-input')
    expect(error.info.message).toMatch(/matched 0 rows/)
    expect(await meta.countTableData({ table: mixed, where: 'Id = 20' })).toBe(0)

    const sqlError = await caught(
      meta.applyChanges(mixed, [
        { type: 'insert', values: { Id: 21, 'Weird Column': 'x', order: 1 } },
        { type: 'insert', values: { Id: 21, 'Weird Column': 'duplicate', order: 1 } },
      ]),
    )
    expect(sqlError.info).toMatchObject({ kind: 'database', code: '2627' })
    expect(await meta.countTableData({ table: mixed, where: 'Id = 21' })).toBe(0)

    const unknown = await caught(meta.applyChanges(mixed, [{ type: 'update', key: { Id: 1 }, values: { nope: 1 } }]))
    expect(unknown.info.kind).toBe('invalid-input')
    const view = await caught(meta.applyChanges(ref('dbo', 'active_customers'), [{ type: 'delete', key: { id: 1 } }]))
    expect(view.info.kind).toBe('invalid-input')
  })
})

suite('mssql metadata — system objects', () => {
  let meta: MetadataProvider

  beforeAll(async () => {
    meta = await mssqlDriver.openMetadata(mssqlConnection())
  })

  afterAll(async () => {
    await meta?.close()
  })

  it('lists and describes system views when browsing system schemas', async () => {
    const objects = await meta.listObjects(TEST_DB, 'sys')
    expect(objects.find((o) => o.name === 'tables')?.kind).toBe('view')
    expect(objects.find((o) => o.name === 'sp_executesql')?.kind).toBe('procedure')
    expect(objects.find((o) => o.name === 'sp_help')?.kind).toBe('procedure')
    const details = await meta.tableDetails(TEST_DB, 'sys', 'tables')
    expect(details.kind).toBe('view')
    expect(details.columns.some((c) => c.name === 'object_id')).toBe(true)
    expect(await meta.getDdl(TEST_DB, 'INFORMATION_SCHEMA', 'TABLES', 'view')).toMatch(/CREATE VIEW/i)
  })

  it('includes system objects in the completion catalog on request', async () => {
    const catalog = await meta.completionCatalog(TEST_DB, true)
    const sys = catalog.schemas.find((s) => s.name === 'sys')
    expect(sys?.objects.find((o) => o.name === 'objects')?.columns?.some((c) => c.name === 'object_id')).toBe(true)
    expect(catalog.schemas.some((s) => s.name === 'db_owner')).toBe(false)
  })
})
