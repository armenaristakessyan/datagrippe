import type { ReactNode } from 'react'
import { ToggleGroup } from 'radix-ui'
import { cn } from '@/lib/cn'
import { renderIcon, type IconLike } from './icon'

export interface SegmentedOption<T extends string> {
  value: T
  label?: ReactNode
  icon?: IconLike
  /** Accessible name when the option is icon-only. */
  ariaLabel?: string
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string> {
  value: T
  onValueChange: (value: T) => void
  options: SegmentedOption<T>[]
  size?: 'xs' | 'sm'
  /** Stretch segments to fill the width. */
  fill?: boolean
  className?: string
  'aria-label'?: string
}

export function SegmentedControl<T extends string>({ value, onValueChange, options, size = 'sm', fill, className, ...aria }: SegmentedControlProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => {
        const option = options.find((o) => o.value === v)
        if (option) onValueChange(option.value)
      }}
      aria-label={aria['aria-label']}
      className={cn(
        'inline-flex items-center gap-px rounded-md bg-hover p-0.5 shadow-[inset_0_0_0_1px_var(--c-line)]',
        size === 'xs' ? 'h-6' : 'h-7',
        fill && 'flex w-full',
        className,
      )}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          aria-label={o.ariaLabel}
          className={cn(
            'no-drag inline-flex h-full items-center justify-center gap-1.5 rounded-[4px] px-2.5 font-medium text-subtle outline-none',
            'transition-[background-color,color,box-shadow] duration-100 hover:text-fg',
            'focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40',
            'data-[state=on]:bg-elevated data-[state=on]:text-fg data-[state=on]:shadow-raised',
            size === 'xs' ? 'text-xs' : 'text-xs',
            !o.label && 'px-1.5',
            fill && 'flex-1',
          )}
        >
          {renderIcon(o.icon, size === 'xs' ? 13 : 14)}
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
