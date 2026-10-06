import type { ReactNode } from 'react'
import { Toaster as Sonner, toast as sonnerToast, type ExternalToast } from 'sonner'
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react'
import { errorMessage } from '@/lib/api'
import { useUi } from '@/stores/ui'
import { Spinner } from './Spinner'

/** Mount once (AppShell does). Toasts are styled with the design tokens and follow the theme. */
export function Toaster() {
  const theme = useUi((s) => s.resolvedTheme)
  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      // Above the status bar (24px) and the pager / results footer bars (32px) with a 12px gap, so a
      // toast never sits on the rows-per-page select or the page arrows.
      offset={{ bottom: 68, right: 14 }}
      gap={8}
      visibleToasts={4}
      closeButton={false}
      icons={{
        success: <CheckCircle2 size={15} strokeWidth={2} className="text-success" />,
        error: <OctagonAlert size={15} strokeWidth={2} className="text-danger" />,
        warning: <AlertTriangle size={15} strokeWidth={2} className="text-warning" />,
        info: <Info size={15} strokeWidth={2} className="text-info" />,
        loading: <Spinner size={14} className="text-muted" />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'group pointer-events-auto flex w-[356px] items-start gap-2.5 rounded-lg border border-line bg-elevated px-3 py-2.5 text-fg shadow-popover',
          icon: 'mt-px flex size-4 shrink-0 items-center justify-center',
          content: 'flex min-w-0 flex-1 flex-col gap-0.5',
          title: 'text-[12.5px] font-medium leading-[18px] text-fg',
          description: 'text-xs leading-[17px] text-subtle! [overflow-wrap:anywhere]',
          actionButton:
            'ml-1 h-6 shrink-0 self-center rounded-[5px] bg-active px-2 text-xs font-medium text-fg outline-none hover:bg-line-strong focus-visible:ring-2 focus-visible:ring-focus',
          cancelButton:
            'h-6 shrink-0 self-center rounded-[5px] px-2 text-xs text-muted outline-none hover:bg-hover hover:text-fg',
        },
      }}
    />
  )
}

type ToastOptions = Pick<ExternalToast, 'description' | 'action' | 'cancel' | 'duration' | 'id'>

/**
 * Toast helpers (sonner underneath). `toast.error` accepts an unknown error and shows its message.
 * Example: toast.success('Connection saved'); toast.error('Could not connect', error)
 */
export const toast = {
  message: (title: ReactNode, options?: ToastOptions) => sonnerToast(title, options),
  info: (title: ReactNode, options?: ToastOptions) => sonnerToast.info(title, options),
  success: (title: ReactNode, options?: ToastOptions) => sonnerToast.success(title, options),
  warning: (title: ReactNode, options?: ToastOptions) => sonnerToast.warning(title, options),
  error: (title: ReactNode, error?: unknown, options?: ToastOptions) =>
    sonnerToast.error(title, {
      duration: 8000,
      ...options,
      description: options?.description ?? (error !== undefined ? errorMessage(error) : undefined),
    }),
  loading: (title: ReactNode, options?: ToastOptions) => sonnerToast.loading(title, options),
  /** Tracks a promise: loading → success/error. */
  promise: <T,>(
    promise: Promise<T>,
    messages: { loading: ReactNode; success: ReactNode | ((value: T) => ReactNode); error: ReactNode | ((error: unknown) => ReactNode) },
  ): void => {
    sonnerToast.promise(promise, messages)
  },
  dismiss: (id?: string | number) => sonnerToast.dismiss(id),
}
