import { useId } from 'react'
import { DIALECT_LABEL, type Dialect } from '@shared/types'
import { cn } from '@/lib/cn'

export interface DialectIconProps {
  dialect: Dialect
  /** Pixel size (default 16). */
  size?: number | string
  /** tile: coloured rounded square with a white mark (default); glyph: mark only, in the dialect colour. */
  variant?: 'tile' | 'glyph'
  className?: string
  /** Accessible label; defaults to the dialect name. Pass '' for decorative use. */
  title?: string
  strokeWidth?: number | string
}

/** Original, simple marks: an elephant head in profile for PostgreSQL, an "SQL" tile for SQL Server. */
export function DialectIcon({ dialect, size = 16, variant = 'tile', className, title }: DialectIconProps) {
  const id = useId().replace(/:/g, '')
  const label = title ?? DIALECT_LABEL[dialect]
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const }
  const tile = variant === 'tile'

  if (dialect === 'postgres') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" className={cn('shrink-0', className)} {...a11y}>
        <defs>
          <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--c-dialect-postgres)" />
            <stop offset="1" stopColor="var(--c-dialect-postgres-deep)" />
          </linearGradient>
          <mask id={`${id}m`} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
            {/* ear, behind the head */}
            <path d="M2.5 6.2C2.5 4 4 2.7 6 2.9L8.2 3.3V11C6.6 12.3 4.1 11.9 3.1 10.2C2.7 9.5 2.5 8.6 2.5 7.6Z" fill="white" />
            {/* head + trunk, separated from the ear by a cut-out outline */}
            <path
              d="M6.4 6.5C6.4 4.3 8 2.8 10 2.8C12.1 2.8 13.6 4.4 13.6 6.6V11.4C13.6 12.6 12.8 13.4 11.8 13.4C11.1 13.4 10.6 13 10.6 12.4C10.6 12 10.9 11.7 11.3 11.7C11.6 11.7 11.8 11.5 11.8 11.2V9.6C11.3 10 10.7 10.2 10 10.2C8 10.2 6.4 8.7 6.4 6.5Z"
              fill="white"
              stroke="black"
              strokeWidth="0.85"
              strokeLinejoin="round"
            />
            <circle cx="10.9" cy="5.9" r="0.62" fill="black" />
          </mask>
        </defs>
        {tile ? (
          <>
            <rect width="16" height="16" rx="4" fill={`url(#${id}g)`} />
            <rect x="0.5" y="0.5" width="15" height="15" rx="3.5" fill="none" stroke="white" strokeOpacity="0.14" />
            <rect width="16" height="16" fill="white" mask={`url(#${id}m)`} />
          </>
        ) : (
          <rect width="16" height="16" fill="var(--c-dialect-postgres)" mask={`url(#${id}m)`} />
        )}
      </svg>
    )
  }

  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={cn('shrink-0', className)} {...a11y}>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--c-dialect-mssql)" />
          <stop offset="1" stopColor="var(--c-dialect-mssql-deep)" />
        </linearGradient>
      </defs>
      {tile && (
        <>
          <rect width="16" height="16" rx="4" fill={`url(#${id}g)`} />
          <rect x="0.5" y="0.5" width="15" height="15" rx="3.5" fill="none" stroke="white" strokeOpacity="0.16" />
        </>
      )}
      <text
        x="8"
        y="10.3"
        textAnchor="middle"
        fontSize={tile ? 6.1 : 6.6}
        fontWeight="800"
        letterSpacing="-0.2"
        fill={tile ? 'white' : 'var(--c-dialect-mssql)'}
        style={{ fontFamily: "'Inter Variable', ui-sans-serif, system-ui, sans-serif" }}
      >
        SQL
      </text>
    </svg>
  )
}
