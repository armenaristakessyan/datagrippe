import { cn } from '@/lib/cn'

export interface ProgressBarProps {
  /** 0..1; omit for an indeterminate bar. */
  value?: number
  tone?: 'accent' | 'warning' | 'danger'
  className?: string
  label?: string
}

/** Thin 2px bar; indeterminate by default (running queries, loading views). */
export function ProgressBar({ value, tone = 'accent', className, label = 'Loading' }: ProgressBarProps) {
  const color = tone === 'accent' ? 'bg-accent' : tone === 'warning' ? 'bg-warning' : 'bg-danger'
  const determinate = value !== undefined
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={determinate ? Math.round(value * 100) : undefined}
      className={cn('relative h-0.5 w-full overflow-hidden', determinate && 'bg-line', className)}
    >
      {determinate ? (
        <div className={cn('h-full transition-[width] duration-150', color)} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      ) : (
        <div data-essential-motion="" className={cn('absolute inset-y-0 left-0 w-full origin-left animate-progress rounded-full', color)} />
      )}
    </div>
  )
}
