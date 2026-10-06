import type { ConnectionStatus } from '@shared/types'
import { cn } from '@/lib/cn'

export type StatusTone = ConnectionStatus | 'success' | 'warning' | 'danger' | 'info' | 'neutral'

const tones: Record<StatusTone, string> = {
  connected: 'bg-success',
  success: 'bg-success',
  connecting: 'bg-warning',
  warning: 'bg-warning',
  error: 'bg-danger',
  danger: 'bg-danger',
  info: 'bg-info',
  disconnected: 'bg-faint',
  neutral: 'bg-faint',
}

const labels: Partial<Record<StatusTone, string>> = {
  connected: 'Connected',
  connecting: 'Connecting',
  error: 'Connection error',
  disconnected: 'Disconnected',
}

export interface StatusDotProps {
  status: StatusTone
  size?: number
  /** Soft halo around the dot (draws attention to live states). */
  halo?: boolean
  className?: string
  label?: string
}

export function StatusDot({ status, size = 7, halo, className, label }: StatusDotProps) {
  const pulsing = status === 'connecting'
  return (
    <span
      role="img"
      aria-label={label ?? labels[status] ?? status}
      data-essential-motion={pulsing ? '' : undefined}
      style={{ width: size, height: size }}
      className={cn(
        'inline-block shrink-0 rounded-full',
        tones[status],
        pulsing && 'animate-pulse-soft',
        halo && status === 'connected' && 'shadow-[0_0_0_3px_var(--c-success-soft)]',
        halo && status === 'error' && 'shadow-[0_0_0_3px_var(--c-danger-soft)]',
        className,
      )}
    />
  )
}
