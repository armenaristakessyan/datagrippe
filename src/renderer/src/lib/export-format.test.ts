import { describe, expect, it } from 'vitest'
import type { CellValue, ColumnMeta } from '@shared/types'
import { formatRows, insertTarget, toCSV, toJSON, toMarkdown, toSqlInList, toSqlInsert, toTSV, uniqueColumnNames } from './export-format'

const columns: ColumnMeta[] = [
  { name: 'id', dataType: 'int4' },
  { name: 'name', dataType: 'text' },
  { name: 'amount', dataType: 'numeric' },
  { name: 'active', dataType: 'bool' },
]
const rows: CellValue[][] = [
  [1, 'Ada', '12.50', true],
  [2, null, '99999999999999999999.01', false],
]

describe('toTSV', () => {
  it('writes a header and tab-separated rows', () => {
    expect(toTSV(columns, rows)).toBe('id\tname\tamount\tactive\n1\tAda\t12.50\ttrue\n2\t\t99999999999999999999.01\tfalse')
  })
  it('omits the header and renders NULL text on request', () => {
    expect(toTSV(columns.slice(0, 2), [[2, null]], { header: false, nullText: 'NULL' })).toBe('2\tNULL')
  })
  it('quotes fields with tabs, line breaks or a leading quote only', () => {
    const values = [['a\tb'], ['line1\nline2'], ['"quoted" start'], ['say "hi"'], ['{"a":1}']]
    expect(toTSV([{ name: 'v', dataType: 'text' }], values, { header: false })).toBe(
      '"a\tb"\n"line1\nline2"\n"""quoted"" start"\nsay "hi"\n{"a":1}',
    )
  })
})

describe('toCSV', () => {
  it('follows RFC 4180 (CRLF, quoting, doubled quotes)', () => {
    const csv = toCSV([{ name: 'a', dataType: 'text' }, { name: 'b,c', dataType: 'text' }], [
      ['x', 'he said "yo"'],
      ['multi\nline', null],
      [' padded', 'ok'],
    ])
    expect(csv).toBe('a,"b,c"\r\nx,"he said ""yo"""\r\n"multi\nline",\r\n" padded",ok\r\n')
  })
  it('supports a custom delimiter', () => {
    expect(toCSV([{ name: 'a', dataType: 'text' }, { name: 'b', dataType: 'text' }], [['1;2', '3']], { delimiter: ';', header: false })).toBe('"1;2";3\r\n')
  })
  it('is empty without header and rows', () => {
    expect(toCSV(columns, [], { header: false })).toBe('')
  })
})

describe('toJSON', () => {
  it('keeps numbers, booleans, null and string numerics', () => {
    expect(JSON.parse(toJSON(columns, rows))).toEqual([
      { id: 1, name: 'Ada', amount: '12.50', active: true },
      { id: 2, name: null, amount: '99999999999999999999.01', active: false },
    ])
  })
  it('embeds json columns and dedupes names', () => {
    const out = JSON.parse(
      toJSON(
        [
          { name: 'doc', dataType: 'jsonb' },
          { name: 'doc', dataType: 'text' },
          { name: 'bad', dataType: 'json' },
        ],
        [['{"a":[1,2]}', '{"a":1}', '{oops']],
      ),
    ) as unknown
    expect(out).toEqual([{ doc: { a: [1, 2] }, doc_2: '{"a":1}', bad: '{oops' }])
  })
  it('renders non-finite numbers as strings', () => {
    expect(JSON.parse(toJSON([{ name: 'f', dataType: 'float8' }], [[Number.POSITIVE_INFINITY]]))).toEqual([{ f: 'Infinity' }])
  })
})

describe('uniqueColumnNames', () => {
  it('suffixes duplicates', () => {
    expect(uniqueColumnNames([{ name: 'a', dataType: '' }, { name: 'a', dataType: '' }, { name: 'a_2', dataType: '' }, { name: '', dataType: '' }])).toEqual([
      'a',
      'a_2',
      'a_2_2',
      'column',
    ])
  })
})

describe('toMarkdown', () => {
  it('escapes pipes and line breaks and right-aligns numbers', () => {
    const md = toMarkdown([{ name: 'n', dataType: 'int8' }, { name: 'a|b', dataType: 'text' }], [
      ['1', 'x|y'],
      [null, 'two\nlines'],
      [3, ''],
    ])
    expect(md).toBe(['| n | a\\|b |', '| ---: | --- |', '| 1 | x\\|y |', '| NULL | two<br>lines |', '| 3 |   |'].join('\n'))
  })
})

describe('insertTarget', () => {
  it('quotes each part when needed', () => {
    expect(insertTarget('public.orders', 'postgres')).toBe('public.orders')
    expect(insertTarget('Sales.Order Lines', 'mssql')).toBe('Sales.[Order Lines]')
    expect(insertTarget('User', 'postgres')).toBe('"User"')
    expect(insertTarget('"Already"."Quoted"', 'postgres')).toBe('"Already"."Quoted"')
    expect(insertTarget(undefined, 'postgres')).toBe('table_name')
  })
})

describe('toSqlInsert', () => {
  it('renders multi-row VALUES with typed literals (postgres)', () => {
    expect(toSqlInsert('public.items', columns, rows, 'postgres')).toBe(
      'INSERT INTO public.items (id, name, amount, active) VALUES\n' +
        "  (1, 'Ada', 12.50, TRUE),\n" +
        '  (2, NULL, 99999999999999999999.01, FALSE);\n',
    )
  })
  it('uses N strings, bit literals and binary on SQL Server', () => {
    const sql = toSqlInsert(
      'dbo.t',
      [
        { name: 'name', dataType: 'nvarchar' },
        { name: 'flag', dataType: 'bit' },
        { name: 'blob', dataType: 'varbinary' },
      ],
      [["O'Brien", true, '0xDEADBEEF']],
      'mssql',
    )
    expect(sql).toBe("INSERT INTO dbo.t (name, flag, blob) VALUES\n  (N'O''Brien', 1, 0xDEADBEEF);\n")
  })
  it('casts PostgreSQL bytea hex', () => {
    expect(toSqlInsert('t', [{ name: 'b', dataType: 'bytea' }], [['\\x0102']], 'postgres')).toBe("INSERT INTO t (b) VALUES\n  ('\\x0102'::bytea);\n")
  })
  it('chunks 100 rows per statement and caps SQL Server at 1000', () => {
    const many = Array.from({ length: 250 }, (_, i) => [i] as CellValue[])
    const pg = toSqlInsert('t', [{ name: 'i', dataType: 'int4' }], many, 'postgres')
    expect(pg.match(/INSERT INTO/g)).toHaveLength(3)
    const big = Array.from({ length: 2500 }, (_, i) => [i] as CellValue[])
    const ms = toSqlInsert('t', [{ name: 'i', dataType: 'int' }], big, 'mssql', { chunkSize: 5000 })
    expect(ms.match(/INSERT INTO/g)).toHaveLength(3)
  })
  it('quotes reserved column names', () => {
    expect(toSqlInsert('t', [{ name: 'order', dataType: 'text' }], [['x']], 'postgres')).toContain('("order")')
  })
  it('is empty without rows', () => {
    expect(toSqlInsert('t', columns, [], 'postgres')).toBe('')
  })
})

describe('toSqlInList', () => {
  it('dedupes and keeps first-seen order', () => {
    expect(toSqlInList([3, 1, 3, null, 2], 'postgres', 'int4')).toBe('(3, 1, NULL, 2)')
    expect(toSqlInList(['a', "b'c", 'a'], 'mssql', 'nvarchar')).toBe("(N'a', N'b''c')")
    expect(toSqlInList(['10', '2'], 'postgres', 'int8')).toBe('(10, 2)')
  })
})

describe('formatRows', () => {
  it('dispatches on the format', () => {
    expect(formatRows('tsv', columns.slice(0, 1), [[1]])).toBe('id\n1')
    expect(formatRows('sql', columns.slice(0, 1), [[1]], { tableName: 't', dialect: 'mssql' })).toBe('INSERT INTO t (id) VALUES\n  (1);\n')
    expect(formatRows('markdown', columns.slice(0, 1), [[1]])).toContain('| id |')
  })
})
