import { useMemo, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { formatShortcut, shortcutTokens } from '@/lib/shortcuts'

export interface KbdProps {
  /** Accelerator ("CmdOrCtrl+Shift+Enter") or symbolic string ("⌘↵"). */
  shortcut?: string
  /** Literal content instead of `shortcut`. */
  children?: ReactNode
  /** keys: one keycap per token; text: plain "⇧⌘N" (menus, tooltips). */
  variant?: 'keys' | 'text'
  size?: 'sm' | 'md'
  className?: string
}

const cap =
  'inline-flex min-w-[1.25rem] items-center justify-center rounded-[4px] border border-kbd-line bg-kbd px-1 font-sans font-medium text-muted shadow-inset'

/** Keyboard shortcut hint, formatted for the host platform. */
export function Kbd({ shortcut, children, variant = 'keys', size = 'sm', className }: KbdProps) {
  const tokens = useMemo(() => (shortcut ? shortcutTokens(shortcut) : []), [shortcut])
  const sizing = size === 'sm' ? 'h-[18px] text-2xs' : 'h-5 text-xs'

  if (variant === 'text') {
    return (
      <kbd className={cn('font-sans text-xs tracking-wide text-subtle tabular', className)}>
        {shortcut ? formatShortcut(shortcut) : children}
      </kbd>
    )
  }
  if (!shortcut) return <kbd className={cn(cap, sizing, className)}>{children}</kbd>
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)} aria-label={formatShortcut(shortcut)}>
      {tokens.map((token, i) => (
        <kbd key={i} className={cn(cap, sizing, token.length > 1 && 'px-1.5')}>
          {token}
        </kbd>
      ))}
    </span>
  )
}
