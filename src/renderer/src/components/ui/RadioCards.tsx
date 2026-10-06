import type { ReactNode } from 'react'
import { RadioGroup } from 'radix-ui'
import { cn } from '@/lib/cn'
import { renderIcon, type IconLike } from './icon'

export interface RadioCardOption<T extends string> {
  value: T
  title: ReactNode
  description?: ReactNode
  icon?: IconLike
  disabled?: boolean
}

export interface RadioCardsProps<T extends string> {
  value: T | undefined
  onValueChange: (value: T) => void
  options: RadioCardOption<T>[]
  /** Grid columns (default: one per option, max 3). */
  columns?: number
  className?: string
  'aria-label'?: string
}

/** Large selectable cards (dialect picker, auth method…). Arrow keys move the selection. */
export function RadioCards<T extends string>({ value, onValueChange, options, columns, className, ...aria }: RadioCardsProps<T>) {
  const cols = columns ?? Math.min(options.length, 3)
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(v) => {
        const option = options.find((o) => o.value === v)
        if (option) onValueChange(option.value)
      }}
      aria-label={aria['aria-label']}
      className={cn('grid gap-2', className)}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          className={cn(
            'group relative flex items-start gap-3 rounded-lg border border-line bg-input p-3 text-left outline-none',
            'transition-[border-color,background-color,box-shadow] duration-100 hover:border-line-strong hover:bg-hover',
            'focus-visible:ring-2 focus-visible:ring-focus',
            'data-[state=checked]:border-accent/70 data-[state=checked]:bg-accent-soft data-[state=checked]:shadow-[0_0_0_1px_var(--c-accent)]',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          {o.icon && <span className="mt-px flex shrink-0">{renderIcon(o.icon, 20)}</span>}
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium leading-5 text-fg">{o.title}</span>
            {o.description && <span className="mt-0.5 block text-xs leading-4 text-subtle">{o.description}</span>}
          </span>
          <span
            aria-hidden
            className={cn(
              'mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border border-line-strong',
              'group-data-[state=checked]:border-accent group-data-[state=checked]:bg-accent',
            )}
          >
            <span className="size-1.5 rounded-full bg-accent-fg opacity-0 group-data-[state=checked]:opacity-100" />
          </span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  )
}
