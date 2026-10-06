// Applies settings.theme to <html> (dark by default, `.light` class for the light palette).
// 'system' follows both the renderer's matchMedia and the main process' `event:nativeTheme`.
import type { ThemePreference } from '@shared/types'
import { onEvent } from '@/lib/api'
import { hasBridge } from '@/lib/platform'
import { useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'

export type ResolvedTheme = 'dark' | 'light'

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light'
  return preference
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

let systemDark = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia(DARK_QUERY).matches
  : true

const CACHE_KEY = 'datagrippe.resolvedTheme'

/** Toggle the `light` class on <html> and record the result in the UI store. */
export function applyResolvedTheme(theme: ResolvedTheme): void {
  const root = document.documentElement
  root.classList.toggle('light', theme === 'light')
  root.dataset.theme = theme
  if (useUi.getState().resolvedTheme !== theme) useUi.getState().setResolvedTheme(theme)
  try {
    localStorage.setItem(CACHE_KEY, theme)
  } catch {
    // storage unavailable: only costs a theme flash at next start
  }
}

/** Apply the last theme synchronously before the first render (settings load asynchronously). */
export function applyCachedTheme(): void {
  let cached: string | null = null
  try {
    cached = localStorage.getItem(CACHE_KEY)
  } catch {
    cached = null
  }
  if (cached === 'light' || cached === 'dark') applyResolvedTheme(cached)
}

function applyFromSettings(): void {
  applyResolvedTheme(resolveTheme(useSettings.getState().settings.theme, systemDark))
}

/** Apply the theme now and keep it in sync with settings and the OS. Returns an unsubscribe. */
export function bindTheme(): () => void {
  // Until settings arrive, keep the cached theme (applyCachedTheme) instead of the default.
  if (useSettings.getState().loaded) applyFromSettings()
  const offSettings = useSettings.subscribe((state, prev) => {
    if (state.settings.theme !== prev.settings.theme || state.loaded !== prev.loaded) applyFromSettings()
  })

  const media = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null
  const onMedia = (event: MediaQueryListEvent) => {
    systemDark = event.matches
    if (useSettings.getState().loaded) applyFromSettings()
  }
  media?.addEventListener('change', onMedia)

  const offNative = hasBridge()
    ? onEvent('event:nativeTheme', ({ dark }) => {
        systemDark = dark
        if (useSettings.getState().loaded) applyFromSettings()
      })
    : () => undefined

  return () => {
    offSettings()
    media?.removeEventListener('change', onMedia)
    offNative()
  }
}

/** Flip between dark and light (an explicit preference, leaving 'system'). */
export function toggleTheme(): void {
  const next: ResolvedTheme = useUi.getState().resolvedTheme === 'dark' ? 'light' : 'dark'
  applyResolvedTheme(next)
  void useSettings
    .getState()
    .update({ theme: next })
    .catch(() => undefined)
}
