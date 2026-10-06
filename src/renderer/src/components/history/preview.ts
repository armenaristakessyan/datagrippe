// Compact SQL previews for history rows.

/** Characters kept before highlighting (rows show 3 lines; the rest is never visible). */
export const PREVIEW_MAX_CHARS = 600
export const PREVIEW_MAX_LINES = 3

/**
 * Trim, drop blank lines, remove the common indentation, and keep at most `maxLines` lines
 * (with "…" when something was cut). Tabs count as two spaces.
 */
export function previewSql(sql: string, maxLines = PREVIEW_MAX_LINES, maxChars = PREVIEW_MAX_CHARS): string {
  const lines = sql
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '')
  if (lines.length === 0) return ''
  const indent = Math.min(...lines.map((line) => line.length - line.trimStart().length))
  const dedented = lines.map((line) => line.slice(indent))
  const kept = dedented.slice(0, maxLines)
  let text = kept.join('\n')
  let cut = dedented.length > maxLines
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).replace(/\s+$/, '')
    cut = true
  }
  return cut ? `${text} …` : text
}

/** Single-line version used for tooltips and accessible names. */
export function sqlSummary(sql: string, maxChars = 120): string {
  const flat = sql.replace(/\s+/g, ' ').trim()
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat
}
