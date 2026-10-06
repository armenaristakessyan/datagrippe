import type { ComponentProps, ReactNode } from 'react'
import { Dialog as RadixDialog, VisuallyHidden } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useReturnFocus } from '@/lib/focus'
import { renderIcon, type IconLike } from './icon'

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl'

const widths: Record<DialogSize, string> = {
  sm: 'w-[400px]',
  md: 'w-[520px]',
  lg: 'w-[680px]',
  xl: 'w-[880px]',
}

export const overlayClass = 'fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out'

export interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  /** Small icon tile left of the title. */
  icon?: IconLike
  /** Tone of the icon tile. */
  tone?: 'neutral' | 'accent' | 'danger' | 'warning'
  size?: DialogSize
  /** Footer row (buttons are right-aligned; put secondary content first). */
  footer?: ReactNode
  /** Remove the body padding (full-bleed lists, editors). */
  flush?: boolean
  hideClose?: boolean
  /** Prevent closing on outside click (forms with unsaved input). */
  modalLock?: boolean
  onOpenAutoFocus?: (event: Event) => void
  /**
   * Replaces the default close focus handling, which returns the focus to the element focused before
   * the dialog opened (or to the active editor when that element is gone).
   */
  onCloseAutoFocus?: (event: Event) => void
  className?: string
  bodyClassName?: string
  children?: ReactNode
}

const toneClass = {
  neutral: 'bg-hover text-muted',
  accent: 'bg-accent-soft text-accent',
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning',
}

/** Modal dialog: header (icon, title, description, close), scrollable body, footer. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  icon,
  tone = 'neutral',
  size = 'md',
  footer,
  flush,
  hideClose,
  modalLock,
  onOpenAutoFocus,
  onCloseAutoFocus,
  className,
  bodyClassName,
  children,
}: DialogProps) {
  const returnFocus = useReturnFocus(open)
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={overlayClass} />
        <div className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center overflow-hidden p-6 pt-[12vh]">
          <RadixDialog.Content
            onOpenAutoFocus={onOpenAutoFocus}
            onCloseAutoFocus={onCloseAutoFocus ?? returnFocus}
            onPointerDownOutside={modalLock ? (e) => e.preventDefault() : undefined}
            className={cn(
              'pointer-events-auto flex max-h-[80vh] max-w-full flex-col overflow-hidden rounded-xl border border-line bg-elevated text-fg shadow-dialog outline-none',
              'data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out',
              widths[size],
              className,
            )}
          >
            <div className="flex shrink-0 items-start gap-3 px-5 pb-1 pt-4">
              {icon && (
                <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg', toneClass[tone])}>
                  {renderIcon(icon, 16)}
                </span>
              )}
              <div className="min-w-0 flex-1 pt-0.5">
                <RadixDialog.Title className="text-[15px] font-semibold leading-6 tracking-[-0.01em] text-fg">{title}</RadixDialog.Title>
                {description ? (
                  <RadixDialog.Description className="mt-0.5 text-xs leading-[18px] text-subtle">{description}</RadixDialog.Description>
                ) : (
                  <VisuallyHidden.Root>
                    <RadixDialog.Description>{typeof title === 'string' ? title : 'Dialog'}</RadixDialog.Description>
                  </VisuallyHidden.Root>
                )}
              </div>
              {!hideClose && (
                <RadixDialog.Close
                  aria-label="Close"
                  className="-mr-2 -mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-subtle outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <X size={15} strokeWidth={1.75} />
                </RadixDialog.Close>
              )}
            </div>
            <div className={cn('min-h-0 flex-1 overflow-y-auto', flush ? 'mt-3' : 'px-5 pb-5 pt-3', bodyClassName)}>{children}</div>
            {footer && <DialogFooter>{footer}</DialogFooter>}
          </RadixDialog.Content>
        </div>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/** Footer bar; also usable standalone inside custom dialog layouts. */
export function DialogFooter({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('flex shrink-0 items-center justify-end gap-2 border-t border-line bg-panel/60 px-5 py-3', className)}>
      {children}
    </div>
  )
}

export const DialogClose = RadixDialog.Close
export type DialogCloseProps = ComponentProps<typeof RadixDialog.Close>
