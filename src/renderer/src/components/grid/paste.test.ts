import { describe, expect, it } from 'vitest'
import { toTSV } from '@/lib/export-format'
import { parsePastedText } from './paste'

describe('parsePastedText', () => {
  it('reads one value', () => {
    expect(parsePastedText('hello')).toEqual([['hello']])
    expect(parsePastedText('')).toEqual([['']])
  })

  it('reads a spreadsheet block (trailing line break ignored, CRLF accepted)', () => {
    expect(parsePastedText('a\t1\r\nb\t2\r\n')).toEqual([
      ['a', '1'],
      ['b', '2'],
    ])
  })

  it('keeps empty fields, including a trailing one', () => {
    expect(parsePastedText('a\t\tc')).toEqual([['a', '', 'c']])
    expect(parsePastedText('a\t')).toEqual([['a', '']])
  })

  it('reads quoted fields holding tabs, line breaks and quotes', () => {
    expect(parsePastedText('"x\ty"\t"line 1\nline 2"\t"say ""hi"""')).toEqual([['x\ty', 'line 1\nline 2', 'say "hi"']])
  })

  it('round-trips what the grid copies as TSV', () => {
    const columns = [
      { name: 'a', dataType: 'text' },
      { name: 'b', dataType: 'text' },
    ]
    const rows = [
      ['tab\there', 'multi\nline'],
      ['"quoted', 'plain'],
    ]
    expect(parsePastedText(toTSV(columns, rows, { header: false }))).toEqual(rows)
  })
})
