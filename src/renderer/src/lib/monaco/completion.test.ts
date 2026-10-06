import { describe, expect, it } from 'vitest'
import type { CompletionCatalog } from '@shared/types'
import { computeCompletions, hoverAt, keywordCase, type CompletionEnv, type SqlCompletionItem } from './completion'
import { analyzeCaret, statementRegion } from './sql-context'

const PG_CATALOG: CompletionCatalog = {
  database: 'shop',
  defaultSchema: 'public',
  schemas: [
    {
      name: 'public',
      objects: [
        {
          name: 'users',
          kind: 'table',
          columns: [
            { name: 'id', dataType: 'integer' },
            { name: 'email', dataType: 'text' },
            { name: 'created_at', dataType: 'timestamp with time zone' },
          ],
        },
        {
          name: 'orders',
          kind: 'table',
          columns: [
            { name: 'id', dataType: 'integer' },
            { name: 'user_id', dataType: 'integer' },
            { name: 'total', dataType: 'numeric(12,2)' },
          ],
        },
        { name: 'active_users', kind: 'view', columns: [{ name: 'id', dataType: 'integer' }] },
        { name: 'order_total', kind: 'function', signature: '(order_id integer)' },
      ],
    },
    {
      name: 'sales',
      objects: [
        { name: 'invoices', kind: 'table', columns: [{ name: 'number', dataType: 'text' }] },
        { name: 'Line Items', kind: 'table', columns: [{ name: 'qty', dataType: 'integer' }] },
      ],
    },
  ],
}

const MSSQL_CATALOG: CompletionCatalog = {
  database: 'shop',
  defaultSchema: 'dbo',
  schemas: [
    {
      name: 'dbo',
      objects: [
        { name: 'Customers', kind: 'table', columns: [{ name: 'CustomerId', dataType: 'int' }, { name: 'Name', dataType: 'nvarchar(100)' }] },
        { name: 'Order Details', kind: 'table', columns: [{ name: 'Quantity', dataType: 'int' }] },
        { name: 'usp_refresh', kind: 'procedure', signature: '(@id int)' },
      ],
    },
  ],
}

const pg: CompletionEnv = { dialect: 'postgres', catalog: PG_CATALOG, defaultSchema: 'public' }
const ms: CompletionEnv = { dialect: 'mssql', catalog: MSSQL_CATALOG, defaultSchema: 'dbo' }

/** Run completion at the `|` marker. */
function complete(sql: string, env: CompletionEnv = pg) {
  const offset = sql.indexOf('|')
  const text = sql.slice(0, offset) + sql.slice(offset + 1)
  return computeCompletions(text, offset, env)
}

const labels = (items: SqlCompletionItem[] | undefined, kind?: SqlCompletionItem['kind']) =>
  (items ?? []).filter((i) => !kind || i.kind === kind).map((i) => i.label)

const sorted = (items: SqlCompletionItem[]) => [...items].sort((a, b) => (a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0))

describe('caret context', () => {
  it('detects relation positions', () => {
    for (const sql of ['SELECT * FROM |', 'SELECT * FROM users u JOIN |', 'INSERT INTO |', 'UPDATE |', 'DELETE FROM |', 'SELECT * FROM users, |', 'TRUNCATE TABLE |']) {
      const offset = sql.indexOf('|')
      expect(analyzeCaret(sql.replace('|', ''), offset, 'postgres').context.kind, sql).toBe('relation')
    }
  })

  it('detects expression positions', () => {
    for (const sql of [
      'SELECT | FROM users',
      'SELECT id, | FROM users',
      'SELECT * FROM users WHERE |',
      'SELECT * FROM users WHERE id = 1 AND |',
      'SELECT * FROM users u JOIN orders o ON |',
      'SELECT * FROM users ORDER BY |',
      'UPDATE users SET |',
      'SELECT coalesce(|',
      'SELECT extract(year FROM |',
      'SELECT * FROM users WHERE id = |',
    ]) {
      const offset = sql.indexOf('|')
      expect(analyzeCaret(sql.replace('|', ''), offset, 'postgres').context.kind, sql).toBe('columns')
    }
  })

  it('detects keyword positions', () => {
    const at = (sql: string) => analyzeCaret(sql.replace('|', ''), sql.indexOf('|'), 'postgres').context
    expect(at('|')).toEqual({ kind: 'keyword', after: 'start' })
    expect(at('SELECT * FROM users |')).toEqual({ kind: 'keyword', after: 'expression' })
    expect(at('SELECT * |')).toEqual({ kind: 'keyword', after: 'expression' })
    expect(at('SELECT * FROM users LEFT |')).toEqual({ kind: 'keyword', after: 'keyword' })
    expect(at('SELECT id::|')).toEqual({ kind: 'type' })
    expect(at('SELECT CAST(id AS |')).toEqual({ kind: 'type' })
  })

  it('suggests nothing inside strings and comments', () => {
    expect(complete("SELECT 'abc|")).toBeNull()
    expect(complete("SELECT 'a|bc'")).toBeNull()
    expect(complete('SELECT 1 -- users.|')).toBeNull()
    expect(complete('SELECT /* fr| */ 1')).toBeNull()
    expect(complete("SELECT 'abc' |")).not.toBeNull()
  })

  it('scopes the analysis to the statement under the caret', () => {
    const text = 'SELECT * FROM orders o;\nSELECT o. FROM users o'
    const offset = text.indexOf('o. FROM') + 2
    const result = computeCompletions(text, offset, pg)
    expect(labels(result?.items, 'column')).toEqual(['id', 'email', 'created_at'])
    expect(statementRegion('SELECT 1;\nSELECT ', 'SELECT 1;\nSELECT '.length, 'postgres').start).toBe(10)
    // T-SQL statements are separated by blank lines even without semicolons
    const tsql = 'SELECT * FROM Customers c\n\nSELECT c.'
    expect(computeCompletions(tsql, tsql.length, ms)?.items).toEqual([])
  })
})

describe('alias resolution', () => {
  it('resolves "schema.table AS alias"', () => {
    expect(labels(complete('SELECT u.| FROM public.users AS u')?.items)).toEqual(['id', 'email', 'created_at'])
  })

  it('resolves "table alias" and join aliases', () => {
    expect(labels(complete('SELECT * FROM users u JOIN orders o ON o.| = u.id')?.items)).toEqual(['id', 'user_id', 'total'])
    expect(labels(complete('SELECT t.| FROM orders t')?.items)).toEqual(['id', 'user_id', 'total'])
  })

  it('resolves a bare table name used as qualifier', () => {
    expect(labels(complete('SELECT users.| FROM users')?.items)).toEqual(['id', 'email', 'created_at'])
    // not in FROM yet: falls back to the catalog
    expect(labels(complete('SELECT orders.|')?.items)).toEqual(['id', 'user_id', 'total'])
  })

  it('resolves CTE names and their columns', () => {
    const items = complete('WITH recent AS (SELECT id, total AS amount, count(*) n FROM orders) SELECT r.| FROM recent r')?.items
    expect(labels(items)).toEqual(['id', 'amount', 'n'])
    const explicit = complete('WITH x (a, b) AS (SELECT 1, 2) SELECT x.| FROM x')?.items
    expect(labels(explicit)).toEqual(['a', 'b'])
  })

  it('resolves derived tables', () => {
    expect(labels(complete('SELECT s.| FROM (SELECT id, email AS mail FROM users) s')?.items)).toEqual(['id', 'mail'])
  })

  it('sees outer relations from a correlated subquery but not inner ones from outside', () => {
    const inner = complete('SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.|)')
    expect(labels(inner?.items)).toEqual(['id', 'email', 'created_at'])
    const outside = complete('SELECT o.| FROM users u WHERE EXISTS (SELECT 1 FROM orders o)')
    // "o" is not visible outside the subquery; it is not a catalog table either
    expect(outside?.items).toEqual([])
  })

  it('offers schema objects after "schema."', () => {
    const result = complete('SELECT * FROM sales.|')
    expect(labels(result?.items)).toEqual(['invoices', 'Line Items'])
    expect(result?.items.find((i) => i.label === 'Line Items')?.insertText).toBe('"Line Items"')
  })

  it('offers the target columns in INSERT INTO t (…)', () => {
    expect(labels(complete('INSERT INTO orders (user_id, |')?.items)).toEqual(['id', 'user_id', 'total'])
  })
})

describe('completion items', () => {
  it('lists relations: default schema bare, other schemas qualified, then schemas', () => {
    const items = sorted(complete('SELECT * FROM |')?.items ?? [])
    expect(items.map((i) => i.label)).toEqual(['active_users', 'orders', 'users', 'invoices', 'Line Items', 'public', 'sales'])
    const invoices = items.find((i) => i.label === 'invoices')!
    expect(invoices).toMatchObject({ insertText: 'sales.invoices', description: 'sales', kind: 'table' })
    expect(items.find((i) => i.label === 'Line Items')?.insertText).toBe('sales."Line Items"')
    expect(items.find((i) => i.label === 'active_users')?.kind).toBe('view')
    expect(items.find((i) => i.label === 'sales')).toMatchObject({ kind: 'schema', insertText: 'sales.', retrigger: true })
    expect(items.find((i) => i.label === 'users')?.documentation).toContain('`email` text')
  })

  it('ranks in-scope columns first, then aliases, functions and keywords', () => {
    const items = sorted(complete('SELECT | FROM users u JOIN orders o ON o.user_id = u.id')?.items ?? [])
    const columns = items.filter((i) => i.kind === 'column')
    expect(items.slice(0, columns.length).every((i) => i.kind === 'column')).toBe(true)
    expect(columns.map((c) => `${c.description}.${c.label}`)).toEqual(['u.id', 'u.email', 'u.created_at', 'o.id', 'o.user_id', 'o.total'])
    // ambiguous names are inserted qualified
    expect(columns.find((c) => c.description === 'o' && c.label === 'id')?.insertText).toBe('o.id')
    expect(columns.find((c) => c.label === 'email')?.insertText).toBe('email')
    expect(columns.find((c) => c.label === 'total')?.detail).toBe('numeric(12,2)')
    const kinds = items.map((i) => i.kind)
    expect(kinds.indexOf('alias')).toBeGreaterThan(kinds.lastIndexOf('column'))
    expect(kinds.indexOf('function')).toBeGreaterThan(kinds.lastIndexOf('alias'))
    expect(kinds.indexOf('keyword')).toBeGreaterThan(kinds.lastIndexOf('function'))
    expect(items.find((i) => i.label === 'order_total')?.kind).toBe('routine')
  })

  it('follows the typed case for keywords and functions', () => {
    expect(keywordCase('')).toBe('upper')
    expect(keywordCase('sel')).toBe('lower')
    expect(keywordCase('SEL')).toBe('upper')
    expect(labels(complete('sel|')?.items, 'keyword')).toContain('select')
    expect(labels(complete('SEL|')?.items, 'keyword')).toContain('SELECT')
    expect(labels(complete('SELECT COU| FROM users')?.items, 'function')).toContain('COUNT')
    expect(labels(complete('SELECT cou| FROM users')?.items, 'function')).toContain('count')
    expect(complete('SELECT cou| FROM users')?.from).toBe(7)
  })

  it('ranks statement starters first at the start of a statement', () => {
    const items = sorted(complete('|')?.items ?? [])
    expect(items[0]?.label).toBe('SELECT')
  })

  it('creates function snippets', () => {
    const count = complete('SELECT | FROM users')?.items.find((i) => i.label === 'count')
    expect(count).toMatchObject({ insertText: 'count($0)', snippet: true, kind: 'function' })
    expect(complete('SELECT | FROM users')?.items.find((i) => i.label === 'now')?.insertText).toBe('now()')
  })

  it('handles SQL Server specifics', () => {
    expect(labels(complete('SELECT TOP 10 | FROM dbo.Customers c', ms)?.items, 'column')).toEqual(['CustomerId', 'Name'])
    expect(complete('SELECT * FROM |', ms)?.items.find((i) => i.label === 'Order Details')?.insertText).toBe('[Order Details]')
    expect(labels(complete('SELECT c.| FROM [dbo].[Customers] AS c', ms)?.items)).toEqual(['CustomerId', 'Name'])
    expect(labels(complete('EXEC |', ms)?.items)).toEqual(['usp_refresh'])
    expect(labels(complete('select getd| from Customers', ms)?.items, 'function')).toContain('getdate')
    expect(labels(complete('select | from Customers', ms)?.items, 'function')).toContain('GETDATE')
  })

  it('filters quoted identifiers on their quoted spelling', () => {
    const result = complete('SELECT * FROM sales."Li|')
    expect(result?.from).toBe('SELECT * FROM sales.'.length)
    expect(result?.items.find((i) => i.label === 'Line Items')?.filterText).toBe('"Line Items"')
  })
})

describe('hover', () => {
  const hover = (sql: string, env: CompletionEnv = pg) => {
    const offset = sql.indexOf('|')
    return hoverAt(sql.slice(0, offset) + sql.slice(offset + 1), offset, env)
  }

  it('describes a table with its columns', () => {
    const info = hover('SELECT * FROM us|ers u')
    expect(info?.markdown).toContain('**public.users** · table · 3 columns')
    expect(info?.markdown).toContain('`created_at` timestamp with time zone')
    expect(info).toMatchObject({ from: 14, to: 19 })
  })

  it('describes aliases and qualified columns', () => {
    expect(hover('SELECT u|.id FROM users u')?.markdown).toContain('`u` → **public.users**')
    expect(hover('SELECT u.em|ail FROM users u')?.markdown).toContain('`email` text')
    expect(hover('SELECT * FROM sales.invo|ices')?.markdown).toContain('**sales.invoices**')
  })

  it('returns null for unknown names', () => {
    expect(hover('SELECT * FROM nope|')).toBeNull()
    expect(hover('SELECT 1 + |2')).toBeNull()
  })
})

/** Labels Monaco keeps for the typed text of the replace range (prefix match on filterText ?? label). */
function visible(sql: string, env: CompletionEnv = pg): string[] {
  const offset = sql.indexOf('|')
  const text = sql.slice(0, offset) + sql.slice(offset + 1)
  const r = computeCompletions(text, offset, env)
  if (!r) return []
  const typed = text.slice(r.from, offset).toLowerCase()
  return r.items.filter((i) => (i.filterText ?? i.label).toLowerCase().startsWith(typed)).map((i) => i.label)
}

describe('quoted identifier being typed', () => {
  it('PostgreSQL: "us and sales."inv match, and insert in the quote style typed', () => {
    expect(visible('SELECT * FROM "us|')).toContain('users')
    expect(visible('SELECT * FROM sales."inv|')).toContain('invoices')
    const r = complete('SELECT * FROM "us|')!
    expect(r.items.find((i) => i.label === 'users')?.insertText).toBe('"users"')
    // keywords cannot be quoted
    expect(r.items.some((i) => i.kind === 'keyword')).toBe(false)
  })

  it('SQL Server: [Cust and c.[Na match, the rest of the statement still resolves aliases', () => {
    expect(visible('SELECT * FROM [dbo].[Cust|', ms)).toContain('Customers')
    expect(visible('SELECT c.[Na| FROM dbo.Customers c', ms)).toContain('Name')
    const r = complete('SELECT c.[Na| FROM dbo.Customers c', ms)!
    expect(r.items.find((i) => i.label === 'Name')?.insertText).toBe('[Name]')
  })

  it('an unterminated quote only replaces up to the caret', () => {
    const text = 'SELECT * FROM "us\nWHERE 1 = 1'
    const offset = text.indexOf('\n')
    const r = computeCompletions(text, offset, pg)!
    expect(r.to).toBe(offset)
  })
})

describe('keywords after an ORDER BY expression', () => {
  it('ranks ASC / DESC / NULLS / LIMIT first and drops earlier clauses', () => {
    const r = complete('SELECT * FROM users u ORDER BY u.id |')!
    const ranked = sorted(r.items).slice(0, 4).map((i) => i.label)
    expect(ranked).toEqual(['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST'])
    const all = labels(r.items)
    for (const k of ['FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'GROUP BY', 'HAVING', 'ORDER BY']) expect(all, k).not.toContain(k)
    expect(all).toContain('LIMIT')
  })

  it('after a WHERE predicate, offers AND / GROUP BY / ORDER BY but not FROM or JOIN', () => {
    const r = complete('SELECT * FROM users u WHERE u.id = 1 |')!
    const ranked = sorted(r.items).map((i) => i.label)
    expect(ranked.slice(0, 12)).toContain('AND')
    expect(ranked).toContain('GROUP BY')
    expect(ranked).not.toContain('FROM')
    expect(ranked).not.toContain('LEFT JOIN')
  })

  it('after a FROM relation, still offers JOIN and WHERE', () => {
    const ranked = sorted(complete('SELECT * FROM users u |')!.items).slice(0, 10).map((i) => i.label)
    expect(ranked).toContain('WHERE')
    expect(ranked).toContain('JOIN')
    expect(ranked).not.toContain('FROM')
  })
})

describe('SQL Server preferred schema (console schema picker)', () => {
  const MS2: CompletionCatalog = {
    database: 'shop',
    defaultSchema: 'dbo',
    schemas: [
      { name: 'dbo', objects: [{ name: 'customers', kind: 'table' }] },
      { name: 'sales', objects: [{ name: 'orders', kind: 'table' }, { name: 'order_items', kind: 'table' }] },
    ],
  }
  const env: CompletionEnv = { dialect: 'mssql', catalog: MS2, defaultSchema: 'dbo', preferredSchema: 'sales' }

  it('ranks the picked schema first but inserts its objects qualified', () => {
    const r = complete('SELECT * FROM ord|', env)!
    const orders = r.items.find((i) => i.label === 'orders')!
    expect(orders.insertText).toBe('sales.orders')
    const first = sorted(r.items.filter((i) => i.kind === 'table'))[0]
    expect(first?.description).toBe('sales')
    // objects of the login's default schema stay unqualified
    expect(r.items.find((i) => i.label === 'customers')?.insertText).toBe('customers')
  })
})
