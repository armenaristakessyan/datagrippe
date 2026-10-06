import type { ComponentProps } from 'react'
import { Popover as RadixPopover } from 'radix-ui'
import { cn } from '@/lib/cn'

/** Floating surface shared by popovers, menus, selects. */
export const floatingSurface = cn(
  'z-50 rounded-lg border border-line bg-elevated text-fg shadow-popover outline-none',
  'data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out',
  'data-[side=top]:[--pop-y:2px] data-[side=bottom]:[--pop-y:-2px]',
)

export const Popover = RadixPopover.Root
export const PopoverTrigger = RadixPopover.Trigger
export const PopoverAnchor = RadixPopover.Anchor
export const PopoverClose = RadixPopover.Close

export type PopoverContentProps = ComponentProps<typeof RadixPopover.Content>

export function PopoverContent({ className, sideOffset = 6, align = 'start', collisionPadding = 8, ...rest }: PopoverContentProps) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={collisionPadding}
        className={cn(floatingSurface, 'p-3', className)}
        {...rest}
      />
    </RadixPopover.Portal>
  )
}
