import { describe, expect, it } from 'vitest'
import { unsavedWorkSummary } from './quit-guard'

describe('unsavedWorkSummary', () => {
  it('is null when nothing would be lost', () => {
    expect(unsavedWorkSummary(0, [])).toBeNull()
  })

  it('lists open transactions and pending work', () => {
    expect(unsavedWorkSummary(1, [])).toBe('A console has an open transaction: it will be rolled back.')
    const text = unsavedWorkSummary(2, [{ kind: 'table-edits', title: 'public.orders', detail: '3 pending changes' }])
    expect(text).toBe('2 consoles have an open transaction: they will be rolled back.\n• public.orders — 3 pending changes')
  })

  it('caps the list', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ kind: 'other' as const, title: `t${i}` }))
    const text = unsavedWorkSummary(0, items) ?? ''
    expect(text.split('\n')).toHaveLength(9)
    expect(text).toContain('…and 4 more')
  })
})
