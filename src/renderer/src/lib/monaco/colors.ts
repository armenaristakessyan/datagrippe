// CSS colour strings (as written in styles.css tokens) → the #rrggbb[aa] form Monaco themes require.

const clampByte = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
const hex2 = (n: number) => clampByte(n).toString(16).padStart(2, '0')

function parseChannel(value: string, max: number): number | null {
  const v = value.trim()
  if (v.endsWith('%')) {
    const n = Number.parseFloat(v)
    return Number.isFinite(n) ? (n / 100) * max : null
  }
  const n = Number.parseFloat(v)
  return Number.isFinite(n) ? n : null
}

/** "#abc", "#aabbcc", "#aabbccdd", "rgb(1 2 3 / 0.5)", "rgba(1, 2, 3, 50%)" → "#rrggbb" or "#rrggbbaa"; null when unparseable. */
export function cssColorToHex(input: string): string | null {
  const value = input.trim().toLowerCase()
  if (value === 'transparent') return '#00000000'
  const hex = /^#([0-9a-f]{3,8})$/.exec(value)
  if (hex) {
    const h = hex[1]!
    if (h.length === 3 || h.length === 4) return `#${[...h].map((c) => c + c).join('')}`
    if (h.length === 6 || h.length === 8) return `#${h}`
    return null
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(value)
  if (!fn) return null
  const body = fn[1]!.trim()
  let parts: string[]
  let alpha: string | undefined
  if (body.includes(',')) {
    parts = body.split(',').map((p) => p.trim())
    if (parts.length === 4) alpha = parts.pop()
  } else {
    const [rgb, a] = body.split('/')
    parts = (rgb ?? '').trim().split(/\s+/)
    alpha = a?.trim()
  }
  if (parts.length !== 3) return null
  const channels = parts.map((p) => parseChannel(p, 255))
  if (channels.some((c) => c === null)) return null
  const [r, g, b] = channels as number[]
  const base = `#${hex2(r!)}${hex2(g!)}${hex2(b!)}`
  if (alpha === undefined) return base
  const a = parseChannel(alpha, 1)
  if (a === null) return null
  return a >= 1 ? base : `${base}${hex2(a * 255)}`
}

/** Same colour with its alpha multiplied by `factor` (0..1). */
export function withAlpha(hex: string, factor: number): string {
  const rgb = hex.slice(1, 7)
  const a = hex.length === 9 ? Number.parseInt(hex.slice(7, 9), 16) / 255 : 1
  return `#${rgb}${hex2(a * factor * 255)}`
}

/** "#rrggbb[aa]" → "rrggbb" (Monaco token rules take opaque colours without '#'). */
export function tokenColor(hex: string): string {
  return hex.slice(1, 7)
}
