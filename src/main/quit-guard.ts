// Text of the "discard unsaved work?" prompt shown before quitting or closing the window.
import type { UnsavedWorkItem } from '@shared/types'

const MAX_LISTED = 8

/** Null when nothing would be lost. */
export function unsavedWorkSummary(openTransactions: number, items: readonly UnsavedWorkItem[]): string | null {
  if (openTransactions <= 0 && items.length === 0) return null
  const lines: string[] = []
  if (openTransactions > 0) {
    lines.push(
      openTransactions === 1
        ? 'A console has an open transaction: it will be rolled back.'
        : `${openTransactions} consoles have an open transaction: they will be rolled back.`,
    )
  }
  for (const item of items.slice(0, MAX_LISTED)) lines.push(`• ${item.title}${item.detail ? ` — ${item.detail}` : ''}`)
  if (items.length > MAX_LISTED) lines.push(`• …and ${items.length - MAX_LISTED} more`)
  return lines.join('\n')
}
