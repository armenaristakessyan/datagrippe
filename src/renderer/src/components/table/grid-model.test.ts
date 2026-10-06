import { describe, expect, it } from 'vitest'
import type { CellValue, ColumnInfo, ColumnMeta } from '@shared/types'
import {
  DEFAULT_PLACEHOLDER,
  applyGridEdit,
  buildGridModel,
  duplicateValues,
  cellPlaceholderIn,
  isCellModifiedIn,
  readOnlyColumnIndices,
  rowRange,
  rowStateOf,
  type PageLike,
} from './grid-model'
import { DEFAULT_VALUE, EMPTY_CHANGES, addInsert, deleteRows, newInsert, rowKeyOf, toRowChanges } from './pending-changes'

const columns: ColumnMeta[] = [
  { name: 'id', dataType: 'int4' },
  { name: 'name', dataType: 'varchar' },
  { name: 'total', dataType: 'numeric' },
]
const rows: CellValue[][] = [
  [1, 'Ada', '10.00'],
  [2, 'Alan', null],
]
const page: PageLike = { columns, rows, primaryKey: ['id'] }
const names = columns.map((c) => c.name)

const detail = (name: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  ordinal: 1,
  dataType: 'int',
  nullable: true,
  defaultValue: null,
  isPrimaryKey: false,
  isIdentity: false,
  isGenerated: false,
  ...extra,
})

describe('buildGridModel', () => {
  it('passes page rows through with stable keys', () => {
    const model = buildGridModel(page, EMPTY_CHANGES)
    expect(model.rows).toEqual(rows)
    expect(model.info.map((i) => i.key)).toEqual(['row:[1]', 'row:[2]'])
    expect(model.info[1]?.pageIndex).toBe(1)
  })

  it('renders inserts on top, newest first, with DEFAULT placeholders', () => {
    let c = addInsert(EMPTY_CHANGES, newInsert('a', names, { name: 'First' }))
    c = addInsert(c, newInsert('b', names))
    const model = buildGridModel(page, c)
    expect(model.rows.slice(0, 2)).toEqual([
      [null, null, null],
      [null, 'First', null],
    ])
    expect(names.map((n) => cellPlaceholderIn(c, model.info[1], n))).toEqual([DEFAULT_PLACEHOLDER, undefined, DEFAULT_PLACEHOLDER])
    expect(cellPlaceholderIn(c, model.info[2], 'name')).toBeUndefined()
    expect(model.info.slice(0, 2).map((i) => i.ref)).toEqual([
      { kind: 'inserted', id: 'b' },
      { kind: 'inserted', id: 'a' },
    ])
    expect(rowStateOf(c, model.info[0])).toBe('inserted')
    expect(rowStateOf(c, model.info[2])).toBeUndefined()
  })

  it('shows edited values and flags modified cells', () => {
    let model = buildGridModel(page, EMPTY_CHANGES)
    const c = applyGridEdit(EMPTY_CHANGES, model, page, 1, 2, '99.50')
    model = buildGridModel(page, c)
    expect(model.rows[1]).toEqual([2, 'Alan', '99.50'])
    expect(rowStateOf(c, model.info[1])).toBe('modified')
    expect(isCellModifiedIn(c, model.info[1], 'total')).toBe(true)
    expect(isCellModifiedIn(c, model.info[1], 'name')).toBe(false)
    expect(toRowChanges(c)).toEqual([{ type: 'update', key: { id: 2 }, values: { total: '99.50' } }])
  })

  it('maps edits below inserts to the right page row', () => {
    const withInsert = addInsert(EMPTY_CHANGES, newInsert('a', names))
    const model = buildGridModel(page, withInsert)
    const c = applyGridEdit(withInsert, model, page, 1, 1, 'Ada L.')
    expect(c.updates[rowKeyOf({ id: 1 }, ['id'])]?.cells.name).toEqual({ original: 'Ada', value: 'Ada L.' })
  })

  it('edits inserted cells, including the literal text DEFAULT and an explicit NULL', () => {
    let c = addInsert(EMPTY_CHANGES, newInsert('a', names))
    let model = buildGridModel(page, c)
    c = applyGridEdit(c, model, page, 0, 1, 'New')
    expect(c.inserts[0]?.values.name).toBe('New')
    model = buildGridModel(page, c)
    expect(isCellModifiedIn(c, model.info[0], 'name')).toBe(true)
    expect(cellPlaceholderIn(c, model.info[0], 'name')).toBeUndefined()
    c = applyGridEdit(c, model, page, 0, 1, 'DEFAULT')
    expect(c.inserts[0]?.values.name).toBe('DEFAULT')
    c = applyGridEdit(c, model, page, 0, 2, null)
    expect(c.inserts[0]?.values.total).toBeNull()
    expect(cellPlaceholderIn(c, buildGridModel(page, c).info[0], 'total')).toBeUndefined()
    expect(c.inserts[0]?.values.id).toEqual(DEFAULT_VALUE)
  })

  it('marks deleted rows', () => {
    const model = buildGridModel(page, EMPTY_CHANGES)
    const first = model.info[0]
    if (!first) throw new Error('missing row')
    const c = deleteRows(EMPTY_CHANGES, [first.ref])
    expect(rowStateOf(c, buildGridModel(page, c).info[0])).toBe('deleted')
  })

  it('never edits rows of a table without a primary key', () => {
    const keyless: PageLike = { ...page, primaryKey: [] }
    const model = buildGridModel(keyless, EMPTY_CHANGES)
    expect(model.info.map((i) => i.key)).toEqual(['idx:0', 'idx:1'])
    expect(applyGridEdit(EMPTY_CHANGES, model, keyless, 0, 1, 'x')).toBe(EMPTY_CHANGES)
  })

  it('ignores out-of-range cells', () => {
    const model = buildGridModel(page, EMPTY_CHANGES)
    expect(applyGridEdit(EMPTY_CHANGES, model, page, 9, 0, 'x')).toBe(EMPTY_CHANGES)
    expect(applyGridEdit(EMPTY_CHANGES, model, page, 0, 9, 'x')).toBe(EMPTY_CHANGES)
  })
})

describe('read-only columns', () => {
  it('locks identity and generated columns', () => {
    const details = [detail('id', { isIdentity: true }), detail('name'), detail('total', { isGenerated: true })]
    expect([...readOnlyColumnIndices(columns, details)]).toEqual([0, 2])
    expect(readOnlyColumnIndices(columns, undefined).size).toBe(0)
  })
})

describe('duplicateValues', () => {
  it('copies displayed values except locked columns', () => {
    const model = buildGridModel(page, EMPTY_CHANGES)
    expect(duplicateValues(model, EMPTY_CHANGES, 0, columns, new Set([0]))).toEqual({
      id: DEFAULT_VALUE,
      name: 'Ada',
      total: '10.00',
    })
  })

  it('copies the DEFAULT markers of a pending insert', () => {
    const c = addInsert(EMPTY_CHANGES, newInsert('a', names, { name: 'X' }))
    const model = buildGridModel(page, c)
    expect(duplicateValues(model, c, 0, columns, new Set())).toEqual({ id: DEFAULT_VALUE, name: 'X', total: DEFAULT_VALUE })
  })
})

describe('rowRange', () => {
  it('covers both directions', () => {
    expect(rowRange(3, 1)).toEqual([1, 2, 3])
    expect(rowRange(2, 2)).toEqual([2])
  })
})
