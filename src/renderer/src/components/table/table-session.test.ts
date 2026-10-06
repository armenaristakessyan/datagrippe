import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearRecentFilters,
  dropSession,
  flipSort,
  getSession,
  initialSession,
  moveSession,
  patchSession,
  pushRecentFilter,
  removeSort,
  useTableSessions,
} from './table-session'

beforeEach(() => useTableSessions.setState({ sessions: {}, recentFilters: {} }))

describe('sessions', () => {
  it('returns a fresh session for unknown tabs', () => {
    expect(getSession('t1')).toEqual(initialSession())
  })

  it('patches with objects and functions', () => {
    patchSession('t1', { where: 'a = 1' })
    patchSession('t1', (s) => ({ offset: s.offset + 500 }))
    expect(getSession('t1')).toMatchObject({ where: 'a = 1', offset: 500 })
  })

  it('moves and drops sessions', () => {
    patchSession('old', { where: 'x' })
    moveSession('old', 'new')
    expect(useTableSessions.getState().sessions.old).toBeUndefined()
    expect(getSession('new').where).toBe('x')
    dropSession('new')
    expect(useTableSessions.getState().sessions).toEqual({})
  })
})

describe('recent filters', () => {
  it('keeps the most recent first, de-duplicated and capped', () => {
    for (let i = 0; i < 12; i++) pushRecentFilter('k', `id = ${i}`)
    pushRecentFilter('k', 'id = 5')
    pushRecentFilter('k', '   ')
    const list = useTableSessions.getState().recentFilters.k ?? []
    expect(list).toHaveLength(10)
    expect(list[0]).toBe('id = 5')
    expect(list.filter((f) => f === 'id = 5')).toHaveLength(1)
    clearRecentFilters('k')
    expect(useTableSessions.getState().recentFilters.k).toBeUndefined()
  })
})

describe('sort chips', () => {
  const sort = [
    { column: 'a', direction: 'asc' as const },
    { column: 'b', direction: 'desc' as const },
  ]
  it('flips and removes one column', () => {
    expect(flipSort(sort, 'b')).toEqual([sort[0], { column: 'b', direction: 'asc' }])
    expect(removeSort(sort, 'a')).toEqual([sort[1]])
  })
})
