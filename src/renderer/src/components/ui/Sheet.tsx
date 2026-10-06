import type { ReactNode } from 'react'
import { Dialog as RadixDialog, VisuallyHidden } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useReturnFocus } from '@/lib/focus'
import { overlayClass } from './Dialog'

export interface SheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  side?: 'right' | 'left'
  /** Width in px (default 440). */
  width?: number
  /** Controls in the header, left of the close button (search, filters…). */
  headerActions?: ReactNode
  footer?: ReactNode
  /** Dim the app behind the sheet (default true). */
  overlay?: boolean
  className?: string
  bodyClassName?: string
  children?: ReactNode
}

/** Side drawer (history, details). Full height below the title bar. */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  side = 'right',
  width = 440,
  headerActions,
  footer,
  overlay = true,
  className,
  bodyClassName,
  children,
}: SheetProps) {
  const returnFocus = useReturnFocus(open)
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        {overlay && <RadixDialog.Overlay className={overlayClass} />}
        <RadixDialog.Content
          onCloseAutoFocus={returnFocus}
          style={{ width }}
          className={cn(
            'fixed bottom-2 top-2 z-50 flex max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl border border-line bg-elevated text-fg shadow-dialog outline-none',
            side === 'right'
              ? 'right-2 data-[state=open]:animate-sheet-in data-[state=closed]:animate-sheet-out'
              : 'left-2 data-[state=open]:animate-sheet-in-left data-[state=closed]:animate-sheet-out-left',
            className,
          )}
        >
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2">
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className="truncate text-sm font-semibold text-fg">{title}</RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="truncate text-2xs text-subtle">{description}</RadixDialog.Description>
              ) : (
                <VisuallyHidden.Root>
                  <RadixDialog.Description>{typeof title === 'string' ? title : 'Panel'}</RadixDialog.Description>
                </VisuallyHidden.Root>
              )}
            </div>
            {headerActions}
            <RadixDialog.Close
              aria-label="Close"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-subtle outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
            >
              <X size={15} strokeWidth={1.75} />
            </RadixDialog.Close>
          </div>
          <div className={cn('min-h-0 flex-1 overflow-y-auto', bodyClassName)}>{children}</div>
          {footer && <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-2.5">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
