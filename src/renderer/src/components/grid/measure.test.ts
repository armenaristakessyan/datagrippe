import { describe, expect, it } from 'vitest'
import type { ColumnMeta } from '@shared/types'
import { CELL_PADDING, columnWidth, headerWidth, STRUCTURED_BADGE_WIDTH, type MeasureText } from './measure'

const measure: MeasureText = (text) => text.length * 7
const column: ColumnMeta = { name: 'order_id', dataType: 'int4' }

describe('column widths', () => {
  it('makes room for the primary-key glyph in the header', () => {
    expect(headerWidth(column, measure, true) - headerWidth(column, measure)).toBe(15)
    const plain = columnWidth(column, 0, 'number', [[1]], { nullDisplay: 'NULL', measure })
    const keyed = columnWidth(column, 0, 'number', [[1]], { nullDisplay: 'NULL', measure, keyColumns: new Set([0]) })
    expect(keyed - plain).toBe(15)
  })
  it('makes room for the JSON / XML badge in front of the value', () => {
    const doc: ColumnMeta = { name: 'd', dataType: 'jsonb' }
    const value = '{"a": [1, 2, 3], "b": "a longer value"}'
    const width = columnWidth(doc, 0, 'json', [[value]], { nullDisplay: 'NULL', measure })
    expect(width).toBe(value.length * 7 + CELL_PADDING + STRUCTURED_BADGE_WIDTH)
  })
})
