import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'

const update = vi.fn<(patch: Partial<AppSettings>) => Promise<AppSettings>>()

vi.mock('@/lib/api', () => ({
  api: { settings: { get: vi.fn(async () => DEFAULT_SETTINGS), update: (patch: Partial<AppSettings>) => update(patch) } },
}))

const { normalizeSettingsPatch, SETTINGS_LIMITS, useSettings } = await import('./settings')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  update.mockReset()
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true })
})

describe('normalizeSettingsPatch', () => {
  it('clamps numbers into range and rounds them', () => {
    expect(normalizeSettingsPatch({ editorFontSize: 4, editorTabSize: 12, maxRows: 2.6 })).toEqual({
      editorFontSize: SETTINGS_LIMITS.editorFontSize.min,
      editorTabSize: SETTINGS_LIMITS.editorTabSize.max,
      maxRows: 3,
    })
    expect(normalizeSettingsPatch({ maxRows: 10_000_000 }).maxRows).toBe(SETTINGS_LIMITS.maxRows.max)
  })

  it('drops invalid values and truncates the NULL text', () => {
    const patch = {
      theme: 'sepia',
      formatKeywordCase: 'title',
      editorFontSize: Number.NaN,
      editorWordWrap: 'yes',
      nullDisplay: 'x'.repeat(50),
    } as unknown as Partial<AppSettings>
    expect(normalizeSettingsPatch(patch)).toEqual({ nullDisplay: 'x'.repeat(SETTINGS_LIMITS.nullDisplayMaxLength) })
  })

  it('keeps valid enums and booleans', () => {
    expect(normalizeSettingsPatch({ theme: 'system', formatKeywordCase: 'lower', gridRowNumbers: false, nullDisplay: '' })).toEqual({
      theme: 'system',
      formatKeywordCase: 'lower',
      gridRowNumbers: false,
      nullDisplay: '',
    })
  })
})

describe('useSettings.update', () => {
  it('applies optimistically, then reconciles with the persisted value', async () => {
    const pending = deferred<AppSettings>()
    update.mockReturnValueOnce(pending.promise)
    const done = useSettings.getState().update({ maxRows: 1000 })
    expect(useSettings.getState().settings.maxRows).toBe(1000)
    pending.resolve({ ...DEFAULT_SETTINGS, maxRows: 999 })
    await done
    expect(useSettings.getState().settings.maxRows).toBe(999)
  })

  it('sends only the normalized patch and skips empty ones', async () => {
    update.mockResolvedValue({ ...DEFAULT_SETTINGS, editorFontSize: 32 })
    await useSettings.getState().update({ editorFontSize: 99 })
    expect(update).toHaveBeenCalledWith({ editorFontSize: 32 })
    update.mockClear()
    await useSettings.getState().update({ editorFontSize: Number.NaN })
    expect(update).not.toHaveBeenCalled()
  })

  it('ignores a stale response that arrives after a newer update', async () => {
    const first = deferred<AppSettings>()
    const second = deferred<AppSettings>()
    update.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const a = useSettings.getState().update({ editorFontSize: 14 })
    const b = useSettings.getState().update({ editorFontSize: 16 })
    second.resolve({ ...DEFAULT_SETTINGS, editorFontSize: 16 })
    await b
    first.resolve({ ...DEFAULT_SETTINGS, editorFontSize: 14 })
    await a
    expect(useSettings.getState().settings.editorFontSize).toBe(16)
  })

  it('reverts the changed keys when saving fails', async () => {
    update.mockRejectedValueOnce(new Error('disk full'))
    await expect(useSettings.getState().update({ theme: 'light', maxRows: 42 })).rejects.toThrow('disk full')
    expect(useSettings.getState().settings.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(useSettings.getState().settings.maxRows).toBe(DEFAULT_SETTINGS.maxRows)
  })
})
