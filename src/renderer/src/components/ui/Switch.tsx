import { useId, type ReactNode } from 'react'
import { Switch as RadixSwitch } from 'radix-ui'
import { cn } from '@/lib/cn'

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  size?: 'sm' | 'md'
  label?: ReactNode
  description?: ReactNode
  disabled?: boolean
  id?: string
  className?: string
  'aria-label'?: string
}

export function Switch({ checked, onCheckedChange, size = 'md', label, description, disabled, id, className, ...aria }: SwitchProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  const sm = size === 'sm'
  const control = (
    <RadixSwitch.Root
      id={inputId}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      aria-label={aria['aria-label']}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full border border-transparent bg-line-strong outline-none',
        'transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus',
        'data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
        sm ? 'h-3.5 w-6' : 'h-[18px] w-8',
        !label && className,
      )}
    >
      <RadixSwitch.Thumb
        className={cn(
          'block rounded-full bg-on-solid shadow-[0_1px_2px_rgb(0_0_0/0.3)] transition-transform duration-150',
          sm ? 'size-2.5 translate-x-[1px] data-[state=checked]:translate-x-[11px]' : 'size-3.5 translate-x-[1px] data-[state=checked]:translate-x-[15px]',
        )}
      />
    </RadixSwitch.Root>
  )
  if (!label) return control
  return (
    <div className={cn('flex items-start justify-between gap-4', disabled && 'opacity-60', className)}>
      <label htmlFor={inputId} className="min-w-0 cursor-default select-none text-sm leading-5 text-fg">
        {label}
        {description && <span className="block text-xs leading-4 text-subtle">{description}</span>}
      </label>
      <span className="flex h-5 items-center">{control}</span>
    </div>
  )
}
