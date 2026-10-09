import { useMemo, useState, type ReactNode } from 'react'
import { Command } from 'cmdk'
import { Check, ChevronsUpDown, Search } from 'lucide-react'
import { cn } from '@/lib/cn'
import { renderIcon, type IconLike } from './icon'
import { controlClassName } from './Input'
import { Popover, PopoverContent, PopoverTrigger } from './Popover'
import { Spinner } from './Spinner'

export interface ComboboxOption<T extends string = string> {
  value: T
  label: string
  /** Rendered instead of `label` in the list (label still drives search). */
  render?: ReactNode
  icon?: IconLike
  /** Dim text on the right (size, count, kind…). */
  hint?: ReactNode
  /** Section heading; options sharing it are grouped (in first-seen order). */
  group?: string
  keywords?: string[]
  disabled?: boolean
}

export interface ComboboxProps<T extends string> {
  value: T | undefined
  onValueChange: (value: T) => void
  options: ComboboxOption<T>[]
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  loading?: boolean
  /** Error text shown instead of the list. */
  error?: string
  size?: 'sm' | 'md'
  /** default = bordered field, ghost = toolbar style. */
  variant?: 'default' | 'ghost'
  /** Leading icon of the trigger (overrides the selected option's icon). */
  icon?: IconLike
  disabled?: boolean
  /** Popover width (px); defaults to the trigger width, min 220. */
  width?: number
  align?: 'start' | 'center' | 'end'
  /** Called when the popover opens (e.g. lazy-load options). */
  onOpen?: () => void
  /** Extra content at the bottom of the popover (e.g. "Refresh"). */
  footer?: ReactNode
  className?: string
  'aria-label'?: string
}

/** Searchable picker (databases, schemas, connections) — cmdk list in a Popover. */
export function Combobox<T extends string>({
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No matches',
  loading,
  error,
  size = 'md',
  variant = 'default',
  icon,
  disabled,
  width,
  align = 'start',
  onOpen,
  footer,
  className,
  ...aria
}: ComboboxProps<T>) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  const leading = icon ?? selected?.icon

  const groups = useMemo(() => {
    const map = new Map<string, ComboboxOption<T>[]>()
    for (const o of options) {
      const key = o.group ?? ''
      const list = map.get(key)
      if (list) list.push(o)
      else map.set(key, [o])
    }
    return [...map.entries()]
  }, [options])

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) onOpen?.()
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        aria-label={aria['aria-label']}
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
        <span className={cn('min-w-0 flex-1 truncate', !selected && 'text-faint')}>{selected?.label ?? placeholder}</span>
        <ChevronsUpDown size={12} strokeWidth={2} className="shrink-0 text-subtle" />
      </PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={4}
        className="overflow-hidden p-0"
        style={{ width: width ?? 'max(var(--radix-popover-trigger-width), 220px)' }}
      >
        <Command loop className="flex max-h-[min(var(--radix-popover-content-available-height),380px)] flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-2.5">
            <Search size={14} strokeWidth={1.75} className="shrink-0 text-subtle" />
            <Command.Input
              autoFocus
              placeholder={searchPlaceholder}
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-faint"
            />
            {loading && <Spinner size={13} className="text-subtle" />}
          </div>
          {error ? (
            <div className="px-3 py-4 text-center text-xs text-danger">{error}</div>
          ) : (
            <Command.List className="min-h-0 flex-1 overflow-y-auto p-1">
              {!loading && <Command.Empty className="px-3 py-5 text-center text-xs text-subtle">{emptyText}</Command.Empty>}
              {loading && options.length === 0 && (
                <Command.Loading>
                  <div className="space-y-1 p-1">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="skeleton h-5 rounded" style={{ width: `${80 - i * 15}%` }} />
                    ))}
                  </div>
                </Command.Loading>
              )}
              {groups.map(([group, items]) => (
                <Command.Group
                  key={group || '_'}
                  heading={group || undefined}
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-0.5 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-subtle"
                >
                  {items.map((o) => (
                    <Command.Item
                      key={o.value}
                      value={o.value}
                      keywords={[o.label, ...(o.keywords ?? [])]}
                      disabled={o.disabled}
                      onSelect={() => {
                        onValueChange(o.value)
                        setOpen(false)
                      }}
                      className={cn(
                        'flex h-7 cursor-default select-none items-center gap-2 rounded-[5px] px-2 text-sm text-fg outline-none',
                        'data-[selected=true]:bg-hover data-[disabled=true]:opacity-40',
                      )}
                    >
                      {o.icon && <span className="flex shrink-0 text-muted">{renderIcon(o.icon, 14)}</span>}
                      {/* The label keeps its width; the hint gets what is left and truncates first. */}
                      <span className="min-w-0 flex-initial truncate">{o.render ?? o.label}</span>
                      {o.hint && (
                        <span
                          className="min-w-0 flex-1 truncate text-right text-xs text-subtle tabular"
                          title={typeof o.hint === 'string' ? o.hint : undefined}
                        >
                          {o.hint}
                        </span>
                      )}
                      <Check
                        size={13}
                        strokeWidth={2.25}
                        className={cn('ml-auto shrink-0 text-accent', o.value === value ? 'opacity-100' : 'opacity-0')}
                      />
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          )}
          {footer && <div className="shrink-0 border-t border-line p-1">{footer}</div>}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
