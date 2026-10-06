import { isValidElement, type ComponentType, type ReactElement, type ReactNode } from 'react'

/** Props every icon component (lucide-react, DialectIcon…) accepts. */
export interface IconProps {
  size?: number | string
  strokeWidth?: number | string
  className?: string
}

/** An icon component (rendered at the kit's size) or an already-built element (rendered as is). */
export type IconLike = ComponentType<IconProps> | ReactElement

export const ICON_STROKE = 1.75

export function renderIcon(icon: IconLike | undefined, size: number, className?: string): ReactNode {
  if (!icon) return null
  if (isValidElement(icon)) return icon
  const Icon = icon
  return <Icon size={size} strokeWidth={ICON_STROKE} className={className} aria-hidden />
}
