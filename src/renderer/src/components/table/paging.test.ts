import { describe, expect, it } from 'vitest'
import { NNBSP } from '@/lib/format'
import { describeWindow, knownTotal } from './paging'

const n = (s: string) => s.replaceAll(NNBSP, ' ')

describe('knownTotal', () => {
  it('prefers the exact count', () => {
    expect(knownTotal(0, 500, true, 12_345)).toBe(12_345)
  })
  it('derives the total on the last page', () => {
    expect(knownTotal(500, 120, false, undefined)).toBe(620)
    expect(knownTotal(0, 0, false, undefined)).toBe(0)
  })
  it('is unknown while more rows exist', () => {
    expect(knownTotal(0, 500, true, undefined)).toBeUndefined()
  })
  it('is unknown on an empty page past the end', () => {
    expect(knownTotal(1000, 0, false, undefined)).toBeUndefined()
  })
})

describe('describeWindow', () => {
  const w = { offset: 0, shown: 500, hasMore: true, pageSize: 500 }
  it('shows the range alone without a total', () => {
    expect(describeWindow(w)).toEqual({ range: 'Rows 1–500' })
  })
  it('shows an exact total', () => {
    const d = describeWindow({ ...w, total: 12_345 })
    expect(n(d.range)).toBe('Rows 1–500')
    expect(n(d.total ?? '')).toBe('of 12 345')
  })
  it('shows an estimate with a tilde when it exceeds the range', () => {
    expect(n(describeWindow({ ...w, estimate: 12_345.4 }).total ?? '')).toBe('of ~12 345')
    expect(describeWindow({ ...w, estimate: 10 }).total).toBeUndefined()
  })
  it('formats later pages and empty pages', () => {
    expect(n(describeWindow({ ...w, offset: 1000, shown: 200 }).range)).toBe('Rows 1 001–1 200')
    expect(describeWindow({ ...w, shown: 0 }).range).toBe('No rows')
    expect(n(describeWindow({ ...w, offset: 500, shown: 0 }).range)).toBe('No rows after 500')
  })
})
