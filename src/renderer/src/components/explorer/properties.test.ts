import { describe, expect, it } from 'vitest'
import type { ColumnInfo, TableDetails } from '@shared/types'
import { columnProperties, detailProperties, indexColumnName } from './properties'

const column = (name: string, ordinal: number, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  ordinal,
  dataType: 'integer',
  nullable: false,
  defaultValue: null,
  isPrimaryKey: false,
  isIdentity: false,
  isGenerated: false,
  ...extra,
})

const lines: TableDetails = {
  schema: 'sales',
  name: 'order_lines',
  kind: 'table',
  columns: [column('order_id', 1, { isPrimaryKey: true }), column('line', 2, { isPrimaryKey: true }), column('sku', 3, { dataType: 'text' })],
  primaryKey: ['order_id', 'line'],
  indexes: [
    { name: 'order_lines_pkey', columns: ['order_id', 'line'], isUnique: true, isPrimary: true, method: 'btree' },
    { name: 'order_lines_sku_idx', columns: ['sku'], isUnique: false, isPrimary: false, method: 'btree' },
    { name: 'order_lines_sku_key', columns: ['sku'], isUnique: true, isPrimary: false, method: 'btree' },
    { name: 'order_lines_line_sku_idx', columns: ['line', 'sku'], isUnique: false, isPrimary: false, method: 'hash' },
  ],
  foreignKeys: [
    {
      name: 'order_lines_order_fk',
      schema: 'sales',
      table: 'order_lines',
      columns: ['order_id'],
      refSchema: 'sales',
      refTable: 'orders',
      refColumns: ['id'],
      onDelete: 'CASCADE',
      onUpdate: 'NO ACTION',
    },
    {
      name: 'order_lines_sku_fk',
      schema: 'sales',
      table: 'order_lines',
      columns: ['sku'],
      refSchema: 'catalog',
      refTable: 'products',
      refColumns: ['sku'],
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
    },
  ],
  referencedBy: [
    {
      name: 'returns_line_fk',
      schema: 'sales',
      table: 'returns',
      columns: ['order_ref', 'line_ref'],
      refSchema: 'sales',
      refTable: 'order_lines',
      refColumns: ['order_id', 'line'],
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
  ],
  constraints: [
    { name: 'order_lines_pkey', type: 'primary-key', columns: ['order_id', 'line'] },
    { name: 'order_lines_sku_key', type: 'unique', columns: ['sku'] },
    { name: 'order_lines_line_check', type: 'check', columns: ['line'], definition: 'CHECK (line > 0)' },
  ],
  triggers: [{ name: 'order_lines_audit', timing: 'AFTER', events: ['INSERT', 'UPDATE'], enabled: false, definition: 'CREATE TRIGGER order_lines_audit …' }],
}

describe('columnProperties', () => {
  it('lists the keys, foreign keys and indexes of a composite primary key column', () => {
    const p = columnProperties(lines.columns[0]!, lines)
    expect(p.primaryKey).toEqual({ name: 'order_lines_pkey', with: ['line'] })
    expect(p.unique).toEqual([])
    expect(p.references).toEqual([{ name: 'order_lines_order_fk', target: 'orders.id', actions: ['ON DELETE CASCADE'] }])
    expect(p.referencedBy).toEqual([{ name: 'returns_line_fk', target: 'returns.order_ref', actions: ['ON DELETE SET NULL', 'ON UPDATE CASCADE'] }])
    // order_lines_pkey backs the primary key, already listed.
    expect(p.indexes).toEqual([])
    expect(p.checks).toEqual([])
  })

  it('pairs each column of a composite foreign key with its own referenced column', () => {
    const p = columnProperties(lines.columns[1]!, lines)
    expect(p.referencedBy.map((r) => r.target)).toEqual(['returns.line_ref'])
    expect(p.checks).toEqual([{ name: 'order_lines_line_check', definition: 'CHECK (line > 0)' }])
  })

  it('qualifies references to another schema and keeps non-key columns key-free', () => {
    const p = columnProperties(lines.columns[2]!, lines)
    expect(p.primaryKey).toBeUndefined()
    expect(p.unique).toEqual([{ name: 'order_lines_sku_key', with: [] }])
    expect(p.references).toEqual([{ name: 'order_lines_sku_fk', target: 'catalog.products.sku', actions: [] }])
    // order_lines_sku_key backs the unique constraint.
    expect(p.indexes).toEqual([
      { name: 'order_lines_sku_idx', unique: false, primary: false, method: 'btree', with: [] },
      { name: 'order_lines_line_sku_idx', unique: false, primary: false, method: 'hash', with: ['line'] },
    ])
  })

  it('falls back to the column flags without table details', () => {
    const p = columnProperties(column('id', 1, { isPrimaryKey: true }), undefined)
    expect(p.primaryKey).toEqual({ name: '', with: [] })
    expect(p.indexes).toEqual([])
  })

  it('matches the quoted column names of PostgreSQL index entries', () => {
    expect(indexColumnName('"AccountId"')).toBe('AccountId')
    expect(indexColumnName('"say ""hi"""')).toBe('say "hi"')
    expect(indexColumnName('lower(name)')).toBe('lower(name)')
    const details: TableDetails = {
      ...lines,
      columns: [column('AccountId', 1)],
      primaryKey: [],
      indexes: [{ name: 'IX_Account', columns: ['"AccountId"'], isUnique: false, isPrimary: false }],
      foreignKeys: [],
      referencedBy: [],
      constraints: [],
    }
    expect(columnProperties(details.columns[0]!, details).indexes.map((i) => i.name)).toEqual(['IX_Account'])
    expect(detailProperties('indexes', 'IX_Account', details)).toMatchObject({ columns: [{ name: 'AccountId', dataType: 'integer' }] })
  })
})

describe('detailProperties', () => {
  it('describes a key with its columns, types and backing index', () => {
    expect(detailProperties('keys', 'order_lines_pkey', lines)).toEqual({
      kind: 'key',
      name: 'order_lines_pkey',
      primary: true,
      columns: [
        { name: 'order_id', dataType: 'integer' },
        { name: 'line', dataType: 'integer' },
      ],
      method: 'btree',
      definition: undefined,
    })
    expect(detailProperties('keys', 'order_lines_sku_key', lines)).toMatchObject({ primary: false, columns: [{ name: 'sku', dataType: 'text' }] })
  })

  it('describes a foreign key column by column', () => {
    expect(detailProperties('foreign-keys', 'order_lines_sku_fk', lines)).toEqual({
      kind: 'foreign-key',
      name: 'order_lines_sku_fk',
      target: 'catalog.products',
      pairs: [{ column: 'sku', dataType: 'text', refColumn: 'sku' }],
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
    })
    expect(detailProperties('foreign-keys', 'order_lines_order_fk', lines)).toMatchObject({ target: 'orders', onDelete: 'CASCADE' })
  })

  it('describes indexes and triggers', () => {
    expect(detailProperties('indexes', 'order_lines_line_sku_idx', lines)).toMatchObject({
      kind: 'index',
      unique: false,
      method: 'hash',
      columns: [{ name: 'line' }, { name: 'sku' }],
    })
    expect(detailProperties('triggers', 'order_lines_audit', lines)).toMatchObject({
      kind: 'trigger',
      timing: 'AFTER',
      events: ['INSERT', 'UPDATE'],
      enabled: false,
    })
  })

  it('is undefined for an item that is gone or details that are not loaded', () => {
    expect(detailProperties('keys', 'order_lines_line_check', lines)).toBeUndefined()
    expect(detailProperties('indexes', 'nope', lines)).toBeUndefined()
    expect(detailProperties('triggers', 'order_lines_audit', undefined)).toBeUndefined()
  })
})
