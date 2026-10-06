import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ call: vi.fn(), onEvent: vi.fn(), errorInfo: vi.fn(), ApiError: class extends Error {} }))
const { autoMapping } = await import('./ImportCsvDialog')

describe('CSV import column mapping', () => {
  it('matches source headers to table columns by name, case-insensitively, once each', () => {
    const columns = [{ name: 'id' }, { name: 'Email' }, { name: 'full_name' }]
    expect(autoMapping(['ID', 'email', 'nickname', 'id'], columns)).toEqual(['id', 'Email', '__skip__', '__skip__'])
    expect(autoMapping([' full_name '], columns)).toEqual(['full_name'])
  })
})
