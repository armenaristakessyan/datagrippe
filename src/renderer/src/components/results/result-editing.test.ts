import { describe, expect, it, vi } from 'vitest'
import type { ColumnInfo, ColumnMeta, StatementResult, TableDetails } from '@shared/types'

vi.mock('@/components/ui', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/lib/api', () => ({ api: {}, errorInfo: (e: unknown) => ({ message: String(e) }) }))
vi.mock('@/stores/consoles', () => ({ useConsoles: { getState: () => ({}) } }))
vi.mock('@/stores/settings', () => ({ useSettings: { getState: () => ({ settings: { confirmDestructive: true } }) } }))
vi.mock('@/stores/ui', () => ({ useUi: { getState: () => ({ confirm: async () => true }) } }))

const { checkEditable, displayRows, editableTable } = await import('./result-editing')

const column = (name: string, over: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  ordinal: 1,
  dataType: 'text',
  nullable: true,
  defaultValue: null,
  isPrimaryKey: false,
  isIdentity: false,
  isGenerated: false,
  ...over,
})

const details: TableDetails = {
  schema: 'public',
  name: 'customers',
  kind: 'table',
  columns: [column('id', { isPrimaryKey: true, dataType: 'int4' }), column('name'), column('total', { isGenerated: true })],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [],
  referencedBy: [],
  constraints: [],
  triggers: [],
}

const writable = { readOnly: false }
const meta = (name: string, table = 'customers'): ColumnMeta => ({ name, dataType: 'text', table })
const result = (sql: string, columns: ColumnMeta[]): Pick<StatementResult, 'sql' | 'columns' | 'kind'> => ({ sql, columns, kind: 'rows' })

describe('editing console results in place', () => {
  it('finds the source table of a single-table SELECT', () => {
    expect(editableTable(result('SELECT * FROM public.customers WHERE id > 1', [meta('id')]), 'public')).toEqual({ schema: 'public', name: 'customers' })
    expect(editableTable(result('SELECT id FROM customers', [meta('id')]), 'app')).toEqual({ schema: 'app', name: 'customers' })
    expect(editableTable(result('SELECT 1 AS x', [{ name: 'x', dataType: 'int4' }]), 'public')).toBeUndefined()
  })

  it('is editable when every primary-key column is in the result', () => {
    const check = checkEditable(result('SELECT id, name, total, 1 AS one FROM customers', [meta('id'), meta('name'), meta('total'), { name: 'one', dataType: 'int4' }]), details, writable, 'postgres')
    expect(check.ok).toBe(true)
    // generated columns and expressions stay read-only
    if (check.ok) expect([...check.target.readOnlyColumns]).toEqual([2, 3])
  })

  it('explains why a result cannot be edited', () => {
    const noKey = checkEditable(result('SELECT name FROM customers', [meta('name')]), details, writable, 'postgres')
    expect(noKey).toEqual({ ok: false, reason: 'Select the primary key (id) to edit these rows.' })
    expect(checkEditable(result('SELECT id FROM customers', [meta('id')]), details, { readOnly: true }, 'postgres').ok).toBe(false)
    expect(checkEditable(result('UPDATE customers SET name = 1 RETURNING id', [meta('id')]), details, writable, 'postgres').ok).toBe(false)
    expect(checkEditable(result('SELECT id FROM customers', [meta('id')]), { ...details, primaryKey: [] }, writable, 'postgres').ok).toBe(false)
  })

  it('shows submitted values over the fetched rows and leaves deleted rows out', () => {
    const rows = [
      [1, 'Ada'],
      [2, 'Alan'],
      [3, 'Grace'],
    ]
    const keyOf = (row: readonly unknown[]) => `id=${String(row[0])}`
    const shown = displayRows(rows, { applied: { 'id=2': { name: 'Turing' } }, removed: ['id=3'] }, keyOf, ['id', 'name'])
    expect(shown).toEqual([
      [1, 'Ada'],
      [2, 'Turing'],
    ])
    expect(displayRows(rows, {}, keyOf, ['id', 'name'])).toBe(rows)
  })
})
