import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { renderIcon, type IconLike } from './icon'

export interface EmptyStateProps {
  icon?: IconLike
  title: ReactNode
  /** One-line explanation. */
  description?: ReactNode
  /** Primary action (usually a <Button variant="primary" size="sm">) and optional secondary ones. */
  action?: ReactNode
  /** compact: for sidebars and small panels. */
  size?: 'compact' | 'default'
  tone?: 'neutral' | 'danger'
  className?: string
  children?: ReactNode
}

/** Centered placeholder for empty / error views: icon tile, title, one line, actions. */
export function EmptyState({ icon, title, description, action, size = 'default', tone = 'neutral', className, children }: EmptyStateProps) {
  const compact = size === 'compact'
  return (
    <div className={cn('flex h-full min-h-0 w-full flex-col items-center justify-center text-center', compact ? 'gap-2 p-4' : 'gap-3 p-8', className)}>
      {icon && (
        <span
          className={cn(
            'flex items-center justify-center rounded-xl border',
            compact ? 'size-9' : 'size-11',
            tone === 'danger' ? 'border-danger/25 bg-danger-soft text-danger' : 'border-line bg-panel text-subtle shadow-inset',
          )}
        >
          {renderIcon(icon, compact ? 16 : 20)}
        </span>
      )}
      <div className={cn('flex max-w-sm flex-col', compact ? 'gap-0.5' : 'gap-1')}>
        <p className={cn('font-medium text-fg', compact ? 'text-xs' : 'text-sm')}>{title}</p>
        {description && <p className={cn('text-subtle', compact ? 'text-2xs leading-4' : 'text-xs leading-[18px]')}>{description}</p>}
      </div>
      {children}
      {action && <div className={cn('flex flex-wrap items-center justify-center gap-2', compact ? 'mt-1' : 'mt-1.5')}>{action}</div>}
    </div>
  )
}
