import { create } from 'zustand'
import { DEFAULT_SETTINGS, isAppIconId, type AppSettings, type ThemePreference } from '@shared/types'
import { api } from '@/lib/api'

/** Accepted ranges (mirrors the main-process sanitizer in src/main/store/settings.ts). */
export const SETTINGS_LIMITS = {
  editorFontSize: { min: 9, max: 32 },
  editorTabSize: { min: 1, max: 8 },
  maxRows: { min: 1, max: 100_000 },
  nullDisplayMaxLength: 32,
} as const

const THEMES: readonly ThemePreference[] = ['dark', 'light', 'system']
const KEYWORD_CASES: readonly AppSettings['formatKeywordCase'][] = ['upper', 'lower', 'preserve']
const BOOLEAN_KEYS = ['editorWordWrap', 'editorMinimap', 'confirmDestructive', 'gridRowNumbers', 'detectParameters'] as const

function clampInt(value: unknown, limits: { min: number; max: number }): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)))
}

/** Keep the valid keys of a patch, clamping numbers into range. Invalid values are dropped. */
export function normalizeSettingsPatch(patch: Partial<AppSettings>): Partial<AppSettings> {
  const out: Partial<AppSettings> = {}
  if (patch.theme !== undefined && THEMES.includes(patch.theme)) out.theme = patch.theme
  if (isAppIconId(patch.appIcon)) out.appIcon = patch.appIcon
  if (patch.formatKeywordCase !== undefined && KEYWORD_CASES.includes(patch.formatKeywordCase)) {
    out.formatKeywordCase = patch.formatKeywordCase
  }
  const fontSize = clampInt(patch.editorFontSize, SETTINGS_LIMITS.editorFontSize)
  if (fontSize !== undefined) out.editorFontSize = fontSize
  const tabSize = clampInt(patch.editorTabSize, SETTINGS_LIMITS.editorTabSize)
  if (tabSize !== undefined) out.editorTabSize = tabSize
  const maxRows = clampInt(patch.maxRows, SETTINGS_LIMITS.maxRows)
  if (maxRows !== undefined) out.maxRows = maxRows
  if (typeof patch.nullDisplay === 'string') out.nullDisplay = patch.nullDisplay.slice(0, SETTINGS_LIMITS.nullDisplayMaxLength)
  for (const key of BOOLEAN_KEYS) {
    const value = patch[key]
    if (typeof value === 'boolean') out[key] = value
  }
  return out
}

interface SettingsState {
  settings: AppSettings
  loaded: boolean
  load: () => Promise<void>
  /** Optimistic: applies immediately, then reconciles with what main persisted (reverts on failure). */
  update: (patch: Partial<AppSettings>) => Promise<void>
}

// Each update gets a revision; only the latest one may overwrite local state with the server's
// answer, so a slow response cannot undo a newer optimistic change.
let revision = 0

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    const settings = await api.settings.get()
    set({ settings: { ...DEFAULT_SETTINGS, ...settings }, loaded: true })
  },
  update: async (patch) => {
    const clean = normalizeSettingsPatch(patch)
    const keys = Object.keys(clean) as (keyof AppSettings)[]
    if (keys.length === 0) return
    const previous = get().settings
    const current = ++revision
    set({ settings: { ...previous, ...clean } })
    try {
      const settings = await api.settings.update(clean)
      if (current === revision) set({ settings: { ...DEFAULT_SETTINGS, ...settings } })
    } catch (error) {
      if (current === revision) {
        const reverted: AppSettings = { ...get().settings }
        for (const key of keys) Object.assign(reverted, { [key]: previous[key] })
        set({ settings: reverted })
      }
      throw error
    }
  },
}))
