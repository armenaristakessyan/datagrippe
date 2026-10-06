import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DriverError } from '../../src/main/db/errors'
import { postgresDriver } from '../../src/main/db/postgres'
import type { DriverSession, MetadataProvider } from '../../src/main/db/types'
import type { DbObjectInfo, ObjectKind } from '../../src/shared/types'
import { testPgConnection } from '../setup/postgres'
import { TEST_PG } from '../test-env'

const DB = TEST_PG.database
const SCRATCH = 'ddl_scratch'

describe('postgres driver: metadata', () => {
  let metadata: MetadataProvider
  let session: DriverSession

  beforeAll(async () => {
    metadata = await postgresDriver.openMetadata(testPgConnection())
    session = await postgresDriver.openSession(testPgConnection(), DB)
    await session.execute(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE; CREATE SCHEMA ${SCRATCH}`, { maxRows: 10 })
  })

  afterAll(async () => {
    await session.execute(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`, { maxRows: 10 })
    await session.close()
    await metadata.close()
  })

  /** Execute a script; fail with the server message when any statement errors. */
  async function run(sql: string): Promise<void> {
    const { results } = await session.execute(sql, { maxRows: 10 })
    const failed = results.find((r) => r.kind === 'error')
    if (failed) throw new Error(`${failed.error?.message}\n--- in ---\n${failed.sql}`)
  }

  it('server info', async () => {
    const info = await metadata.serverInfo()
    expect(info).toMatchObject({ dialect: 'postgres', currentDatabase: DB, currentUser: TEST_PG.user })
  })

  it('lists databases', async () => {
    const databases = await metadata.listDatabases(false)
    const test = databases.find((d) => d.name === DB)
    expect(test).toMatchObject({ isSystem: false })
    expect(test?.sizeBytes).toBeGreaterThan(0)
    expect(databases.some((d) => d.name.startsWith('template'))).toBe(false)
    const names = databases.map((d) => d.name)
    expect(names).toEqual([...names].sort())
    const all = await metadata.listDatabases(true)
    expect(all.find((d) => d.name === 'template1')).toMatchObject({ isSystem: true })
  })

  it('lists schemas', async () => {
    const schemas = await metadata.listSchemas(DB, false)
    expect(schemas.map((s) => s.name)).toEqual(expect.arrayContaining(['public', 'sales']))
    expect(schemas.every((s) => !s.isSystem)).toBe(true)
    expect(schemas.find((s) => s.name === 'sales')?.owner).toBe(TEST_PG.user)
    const withSystem = await metadata.listSchemas(DB, true)
    expect(withSystem.find((s) => s.name === 'pg_catalog')).toMatchObject({ isSystem: true })
    expect(withSystem.find((s) => s.name === 'information_schema')).toMatchObject({ isSystem: true })
  })

  it('lists objects of every kind in public', async () => {
    const objects = await metadata.listObjects(DB, 'public')
    const find = (name: string, kind: ObjectKind): DbObjectInfo | undefined =>
      objects.find((o) => o.name === name && o.kind === kind)
    expect(find('customers', 'table')).toMatchObject({ schema: 'public', comment: 'People who buy things', rowEstimate: 5 })
    expect(find('customers', 'table')?.identity).toMatch(/^\d+$/)
    expect(find('measurements', 'table')).toBeDefined()
    expect(objects.some((o) => o.name.startsWith('measurements_2024'))).toBe(false)
    expect(find('Mixed Case Table', 'table')).toBeDefined()
    expect(find('audit_log', 'table')).toBeDefined()
    expect(find('active_customers', 'view')).toMatchObject({ comment: 'Customers that can place orders' })
    expect(find('invoice_seq', 'sequence')).toMatchObject({ comment: 'Invoice numbers' })
    expect(find('customers_id_seq', 'sequence')).toBeDefined()
    expect(find('order_status', 'type')).toMatchObject({ comment: 'Lifecycle of an order' })
    expect(find('email_address', 'type')).toBeDefined()
    expect(find('postal_address', 'type')).toBeDefined()
    // Aggregates, table row types and array types are not listed.
    expect(objects.some((o) => o.name === 'text_concat')).toBe(false)
    expect(objects.some((o) => o.kind === 'type' && (o.name === 'customers' || o.name.startsWith('_')))).toBe(false)

    const order: ObjectKind[] = ['table', 'view', 'materialized-view', 'foreign-table', 'function', 'procedure', 'sequence', 'type']
    const ranks = objects.map((o) => order.indexOf(o.kind))
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })

  it('lists sales objects including overloads and procedures', async () => {
    const objects = await metadata.listObjects(DB, 'sales')
    expect(objects.filter((o) => o.kind === 'table').map((o) => o.name)).toEqual(['order_items', 'orders'])
    expect(objects.find((o) => o.kind === 'materialized-view')).toMatchObject({ name: 'monthly_totals', comment: 'Revenue per month' })
    const totals = objects.filter((o) => o.name === 'customer_total')
    expect(totals.map((o) => [o.kind, o.signature, o.returnType])).toEqual([
      ['function', '(p_customer_id integer)', 'numeric'],
      ['function', '(p_customer_id integer, p_since timestamp with time zone)', 'numeric'],
    ])
    expect(totals[0]?.comment).toBe('Lifetime spend of a customer')
    expect(new Set(totals.map((o) => o.identity)).size).toBe(2)
    expect(objects.find((o) => o.name === 'touch_updated_at')).toMatchObject({ kind: 'function', returnType: 'trigger' })
    const procedure = objects.find((o) => o.name === 'archive_orders')
    expect(procedure).toMatchObject({ kind: 'procedure', signature: '()' })
    expect(procedure?.returnType).toBeUndefined()
  })

  it('describes customers', async () => {
    const details = await metadata.tableDetails(DB, 'public', 'customers')
    expect(details).toMatchObject({ schema: 'public', name: 'customers', kind: 'table', comment: 'People who buy things', rowEstimate: 5 })
    expect(details.sizeBytes).toBeGreaterThan(0)
    expect(details.primaryKey).toEqual(['id'])
    expect(details.columns.map((c) => c.name)).toEqual([
      'id', 'name', 'email', 'is_active', 'credit_limit', 'created_at', 'birth_date', 'preferences', 'external_id', 'tags',
      'last_ip', 'avatar',
    ])
    const column = (name: string) => details.columns.find((c) => c.name === name)
    expect(column('id')).toMatchObject({ ordinal: 1, dataType: 'integer', nullable: false, isPrimaryKey: true, isIdentity: true, isGenerated: false })
    expect(column('id')?.defaultValue).toMatch(/^nextval\('customers_id_seq'::regclass\)$/)
    expect(column('name')).toMatchObject({ dataType: 'character varying(255)', nullable: false, isIdentity: false })
    expect(column('email')).toMatchObject({ dataType: 'email_address', comment: 'Primary contact email' })
    expect(column('credit_limit')).toMatchObject({ dataType: 'numeric(12,2)', nullable: true, defaultValue: '1000.00' })
    expect(column('created_at')).toMatchObject({ dataType: 'timestamp with time zone', defaultValue: 'now()' })
    expect(column('tags')).toMatchObject({ dataType: 'text[]' })

    const index = (name: string) => details.indexes.find((i) => i.name === name)
    expect(index('customers_pkey')).toMatchObject({ isPrimary: true, isUnique: true, columns: ['id'], method: 'btree' })
    expect(index('customers_email_key')).toMatchObject({ isPrimary: false, isUnique: true, columns: ['email'] })
    expect(index('customers_name_lower_idx')?.columns).toEqual(['lower(name::text)'])
    expect(index('customers_name_lower_idx')?.definition).toMatch(/^CREATE INDEX customers_name_lower_idx ON public\.customers/)
    expect(index('customers_active_created_idx')).toMatchObject({ predicate: 'is_active', columns: ['created_at'] })

    expect(details.constraints.map((c) => [c.type, c.name])).toEqual([
      ['primary-key', 'customers_pkey'],
      ['unique', 'customers_email_key'],
      ['check', 'customers_credit_limit_check'],
    ])
    expect(details.constraints[2]).toMatchObject({ columns: ['credit_limit'], definition: 'CHECK (credit_limit >= 0::numeric)' })
    expect(details.foreignKeys).toEqual([])
    expect(details.referencedBy).toEqual([
      {
        name: 'orders_customer_id_fkey',
        schema: 'sales',
        table: 'orders',
        columns: ['customer_id'],
        refSchema: 'public',
        refTable: 'customers',
        refColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE',
      },
    ])
    expect(details.triggers).toEqual([])
  })

  it('describes orders (identity, FK, trigger)', async () => {
    const details = await metadata.tableDetails(DB, 'sales', 'orders')
    expect(details.columns[0]).toMatchObject({ name: 'id', isIdentity: true, defaultValue: null, isPrimaryKey: true })
    expect(details.columns.find((c) => c.name === 'status')).toMatchObject({ dataType: 'order_status', defaultValue: "'pending'::order_status" })
    expect(details.foreignKeys).toHaveLength(1)
    expect(details.foreignKeys[0]).toMatchObject({ refSchema: 'public', refTable: 'customers', onDelete: 'CASCADE' })
    expect(details.referencedBy.map((f) => f.table)).toEqual(['order_items'])
    expect(details.triggers).toHaveLength(1)
    expect(details.triggers[0]).toMatchObject({ name: 'orders_touch_updated_at', timing: 'BEFORE', events: ['UPDATE'], enabled: true })
    expect(details.triggers[0]?.definition).toMatch(/EXECUTE FUNCTION sales\.touch_updated_at\(\)/)
  })

  it('describes order_items (composite key, generated column)', async () => {
    const details = await metadata.tableDetails(DB, 'sales', 'order_items')
    expect(details.primaryKey).toEqual(['order_id', 'line_no'])
    expect(details.columns.filter((c) => c.isPrimaryKey).map((c) => c.name)).toEqual(['order_id', 'line_no'])
    expect(details.columns.find((c) => c.name === 'line_total')).toMatchObject({ isGenerated: true, isIdentity: false })
    expect(details.foreignKeys[0]).toMatchObject({ columns: ['order_id'], onUpdate: 'RESTRICT', onDelete: 'CASCADE' })
    expect(details.constraints.find((c) => c.type === 'primary-key')?.columns).toEqual(['order_id', 'line_no'])
  })

  it('describes views, materialized views and partitioned tables', async () => {
    const view = await metadata.tableDetails(DB, 'public', 'active_customers')
    expect(view).toMatchObject({ kind: 'view', primaryKey: [], indexes: [], constraints: [], foreignKeys: [] })
    expect(view.columns.map((c) => c.name)).toEqual(['id', 'name', 'email', 'credit_limit'])
    expect(view.rowEstimate).toBeUndefined()

    const matview = await metadata.tableDetails(DB, 'sales', 'monthly_totals')
    expect(matview.kind).toBe('materialized-view')
    expect(matview.indexes.map((i) => i.name)).toEqual(['monthly_totals_month_idx'])

    const partitioned = await metadata.tableDetails(DB, 'public', 'measurements')
    expect(partitioned.kind).toBe('table')
    expect(partitioned.primaryKey).toEqual(['sensor_id', 'measured_on'])
    expect(partitioned.rowEstimate).toBeGreaterThan(0)
    expect(partitioned.sizeBytes).toBeGreaterThan(0)
  })

  it('unknown tables are not-found errors', async () => {
    const error = await metadata.tableDetails(DB, 'public', 'nope').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as DriverError).info.kind).toBe('not-found')
  })

  it('table DDL re-executes in another schema', async () => {
    const ddl = await metadata.getDdl(DB, 'public', 'customers', 'table')
    expect(ddl).toContain('CREATE TABLE public.customers (')
    expect(ddl).toContain('    id serial')
    expect(ddl).toContain('email public.email_address NOT NULL')
    expect(ddl).toContain("credit_limit numeric(12,2) DEFAULT 1000.00")
    expect(ddl).toContain('CONSTRAINT customers_pkey PRIMARY KEY (id)')
    expect(ddl).toContain('CONSTRAINT customers_email_key UNIQUE (email)')
    expect(ddl).toContain('CREATE INDEX customers_name_lower_idx ON public.customers USING btree (lower((name)::text));')
    expect(ddl).toContain("COMMENT ON TABLE public.customers IS 'People who buy things';")
    expect(ddl).toContain("COMMENT ON COLUMN public.customers.email IS 'Primary contact email';")
    expect(ddl).not.toContain('customers_pkey ON')
    await run(ddl.replace(/public\.customers\b/g, `${SCRATCH}.customers`))

    const orders = await metadata.getDdl(DB, 'sales', 'orders', 'table')
    expect(orders).toContain('id integer GENERATED ALWAYS AS IDENTITY')
    expect(orders).toContain("status public.order_status DEFAULT 'pending'::public.order_status NOT NULL")
    expect(orders).toContain('REFERENCES public.customers(id) ON DELETE CASCADE')
    expect(orders).toContain('CREATE TRIGGER orders_touch_updated_at BEFORE UPDATE ON sales.orders')
    await run(orders.replace(/sales\.orders\b/g, `${SCRATCH}.orders`))

    const items = await metadata.getDdl(DB, 'sales', 'order_items', 'table')
    expect(items).toContain('GENERATED ALWAYS AS (((quantity)::numeric * unit_price)) STORED')
    expect(items).toContain('PRIMARY KEY (order_id, line_no)')
    await run(items.replace(/sales\.order_items\b/g, `${SCRATCH}.order_items`).replace(/sales\.orders\b/g, `${SCRATCH}.orders`))

    const measurements = await metadata.getDdl(DB, 'public', 'measurements', 'table')
    expect(measurements).toContain('PARTITION BY RANGE (measured_on)')
    expect(measurements).toContain(
      "CREATE TABLE public.measurements_2024_h1 PARTITION OF public.measurements\n    FOR VALUES FROM ('2024-01-01') TO ('2024-07-01');",
    )
    await run(measurements.replace(/public\.measurements/g, `${SCRATCH}.measurements`))

    const mixed = await metadata.getDdl(DB, 'public', 'Mixed Case Table', 'table')
    expect(mixed).toContain('CREATE TABLE public."Mixed Case Table" (')
    expect(mixed).toContain('"Weird Column" text')
    expect(mixed).toContain('"order" integer')
    await run(mixed.replace(/public\."Mixed Case Table"/g, `${SCRATCH}."Mixed Case Table"`))

    const audit = await metadata.getDdl(DB, 'public', 'audit_log', 'table')
    await run(audit.replace(/public\.audit_log\b/g, `${SCRATCH}.audit_log`))

    const scratch = await metadata.listObjects(DB, SCRATCH)
    expect(scratch.filter((o) => o.kind === 'table').map((o) => o.name).sort()).toEqual(
      ['Mixed Case Table', 'audit_log', 'customers', 'measurements', 'order_items', 'orders'].sort(),
    )
    const copy = await metadata.tableDetails(DB, SCRATCH, 'customers')
    const original = await metadata.tableDetails(DB, 'public', 'customers')
    expect(copy.columns.map((c) => [c.name, c.dataType, c.nullable, c.isIdentity])).toEqual(
      original.columns.map((c) => [c.name, c.dataType, c.nullable, c.isIdentity]),
    )
    expect(copy.indexes.map((i) => i.name).sort()).toEqual(original.indexes.map((i) => i.name).sort())
  })

  it('view and materialized view DDL', async () => {
    const view = await metadata.getDdl(DB, 'public', 'active_customers', 'view')
    expect(view).toMatch(/^CREATE OR REPLACE VIEW public\.active_customers AS\n/)
    expect(view).toContain('FROM public.customers')
    expect(view).toContain("COMMENT ON VIEW public.active_customers IS 'Customers that can place orders';")
    await run(view.replace(/public\.active_customers/g, `${SCRATCH}.active_customers`))

    const matview = await metadata.getDdl(DB, 'sales', 'monthly_totals', 'materialized-view')
    expect(matview).toMatch(/^CREATE MATERIALIZED VIEW sales\.monthly_totals AS\n/)
    expect(matview).toContain('\nWITH DATA;')
    expect(matview).toContain('CREATE UNIQUE INDEX monthly_totals_month_idx ON sales.monthly_totals USING btree (month);')
    expect(matview).toContain("COMMENT ON MATERIALIZED VIEW sales.monthly_totals IS 'Revenue per month';")
    await run(matview.replace(/sales\.monthly_totals/g, `${SCRATCH}.monthly_totals`))
  })

  it('routine DDL by identity and by name', async () => {
    const objects = await metadata.listObjects(DB, 'sales')
    const overload = objects.find((o) => o.name === 'customer_total' && o.signature?.includes('p_since'))
    const byIdentity = await metadata.getDdl(DB, 'sales', 'customer_total', 'function', overload?.identity)
    expect(byIdentity).toContain('CREATE OR REPLACE FUNCTION sales.customer_total(p_customer_id integer, p_since timestamp with time zone)')
    expect(byIdentity.trimEnd().endsWith(';')).toBe(true)

    const byName = await metadata.getDdl(DB, 'sales', 'customer_total', 'function')
    expect(byName).toContain('CREATE OR REPLACE FUNCTION sales.customer_total(')
    const stale = await metadata.getDdl(DB, 'sales', 'customer_total', 'function', '1')
    expect(stale).toContain('CREATE OR REPLACE FUNCTION sales.customer_total(')

    const first = objects.find((o) => o.name === 'customer_total' && !o.signature?.includes('p_since'))
    const commented = await metadata.getDdl(DB, 'sales', 'customer_total', 'function', first?.identity)
    expect(commented).toContain("COMMENT ON FUNCTION sales.customer_total(p_customer_id integer) IS 'Lifetime spend of a customer';")
    await run(commented.replaceAll('sales.customer_total', `${SCRATCH}.customer_total`))

    const procedure = await metadata.getDdl(DB, 'sales', 'archive_orders', 'procedure')
    expect(procedure).toContain('CREATE OR REPLACE PROCEDURE sales.archive_orders()')
    await run(procedure.replace('sales.archive_orders', `${SCRATCH}.archive_orders`))

    const missing = await metadata.getDdl(DB, 'sales', 'nope', 'function').catch((e: unknown) => e)
    expect((missing as DriverError).info.kind).toBe('not-found')
  })

  it('sequence DDL', async () => {
    const ddl = await metadata.getDdl(DB, 'public', 'invoice_seq', 'sequence')
    expect(ddl).toContain('CREATE SEQUENCE public.invoice_seq')
    expect(ddl).toContain('AS bigint')
    expect(ddl).toContain('INCREMENT BY 10')
    expect(ddl).toContain('START WITH 1000')
    expect(ddl).toContain('CACHE 5')
    expect(ddl).toContain('NO CYCLE;')
    expect(ddl).toContain("COMMENT ON SEQUENCE public.invoice_seq IS 'Invoice numbers';")
    await run(ddl.replaceAll('public.invoice_seq', `${SCRATCH}.invoice_seq`))

    const owned = await metadata.getDdl(DB, 'public', 'customers_id_seq', 'sequence')
    expect(owned).toContain('ALTER SEQUENCE public.customers_id_seq OWNED BY public.customers.id;')
  })

  it('type DDL (enum, domain, composite)', async () => {
    const objects = await metadata.listObjects(DB, 'public')
    const enumType = objects.find((o) => o.name === 'order_status')
    const enumDdl = await metadata.getDdl(DB, 'public', 'order_status', 'type', enumType?.identity)
    expect(enumDdl).toContain("CREATE TYPE public.order_status AS ENUM (\n    'pending',\n    'paid',\n    'shipped',\n    'cancelled'\n);")
    expect(enumDdl).toContain("COMMENT ON TYPE public.order_status IS 'Lifecycle of an order';")
    await run(enumDdl.replaceAll('public.order_status', `${SCRATCH}.order_status`))

    const domain = await metadata.getDdl(DB, 'public', 'email_address', 'type')
    expect(domain).toContain('CREATE DOMAIN public.email_address AS character varying(320)')
    expect(domain).toContain('CONSTRAINT email_address_check CHECK')
    await run(domain.replaceAll('public.email_address', `${SCRATCH}.email_address`))

    const composite = await metadata.getDdl(DB, 'public', 'postal_address', 'type')
    expect(composite).toBe('CREATE TYPE public.postal_address AS (\n    street text,\n    city text,\n    zip character varying(10)\n);')
    await run(composite.replaceAll('public.postal_address', `${SCRATCH}.postal_address`))
  })

  it('DDL of unknown objects is a not-found error', async () => {
    for (const kind of ['table', 'view', 'sequence', 'type'] as const) {
      const error = await metadata.getDdl(DB, 'public', 'does_not_exist', kind).catch((e: unknown) => e)
      expect((error as DriverError).info.kind).toBe('not-found')
    }
  })

  it('completion catalog', async () => {
    const catalog = await metadata.completionCatalog(DB, false)
    expect(catalog.database).toBe(DB)
    expect(catalog.defaultSchema).toBe('public')
    const names = catalog.schemas.map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining(['public', 'sales']))
    expect(names).not.toContain('pg_catalog')
    const pub = catalog.schemas.find((s) => s.name === 'public')
    const customers = pub?.objects.find((o) => o.name === 'customers')
    expect(customers?.kind).toBe('table')
    expect(customers?.columns?.slice(0, 3)).toEqual([
      { name: 'id', dataType: 'integer' },
      { name: 'name', dataType: 'character varying(255)' },
      { name: 'email', dataType: 'email_address' },
    ])
    expect(pub?.objects.find((o) => o.name === 'active_customers')?.kind).toBe('view')
    expect(pub?.objects.some((o) => o.name.startsWith('measurements_'))).toBe(false)
    const sales = catalog.schemas.find((s) => s.name === 'sales')
    expect(sales?.objects.filter((o) => o.name === 'customer_total').map((o) => o.signature)).toHaveLength(2)
    expect(sales?.objects.find((o) => o.name === 'archive_orders')).toMatchObject({ kind: 'procedure', signature: '()' })

    const withSystem = await metadata.completionCatalog(DB, true)
    const pgCatalog = withSystem.schemas.find((s) => s.name === 'pg_catalog')
    expect(pgCatalog?.objects.some((o) => o.name === 'pg_class')).toBe(true)
  })
})
