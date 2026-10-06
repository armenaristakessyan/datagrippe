import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  /** sm = 32px, md = 36px (default). */
  size?: 'sm' | 'md'
  /** Hairline under the toolbar (default true). */
  bordered?: boolean
}

/** Horizontal bar of controls at the top of a view. */
export function Toolbar({ size = 'md', bordered = true, className, ...rest }: ToolbarProps) {
  return (
    <div
      role="toolbar"
      className={cn(
        'flex shrink-0 items-center gap-1 bg-panel px-2',
        size === 'sm' ? 'h-8' : 'h-9',
        bordered && 'border-b border-line',
        className,
      )}
      {...rest}
    />
  )
}

export function ToolbarGroup({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center gap-0.5', className)} {...rest} />
}

export function ToolbarSeparator({ className }: { className?: string }) {
  return <div role="separator" aria-orientation="vertical" className={cn('mx-1.5 h-4 w-px shrink-0 bg-line', className)} />
}

/** Pushes the following items to the right. */
export function ToolbarSpacer() {
  return <div className="flex-1" />
}
