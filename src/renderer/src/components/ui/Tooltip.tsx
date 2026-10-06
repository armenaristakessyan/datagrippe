import type { ReactNode } from 'react'
import { Tooltip as RadixTooltip } from 'radix-ui'
import { cn } from '@/lib/cn'
import { Kbd } from './Kbd'

export const TOOLTIP_DELAY = 400

/** Mount once near the root (App does). Shares the open delay and the skip-delay window. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={TOOLTIP_DELAY} skipDelayDuration={250}>
      {children}
    </RadixTooltip.Provider>
  )
}

export interface TooltipProps {
  /** Tooltip text; falsy renders the trigger alone. */
  content: ReactNode
  /** Accelerator shown after the text. */
  shortcut?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  delayDuration?: number
  /** The trigger: a single element that accepts a ref (buttons, spans…). */
  children: ReactNode
  className?: string
}

export function Tooltip({ content, shortcut, side = 'bottom', align = 'center', sideOffset = 6, delayDuration, children, className }: TooltipProps) {
  if (!content && !shortcut) return <>{children}</>
  return (
    <RadixTooltip.Root delayDuration={delayDuration}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          className={cn(
            'z-[60] flex max-w-xs items-center gap-2 rounded-md border border-line bg-elevated px-2 py-1 text-xs text-fg shadow-popover',
            'data-[state=delayed-open]:animate-fade-in data-[state=instant-open]:animate-fade-in data-[state=closed]:animate-fade-out',
            className,
          )}
        >
          {content && <span className="leading-4">{content}</span>}
          {shortcut && <Kbd shortcut={shortcut} />}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}
