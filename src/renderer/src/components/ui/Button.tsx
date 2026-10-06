import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { Slot } from 'radix-ui'
import { cn } from '@/lib/cn'
import { renderIcon, type IconLike } from './icon'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger' | 'outline'
export type ButtonSize = 'xs' | 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  /** xs = 24px, sm = 28px (default), md = 32px. */
  size?: ButtonSize
  leadingIcon?: IconLike
  trailingIcon?: IconLike
  /** Shows a spinner in place of the leading icon and disables the button. */
  loading?: boolean
  /** Square icon-only button (pass `icon` + `aria-label`, no children). */
  icon?: IconLike
  /** Pressed / toggled-on look (ghost & subtle variants). */
  active?: boolean
  /** Render the child element instead of a <button> (e.g. a link). */
  asChild?: boolean
  ref?: Ref<HTMLButtonElement>
}

export const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_1px_2px_rgb(0_0_0/0.2)] hover:bg-accent-hover active:brightness-95',
  secondary: 'bg-active text-fg shadow-inset hover:bg-line-strong',
  ghost: 'text-muted hover:bg-hover hover:text-fg data-[active=true]:bg-active data-[active=true]:text-fg',
  subtle: 'bg-hover text-fg hover:bg-active data-[active=true]:bg-accent-soft data-[active=true]:text-accent',
  danger:
    'bg-danger text-on-solid shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(0_0_0/0.2)] hover:brightness-110 active:brightness-95',
  outline: 'border border-line-strong bg-transparent text-fg hover:border-faint hover:bg-hover',
}

const sizes: Record<ButtonSize, { base: string; square: string; icon: number; gap: string }> = {
  xs: { base: 'h-6 px-2 text-xs rounded-[5px]', square: 'h-6 w-6 rounded-[5px]', icon: 14, gap: 'gap-1' },
  sm: { base: 'h-7 px-2.5 text-sm rounded-md', square: 'h-7 w-7 rounded-md', icon: 15, gap: 'gap-1.5' },
  md: { base: 'h-8 px-3.5 text-sm rounded-md', square: 'h-8 w-8 rounded-md', icon: 16, gap: 'gap-2' },
}

export function buttonClassName({
  variant = 'secondary',
  size = 'sm',
  square = false,
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; square?: boolean; className?: string }): string {
  const s = sizes[size]
  return cn(
    'no-drag relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium outline-none',
    'transition-[background-color,color,border-color,box-shadow,filter] duration-100',
    'focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-0 focus-visible:outline-none',
    'disabled:pointer-events-none disabled:opacity-45',
    s.gap,
    square ? s.square : s.base,
    buttonVariants[variant],
    className,
  )
}

export function Button({
  variant = 'secondary',
  size = 'sm',
  leadingIcon,
  trailingIcon,
  loading = false,
  icon,
  active,
  asChild = false,
  className,
  children,
  disabled,
  type = 'button',
  ref,
  ...rest
}: ButtonProps) {
  const square = icon !== undefined && (children === undefined || children === null || children === false)
  const iconSize = sizes[size].icon
  const Comp = asChild ? Slot.Root : 'button'
  const lead: ReactNode = loading ? <Spinner size={iconSize - 1} /> : renderIcon(square ? icon : (leadingIcon ?? icon), iconSize)

  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-active={active ? 'true' : undefined}
      aria-pressed={active === undefined ? undefined : active}
      className={buttonClassName({ variant, size, square, className })}
      {...rest}
    >
      {asChild ? (
        children
      ) : (
        <>
          {lead}
          {!square && children !== undefined && <span className="truncate">{children}</span>}
          {!square && renderIcon(trailingIcon, iconSize - 1, 'opacity-70')}
        </>
      )}
    </Comp>
  )
}
