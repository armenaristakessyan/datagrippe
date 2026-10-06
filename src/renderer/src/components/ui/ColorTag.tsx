import type { ConnectionColor } from '@shared/types'
import { cn } from '@/lib/cn'

/** CSS color for a connection tag, or undefined for 'none'. */
export function connectionColorVar(color: ConnectionColor | undefined): string | undefined {
  if (!color || color === 'none') return undefined
  return `var(--c-tag-${color})`
}

export const CONNECTION_COLOR_LABEL: Record<ConnectionColor, string> = {
  none: 'No color',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
  gray: 'Gray',
}

export interface ColorTagProps {
  color: ConnectionColor | undefined
  /** dot: round 8px; square: rounded 10px chip; bar: 3px vertical stripe (full height of parent). */
  variant?: 'dot' | 'square' | 'bar'
  size?: number
  /** Render an outlined empty dot for 'none' instead of nothing. */
  showNone?: boolean
  className?: string
}

/** Connection colour marker (see CONNECTION_COLORS). */
export function ColorTag({ color, variant = 'dot', size, showNone, className }: ColorTagProps) {
  const css = connectionColorVar(color)
  if (!css && !showNone) return null
  if (variant === 'bar') {
    return <span aria-hidden className={cn('w-[3px] shrink-0 self-stretch rounded-full', className)} style={{ background: css }} />
  }
  const px = size ?? (variant === 'square' ? 10 : 8)
  return (
    <span
      aria-hidden
      className={cn('inline-block shrink-0', variant === 'dot' ? 'rounded-full' : 'rounded-[3px]', !css && 'border border-line-strong', className)}
      style={{ width: px, height: px, background: css, boxShadow: css ? `0 0 0 1px color-mix(in srgb, ${css} 30%, transparent)` : undefined }}
    />
  )
}
