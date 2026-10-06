// Small pure helpers of the console UI.
import { isMac } from '@/lib/platform'
import type { ConsoleTab } from '@/stores/tabs'

export function fileBaseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** File name (or full path, when the console came from a file) offered by the save dialog. */
export function suggestedFileName(tab: Pick<ConsoleTab, 'title' | 'filePath'>): string {
  if (tab.filePath) return tab.filePath
  const base = tab.title.trim().replace(/[\\/:*?"<>|]+/g, '-') || 'query'
  return /\.sql$/i.test(base) ? base : `${base}.sql`
}

/** Running-query ticker: "0.4 s", "12.0 s", then "1:05". */
export function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * A shortcut spelled in words ("Cmd+Enter"): the mono editor font has no ⌘ / ⇧ / ↵ glyphs, and the
 * fallback font draws them small and off the baseline inside the placeholder.
 */
export function shortcutInWords(accelerator: string, mac = isMac()): string {
  return accelerator
    .split('+')
    .map((part) => {
      if (part === 'CmdOrCtrl' || part === 'CommandOrControl') return mac ? 'Cmd' : 'Ctrl'
      if (part === 'Alt' || part === 'Option') return mac ? 'Option' : 'Alt'
      if (part === 'Return') return 'Enter'
      return part
    })
    .join('+')
}
