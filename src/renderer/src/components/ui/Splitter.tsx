// Thin wrappers over react-resizable-panels v4 (Group / Panel / Separator) with the app's handle.
// Sizes: numbers are pixels, strings without unit are percentages ("30"), or "30%" / "240px".
import type { ComponentProps } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { cn } from '@/lib/cn'

export { usePanelRef, useGroupRef } from 'react-resizable-panels'
export type { PanelImperativeHandle, GroupImperativeHandle, Layout as SplitLayout, PanelSize } from 'react-resizable-panels'

export type SplitGroupProps = ComponentProps<typeof Group>

/** `orientation="horizontal"` lays panels side by side; "vertical" stacks them. */
export function SplitGroup({ className, ...rest }: SplitGroupProps) {
  return <Group className={cn('h-full w-full', className)} {...rest} />
}

export type SplitPanelProps = ComponentProps<typeof Panel>

export function SplitPanel({ className, ...rest }: SplitPanelProps) {
  return <Panel className={cn('min-h-0 min-w-0', className)} {...rest} />
}

export interface SplitHandleProps extends ComponentProps<typeof Separator> {
  /** Direction of the line (matches the parent group's orientation: horizontal group → vertical line). */
  direction?: 'vertical' | 'horizontal'
}

/** 1px hairline that highlights in the accent colour on hover / drag / focus (hit area is wider). */
export function SplitHandle({ direction = 'vertical', className, ...rest }: SplitHandleProps) {
  const vertical = direction === 'vertical'
  return (
    <Separator
      className={cn(
        'group relative z-10 shrink-0 bg-line outline-none transition-colors duration-150',
        vertical ? 'w-px' : 'h-px',
        'data-[separator=hover]:bg-accent/60 data-[separator=active]:bg-accent data-[separator=focus]:bg-accent',
        'after:absolute after:transition-colors after:duration-150',
        vertical ? 'after:inset-y-0 after:-left-px after:w-[3px]' : 'after:inset-x-0 after:-top-px after:h-[3px]',
        'data-[separator=hover]:after:bg-accent/30 data-[separator=active]:after:bg-accent/45',
        className,
      )}
      {...rest}
    />
  )
}
