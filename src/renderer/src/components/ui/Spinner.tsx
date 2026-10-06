import { cn } from '@/lib/cn'

export interface SpinnerProps {
  size?: number
  className?: string
  /** Accessible label; omitted → decorative. */
  label?: string
}

/** Thin circular spinner in currentColor. */
export function Spinner({ size = 14, className, label }: SpinnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-essential-motion=""
      className={cn('shrink-0 animate-spin', className)}
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.75" />
      <path d="M14.25 8A6.25 6.25 0 0 0 8 1.75" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  )
}
