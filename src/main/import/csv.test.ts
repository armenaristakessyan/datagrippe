import { describe, expect, it } from 'vitest'
import { CsvParser, csvOptions, detectDelimiter, parseCsv } from './csv'
import { headerNames, importLiteral, textLiteral } from './import-csv'

describe('parseCsv', () => {
  it('reads RFC 4180 fields', () => {
    expect(parseCsv('a,b\r\n1,"x, y"\r\n2,"say ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['1', 'x, y'],
      ['2', 'say "hi"'],
    ])
  })

  it('keeps line breaks inside quotes and accepts LF / CR endings and no final newline', () => {
    expect(parseCsv('1,"two\nlines"\n2,x\r3,y')).toEqual([
      ['1', 'two\nlines'],
      ['2', 'x'],
      ['3', 'y'],
    ])
  })

  it('reads unquoted empty fields as NULL and quoted ones as empty strings', () => {
    expect(parseCsv('1,,""\n')).toEqual([['1', null, '']])
    expect(parseCsv('1,NULL,"NULL"\n', { nullText: 'NULL' })).toEqual([['1', null, 'NULL']])
    expect(parseCsv('1,,x\n', { nullText: 'NULL' })).toEqual([['1', '', 'x']])
  })

  it('skips blank lines and leading lines', () => {
    expect(parseCsv('title\n\na,b\n\n1,2\n', { skipLines: 1 })).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('handles other delimiters, including an escaped tab', () => {
    expect(parseCsv('a;b\n1;2', { delimiter: ';' })).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(parseCsv('a\tb\n1\t2', { delimiter: '\\t' })).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(() => csvOptions({ delimiter: '"' })).toThrow(/delimiter/)
  })

  it('gives the same records whatever the chunk boundaries', () => {
    const text = 'id,name\r\n1,"a ""quoted"",\r\nvalue"\r\n2,b\r\n'
    const whole = parseCsv(text)
    for (let size = 1; size < text.length; size++) {
      const parser = new CsvParser()
      const records = []
      for (let i = 0; i < text.length; i += size) records.push(...parser.feed(text.slice(i, i + size)))
      records.push(...parser.end())
      expect(records).toEqual(whole)
    }
  })

  it('fails on an unterminated quoted field', () => {
    expect(() => parseCsv('1,"open\n2,3')).toThrow(/closing quote/)
  })
})

describe('detectDelimiter', () => {
  it('picks the consistent separator', () => {
    expect(detectDelimiter('a,b,c\n1,2,3\n')).toBe(',')
    expect(detectDelimiter('a;b;c\n1;2,5;3\n')).toBe(';')
    expect(detectDelimiter('a\tb\n1\t"x,y"\n')).toBe('\t')
    expect(detectDelimiter('single\nvalue\n')).toBe(',')
  })
})

describe('import helpers', () => {
  it('names columns from the header, unique and never blank', () => {
    expect(headerNames(['id', '', 'Id', null], 4, true)).toEqual(['id', 'column_2', 'Id_2', 'column_4'])
    expect(headerNames(undefined, 2, false)).toEqual(['column_1', 'column_2'])
  })

  it('renders escape-safe literals', () => {
    expect(textLiteral("it's \\ back", 'postgres')).toBe("E'it''s \\\\ back'")
    expect(textLiteral("it's", 'mssql')).toBe("N'it''s'")
    expect(() => textLiteral('a\0b', 'postgres')).toThrow(/NUL/)
    expect(importLiteral(null, { dataType: 'int' }, 'mssql')).toBe('NULL')
    expect(importLiteral('0xDEADBEEF', { dataType: 'varbinary(16)' }, 'mssql')).toBe('0xDEADBEEF')
    expect(() => importLiteral('0x1); DROP TABLE t; --', { dataType: 'varbinary' }, 'mssql')).toThrow(/binary/)
    expect(importLiteral('\\xdeadbeef', { dataType: 'bytea' }, 'postgres')).toBe("E'\\\\xdeadbeef'")
  })
})
