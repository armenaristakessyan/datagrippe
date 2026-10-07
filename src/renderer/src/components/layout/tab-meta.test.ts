import { describe, expect, it } from 'vitest'
import type { ConnectionConfig, DatabaseInfo } from '@shared/types'
import type { Tab } from '@/stores/tabs'
import { firstUserDatabase, tabDatabase, tabHint } from './tab-meta'

const table = (
  id: string,
  connectionId: string,
  schema: string,
  name = 'customers',
  database = 'app',
  kind: 'table' | 'structure' = 'table',
): Tab => ({
  id,
  kind,
  title: name,
  connectionId,
  database,
  table: { schema, name, kind: 'table' },
})
const connections = [{ id: 'pg', name: 'Local PG' }, { id: 'ms', name: 'Local MSSQL' }] as ConnectionConfig[]

describe('tabHint', () => {
  it('is empty for a unique title', () => {
    const tabs = [table('a', 'pg', 'public'), table('b', 'pg', 'public', 'orders')]
    expect(tabHint(tabs[0]!, tabs, connections)).toBeUndefined()
  })

  it('names the connection, then the schema, then the database', () => {
    const across = [table('a', 'pg', 'public'), table('b', 'ms', 'dbo')]
    expect(tabHint(across[1]!, across, connections)).toBe('Local MSSQL')
    const schemas = [table('a', 'pg', 'public'), table('b', 'pg', 'crm')]
    expect(tabHint(schemas[1]!, schemas, connections)).toBe('crm')
    const dbs = [table('a', 'pg', 'public', 'customers', 'app'), table('b', 'pg', 'public', 'customers', 'staging')]
    expect(tabHint(dbs[1]!, dbs, connections)).toBe('staging')
  })

  it('labels the structure tab of an object whose data tab is open', () => {
    const data = table('a', 'pg', 'public')
    const structure = table('b', 'pg', 'public', 'customers', 'app', 'structure')
    const tabs = [data, structure]
    expect(tabHint(data, tabs, connections)).toBeUndefined()
    expect(tabHint(structure, tabs, connections)).toBe('Structure')
  })

  it('combines the location and the view when both differ', () => {
    const tabs = [table('a', 'pg', 'public'), table('b', 'ms', 'dbo', 'customers', 'app', 'structure')]
    expect(tabHint(tabs[1]!, tabs, connections)).toBe('Local MSSQL · Structure')
    expect(tabHint(tabs[0]!, tabs, connections)).toBe('Local PG')
  })
})

describe('tabDatabase', () => {
  const pg = { id: 'pg', name: 'Local PG', database: 'app' } as ConnectionConfig
  const consoleTab = (database?: string): Tab => ({ id: 'c', kind: 'console', title: 'Query 1', connectionId: 'pg', database }) as Tab

  it("gives a console's database, else the connection's, else the first one listed", () => {
    expect(tabDatabase(consoleTab('sales'), pg, 'other')).toBe('sales')
    expect(tabDatabase(consoleTab(), pg, 'other')).toBe('app')
    expect(tabDatabase(consoleTab(), { ...pg, database: '' }, 'other')).toBe('other')
    expect(tabDatabase(consoleTab(), { ...pg, database: '' })).toBeUndefined()
  })

  it("gives a table's database, and none for server sessions", () => {
    expect(tabDatabase(table('a', 'pg', 'public', 'orders', 'shop'), pg)).toBe('shop')
    expect(tabDatabase({ id: 's', kind: 'sessions', title: 'Sessions', connectionId: 'pg' } as Tab, pg, 'other')).toBeUndefined()
  })

  it('prefers the first user database', () => {
    const db = (name: string, isSystem = false) => ({ name, isSystem }) as DatabaseInfo
    expect(firstUserDatabase([db('master', true), db('shop')])).toBe('shop')
    expect(firstUserDatabase([db('master', true)])).toBe('master')
    expect(firstUserDatabase(undefined)).toBeUndefined()
  })
})
