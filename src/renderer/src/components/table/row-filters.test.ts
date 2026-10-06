import { describe, expect, it } from 'vitest'
import type { ColumnMeta, ForeignKeyInfo } from '@shared/types'
import { combineWhere, foreignKeyLabels, referencedRows, referencingRows, valuePredicate } from './row-filters'

const fk = (over: Partial<ForeignKeyInfo>): ForeignKeyInfo => ({
  name: 'fk',
  schema: 'sales',
  table: 'orders',
  columns: ['customer_id'],
  refSchema: 'public',
  refTable: 'customers',
  refColumns: ['id'],
  onUpdate: 'NO ACTION',
  onDelete: 'CASCADE',
  ...over,
})

const orderColumns: ColumnMeta[] = [
  { name: 'id', dataType: 'int4' },
  { name: 'customer_id', dataType: 'int4' },
  { name: 'note', dataType: 'text' },
]

describe('value predicates', () => {
  it('builds = / <> / IS [NOT] NULL quoting identifiers when needed', () => {
    expect(valuePredicate({ column: 'status', dataType: 'text', value: "it's" }, false, 'postgres')).toBe(`status = 'it''s'`)
    expect(valuePredicate({ column: 'n', dataType: 'int4', value: 3 }, true, 'postgres')).toBe('n <> 3')
    expect(valuePredicate({ column: 'Order Date', dataType: 'date', value: null }, true, 'mssql')).toBe('[Order Date] IS NOT NULL')
    expect(valuePredicate({ column: 'Status', dataType: 'text', value: 'x' }, false, 'postgres')).toBe(`"Status" = 'x'`)
  })

  it('adds to an existing filter without rewriting it', () => {
    expect(combineWhere('', 'a = 1')).toBe('a = 1')
    expect(combineWhere('b > 2 OR c', 'a = 1')).toBe('(b > 2 OR c) AND a = 1')
    expect(combineWhere('a = 1', 'a = 1')).toBe('a = 1')
  })
})

describe('foreign-key navigation', () => {
  it('links a row to the row its foreign key references', () => {
    const links = referencedRows([fk({})], orderColumns, [7, 3, 'x'], 'customer_id', 'sales', 'postgres')
    expect(links).toEqual([
      { label: 'Open referenced row in public.customers', schema: 'public', table: 'customers', where: 'id = 3', constraint: 'fk' },
    ])
    // another active column, or a NULL key, references nothing
    expect(referencedRows([fk({})], orderColumns, [7, 3, 'x'], 'note', 'sales', 'postgres')).toEqual([])
    expect(referencedRows([fk({})], orderColumns, [7, null, 'x'], undefined, 'sales', 'postgres')).toEqual([])
  })

  it('links a row to the rows of other tables that reference it', () => {
    const items = fk({ name: 'fk_items', table: 'order_items', columns: ['order_id'], refSchema: 'sales', refTable: 'orders', refColumns: ['id'] })
    const links = referencingRows([items], orderColumns, [7, 3, 'x'], 'sales', 'postgres')
    expect(links.map((l) => [l.label, l.table, l.where])).toEqual([['Rows in order_items referencing this (order_id)', 'order_items', 'order_id = 7']])
  })

  it('labels foreign-key columns for the header tooltip', () => {
    expect(foreignKeyLabels([fk({})], orderColumns, 'sales')).toEqual(new Map([[1, '→ public.customers (id)']]))
  })
})
