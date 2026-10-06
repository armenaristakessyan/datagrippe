import { beforeEach, describe, expect, it } from 'vitest'
import type { CompletionCatalog, ConnectionConfig, DbObjectInfo } from '@shared/types'
import type { Command } from '@/lib/commands'
import type { Loadable } from '@/stores/explorer'
import {
  clearRecent,
  collectObjects,
  commandEntries,
  connectionEntries,
  groupCommands,
  rankEntries,
  recentEntries,
  recordRecent,
  RECENT_LIMIT,
  type ObjectEntry,
  type PaletteEntry,
} from './items'

function connection(id: string, name = id): ConnectionConfig {
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
    ssl: { mode: 'disable' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'agent' },
    color: 'blue',
    readOnly: false,
    productionGuard: false,
    options: {},
    createdAt: '',
    updatedAt: '',
  }
}

const ready = <T,>(data: T): Loadable<T> => ({ status: 'ready', data })

const obj = (schema: string, name: string, kind: DbObjectInfo['kind'] = 'table', extra: Partial<DbObjectInfo> = {}): DbObjectInfo => ({
  schema,
  name,
  kind,
  ...extra,
})

describe('collectObjects', () => {
  const connections = [connection('c1', 'Local PG'), connection('c2', 'Offline')]
  const runtime = { c1: { status: 'connected' as const }, c2: { status: 'disconnected' as const } }

  it('takes loaded explorer objects of connected connections only', () => {
    const entries = collectObjects({
      connections,
      runtime,
      objects: {
        'c1|app|public': ready([obj('public', 'orders'), obj('public', 'customers', 'view')]),
        'c1|app|sales': { status: 'loading' },
        'c2|app|public': ready([obj('public', 'hidden')]),
      },
      catalogs: {},
    })
    expect(entries.map((e) => `${e.connectionName}:${e.database}:${e.schema}.${e.name}:${e.kind}`)).toEqual([
      'Local PG:app:public.orders:table',
      'Local PG:app:public.customers:view',
    ])
  })

  it('handles databases whose name contains the key separator', () => {
    const entries = collectObjects({
      connections,
      runtime,
      objects: { 'c1|weird|db|dbo': ready([obj('dbo', 't')]) },
      catalogs: {},
    })
    expect(entries[0]?.database).toBe('weird|db')
  })

  it('keeps routine overloads apart and merges catalog objects without duplicates', () => {
    const catalog: CompletionCatalog = {
      database: 'app',
      defaultSchema: 'public',
      schemas: [
        {
          name: 'public',
          objects: [
            { name: 'orders', kind: 'table', columns: [] },
            { name: 'total', kind: 'function', signature: '(a integer)' },
            { name: 'total', kind: 'function', signature: '(a integer)' },
            { name: 'invoices', kind: 'table', columns: [] },
          ],
        },
      ],
    }
    const entries = collectObjects({
      connections,
      runtime,
      objects: {
        'c1|app|public': ready([
          obj('public', 'orders'),
          obj('public', 'total', 'function', { identity: '101', signature: '(a integer)' }),
          obj('public', 'total', 'function', { identity: '102', signature: '(a text)' }),
        ]),
      },
      catalogs: { 'c1|app': ready(catalog) },
    })
    expect(entries.map((e) => `${e.name}${e.identity ? `#${e.identity}` : ''}`)).toEqual(['orders', 'total#101', 'total#102', 'invoices'])
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length)
  })
})

describe('rankEntries', () => {
  const base = { type: 'object' as const, connectionId: 'c1', connectionName: 'Local PG', database: 'app' }
  const entry = (schema: string, name: string, kind: ObjectEntry['kind'] = 'table'): ObjectEntry => ({
    ...base,
    key: `${schema}.${name}.${kind}`,
    schema,
    name,
    kind,
  })
  const entries = [
    entry('public', 'order_items'),
    entry('public', 'orders'),
    entry('sales', 'customer_orders'),
    entry('public', 'orders_v', 'view'),
    entry('public', 'recalc_orders', 'function'),
  ]

  it('ranks exact, prefix and word-start matches first', () => {
    const names = rankEntries('orders', entries).map((r) => r.entry.name)
    expect(names.slice(0, 2)).toEqual(['orders', 'orders_v'])
    expect(names.indexOf('customer_orders')).toBeLessThan(names.indexOf('order_items') === -1 ? Infinity : names.indexOf('order_items'))
  })

  it('matches schema-qualified queries and highlights the name part', () => {
    const [first] = rankEntries('sales.cust', entries)
    expect(first?.entry.name).toBe('customer_orders')
    expect(first?.positions).toEqual([0, 1, 2, 3])
  })

  it('uses connection and database context as extra tokens', () => {
    expect(rankEntries('orders local', entries)[0]?.entry.name).toBe('orders')
    expect(rankEntries('orders nowhere', entries)).toHaveLength(0)
  })

  it('ignores scattered matches in context fields', () => {
    // "ord" is a subsequence of "Local PG datagrippe_test public" but not of "events".
    expect(rankEntries('ord', [entry('public', 'events')])).toHaveLength(0)
    expect(rankEntries('local', [entry('public', 'events')])).toHaveLength(1)
  })

  it('orders an empty query by kind, then alphabetically', () => {
    expect(rankEntries('', entries).map((r) => r.entry.name)).toEqual([
      'customer_orders',
      'order_items',
      'orders',
      'orders_v',
      'recalc_orders',
    ])
  })

  it('applies the limit', () => {
    expect(rankEntries('', entries, 2)).toHaveLength(2)
  })

  it('matches connections by name and host', () => {
    const conns = connectionEntries([connection('a', 'Production'), connection('b', 'Staging')], { a: { status: 'connected' } })
    expect(conns[0]?.connected).toBe(true)
    expect(rankEntries('stag', conns)[0]?.entry.connection.name).toBe('Staging')
    expect(rankEntries('localhost', conns)).toHaveLength(2)
  })
})

describe('commands', () => {
  const cmd = (id: string, title: string, group?: string, keywords?: string[]): Command => ({ id, title, group, keywords, run: () => undefined })
  const commands = commandEntries([
    cmd('new-console', 'New console', 'Query', ['editor']),
    cmd('toggle-sidebar', 'Toggle sidebar', 'View', ['explorer']),
    cmd('open-settings', 'Settings…', 'View', ['preferences']),
    cmd('custom', 'Custom thing'),
  ])

  it('groups by the fixed order without a query', () => {
    const groups = groupCommands(rankEntries('', commands), false)
    expect(groups.map((g) => g.heading)).toEqual(['Query', 'View', 'Other'])
    expect(groups[1]?.items.map((i) => i.entry.key)).toEqual(['cmd|open-settings', 'cmd|toggle-sidebar'])
  })

  it('puts the everyday query commands first, never an executing explain', () => {
    const query = commandEntries([
      cmd('explain-analyze', 'Explain analyze', 'Query'),
      cmd('explain', 'Explain plan', 'Query'),
      cmd('format-sql', 'Format SQL', 'Query'),
      cmd('run-script', 'Run script', 'Query'),
      cmd('run-statement', 'Run statement', 'Query'),
      cmd('refresh-completions', 'Refresh autocompletion', 'Query'),
      { ...cmd('pinned', 'Zzz pinned', 'Query'), priority: -1 },
    ])
    const [group] = groupCommands(rankEntries('', query), false)
    expect(group?.items.map((i) => i.entry.key.replace('cmd|', ''))).toEqual([
      'pinned',
      'run-statement',
      'run-script',
      'format-sql',
      'explain',
      'explain-analyze',
      'refresh-completions',
    ])
  })

  it('orders groups by best score with a query and matches keywords', () => {
    const groups = groupCommands(rankEntries('prefer', commands), true)
    expect(groups.map((g) => g.heading)).toEqual(['View'])
    expect(groups[0]?.items[0]?.entry.key).toBe('cmd|open-settings')
  })
})

describe('recent entries', () => {
  beforeEach(() => clearRecent())

  it('puts the latest pick first, dedupes and caps the list', () => {
    const entries: PaletteEntry[] = Array.from({ length: RECENT_LIMIT + 3 }, (_, i) => ({
      type: 'command',
      key: `cmd|${i}`,
      command: { id: String(i), title: `C${i}`, run: () => undefined },
    }))
    const live = new Map(entries.map((e) => [e.key, e]))
    for (const e of entries) recordRecent('commands', e)
    recordRecent('commands', entries[0] as PaletteEntry)
    const recent = recentEntries('commands', live)
    expect(recent).toHaveLength(RECENT_LIMIT)
    expect(recent[0]?.key).toBe('cmd|0')
    expect(recent[1]?.key).toBe(`cmd|${RECENT_LIMIT + 2}`)
  })

  it('drops stale commands but keeps object snapshots', () => {
    const command: PaletteEntry = { type: 'command', key: 'cmd|gone', command: { id: 'gone', title: 'Gone', run: () => undefined } }
    const object: ObjectEntry = {
      type: 'object',
      key: 'obj|x',
      connectionId: 'c1',
      connectionName: 'Local',
      database: 'app',
      schema: 'public',
      name: 'orders',
      kind: 'table',
    }
    recordRecent('commands', command)
    recordRecent('objects', object)
    expect(recentEntries('commands', new Map())).toEqual([])
    expect(recentEntries('objects', new Map())).toEqual([object])
    expect(recentEntries('commands', new Map())).toEqual([])
  })
})
