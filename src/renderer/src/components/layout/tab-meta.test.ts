import { describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '@shared/types'
import type { Tab } from '@/stores/tabs'
import { tabHint } from './tab-meta'

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
