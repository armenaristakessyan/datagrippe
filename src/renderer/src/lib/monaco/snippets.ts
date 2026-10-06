// User snippets (live templates): reusable SQL offered by autocompletion when their abbreviation is
// typed, and insertable from the command palette. Bodies use Monaco snippet syntax ($1, ${1:default}, $0).
// Stored with the workspace (tabs store layout) so they survive restarts.
import { useTabs } from '@/stores/tabs'

export interface UserSnippet {
  id: string
  /** Shown in the suggest list and the snippets dialog. */
  name: string
  /** Typed in the editor to offer the snippet (letters, digits, _ and -). */
  abbreviation: string
  body: string
}

export const SNIPPETS_KEY = 'editor.snippets'

export const ABBREVIATION = /^[A-Za-z_][\w-]{0,31}$/

function isSnippet(value: unknown): value is UserSnippet {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.abbreviation === 'string' && typeof v.body === 'string'
}

/** Snippets of a layout record (defaults to the current workspace). */
export function snippetsOf(layout: Record<string, unknown> = useTabs.getState().layout): UserSnippet[] {
  const value = layout[SNIPPETS_KEY]
  return Array.isArray(value) ? value.filter(isSnippet) : []
}

export function userSnippets(): UserSnippet[] {
  return snippetsOf()
}

/** Reason the snippet cannot be saved, or null. */
export function validateSnippet(snippet: Omit<UserSnippet, 'id'> & { id?: string }, existing: UserSnippet[] = userSnippets()): string | null {
  if (!snippet.name.trim()) return 'Give the snippet a name.'
  if (!ABBREVIATION.test(snippet.abbreviation)) return 'The abbreviation is a word: letters, digits, _ or -, up to 32 characters.'
  if (existing.some((s) => s.id !== snippet.id && s.abbreviation.toLowerCase() === snippet.abbreviation.toLowerCase())) {
    return `Another snippet already uses “${snippet.abbreviation}”.`
  }
  if (!snippet.body.trim()) return 'The snippet has no SQL.'
  return null
}

/** Add or replace a snippet (by id). */
export function saveSnippet(snippet: UserSnippet): void {
  const list = userSnippets()
  const index = list.findIndex((s) => s.id === snippet.id)
  const next = index >= 0 ? list.map((s, i) => (i === index ? snippet : s)) : [...list, snippet]
  useTabs.getState().setLayout(SNIPPETS_KEY, next)
}

export function deleteSnippet(id: string): void {
  useTabs.getState().setLayout(
    SNIPPETS_KEY,
    userSnippets().filter((s) => s.id !== id),
  )
}

/** Escape text so Monaco inserts it literally inside a snippet body. */
export function literalSnippetBody(text: string): string {
  return text.replace(/[\\$}]/g, (m) => `\\${m}`)
}

/** The body with placeholders resolved to their defaults (for previews and plain insertion). */
export function snippetPreview(body: string): string {
  return body
    .replace(/\$\{\d+:([^}]*)\}/g, '$1')
    .replace(/\$\{\d+\}|\$\d+/g, '')
    .replace(/\\([\\$}])/g, '$1')
}
