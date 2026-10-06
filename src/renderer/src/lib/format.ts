// Human-readable formatting for sizes, durations, counts and timestamps (UI copy is English).

/** Narrow no-break space: thousands separator and number/unit gap that never wraps. */
export const NNBSP = ' '

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/** 0 → "0 B", 1536 → "1.5 KB", 12_582_912 → "12 MB" (binary multiples, 1 decimal under 10). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  const sign = bytes < 0 ? '-' : ''
  let value = Math.abs(bytes)
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  if (unit === 0) return `${sign}${Math.round(value)} B`
  let rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value)
  // 1023.6 KB rounds to 1024 KB → promote to the next unit.
  if (rounded >= 1024 && unit < BYTE_UNITS.length - 1) {
    rounded = 1
    unit += 1
  }
  return `${sign}${trimZero(rounded)} ${BYTE_UNITS[unit]}`
}

/** 0.4 → "<1 ms", 12 → "12 ms", 1430 → "1.4 s", 23_400 → "23 s", 123_000 → "2 min 3 s", 3_720_000 → "1 h 2 min". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms === 0) return '0 ms'
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 10) {
    const r = Math.round(seconds * 10) / 10
    return r >= 10 ? '10 s' : `${trimZero(r)} s`
  }
  if (seconds < 60) {
    const r = Math.round(seconds)
    return r >= 60 ? '1 min' : `${r} s`
  }
  const totalSeconds = Math.round(seconds)
  if (totalSeconds < 3600) {
    const m = Math.floor(totalSeconds / 60)
    const s = totalSeconds % 60
    return s === 0 ? `${m} min` : `${m} min ${s} s`
  }
  const totalMinutes = Math.round(totalSeconds / 60)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** 1234 → "1 234" (narrow no-break space separators); keeps decimals as given. */
export function formatCount(value: number | bigint | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number' && !Number.isFinite(value)) return '—'
  const text = String(value)
  const negative = text.startsWith('-')
  const [intPart, frac] = (negative ? text.slice(1) : text).split('.')
  const grouped = (intPart ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP)
  return `${negative ? '-' : ''}${grouped}${frac !== undefined ? `.${frac}` : ''}`
}

/** "1 row" / "1 234 rows". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : plural}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then "Mar 4" (same year) or
 * "Mar 4, 2024". Future dates: "in 5 min", "in 3 h", "tomorrow", then absolute.
 */
export function formatRelativeTime(input: string | number | Date, now: number | Date = Date.now()): string {
  const date = input instanceof Date ? input : new Date(input)
  const t = date.getTime()
  if (Number.isNaN(t)) return '—'
  const nowMs = now instanceof Date ? now.getTime() : now
  const diff = nowMs - t
  const abs = Math.abs(diff)
  const future = diff < 0

  if (abs < 45_000) return 'just now'
  if (abs < 3_600_000) {
    const m = Math.max(1, Math.round(abs / 60_000))
    if (m < 60) return future ? `in ${m} min` : `${m} min ago`
  }
  if (abs < 86_400_000) {
    const h = Math.max(1, Math.round(abs / 3_600_000))
    if (h < 24) return future ? `in ${h} h` : `${h} h ago`
  }
  const days = calendarDayDiff(new Date(nowMs), date)
  if (days === 1) return 'yesterday'
  if (days === -1) return 'tomorrow'
  if (days > 1 && days < 7) return `${days} days ago`
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear()
  const base = `${MONTHS[date.getMonth()]} ${date.getDate()}`
  return sameYear ? base : `${base}, ${date.getFullYear()}`
}

/** Absolute local timestamp, e.g. "2026-03-04 14:05:09". */
export function formatTimestamp(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}

function calendarDayDiff(a: Date, b: Date): number {
  const startA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()
  const startB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()
  return Math.round((startA - startB) / 86_400_000)
}

function trimZero(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}
