import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VALUE,
  EMPTY_CHANGES,
  addInsert,
  changeCount,
  deleteRows,
  describeSummary,
  editCell,
  editInsertedCell,
  hasChanges,
  newInsert,
  primaryKeyValues,
  revertRows,
  rowKeyOf,
  rowsHaveChanges,
  sameValue,
  summarize,
  toRowChanges,
  type ExistingRowRef,
  type PendingChanges,
} from './pending-changes'

const PK = ['id']
const row = (id: number): ExistingRowRef => ({ kind: 'existing', rowKey: rowKeyOf({ id }, PK), key: { id } })

describe('row keys', () => {
  it('serializes PK values in key order', () => {
    expect(rowKeyOf({ b: 2, a: 'x' }, ['a', 'b'])).toBe('["x",2]')
    expect(rowKeyOf({ a: 'x', b: 2 }, ['a', 'b'])).toBe(rowKeyOf({ b: 2, a: 'x' }, ['a', 'b']))
  })

  it('distinguishes numbers from numeric strings', () => {
    expect(rowKeyOf({ id: 1 }, PK)).not.toBe(rowKeyOf({ id: '1' }, PK))
  })

  it('extracts PK values from a fetched row', () => {
    const columns = ['order_id', 'name', 'line_no']
    expect(primaryKeyValues([7, 'x', 2], columns, ['order_id', 'line_no'])).toEqual({ order_id: 7, line_no: 2 })
    expect(primaryKeyValues([7, 'x'], ['order_id', 'name'], ['missing'])).toBeNull()
    expect(primaryKeyValues([7], ['id'], [])).toBeNull()
  })
})

describe('sameValue', () => {
  it('treats text typed over a number as equal', () => {
    expect(sameValue(5, '5')).toBe(true)
    expect(sameValue(true, 'true')).toBe(true)
    expect(sameValue(null, null)).toBe(true)
    expect(sameValue(null, '')).toBe(false)
    expect(sameValue('', null)).toBe(false)
    expect(sameValue('a', 'b')).toBe(false)
  })
})

describe('updates', () => {
  it('records the original and new value of a cell', () => {
    const c = editCell(EMPTY_CHANGES, row(1), 'name', 'Ada', 'Ada L.')
    expect(c.updates[row(1).rowKey]).toEqual({ key: { id: 1 }, cells: { name: { original: 'Ada', value: 'Ada L.' } } })
    expect(changeCount(c)).toBe(1)
  })

  it('keeps the first original across successive edits', () => {
    let c = editCell(EMPTY_CHANGES, row(1), 'name', 'Ada', 'B')
    c = editCell(c, row(1), 'name', 'B', 'C')
    expect(c.updates[row(1).rowKey]?.cells.name).toEqual({ original: 'Ada', value: 'C' })
  })

  it('editing back to the original removes the change', () => {
    let c = editCell(EMPTY_CHANGES, row(1), 'name', 'Ada', 'B')
    c = editCell(c, row(1), 'email', 'a@x', 'b@x')
    c = editCell(c, row(1), 'name', 'B', 'Ada')
    expect(Object.keys(c.updates[row(1).rowKey]?.cells ?? {})).toEqual(['email'])
    c = editCell(c, row(1), 'email', 'b@x', 'a@x')
    expect(c.updates).toEqual({})
    expect(hasChanges(c)).toBe(false)
  })

  it('is a no-op when setting the original value on an unedited cell', () => {
    const c = editCell(EMPTY_CHANGES, row(1), 'credit', 10, '10')
    expect(c).toBe(EMPTY_CHANGES)
  })

  it('keeps the original key when the PK itself is edited', () => {
    const c = editCell(EMPTY_CHANGES, row(1), 'id', 1, 100)
    expect(toRowChanges(c)).toEqual([{ type: 'update', key: { id: 1 }, values: { id: 100 } }])
  })

  it('supports setting NULL', () => {
    const c = editCell(EMPTY_CHANGES, row(2), 'birth_date', '1815-12-10', null)
    expect(toRowChanges(c)).toEqual([{ type: 'update', key: { id: 2 }, values: { birth_date: null } }])
  })

  it('ignores edits of rows marked for deletion', () => {
    const deleted = deleteRows(EMPTY_CHANGES, [row(1)])
    expect(editCell(deleted, row(1), 'name', 'Ada', 'X')).toBe(deleted)
  })

  it('sends only changed columns', () => {
    let c = editCell(EMPTY_CHANGES, row(3), 'name', 'Grace', 'G. Hopper')
    c = editCell(c, row(3), 'is_active', false, true)
    c = editCell(c, row(3), 'email', 'g@x', 'g@x')
    expect(toRowChanges(c)).toEqual([{ type: 'update', key: { id: 3 }, values: { name: 'G. Hopper', is_active: true } }])
  })
})

describe('inserts', () => {
  const columns = ['id', 'name', 'created_at']

  it('defaults every column to DEFAULT', () => {
    expect(newInsert('n1', columns).values).toEqual({ id: DEFAULT_VALUE, name: DEFAULT_VALUE, created_at: DEFAULT_VALUE })
  })

  it('applies provided values', () => {
    expect(newInsert('n1', columns, { name: 'Copy', created_at: null }).values).toEqual({
      id: DEFAULT_VALUE,
      name: 'Copy',
      created_at: null,
    })
  })

  it('edits cells of a pending insert and back to DEFAULT', () => {
    let c = addInsert(EMPTY_CHANGES, newInsert('n1', columns))
    c = editInsertedCell(c, 'n1', 'name', 'Linus')
    expect(c.inserts[0]?.values.name).toBe('Linus')
    const same = editInsertedCell(c, 'n1', 'name', 'Linus')
    expect(same).toBe(c)
    c = editInsertedCell(c, 'n1', 'name', DEFAULT_VALUE)
    expect(c.inserts[0]?.values.name).toEqual(DEFAULT_VALUE)
    expect(editInsertedCell(c, 'n1', 'name', DEFAULT_VALUE)).toBe(c)
  })

  it('ignores unknown insert ids', () => {
    const c = addInsert(EMPTY_CHANGES, newInsert('n1', columns))
    expect(editInsertedCell(c, 'nope', 'name', 'x')).toBe(c)
  })

  it('emits inserts with DEFAULT markers, in creation order', () => {
    let c = addInsert(EMPTY_CHANGES, newInsert('n1', columns, { name: 'A' }))
    c = addInsert(c, newInsert('n2', columns, { name: 'B' }))
    expect(toRowChanges(c)).toEqual([
      { type: 'insert', values: { id: DEFAULT_VALUE, name: 'A', created_at: DEFAULT_VALUE } },
      { type: 'insert', values: { id: DEFAULT_VALUE, name: 'B', created_at: DEFAULT_VALUE } },
    ])
  })

  it('deleting an inserted row just drops it', () => {
    let c = addInsert(EMPTY_CHANGES, newInsert('n1', columns))
    c = addInsert(c, newInsert('n2', columns))
    c = deleteRows(c, [{ kind: 'inserted', id: 'n1' }])
    expect(c.inserts.map((i) => i.id)).toEqual(['n2'])
    expect(c.deletes).toEqual({})
    expect(changeCount(c)).toBe(1)
  })
})

describe('deletes', () => {
  it('marks rows and emits deletes with their key', () => {
    const c = deleteRows(EMPTY_CHANGES, [row(1), row(2)])
    expect(toRowChanges(c)).toEqual([
      { type: 'delete', key: { id: 1 } },
      { type: 'delete', key: { id: 2 } },
    ])
    expect(changeCount(c)).toBe(2)
  })

  it('a deleted row with edits only sends the delete, using the original key', () => {
    let c = editCell(EMPTY_CHANGES, row(1), 'id', 1, 99)
    c = editCell(c, row(1), 'name', 'Ada', 'X')
    c = deleteRows(c, [row(1)])
    expect(toRowChanges(c)).toEqual([{ type: 'delete', key: { id: 1 } }])
    expect(changeCount(c)).toBe(1)
  })

  it('is a no-op for an empty selection', () => {
    expect(deleteRows(EMPTY_CHANGES, [])).toBe(EMPTY_CHANGES)
  })

  it('supports composite keys', () => {
    const pk = ['order_id', 'line_no']
    const key = { order_id: 7, line_no: 2 }
    const c = deleteRows(EMPTY_CHANGES, [{ kind: 'existing', rowKey: rowKeyOf(key, pk), key }])
    expect(toRowChanges(c)).toEqual([{ type: 'delete', key: { order_id: 7, line_no: 2 } }])
  })
})

describe('revert', () => {
  const build = (): PendingChanges => {
    let c = editCell(EMPTY_CHANGES, row(1), 'name', 'Ada', 'X')
    c = editCell(c, row(2), 'name', 'Alan', 'Y')
    c = deleteRows(c, [row(3)])
    c = addInsert(c, newInsert('n1', ['id', 'name']))
    return c
  }

  it('reverts selected rows of every kind', () => {
    const c = revertRows(build(), [row(1), row(3), { kind: 'inserted', id: 'n1' }])
    expect(Object.keys(c.updates)).toEqual([row(2).rowKey])
    expect(c.deletes).toEqual({})
    expect(c.inserts).toEqual([])
    expect(changeCount(c)).toBe(1)
  })

  it('reverting a deleted + edited row restores both', () => {
    let c = editCell(EMPTY_CHANGES, row(1), 'name', 'Ada', 'X')
    c = deleteRows(c, [row(1)])
    c = revertRows(c, [row(1)])
    expect(hasChanges(c)).toBe(false)
  })

  it('knows whether rows have something to revert', () => {
    const c = build()
    expect(rowsHaveChanges(c, [row(4)])).toBe(false)
    expect(rowsHaveChanges(c, [row(4), row(3)])).toBe(true)
    expect(rowsHaveChanges(c, [{ kind: 'inserted', id: 'n1' }])).toBe(true)
  })
})

describe('change list', () => {
  it('orders deletes, then updates, then inserts', () => {
    let c = addInsert(EMPTY_CHANGES, newInsert('n1', ['id', 'email'], { email: 'ada@x' }))
    c = editCell(c, row(2), 'email', 'alan@x', 'turing@x')
    c = deleteRows(c, [row(1)])
    expect(toRowChanges(c).map((r) => r.type)).toEqual(['delete', 'update', 'insert'])
  })

  it('returns copies (mutating the output never touches the state)', () => {
    const c = editCell(EMPTY_CHANGES, row(1), 'name', 'Ada', 'X')
    const [change] = toRowChanges(c)
    if (change?.type !== 'update') throw new Error('expected update')
    change.values.name = 'mutated'
    change.key.id = 42
    expect(c.updates[row(1).rowKey]).toEqual({ key: { id: 1 }, cells: { name: { original: 'Ada', value: 'X' } } })
  })

  it('summarizes counts', () => {
    let c = editCell(EMPTY_CHANGES, row(1), 'name', 'Ada', 'X')
    c = editCell(c, row(2), 'name', 'Alan', 'Y')
    c = deleteRows(c, [row(2), row(3)])
    c = addInsert(c, newInsert('n1', ['id']))
    const summary = summarize(c)
    expect(summary).toEqual({ updates: 1, inserts: 1, deletes: 2 })
    expect(describeSummary(summary)).toBe('1 update, 1 insert, 2 deletes')
    expect(changeCount(c)).toBe(4)
  })
})
