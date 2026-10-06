import type { DbErrorInfo } from '@shared/types'
import { cn } from '@/lib/cn'

/**
 * Body of an error Callout: message, server detail / hint, and the error code. `showPosition` false
 * hides the server's line / position, for statements the app generated (table data views): they
 * point into SQL the user never sees.
 */
export function ErrorDetail({
  error,
  showMessage = true,
  showPosition = true,
  className,
}: {
  error: DbErrorInfo
  showMessage?: boolean
  showPosition?: boolean
  className?: string
}) {
  const line = showPosition ? error.line : undefined
  const position = showPosition ? error.position : undefined
  return (
    <div className={cn('selectable space-y-1', className)}>
      {showMessage && <p className="text-fg/90">{error.message}</p>}
      {error.detail && <p className="font-mono text-[11.5px] leading-[17px] text-muted">{error.detail}</p>}
      {error.hint && (
        <p>
          <span className="text-subtle">Hint: </span>
          {error.hint}
        </p>
      )}
      {error.context && (
        <p className="font-mono text-2xs text-subtle">
          <span className="font-sans">Context: </span>
          {error.context}
        </p>
      )}
      {(error.code || line !== undefined || position !== undefined) && (
        <p className="flex flex-wrap gap-x-3 font-mono text-2xs text-subtle">
          {error.code && <span>code {error.code}</span>}
          {line !== undefined && <span>line {line}</span>}
          {position !== undefined && <span>position {position}</span>}
        </p>
      )}
    </div>
  )
}
