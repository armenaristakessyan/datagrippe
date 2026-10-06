import { useId, type ReactNode } from 'react'
import { Checkbox as RadixCheckbox } from 'radix-ui'
import { Check, Minus } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface CheckboxProps {
  checked: boolean | 'indeterminate'
  onCheckedChange: (checked: boolean) => void
  label?: ReactNode
  /** Secondary line under the label. */
  description?: ReactNode
  disabled?: boolean
  id?: string
  className?: string
}

export function Checkbox({ checked, onCheckedChange, label, description, disabled, id, className }: CheckboxProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  const box = (
    <RadixCheckbox.Root
      id={inputId}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      className={cn(
        'peer flex size-[15px] shrink-0 items-center justify-center rounded-[4px] border border-line-strong bg-input shadow-inset outline-none',
        'transition-colors duration-100 hover:border-faint',
        'focus-visible:ring-2 focus-visible:ring-focus',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-accent-fg',
        'data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent data-[state=indeterminate]:text-accent-fg',
        'disabled:cursor-not-allowed disabled:opacity-50',
        !label && className,
      )}
    >
      <RadixCheckbox.Indicator>
        {checked === 'indeterminate' ? <Minus size={11} strokeWidth={3} /> : <Check size={11} strokeWidth={3} />}
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  )
  if (!label) return box
  return (
    <div className={cn('flex items-start gap-2', disabled && 'opacity-60', className)}>
      <span className="flex h-5 items-center">{box}</span>
      <label htmlFor={inputId} className="min-w-0 cursor-default select-none text-sm leading-5 text-fg">
        {label}
        {description && <span className="block text-xs leading-4 text-subtle">{description}</span>}
      </label>
    </div>
  )
}
