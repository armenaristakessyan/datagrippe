import { DIALECT_LABEL, type Dialect } from '@shared/types'
import mssqlIcon from '@/assets/dialects/mssql.png'
import postgresIcon from '@/assets/dialects/postgres.png'
import { cn } from '@/lib/cn'

export interface DialectIconProps {
  dialect: Dialect
  /** Pixel size (default 16). */
  size?: number | string
  /** Kept for the callers: both variants draw the same logo. */
  variant?: 'tile' | 'glyph'
  className?: string
  /** Accessible label; defaults to the dialect name. Pass '' for decorative use. */
  title?: string
  strokeWidth?: number | string
}

const LOGO: Record<Dialect, string> = { postgres: postgresIcon, mssql: mssqlIcon }

/** Engine logo (assets/dialects/*.png: 128 px, transparent background). */
export function DialectIcon({ dialect, size = 16, className, title }: DialectIconProps) {
  const label = title ?? DIALECT_LABEL[dialect]
  return <img src={LOGO[dialect]} width={size} height={size} alt={label} draggable={false} className={cn('shrink-0 select-none', className)} />
}
