import { describe, expect, it } from 'vitest'
import type { ColumnInfo, ConnectionConfig, DbObjectInfo, TableDetails } from '@shared/types'
import { dbKey, objectKey, schemaKey } from '@/stores/explorer'
import { ancestorIds, connectionIdOf, flattenTree, nodeIds, pruneExpanded, type TreeInput, type TreeRow } from './tree'

function connection(id: string, name: string, extra: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id,
    name,
    dialect: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'app',
    user: 'u',
    savePassword: true,
    hasPassword: true,
    ssl: { mode: 'prefer' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
    color: 'none',
    readOnly: false,
    productionGuard: false,
    options: {},
    createdAt: '',
    updatedAt: '',
    ...extra,
  }
}

function column(name: string, ordinal: number, extra: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    ordinal,
    dataType: 'integer',
    nullable: false,
    defaultValue: null,
    isPrimaryKey: false,
    isIdentity: false,
    isGenerated: false,
    ...extra,
  }
}

const obj = (name: string, kind: DbObjectInfo['kind'], extra: Partial<DbObjectInfo> = {}): DbObjectInfo => ({ schema: 'public', name, kind, ...extra })

const customersDetails: TableDetails = {
  schema: 'public',
  name: 'customers',
  kind: 'table',
  columns: [column('email', 2, { dataType: 'text', nullable: true }), column('id', 1, { isPrimaryKey: true })],
  primaryKey: ['id'],
  indexes: [{ name: 'customers_pkey', columns: ['id'], isUnique: true, isPrimary: true }],
  foreignKeys: [],
  referencedBy: [],
  constraints: [{ name: 'customers_pkey', type: 'primary-key', columns: ['id'] }],
  triggers: [],
}

function input(overrides: Partial<TreeInput> = {}): TreeInput {
  return {
    connections: [connection('c2', 'beta'), connection('c1', 'Alpha'), connection('c3', 'gamma', { group: 'Prod' })],
    runtime: { c1: { status: 'connected' } },
    databases: { c1: { status: 'ready', data: [{ name: 'app', isSystem: false }, { name: 'postgres', isSystem: false }] } },
    schemas: { [dbKey('c1', 'app')]: { status: 'ready', data: [{ name: 'public', isSystem: false }, { name: 'sales', isSystem: false }] } },
    objects: {
      [schemaKey('c1', 'app', 'public')]: {
        status: 'ready',
        data: [obj('orders', 'table'), obj('customers', 'table'), obj('active_customers', 'view'), obj('touch', 'function', { identity: '42' })],
      },
    },
    details: { [objectKey('c1', 'app', 'public', 'customers')]: { status: 'ready', data: customersDetails } },
    expanded: {},
    filter: '',
    ...overrides,
  }
}

const labels = (rows: TreeRow[]) => rows.map((r) => `${'  '.repeat(r.depth)}${r.node.type}:${labelOf(r)}`)

function labelOf(row: TreeRow): string {
  const n = row.node
  switch (n.type) {
    case 'group':
      return n.name
    case 'connection':
      return n.connection.name
    case 'database':
      return n.database.name
    case 'schema':
      return n.schema.name
    case 'folder':
      return `${n.kind}(${n.count})`
    case 'object':
      return n.object.name
    case 'column':
      return n.column.name
    case 'detail-folder':
      return `${n.folder}(${n.count})`
    case 'detail':
      return n.name
    case 'message':
      return `${n.tone}:${n.text}`
  }
}

const c1 = nodeIds.connection('c1')
const app = nodeIds.database('c1', 'app')
const pub = nodeIds.schema('c1', 'app', 'public')
const path = { connectionId: 'c1', database: 'app', schema: 'public' }
const tables = nodeIds.folder(path, 'table')
const customers = nodeIds.object(path, obj('customers', 'table'))

describe('flattenTree (no filter)', () => {
  it('lists group folders first, then connections sorted by name; groups are expanded by default', () => {
    expect(labels(flattenTree(input()))).toEqual(['group:Prod', '  connection:gamma', 'connection:Alpha', 'connection:beta'])
    const collapsed = flattenTree(input({ expanded: { [nodeIds.group('Prod')]: false } }))
    expect(labels(collapsed)).toEqual(['group:Prod', 'connection:Alpha', 'connection:beta'])
  })

  it('walks expanded nodes down to columns and detail folders', () => {
    const rows = flattenTree(input({ expanded: { [c1]: true, [app]: true, [pub]: true, [tables]: true, [customers]: true } }))
    expect(labels(rows)).toEqual([
      'group:Prod',
      '  connection:gamma',
      'connection:Alpha',
      '  database:app',
      '    schema:public',
      '      folder:table(2)',
      '        object:customers',
      '          column:id',
      '          column:email',
      '          detail-folder:keys(1)',
      '          detail-folder:indexes(1)',
      '        object:orders',
      '      folder:view(1)',
      '      folder:function(1)',
      '    schema:sales',
      '  database:postgres',
      'connection:beta',
    ])
    const tableRow = rows.find((r) => r.id === customers)
    expect(tableRow).toMatchObject({ expandable: true, expanded: true, connectionId: 'c1', parentId: tables })
    expect(rows.find((r) => r.node.type === 'object' && r.node.object.kind === 'function')).toBeUndefined()
  })

  it('requests missing children of expanded nodes', () => {
    const rows = flattenTree(input({ expanded: { [c1]: true, [nodeIds.database('c1', 'postgres')]: true } }))
    const postgres = rows.find((r) => r.id === nodeIds.database('c1', 'postgres'))
    expect(postgres?.pendingLoad).toEqual({ type: 'schemas', connectionId: 'c1', database: 'postgres' })
    expect(postgres?.loading).toBe(true)
  })

  it('does not open a disconnected connection that has nothing loaded', () => {
    const rows = flattenTree(input({ expanded: { [nodeIds.connection('c2')]: true } }))
    const beta = rows.find((r) => r.id === nodeIds.connection('c2'))
    expect(beta?.expanded).toBe(false)
    expect(beta?.pendingLoad).toBeUndefined()
  })

  it('shows inline error and empty rows', () => {
    const rows = flattenTree(
      input({
        expanded: { [c1]: true, [app]: true, [nodeIds.schema('c1', 'app', 'sales')]: true, [pub]: true },
        objects: {
          [schemaKey('c1', 'app', 'public')]: { status: 'ready', data: [] },
          [schemaKey('c1', 'app', 'sales')]: { status: 'error', error: 'permission denied' },
        },
      }),
    )
    const messages = rows.filter((r) => r.node.type === 'message').map(labelOf)
    expect(messages).toEqual(['empty:Empty schema', 'error:permission denied'])
    const error = rows.find((r) => r.node.type === 'message' && r.node.tone === 'error')
    expect(error?.node.type === 'message' && error.node.retry).toEqual({ type: 'objects', connectionId: 'c1', database: 'app', schema: 'sales' })
  })

  it('keeps stale children visible while reloading and flags the parent as loading', () => {
    const rows = flattenTree(
      input({
        expanded: { [c1]: true },
        databases: { c1: { status: 'loading', data: [{ name: 'app', isSystem: false }] } },
      }),
    )
    expect(rows.find((r) => r.id === c1)?.loading).toBe(true)
    expect(rows.some((r) => r.id === app)).toBe(true)
  })

  it('orders detail folders and skips empty ones', () => {
    const details: TableDetails = {
      ...customersDetails,
      foreignKeys: [
        { name: 'fk_x', schema: 'public', table: 'customers', columns: ['x'], refSchema: 'sales', refTable: 'orders', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
      ],
      triggers: [{ name: 'trg', timing: 'BEFORE', events: ['UPDATE'], enabled: false }],
    }
    const keys = nodeIds.detailFolder(customers, 'foreign-keys')
    const rows = flattenTree(
      input({
        expanded: { [c1]: true, [app]: true, [pub]: true, [tables]: true, [customers]: true, [keys]: true },
        details: { [objectKey('c1', 'app', 'public', 'customers')]: { status: 'ready', data: details } },
      }),
    )
    const sub = rows.filter((r) => r.parentId === customers).map(labelOf)
    expect(sub).toEqual(['id', 'email', 'keys(1)', 'indexes(1)', 'foreign-keys(1)', 'triggers(1)'])
    const fk = rows.find((r) => r.parentId === keys)
    expect(fk?.node.type === 'detail' && fk.node.info).toBe('x → sales.orders')
  })
})

describe('flattenTree (filter)', () => {
  it('shows matches with their ancestors auto-expanded, ignoring stored expansion', () => {
    const rows = flattenTree(input({ filter: 'CUST' }))
    expect(labels(rows)).toEqual([
      'connection:Alpha',
      '  database:app',
      '    schema:public',
      '      folder:table(2)',
      '        object:customers',
      '      folder:view(1)',
      '        object:active_customers',
    ])
    const match = rows.find((r) => r.id === customers)
    expect(match?.match).toEqual([0, 4])
    expect(match?.expanded).toBe(false)
    expect(rows.find((r) => r.node.type === 'object' && r.node.object.name === 'active_customers')?.match).toEqual([7, 11])
  })

  it('matches columns of loaded table details', () => {
    const rows = flattenTree(input({ filter: 'mail' }))
    expect(labels(rows).slice(-2)).toEqual(['        object:customers', '          column:email'])
  })

  it('matches connections and groups by name', () => {
    expect(labels(flattenTree(input({ filter: 'prod' })))).toEqual(['group:Prod'])
    expect(labels(flattenTree(input({ filter: 'gam' })))).toEqual(['group:Prod', '  connection:gamma'])
  })

  it('never matches folder labels', () => {
    expect(flattenTree(input({ filter: 'tables' }))).toEqual([])
  })

  it('lets the user collapse an auto-expanded ancestor or browse inside a match', () => {
    const collapsed = flattenTree(input({ filter: 'cust', filterExpanded: { [pub]: false } }))
    expect(labels(collapsed)).toEqual(['connection:Alpha', '  database:app', '    schema:public'])

    const browsing = flattenTree(input({ filter: 'cust', filterExpanded: { [customers]: true } }))
    const children = browsing.filter((r) => r.parentId === customers).map(labelOf)
    expect(children).toEqual(['id', 'email', 'keys(1)', 'indexes(1)'])
  })

  it('requests children when a match is expanded before they are loaded', () => {
    const orders = nodeIds.object(path, obj('orders', 'table'))
    const rows = flattenTree(input({ filter: 'orders', filterExpanded: { [orders]: true } }))
    expect(rows.find((r) => r.id === orders)?.pendingLoad).toEqual({ type: 'details', ...path, name: 'orders' })
  })
})

describe('ids', () => {
  it('embed the connection id and escape separators', () => {
    expect(c1).toBe('c1')
    expect(pub).toBe('c1|app|public')
    expect(nodeIds.database('c1', 'a|b')).toBe('c1|a%7Cb')
    expect(connectionIdOf(customers)).toBe('c1')
    expect(connectionIdOf(nodeIds.group('Prod'))).toBeUndefined()
    expect(nodeIds.object(path, obj('f', 'function', { identity: '1' }))).not.toBe(nodeIds.object(path, obj('f', 'function', { identity: '2' })))
  })

  it('resolves ancestors from rows', () => {
    const rows = flattenTree(input({ expanded: { [c1]: true, [app]: true, [pub]: true, [tables]: true } }))
    expect(ancestorIds(rows, customers)).toEqual([tables, pub, app, c1])
  })

  it('prunes persisted expansion', () => {
    expect(
      pruneExpanded(
        { c1: true, 'c1|app': true, gone: true, 'gone|x': true, 'c1|other': false, 'group:Prod': false, 'group:Dev': true },
        new Set(['c1']),
      ),
    ).toEqual({ c1: true, 'c1|app': true, 'group:Prod': false })
    expect(Object.keys(pruneExpanded({ c1: true, 'c1|a': true, 'c1|b': true }, new Set(['c1']), 2))).toHaveLength(2)
  })
})

describe('scale', () => {
  it('flattens 10k objects quickly', () => {
    const many = Array.from({ length: 10_000 }, (_, i) => obj(`table_${i}`, 'table'))
    const data = input({
      expanded: { [c1]: true, [app]: true, [pub]: true, [tables]: true },
      objects: { [schemaKey('c1', 'app', 'public')]: { status: 'ready', data: many } },
    })
    const start = performance.now()
    const rows = flattenTree(data)
    const filtered = flattenTree({ ...data, filter: 'table_99' })
    const elapsed = performance.now() - start
    expect(rows.length).toBeGreaterThan(10_000)
    expect(filtered.filter((r) => r.node.type === 'object')).toHaveLength(111)
    expect(elapsed).toBeLessThan(500)
  })
})
