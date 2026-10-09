// settings.json — user preferences, always merged with DEFAULT_SETTINGS and clamped to sane ranges.
import { join } from 'node:path'
import { DEFAULT_SETTINGS, isAppIconId, type AppSettings, type ThemePreference } from '@shared/types'
import { isRecord, JsonFile } from './json-file'

const THEMES: ThemePreference[] = ['dark', 'light', 'system']
const KEYWORD_CASES: AppSettings['formatKeywordCase'][] = ['upper', 'lower', 'preserve']

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Apply `patch` on top of `base`, ignoring unknown keys and invalid values. */
export function sanitizeSettings(patch: unknown, base: AppSettings = DEFAULT_SETTINGS): AppSettings {
  const p = isRecord(patch) ? patch : {}
  return {
    theme: THEMES.includes(p.theme as ThemePreference) ? (p.theme as ThemePreference) : base.theme,
    appIcon: isAppIconId(p.appIcon) ? p.appIcon : base.appIcon,
    editorFontSize: clampInt(p.editorFontSize, 9, 32, base.editorFontSize),
    editorWordWrap: bool(p.editorWordWrap, base.editorWordWrap),
    editorTabSize: clampInt(p.editorTabSize, 1, 8, base.editorTabSize),
    editorMinimap: bool(p.editorMinimap, base.editorMinimap),
    maxRows: clampInt(p.maxRows, 1, 100_000, base.maxRows),
    nullDisplay: typeof p.nullDisplay === 'string' ? p.nullDisplay.slice(0, 32) : base.nullDisplay,
    confirmDestructive: bool(p.confirmDestructive, base.confirmDestructive),
    formatKeywordCase: KEYWORD_CASES.includes(p.formatKeywordCase as AppSettings['formatKeywordCase'])
      ? (p.formatKeywordCase as AppSettings['formatKeywordCase'])
      : base.formatKeywordCase,
    gridRowNumbers: bool(p.gridRowNumbers, base.gridRowNumbers),
    detectParameters: bool(p.detectParameters, base.detectParameters),
  }
}

export class SettingsStore {
  private readonly file: JsonFile<AppSettings>

  constructor(baseDir: string, log?: Pick<Console, 'warn' | 'error'>) {
    this.file = new JsonFile<AppSettings>(join(baseDir, 'settings.json'), {
      fallback: () => ({ ...DEFAULT_SETTINGS }),
      parse: (raw) => {
        if (!isRecord(raw)) throw new Error('expected an object')
        return sanitizeSettings(raw)
      },
      log,
    })
  }

  get(): AppSettings {
    return { ...this.file.get() }
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const next = sanitizeSettings(patch, this.file.get())
    this.file.set(next)
    return { ...next }
  }

  flush(): void {
    this.file.flush()
  }
}
