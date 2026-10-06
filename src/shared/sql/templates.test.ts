import { describe, expect, it } from 'vitest'
import type { ColumnInfo } from '../types'
import { classifyStatement, generateDelete, generateInsert, generateSelect, generateUpdate, splitStatements } from './index'

function col(name: string, dataType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    ordinal: 0,
    dataType,
    nullable: true,
    defaultValue: null,
    isPrimaryKey: false,
    isIdentity: false,
    isGenerated: false,
    ...extra,
  }
}

const users: ColumnInfo[] = [
  col('id', 'integer', { ordinal: 1, nullable: false, isPrimaryKey: true, isIdentity: true }),
  col('Email', 'varchar(255)', { ordinal: 2, nullable: false }),
  col('created_at', 'timestamptz', { ordinal: 3, defaultValue: 'now()' }),
  col('search', 'tsvector', { ordinal: 4, isGenerated: true }),
]

const orderLines: ColumnInfo[] = [
  col('OrderId', 'int', { ordinal: 1, nullable: false, isPrimaryKey: true }),
  col('LineNo', 'int', { ordinal: 2, nullable: false, isPrimaryKey: true }),
  col('Qty', 'decimal(12,2)', { ordinal: 3 }),
]

describe('generateSelect', () => {
  it('lists up to three columns inline', () => {
    expect(generateSelect('public', 'users', ['id', 'Email'], 'postgres')).toBe(
      'SELECT id, "Email"\nFROM public.users;',
    )
  })

  it('lists more than three columns one per line', () => {
    expect(generateSelect('public', 'users', ['id', 'Email', 'order', 'x'], 'postgres', 100)).toBe(
      'SELECT\n    id,\n    "Email",\n    "order",\n    x\nFROM public.users\nLIMIT 100;',
    )
  })

  it('uses TOP on SQL Server', () => {
    expect(generateSelect('dbo', 'Order Lines', ['OrderId'], 'mssql', 50)).toBe(
      'SELECT TOP (50) OrderId\nFROM dbo.[Order Lines];',
    )
    expect(generateSelect('dbo', 't', ['a', 'b', 'c', 'Key'], 'mssql', 10)).toBe(
      'SELECT TOP (10)\n    a,\n    b,\n    c,\n    [Key]\nFROM dbo.t;',
    )
  })

  it('falls back to * without columns', () => {
    expect(generateSelect('public', 't', [], 'postgres', 10)).toBe('SELECT *\nFROM public.t\nLIMIT 10;')
    expect(generateSelect('dbo', 't', [], 'mssql')).toBe('SELECT *\nFROM dbo.t;')
  })

  it('ignores invalid limits', () => {
    expect(generateSelect('public', 't', ['a'], 'postgres', -1)).toBe('SELECT a\nFROM public.t;')
    expect(generateSelect('public', 't', ['a'], 'postgres', Number.NaN)).toBe('SELECT a\nFROM public.t;')
    expect(generateSelect('public', 't', ['a'], 'postgres', 0)).toBe('SELECT a\nFROM public.t\nLIMIT 0;')
  })

  it('produces a read-only statement', () => {
    expect(classifyStatement(generateSelect('public', 't', ['a'], 'postgres', 5), 'postgres').readOnly).toBe(true)
  })
})

describe('generateInsert', () => {
  it('skips identity and generated columns and uses typed placeholders', () => {
    expect(generateInsert('public', 'users', users, 'postgres')).toBe(
      'INSERT INTO public.users ("Email", created_at)\n' +
        'VALUES (NULL /* Email varchar(255) */, DEFAULT /* created_at timestamptz */);',
    )
  })

  it('writes long column lists one per line', () => {
    const cols = ['a', 'b', 'c', 'd'].map((n, i) => col(n, 'int', { ordinal: i + 1 }))
    expect(generateInsert('dbo', 't', cols, 'mssql')).toBe(
      'INSERT INTO dbo.t (\n    a,\n    b,\n    c,\n    d\n)\nVALUES (\n' +
        '    NULL /* a int */,\n    NULL /* b int */,\n    NULL /* c int */,\n    NULL /* d int */\n);',
    )
  })

  it('orders columns by ordinal', () => {
    const cols = [col('b', 'int', { ordinal: 2 }), col('a', 'int', { ordinal: 1 })]
    expect(generateInsert('public', 't', cols, 'postgres')).toContain('(a, b)')
  })

  it('uses DEFAULT VALUES when nothing is insertable', () => {
    expect(generateInsert('public', 't', [users[0], users[3]], 'postgres')).toBe('INSERT INTO public.t DEFAULT VALUES;')
  })

  it('cannot break out of placeholder comments', () => {
    const sql = generateInsert('public', 't', [col('x', 'weird */ DROP TABLE t; /* type')], 'postgres')
    expect(splitStatements(sql, 'postgres')).toHaveLength(1)
    expect(classifyStatement(sql, 'postgres').destructive).toBe(false)
  })

  it('quotes identifiers per dialect', () => {
    expect(generateInsert('dbo', 'Order Lines', orderLines, 'mssql')).toBe(
      'INSERT INTO dbo.[Order Lines] (OrderId, [LineNo], Qty)\n' +
        'VALUES (NULL /* OrderId int */, NULL /* LineNo int */, NULL /* Qty decimal(12,2) */);',
    )
  })
})

describe('generateUpdate', () => {
  it('sets non-key writable columns and filters on the primary key', () => {
    expect(generateUpdate('public', 'users', users, 'postgres')).toBe(
      'UPDATE public.users\n' +
        'SET "Email" = NULL /* varchar(255) */,\n' +
        '    created_at = NULL /* timestamptz */\n' +
        'WHERE id = NULL /* integer */;',
    )
  })

  it('uses every primary key column', () => {
    expect(generateUpdate('dbo', 'Order Lines', orderLines, 'mssql')).toBe(
      'UPDATE dbo.[Order Lines]\n' +
        'SET Qty = NULL /* decimal(12,2) */\n' +
        'WHERE OrderId = NULL /* int */\n' +
        '  AND [LineNo] = NULL /* int */;',
    )
  })

  it('filters on all columns when there is no primary key', () => {
    const cols = [col('a', 'int', { ordinal: 1 }), col('b', 'text', { ordinal: 2 })]
    expect(generateUpdate('public', 'log', cols, 'postgres')).toBe(
      'UPDATE public.log\n' +
        'SET a = NULL /* int */,\n' +
        '    b = NULL /* text */\n' +
        'WHERE a = NULL /* int */\n' +
        '  AND b = NULL /* text */;',
    )
  })

  it('is never flagged as UPDATE without WHERE', () => {
    expect(classifyStatement(generateUpdate('public', 'users', users, 'postgres'), 'postgres').destructive).toBe(false)
  })

  it('handles a table without columns', () => {
    expect(splitStatements(generateUpdate('public', 't', [], 'postgres'), 'postgres')).toHaveLength(0)
  })
})

describe('generateDelete', () => {
  it('filters on the primary key', () => {
    expect(generateDelete('public', 'users', users, 'postgres')).toBe('DELETE FROM public.users\nWHERE id = NULL /* integer */;')
    expect(generateDelete('dbo', 'Order Lines', orderLines, 'mssql')).toBe(
      'DELETE FROM dbo.[Order Lines]\nWHERE OrderId = NULL /* int */\n  AND [LineNo] = NULL /* int */;',
    )
  })

  it('filters on all columns without a primary key', () => {
    const cols = [col('a', 'int', { ordinal: 1 })]
    expect(generateDelete('public', 'log', cols, 'postgres')).toBe('DELETE FROM public.log\nWHERE a = NULL /* int */;')
  })

  it('is never flagged as DELETE without WHERE', () => {
    expect(classifyStatement(generateDelete('dbo', 't', orderLines, 'mssql'), 'mssql').destructive).toBe(false)
    expect(classifyStatement(generateDelete('dbo', 't', [], 'mssql'), 'mssql').destructive).toBe(false)
    expect(classifyStatement(generateDelete('public', 't', [], 'postgres'), 'postgres').destructive).toBe(false)
  })
})
