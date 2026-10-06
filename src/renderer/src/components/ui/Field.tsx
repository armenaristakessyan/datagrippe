import type { ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface FieldProps {
  label?: ReactNode
  /** id of the control, links the <label>. */
  htmlFor?: string
  hint?: ReactNode
  /** Replaces the hint and colors it red. */
  error?: ReactNode
  required?: boolean
  /** Element at the right of the label row (link, toggle…). */
  labelAside?: ReactNode
  /** Label on the left, control on the right (settings rows). */
  inline?: boolean
  className?: string
  children: ReactNode
}

export function Field({ label, htmlFor, hint, error, required, labelAside, inline, className, children }: FieldProps) {
  const labelNode = label && (
    <label htmlFor={htmlFor} className="flex select-none items-center gap-1 text-xs font-medium leading-4 text-muted">
      {label}
      {required && (
        <span className="text-danger" aria-hidden>
          *
        </span>
      )}
    </label>
  )
  const message = error ? (
    <p role="alert" className="flex items-start gap-1 text-2xs leading-4 text-danger">
      <AlertCircle size={12} strokeWidth={2} className="mt-0.5 shrink-0" />
      <span>{error}</span>
    </p>
  ) : hint ? (
    <p className="text-2xs leading-4 text-subtle">{hint}</p>
  ) : null

  if (inline) {
    return (
      <div className={cn('flex items-start justify-between gap-6', className)}>
        <div className="min-w-0 pt-1.5">
          {labelNode}
          {message && <div className="mt-0.5">{message}</div>}
        </div>
        <div className="shrink-0">{children}</div>
      </div>
    )
  }
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {(labelNode || labelAside) && (
        <div className="flex items-center justify-between gap-2">
          {labelNode}
          {labelAside}
        </div>
      )}
      {children}
      {message}
    </div>
  )
}
