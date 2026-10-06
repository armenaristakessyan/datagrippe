import type { ButtonHTMLAttributes, Ref } from 'react'
import { Button, type ButtonSize, type ButtonVariant } from './Button'
import type { IconLike } from './icon'
import { Tooltip } from './Tooltip'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconLike
  /** Accessible name and tooltip text. */
  label: string
  /** Accelerator shown in the tooltip. */
  shortcut?: string
  variant?: ButtonVariant
  size?: ButtonSize
  active?: boolean
  loading?: boolean
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
  /** Hide the tooltip (keeps aria-label). */
  noTooltip?: boolean
  ref?: Ref<HTMLButtonElement>
}

/** Square ghost button with a tooltip (label + optional shortcut). */
export function IconButton({
  icon,
  label,
  shortcut,
  variant = 'ghost',
  size = 'sm',
  tooltipSide = 'bottom',
  noTooltip,
  ref,
  ...rest
}: IconButtonProps) {
  const button = <Button ref={ref} icon={icon} aria-label={label} variant={variant} size={size} {...rest} />
  if (noTooltip) return button
  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      {button}
    </Tooltip>
  )
}
