import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'
import { renderIcon, type IconLike } from './icon'

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'outline'

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-active text-muted',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  outline: 'border border-line-strong text-muted',
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
  icon?: IconLike
  size?: 'sm' | 'md'
  /** Monospace (types, codes). */
  mono?: boolean
}

export function Badge({ tone = 'neutral', icon, size = 'sm', mono, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[4px] font-medium',
        size === 'sm' ? 'h-[18px] px-1.5 text-2xs' : 'h-5 px-2 text-xs',
        mono && 'font-mono text-[10.5px]',
        tones[tone],
        className,
      )}
      {...rest}
    >
      {renderIcon(icon, size === 'sm' ? 11 : 12)}
      {children}
    </span>
  )
}
