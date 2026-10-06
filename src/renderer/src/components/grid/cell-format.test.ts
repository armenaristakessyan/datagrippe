import { describe, expect, it } from 'vitest'
import { cellDisplay, CELL_TEXT_CAP, isRightAligned, parseEditedText, prettyJson, prettyXml, tokenizeJson, tokenizeXml } from './cell-format'
import { columnKind, inferColumnKind, isNumericText } from './column-types'
import { columnWidth, sampleRows } from './measure'

describe('columnKind', () => {
  it('classifies PostgreSQL and SQL Server types', () => {
    expect(columnKind('int8')).toBe('number')
    expect(columnKind('numeric(12,2)')).toBe('number')
    expect(columnKind('money')).toBe('number')
    expect(columnKind('decimal')).toBe('number')
    expect(columnKind('bool')).toBe('boolean')
    expect(columnKind('bit', 'mssql')).toBe('boolean')
    // PostgreSQL bit(n) is a bit string
    expect(columnKind('bit', 'postgres')).toBe('text')
    expect(columnKind('bit(3)', 'postgres')).toBe('text')
    expect(columnKind('varbit', 'postgres')).toBe('text')
    // a typed bit string is submitted as text, never as a JS boolean ('"f" is not a valid binary digit')
    const pgBit = inferColumnKind({ name: 'b', dataType: 'bit' }, [['1'], ['0']], 0, 'postgres')
    expect(pgBit).toBe('text')
    expect(parseEditedText('0', '1', pgBit)).toBe('0')
    expect(parseEditedText('0110', '101', inferColumnKind({ name: 'v', dataType: 'varbit' }, [['101']], 0, 'postgres'))).toBe('0110')
    expect(columnKind('jsonb')).toBe('json')
    expect(columnKind('xml')).toBe('xml')
    expect(columnKind('timestamptz')).toBe('date')
    expect(columnKind('datetime2')).toBe('date')
    expect(columnKind('bytea')).toBe('binary')
    expect(columnKind('varbinary')).toBe('binary')
    expect(columnKind('timestamp', 'mssql')).toBe('binary')
    expect(columnKind('timestamp', 'postgres')).toBe('date')
    expect(columnKind('uniqueidentifier')).toBe('uuid')
    expect(columnKind('int4[]')).toBe('array')
    expect(columnKind('_text')).toBe('array')
    expect(columnKind('varchar')).toBe('text')
  })
  it('infers unknown types from values', () => {
    expect(inferColumnKind({ name: 'x', dataType: 'sql_variant' }, [[1], [null], [2]], 0)).toBe('number')
    expect(inferColumnKind({ name: 'x', dataType: 'unknown' }, [[true]], 0)).toBe('boolean')
    expect(inferColumnKind({ name: 'x', dataType: 'unknown' }, [['\\x00ff']], 0)).toBe('binary')
    expect(inferColumnKind({ name: 'x', dataType: 'text' }, [['a'], [1]], 0)).toBe('text')
  })
  it('detects numeric text', () => {
    expect(isNumericText('-12.5e3')).toBe(true)
    expect(isNumericText(' 42 ')).toBe(true)
    expect(isNumericText('12a')).toBe(false)
    expect(isNumericText('')).toBe(false)
  })
})

describe('cellDisplay', () => {
  it('distinguishes NULL, empty and whitespace-only strings', () => {
    expect(cellDisplay(null, 'text')).toEqual({ type: 'null' })
    expect(cellDisplay('', 'text')).toEqual({ type: 'empty' })
    expect(cellDisplay('   ', 'text')).toEqual({ type: 'blank', length: 3 })
  })
  it('renders booleans, including bit numbers', () => {
    expect(cellDisplay(true, 'boolean')).toEqual({ type: 'boolean', value: true })
    expect(cellDisplay(0, 'boolean')).toEqual({ type: 'boolean', value: false })
  })
  it('splits line breaks and caps long text', () => {
    expect(cellDisplay('a\nb', 'text')).toEqual({ type: 'text', segments: ['a', 'b'], truncated: false, badge: undefined })
    const long = cellDisplay('x'.repeat(CELL_TEXT_CAP + 50), 'text')
    expect(long.type === 'text' && long.truncated && long.segments[0]!.length === CELL_TEXT_CAP).toBe(true)
  })
  it('collapses multi-line JSON and badges it', () => {
    expect(cellDisplay('{\n  "a": 1\n}', 'json')).toEqual({ type: 'text', segments: ['{ "a": 1 }'], truncated: false, badge: 'json' })
  })
  it('truncates binary hex with the byte size', () => {
    const d = cellDisplay('\\x' + 'ab'.repeat(100), 'binary')
    expect(d).toEqual({ type: 'binary', hex: '\\x' + 'ab'.repeat(24), bytes: 100, truncated: true })
  })
  it('aligns numbers right', () => {
    expect(isRightAligned(1, 'text')).toBe(true)
    expect(isRightAligned('12.5', 'number')).toBe(true)
    expect(isRightAligned('abc', 'text')).toBe(false)
  })
})

describe('inspector formatting', () => {
  it('pretty prints JSON or returns null', () => {
    expect(prettyJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}')
    expect(prettyJson('not json')).toBeNull()
    expect(prettyJson('{broken')).toBeNull()
  })
  it('indents XML, keeping simple elements on one line', () => {
    expect(prettyXml('<a x="1"><b>text</b><c/><d><e>1</e></d></a>')).toBe(
      '<a x="1">\n  <b>text</b>\n  <c/>\n  <d>\n    <e>1</e>\n  </d>\n</a>',
    )
    expect(prettyXml('plain')).toBe('plain')
  })
  it('tokenizes JSON keys, strings, numbers and literals', () => {
    const types = tokenizeJson('{"k": "v", "n": -1.5e2, "b": true, "z": null}')
      .filter((t) => t.type !== 'punct' && t.type !== 'text')
      .map((t) => `${t.type}:${t.text}`)
    expect(types).toEqual(['key:"k"', 'string:"v"', 'key:"n"', 'number:-1.5e2', 'key:"b"', 'literal:true', 'key:"z"', 'literal:null'])
    expect(tokenizeJson('{"a":1}').map((t) => t.text).join('')).toBe('{"a":1}')
  })
  it('tokenizes XML and round-trips the text', () => {
    const text = '<a href="x"><!-- c -->hi</a>'
    const tokens = tokenizeXml(text)
    expect(tokens.map((t) => t.text).join('')).toBe(text)
    expect(tokens.find((t) => t.type === 'attr')?.text).toBe(' href')
    expect(tokens.find((t) => t.type === 'comment')?.text).toBe('<!-- c -->')
  })
})

describe('parseEditedText', () => {
  it('keeps the column value type', () => {
    expect(parseEditedText('42', 7, 'number')).toBe(42)
    expect(parseEditedText('12345678901234567890', '1', 'number')).toBe('12345678901234567890')
    expect(parseEditedText('abc', 7, 'number')).toBe('abc')
    expect(parseEditedText('5', null, 'number')).toBe(5)
    expect(parseEditedText('0.1000', null, 'number')).toBe('0.1000')
    expect(parseEditedText('TRUE', false, 'boolean')).toBe(true)
    expect(parseEditedText('0', true, 'boolean')).toBe(false)
    expect(parseEditedText('maybe', true, 'boolean')).toBe('maybe')
    expect(parseEditedText(' text ', 'x', 'text')).toBe(' text ')
  })
})

describe('measure', () => {
  const measure = (text: string) => text.length * 7
  it('samples rows evenly with the head included', () => {
    expect(sampleRows(5, 10)).toEqual([0, 1, 2, 3, 4])
    const s = sampleRows(1000, 10)
    expect(s.slice(0, 5)).toEqual([0, 1, 2, 3, 4])
    expect(s).toHaveLength(10)
    expect(Math.max(...s)).toBeLessThan(1000)
  })
  it('fits header and values within the clamp', () => {
    const w = columnWidth({ name: 'id', dataType: 'int4' }, 0, 'number', [[1], [22]], { nullDisplay: 'NULL', measure })
    expect(w).toBe(64 + 4) // the type label 'int4' is the widest
    const wide = columnWidth({ name: 'c', dataType: 'text' }, 0, 'text', [['x'.repeat(500)]], { nullDisplay: 'NULL', measure })
    expect(wide).toBe(420)
    const mid = columnWidth({ name: 'c', dataType: 'text' }, 0, 'text', [['x'.repeat(20)]], { nullDisplay: 'NULL', measure })
    expect(mid).toBe(20 * 7 + 20)
  })
})
