import { describe, expect, it } from 'vitest'
import { toJSON } from '@/lib/export-format'
import { prettyJson } from './cell-format'
import { isValidJson, reindentJson } from './json-text'

describe('reindentJson', () => {
  it('lays out like JSON.stringify(…, 2) for ordinary documents', () => {
    const docs = ['{"a":1,"b":[1,2,{"c":null}],"d":{},"e":[],"f":"x"}', '[]', '{}', '"s"', '[ 1 , [ ] , { "k" : true } ]', '  {"nested": {"deep": [[1], [2, 3]]}}  ']
    for (const doc of docs) expect(reindentJson(doc.trim())).toBe(JSON.stringify(JSON.parse(doc), null, 2))
  })
  it('copies numbers and strings verbatim (no round trip through JS doubles)', () => {
    const pretty = reindentJson('{"id": 12345678901234567890, "price": 1.10, "e": 1E+2, "neg": -0, "s": "a\\u00e9\\"b,:{}"}')!
    expect(pretty).toContain('12345678901234567890')
    expect(pretty).toContain('1.10')
    expect(pretty).toContain('1E+2')
    expect(pretty).toContain('-0')
    expect(pretty).toContain('"a\\u00e9\\"b,:{}"')
  })
  it('supports compact output and a starting depth', () => {
    expect(reindentJson('{ "a" : [ 1, 2 ] }', '')).toBe('{"a":[1,2]}')
    expect(reindentJson('{"a":1}', '  ', 2)).toBe('{\n      "a": 1\n    }')
  })
  it('rejects invalid JSON', () => {
    expect(reindentJson('{"a":')).toBeNull()
    expect(isValidJson('')).toBe(false)
  })
})

describe('JSON precision', () => {
  it('prettyJson keeps big integers and decimal text exactly (inspector Pretty / Format)', () => {
    const pretty = prettyJson('{"id": 12345678901234567890, "price": 1.10}')
    expect(pretty).toBe('{\n  "id": 12345678901234567890,\n  "price": 1.10\n}')
  })

  it('toJSON keeps big integers of embedded json / jsonb values', () => {
    const text = toJSON([{ name: 'doc', dataType: 'jsonb' }], [['{"id": 12345678901234567890}']])
    expect(text).toContain('12345678901234567890')
    expect(JSON.parse(text)).toEqual([{ doc: { id: 12345678901234567890 } }])
  })

  it('toJSON matches JSON.stringify for plain values and embeds documents at the right depth', () => {
    const columns = [
      { name: 'id', dataType: 'int4' },
      { name: 'doc', dataType: 'json' },
      { name: 'id', dataType: 'text' },
      { name: 'bad', dataType: 'jsonb' },
    ]
    const rows = [
      [1, '{"a":[1,2]}', 'x', '{oops'],
      [Number.NaN, null, null, null],
    ]
    const expected = JSON.stringify(
      [
        { id: 1, doc: { a: [1, 2] }, id_2: 'x', bad: '{oops' },
        { id: 'NaN', doc: null, id_2: null, bad: null },
      ],
      null,
      2,
    )
    expect(toJSON(columns, rows)).toBe(expected)
    expect(toJSON(columns, rows, { indent: 0 })).toBe(JSON.stringify(JSON.parse(expected)))
    expect(toJSON(columns, [])).toBe('[]')
  })
})
