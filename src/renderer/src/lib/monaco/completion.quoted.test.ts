// Regression: completion offered nothing for a quoted-identifier prefix ("cust, sales."ord, [sales].[ord, c.[em).
import { describe, expect, it } from 'vitest'
import type { CompletionCatalog } from '@shared/types'
import { computeCompletions, type CompletionEnv } from './completion'

const PG: CompletionCatalog = {
  database: 'shop',
  defaultSchema: 'public',
  schemas: [
    { name: 'public', objects: [{ name: 'customers', kind: 'table', columns: [{ name: 'id', dataType: 'integer' }] }] },
    { name: 'sales', objects: [{ name: 'orders', kind: 'table', columns: [{ name: 'status', dataType: 'text' }] }] },
  ],
}
const MS: CompletionCatalog = {
  database: 'shop',
  defaultSchema: 'dbo',
  schemas: [
    { name: 'dbo', objects: [{ name: 'customers', kind: 'table', columns: [{ name: 'email', dataType: 'nvarchar' }] }] },
    { name: 'sales', objects: [{ name: 'orders', kind: 'table', columns: [{ name: 'total', dataType: 'money' }] }] },
  ],
}
const pg: CompletionEnv = { dialect: 'postgres', catalog: PG, defaultSchema: 'public' }
const ms: CompletionEnv = { dialect: 'mssql', catalog: MS, defaultSchema: 'dbo' }

/**
 * Labels Monaco would keep: it filters each item's filterText (or label) against the text of the
 * replace range up to the caret. A prefix match is enough for this check.
 */
function visible(sql: string, env: CompletionEnv): string[] {
  const offset = sql.indexOf('|')
  const text = sql.slice(0, offset) + sql.slice(offset + 1)
  const r = computeCompletions(text, offset, env)
  if (!r) return []
  const typed = text.slice(r.from, offset).toLowerCase()
  return r.items.filter((i) => (i.filterText ?? i.label).toLowerCase().startsWith(typed)).map((i) => i.label)
}

describe('completion of quoted identifiers', () => {
  it('PostgreSQL: typing "cust suggests customers', () => {
    expect(visible('SELECT * FROM "cust|', pg)).toContain('customers')
  })
  it('PostgreSQL: typing sales."ord suggests orders', () => {
    expect(visible('SELECT * FROM sales."ord|', pg)).toContain('orders')
  })
  it('SQL Server: typing [sales].[ord suggests orders', () => {
    expect(visible('SELECT * FROM [sales].[ord|', ms)).toContain('orders')
  })
  it('SQL Server: typing c.[em suggests email', () => {
    expect(visible('SELECT c.[em| FROM dbo.customers c', ms)).toContain('email')
  })
})

