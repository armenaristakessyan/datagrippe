import { useRef, useState, type InputHTMLAttributes, type ReactNode, type Ref, type TextareaHTMLAttributes } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { renderIcon, type IconLike } from './icon'

export type InputSize = 'sm' | 'md' | 'lg'

/** Shared control chrome: border, background, focus ring, invalid state. */
export const controlClassName = cn(
  'rounded-md border border-line bg-input text-fg shadow-inset outline-none',
  'transition-[border-color,box-shadow,background-color] duration-100',
  'placeholder:text-faint hover:border-line-strong',
  'focus-within:border-accent/70 focus-within:ring-[3px] focus-within:ring-accent-soft focus-within:hover:border-accent/70',
  'aria-[invalid=true]:border-danger/70 aria-[invalid=true]:focus-within:ring-danger-soft',
  'data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50',
)

const heights: Record<InputSize, { box: string; text: string; icon: number; pad: string }> = {
  sm: { box: 'h-6', text: 'text-xs', icon: 13, pad: 'px-2' },
  md: { box: 'h-7', text: 'text-sm', icon: 14, pad: 'px-2.5' },
  lg: { box: 'h-8', text: 'text-sm', icon: 15, pad: 'px-3' },
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** sm = 24px, md = 28px (default), lg = 32px. */
  size?: InputSize
  leadingIcon?: IconLike
  /** Element rendered inside the box on the right (unit, Kbd, button…). */
  trailing?: ReactNode
  /** Shows a × button when the input has a value. */
  onClear?: () => void
  invalid?: boolean
  /** Monospace text (identifiers, hosts, SQL fragments). */
  mono?: boolean
  /** Class of the outer box (the `className` goes to the <input>). */
  wrapperClassName?: string
  ref?: Ref<HTMLInputElement>
}

export function Input({
  size = 'md',
  leadingIcon,
  trailing,
  onClear,
  invalid,
  mono,
  className,
  wrapperClassName,
  disabled,
  ref,
  value,
  ...rest
}: InputProps) {
  const h = heights[size]
  const innerRef = useRef<HTMLInputElement | null>(null)
  const hasValue = value !== undefined && value !== null && String(value) !== ''
  const setRefs = (el: HTMLInputElement | null) => {
    innerRef.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) ref.current = el
  }
  return (
    <div
      aria-invalid={invalid || undefined}
      data-disabled={disabled || undefined}
      className={cn(controlClassName, 'flex items-center gap-1.5', h.box, h.pad, leadingIcon && 'pl-2', wrapperClassName)}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault()
          innerRef.current?.focus()
        }
      }}
    >
      {leadingIcon && <span className="flex shrink-0 text-subtle">{renderIcon(leadingIcon, h.icon)}</span>}
      <input
        ref={setRefs}
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          'h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint disabled:cursor-not-allowed',
          h.text,
          mono && 'font-mono text-xs',
          className,
        )}
        {...rest}
      />
      {onClear && hasValue && !disabled && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Clear"
          onClick={() => {
            onClear()
            innerRef.current?.focus()
          }}
          className="-mr-1 flex size-4 shrink-0 items-center justify-center rounded-full text-subtle hover:bg-active hover:text-fg"
        >
          <X size={11} strokeWidth={2.25} />
        </button>
      )}
      {trailing}
    </div>
  )
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
  mono?: boolean
  ref?: Ref<HTMLTextAreaElement>
}

export function Textarea({ invalid, mono, className, disabled, ref, ...rest }: TextareaProps) {
  return (
    <textarea
      ref={ref}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      data-disabled={disabled || undefined}
      spellCheck={false}
      className={cn(
        controlClassName,
        'block min-h-16 w-full resize-y px-2.5 py-1.5 text-sm leading-5 focus:border-accent/70 focus:ring-[3px] focus:ring-accent-soft',
        'aria-[invalid=true]:focus:ring-danger-soft',
        mono && 'font-mono text-xs leading-5',
        className,
      )}
      {...rest}
    />
  )
}

export interface NumberInputProps extends Omit<InputProps, 'value' | 'onChange' | 'type' | 'defaultValue' | 'onClear'> {
  value: number | null
  /** Called with the parsed, clamped value (null when the field is emptied and `allowEmpty`). */
  onValueChange: (value: number | null) => void
  min?: number
  max?: number
  step?: number
  /** Integers only (default true). */
  integer?: boolean
  allowEmpty?: boolean
  /** Hide the ▲▼ stepper. */
  hideStepper?: boolean
}

function clamp(n: number, min?: number, max?: number): number {
  let v = n
  if (min !== undefined) v = Math.max(min, v)
  if (max !== undefined) v = Math.min(max, v)
  return v
}

/** Numeric field: keeps a text draft while typing, commits on blur / Enter / arrows / stepper. */
export function NumberInput({
  value,
  onValueChange,
  min,
  max,
  step = 1,
  integer = true,
  allowEmpty = false,
  hideStepper,
  disabled,
  trailing,
  onBlur,
  onKeyDown,
  ...rest
}: NumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? (value === null ? '' : String(value))

  const commit = (raw: string) => {
    setDraft(null)
    const trimmed = raw.trim()
    if (trimmed === '') {
      if (allowEmpty) onValueChange(null)
      return
    }
    const parsed = Number(trimmed.replace(',', '.'))
    if (!Number.isFinite(parsed)) return
    const next = clamp(integer ? Math.round(parsed) : parsed, min, max)
    if (next !== value) onValueChange(next)
  }
  const bump = (direction: 1 | -1) => {
    const base = value ?? min ?? 0
    const next = clamp(Number((base + direction * step).toFixed(10)), min, max)
    setDraft(null)
    if (next !== value) onValueChange(next)
  }

  const stepper = !hideStepper && !disabled && (
    <span className="-mr-1.5 flex h-full shrink-0 flex-col justify-center py-[3px]">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Increment"
        disabled={max !== undefined && value !== null && value >= max}
        onClick={() => bump(1)}
        className="flex h-1/2 w-4 items-center justify-center rounded-t-[3px] text-subtle hover:bg-active hover:text-fg disabled:opacity-40"
      >
        <ChevronUp size={10} strokeWidth={2.25} />
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Decrement"
        disabled={min !== undefined && value !== null && value <= min}
        onClick={() => bump(-1)}
        className="flex h-1/2 w-4 items-center justify-center rounded-b-[3px] text-subtle hover:bg-active hover:text-fg disabled:opacity-40"
      >
        <ChevronDown size={10} strokeWidth={2.25} />
      </button>
    </span>
  )

  return (
    <Input
      {...rest}
      inputMode={integer ? 'numeric' : 'decimal'}
      value={text}
      disabled={disabled}
      className={cn('tabular', rest.className)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        commit(e.target.value)
        onBlur?.(e)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(e.currentTarget.value)
        else if (e.key === 'ArrowUp') {
          e.preventDefault()
          bump(1)
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          bump(-1)
        } else if (e.key === 'Escape' && draft !== null) {
          e.stopPropagation()
          setDraft(null)
        }
        onKeyDown?.(e)
      }}
      trailing={
        <>
          {trailing}
          {stepper}
        </>
      }
    />
  )
}
