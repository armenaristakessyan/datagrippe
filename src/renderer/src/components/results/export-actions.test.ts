import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CellValue, ColumnMeta } from '@shared/types'

const copyText = vi.fn(async (_text: string) => undefined)
const toast = Object.assign(vi.fn(), {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  message: vi.fn(),
  loading: vi.fn(() => 'toast-1'),
  dismiss: vi.fn(),
})
vi.mock('@/lib/clipboard', () => ({ copyText }))
vi.mock('@/components/ui', () => ({ toast }))
vi.mock('@/lib/api', () => ({ api: {} }))

const { CLIPBOARD_CHAR_LIMIT, copyAllAs, estimateChars } = await import('./export-actions')
const { formatRows } = await import('@/lib/export-format')

function wide(rowCount: number, colCount: number) {
  const columns = Array.from({ length: colCount }, (_, i) => ({ name: `column_${i}`, dataType: 'text', nullable: true }) as ColumnMeta)
  const rows: CellValue[][] = Array.from({ length: rowCount }, (_, r) => columns.map((_, c) => `value ${r}-${c}`))
  return { columns, rows, dialect: 'postgres' as const, baseName: 'result' }
}

describe('copy all as…', () => {
  beforeEach(() => {
    copyText.mockClear()
    for (const fn of [toast.success, toast.error, toast.warning, toast.loading]) fn.mockClear()
  })

  it('estimates the serialized size from a sample', () => {
    const source = wide(2000, 6)
    for (const format of ['tsv', 'csv', 'json', 'sql'] as const) {
      const exact = formatRows(format, source.columns, source.rows, { dialect: 'postgres' }).length
      const estimate = estimateChars(format, source)
      expect(Math.abs(estimate - exact) / exact).toBeLessThan(0.1)
    }
  })

  it('refuses a result too large for the clipboard instead of freezing', async () => {
    // 100 000 rows × 80 columns: hundreds of MB of JSON
    const source = wide(100_000, 80)
    expect(estimateChars('json', source, 0)).toBeGreaterThan(CLIPBOARD_CHAR_LIMIT)
    await copyAllAs('json', source)
    expect(copyText).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith('Too large for the clipboard', expect.objectContaining({ description: expect.stringContaining('Export all rows') }))
  })

  it('shows progress and copies compact JSON for large (but acceptable) results', async () => {
    const source = wide(40_000, 12)
    await copyAllAs('json', source)
    expect(toast.loading).toHaveBeenCalled()
    expect(copyText).toHaveBeenCalledTimes(1)
    const text = copyText.mock.calls[0]![0]
    expect(text.startsWith('[{"column_0":')).toBe(true)
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('rows as JSON'), expect.objectContaining({ id: 'toast-1', description: 'Compact JSON (large result).' }))
  })

  it('copies small results directly', async () => {
    await copyAllAs('csv', wide(3, 2))
    expect(toast.loading).not.toHaveBeenCalled()
    expect(copyText).toHaveBeenCalledWith('column_0,column_1\r\nvalue 0-0,value 0-1\r\nvalue 1-0,value 1-1\r\nvalue 2-0,value 2-1\r\n')
  })
})
