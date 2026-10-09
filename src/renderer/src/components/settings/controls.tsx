// Layout primitives of the settings dialog: section header, grouped card, label/control rows.
import { useEffect, useState, type ReactNode } from 'react'
import type { AppSettings, ThemePreference } from '@shared/types'
import { cn } from '@/lib/cn'
import { useSettings } from '@/stores/settings'
import type { SettingsSaver } from './useSettingsSaver'

export function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-4">
      <h2 className="text-sm font-semibold text-fg">{title}</h2>
      {description && <p className="mt-0.5 text-xs leading-[18px] text-subtle">{description}</p>}
    </header>
  )
}

/** Card of rows separated by hairlines. */
export function SettingsGroup({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('mb-5 last:mb-0', className)}>
      {title && <h3 className="mb-1.5 px-0.5 text-2xs font-medium uppercase tracking-wider text-subtle">{title}</h3>}
      <div className="divide-y divide-line rounded-lg border border-line bg-surface">{children}</div>
    </section>
  )
}

export interface SettingRowProps {
  label: ReactNode
  description?: ReactNode
  /** id of the control, links the label. */
  htmlFor?: string
  /** Control on the right of the label; none when the row's control is `below`. */
  children?: ReactNode
  /** Content under the row (previews, presets, a wide picker). */
  below?: ReactNode
}

export function SettingRow({ label, description, htmlFor, children, below }: SettingRowProps) {
  return (
    <div className="px-3.5 py-3">
      <div className="flex min-h-7 items-center justify-between gap-6">
        <div className="min-w-0">
          <label htmlFor={htmlFor} className="block select-none text-sm leading-5 text-fg">
            {label}
          </label>
          {description && <p className="mt-0.5 text-xs leading-4 text-subtle">{description}</p>}
        </div>
        {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
      </div>
      {below && <div className="mt-2.5">{below}</div>}
    </div>
  )
}

/**
 * Local value for a debounced setting: shows the user's input immediately while the save waits,
 * then follows the store again once it changes.
 */
export function useDraftSetting<K extends keyof AppSettings>(
  key: K,
  saver: SettingsSaver,
  delay?: number,
): [AppSettings[K], (value: AppSettings[K]) => void] {
  const stored = useSettings((s) => s.settings[key])
  const [draft, setDraft] = useState<{ value: AppSettings[K] } | null>(null)
  // Follow the store once nothing is waiting to be saved (also picks up a revert after a failure).
  useEffect(() => {
    if (!saver.isPending(key)) setDraft(null)
  }, [stored, key, saver])
  const set = (value: AppSettings[K]) => {
    setDraft({ value })
    saver.saveLater(key, value, delay)
  }
  return [draft ? draft.value : stored, set]
}

// Theme previews depict the palettes themselves (not the current theme), so they mirror the
// --c-app / --c-surface / --c-line / --c-accent values of each theme in styles.css.
const SWATCH = {
  dark: { app: '#0d0e11', surface: '#17191e', line: 'rgb(255 255 255 / 0.13)', accent: '#7c8cff', text: '#a0a6b2' },
  light: { app: '#eceef1', surface: '#ffffff', line: 'rgb(15 18 24 / 0.15)', accent: '#5465ff', text: '#555c69' },
} as const

function MiniWindow({ theme }: { theme: 'dark' | 'light' }) {
  const c = SWATCH[theme]
  return (
    <svg viewBox="0 0 20 14" className="size-full" aria-hidden>
      <rect width="20" height="14" fill={c.app} />
      <rect x="5" y="2" width="14" height="11" rx="1" fill={c.surface} stroke={c.line} strokeWidth="0.5" />
      <rect x="1.2" y="2.4" width="2.6" height="0.9" rx="0.45" fill={c.text} opacity="0.7" />
      <rect x="1.2" y="4.2" width="2.2" height="0.9" rx="0.45" fill={c.text} opacity="0.45" />
      <rect x="6.5" y="4" width="6" height="1" rx="0.5" fill={c.accent} />
      <rect x="6.5" y="6.2" width="9" height="0.9" rx="0.45" fill={c.text} opacity="0.5" />
      <rect x="6.5" y="8.2" width="7" height="0.9" rx="0.45" fill={c.text} opacity="0.35" />
    </svg>
  )
}

/** Tiny window preview of a theme; "system" shows dark and light split diagonally. */
export function ThemeSwatch({ theme, className }: { theme: ThemePreference; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('relative inline-block h-3.5 w-5 shrink-0 overflow-hidden rounded-[3px] shadow-[0_0_0_1px_var(--c-line-strong)]', className)}
    >
      {theme === 'system' ? (
        <>
          <span className="absolute inset-0">
            <MiniWindow theme="light" />
          </span>
          <span className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]">
            <MiniWindow theme="dark" />
          </span>
        </>
      ) : (
        <MiniWindow theme={theme} />
      )}
    </span>
  )
}
