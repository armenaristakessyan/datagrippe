import type { ReactNode } from 'react'
import { Select as RadixSelect } from 'radix-ui'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/cn'
import { renderIcon, type IconLike } from './icon'
import { controlClassName } from './Input'
import { floatingSurface } from './Popover'

export interface SelectOption<T extends string = string> {
  value: T
  label: ReactNode
  /** Text shown in the trigger when `label` is rich (defaults to label). */
  triggerLabel?: ReactNode
  icon?: IconLike
  /** Dim secondary text on the right of the option. */
  hint?: ReactNode
  disabled?: boolean
}

export interface SelectGroup<T extends string = string> {
  label: string
  options: SelectOption<T>[]
}

export type SelectItems<T extends string> = (SelectOption<T> | SelectGroup<T>)[]

export interface SelectProps<T extends string> {
  value: T | undefined
  onValueChange: (value: T) => void
  options: SelectItems<T>
  placeholder?: string
  size?: 'sm' | 'md'
  /** Leading icon in the trigger (overrides the selected option's icon). */
  icon?: IconLike
  disabled?: boolean
  invalid?: boolean
  /** ghost = borderless trigger for toolbars. */
  variant?: 'default' | 'ghost'
  id?: string
  className?: string
  contentClassName?: string
  'aria-label'?: string
}

function isGroup<T extends string>(item: SelectOption<T> | SelectGroup<T>): item is SelectGroup<T> {
  return 'options' in item
}

function flatten<T extends string>(items: SelectItems<T>): SelectOption<T>[] {
  return items.flatMap((i) => (isGroup(i) ? i.options : [i]))
}

const itemClass = cn(
  'relative flex h-7 cursor-default select-none items-center gap-2 rounded-[5px] pl-2 pr-7 text-sm text-fg outline-none',
  'data-[highlighted]:bg-hover data-[disabled]:opacity-40',
)

export function Select<T extends string>({
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  size = 'md',
  icon,
  disabled,
  invalid,
  variant = 'default',
  id,
  className,
  contentClassName,
  ...aria
}: SelectProps<T>) {
  const all = flatten(options)
  const selected = all.find((o) => o.value === value)
  const leading = icon ?? selected?.icon

  const renderOption = (o: SelectOption<T>) => (
    <RadixSelect.Item key={o.value} value={o.value} disabled={o.disabled} className={itemClass}>
      {o.icon && <span className="flex shrink-0 text-muted">{renderIcon(o.icon, 14)}</span>}
      <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
      {o.hint && <span className="ml-auto pl-3 text-xs text-subtle">{o.hint}</span>}
      <RadixSelect.ItemIndicator className="absolute right-2 flex items-center text-accent">
        <Check size={13} strokeWidth={2.25} />
      </RadixSelect.ItemIndicator>
    </RadixSelect.Item>
  )

  return (
    <RadixSelect.Root
      value={value}
      onValueChange={(v) => {
        const option = all.find((o) => o.value === v)
        if (option) onValueChange(option.value)
      }}
      disabled={disabled}
    >
      <RadixSelect.Trigger
        id={id}
        aria-label={aria['aria-label']}
        aria-invalid={invalid || undefined}
        className={cn(
          'no-drag group inline-flex min-w-0 items-center gap-1.5 text-left outline-none',
          variant === 'default'
            ? cn(controlClassName, 'focus-visible:border-accent/70 focus-visible:ring-[3px] focus-visible:ring-accent-soft data-[state=open]:border-accent/70')
            : 'rounded-md text-muted transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus data-[state=open]:bg-active data-[state=open]:text-fg',
          size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-sm',
          disabled && 'cursor-not-allowed opacity-50',
          className,
        )}
      >
        {leading && <span className="flex shrink-0 text-muted">{renderIcon(leading, size === 'sm' ? 13 : 14)}</span>}
        <span className={cn('min-w-0 flex-1 truncate', !selected && 'text-faint')}>
          {selected ? (selected.triggerLabel ?? selected.label) : placeholder}
        </span>
        <RadixSelect.Icon className="flex shrink-0 text-subtle transition-transform group-data-[state=open]:rotate-180">
          <ChevronDown size={13} strokeWidth={2} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className={cn(
            floatingSurface,
            'max-h-[min(var(--radix-select-content-available-height),360px)] min-w-[var(--radix-select-trigger-width)] overflow-hidden',
            contentClassName,
          )}
        >
          <RadixSelect.ScrollUpButton className="flex h-5 items-center justify-center text-subtle">
            <ChevronUp size={12} />
          </RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport className="p-1">
            {options.map((item, i) =>
              isGroup(item) ? (
                <RadixSelect.Group key={`g${i}`} className={cn(i > 0 && 'mt-1 border-t border-line pt-1')}>
                  <RadixSelect.Label className="px-2 pb-0.5 pt-1 text-2xs font-medium uppercase tracking-wider text-subtle">
                    {item.label}
                  </RadixSelect.Label>
                  {item.options.map(renderOption)}
                </RadixSelect.Group>
              ) : (
                renderOption(item)
              ),
            )}
          </RadixSelect.Viewport>
          <RadixSelect.ScrollDownButton className="flex h-5 items-center justify-center text-subtle">
            <ChevronDown size={12} />
          </RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}
