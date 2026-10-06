// Root: bootstraps settings, connections and the workspace, applies the theme, wires main-process
// events, and renders the AppShell inside a top-level error boundary.
import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import { Copy, PlugZap, RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react'
import type { DbErrorInfo } from '@shared/types'
import { AppMark } from '@/components/layout/AppMark'
import { AppShell } from '@/components/layout/AppShell'
import { bindConsoleGuards } from '@/components/layout/console-guards'
import { DialogHost } from '@/components/layout/DialogHost'
import { bindUnsavedWorkReport } from '@/components/table/unsaved-work'
import { Button, CodeBlock, ErrorBoundary, Spinner, toast, Toaster, TooltipProvider } from '@/components/ui'
import { errorInfo, onEvent } from '@/lib/api'
import { runCommand } from '@/lib/commands'
import { flushAllEditors } from '@/lib/editor-registry'
import { closeTopmostOverlay } from '@/lib/focus'
import { hasBridge } from '@/lib/platform'
import { bindTheme } from '@/lib/theme'
import { bindConnectionEvents, useConnections } from '@/stores/connections'
import { bindConsoleEvents } from '@/stores/consoles'
import { useSettings } from '@/stores/settings'
import { flushWorkspace, useTabs } from '@/stores/tabs'

// Living style guide of the UI kit, shown instead of the shell when the URL hash is #ui-gallery.
const Gallery = lazy(() => import('@/components/ui/Gallery').then((m) => ({ default: m.Gallery })))

function useGalleryHash(): boolean {
  const [on, setOn] = useState(() => window.location.hash === '#ui-gallery')
  useEffect(() => {
    const update = () => setOn(window.location.hash === '#ui-gallery')
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  return on
}

type BootState = { phase: 'loading' } | { phase: 'ready' } | { phase: 'error'; error: DbErrorInfo }

const STEPS = [
  { label: 'settings', run: () => useSettings.getState().load() },
  { label: 'connections', run: () => useConnections.getState().load() },
  { label: 'workspace', run: () => useTabs.getState().hydrate() },
] as const

async function bootstrap(): Promise<BootState> {
  if (!hasBridge()) {
    return { phase: 'error', error: { message: 'The preload bridge is not available.', kind: 'internal' } }
  }
  const results = await Promise.allSettled(STEPS.map((s) => s.run()))
  const failures = results.flatMap((r, i) => (r.status === 'rejected' ? [{ step: STEPS[i]!.label, error: errorInfo(r.reason) }] : []))
  if (failures.length === STEPS.length) {
    const first = failures[0]!.error
    return { phase: 'error', error: { ...first, detail: failures.map((f) => `${f.step}: ${f.error.message}`).join('\n') } }
  }
  // Partial failure: keep going with defaults and say what is missing.
  for (const f of failures) toast.warning(`Could not load ${f.step}`, { description: f.error.message })
  return { phase: 'ready' }
}

export function App() {
  return (
    <TooltipProvider>
      <ErrorBoundary name="root" fallback={(error, reset) => <CrashScreen error={error} onReset={reset} />}>
        <Bootstrap />
      </ErrorBoundary>
      <Toaster />
    </TooltipProvider>
  )
}

/** Write the last keystrokes and the workspace before the window closes or reloads. */
function bindUnloadFlush(): () => void {
  const flush = () => {
    flushAllEditors()
    flushWorkspace()
  }
  window.addEventListener('beforeunload', flush)
  window.addEventListener('pagehide', flush)
  return () => {
    window.removeEventListener('beforeunload', flush)
    window.removeEventListener('pagehide', flush)
  }
}

function Bootstrap() {
  const [state, setState] = useState<BootState>({ phase: 'loading' })
  const gallery = useGalleryHash()

  const start = useCallback(() => {
    setState({ phase: 'loading' })
    void bootstrap().then(setState)
  }, [])

  useEffect(() => bindTheme(), [])
  useEffect(start, [start])

  useEffect(() => {
    if (state.phase !== 'ready') return
    const offs = [
      bindConnectionEvents(),
      bindConsoleEvents(),
      bindConsoleGuards(),
      bindUnloadFlush(),
      bindUnsavedWorkReport(),
      onEvent('event:menu', ({ command }) => {
        // ⌘W closes an open dialog / sheet / menu first (even with no tab open), like any window.
        if (command === 'close-tab' && closeTopmostOverlay()) return
        runCommand(command)
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [state.phase])

  if (state.phase === 'loading') return <BootScreen />
  if (state.phase === 'error') return <UnreachableScreen error={state.error} onRetry={start} />
  if (gallery) {
    return (
      <Suspense fallback={<BootScreen />}>
        <Gallery />
        <DialogHost />
      </Suspense>
    )
  }
  return <AppShell />
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="drag-region flex h-full flex-col items-center justify-center bg-app p-8">
      <div className="no-drag flex w-full max-w-md flex-col items-center text-center">{children}</div>
    </div>
  )
}

function BootScreen() {
  // Only show the splash when start-up is slow, to avoid a flash.
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 250)
    return () => clearTimeout(t)
  }, [])
  return (
    <Centered>
      <div className={visible ? 'flex animate-fade-in flex-col items-center gap-4' : 'invisible'}>
        <AppMark size={40} />
        <div className="flex items-center gap-2 text-xs text-subtle">
          <Spinner size={12} />
          Loading workspace…
        </div>
      </div>
    </Centered>
  )
}

function UnreachableScreen({ error, onRetry }: { error: DbErrorInfo; onRetry: () => void }) {
  return (
    <Centered>
      <span className="flex size-11 items-center justify-center rounded-xl border border-line bg-panel text-subtle shadow-inset">
        <PlugZap size={20} strokeWidth={1.75} />
      </span>
      <h1 className="mt-4 text-[15px] font-semibold text-fg">Can't reach the DataGrippe core</h1>
      <p className="mt-1 text-xs leading-[18px] text-subtle">
        The window started but the main process did not answer. Your connections and workspace are untouched.
      </p>
      <div className="mt-4 w-full text-left">
        <CodeBlock language="text" code={error.detail ?? error.message} maxHeight={160} />
      </div>
      <div className="mt-5 flex gap-2">
        <Button variant="primary" leadingIcon={RefreshCw} onClick={onRetry}>
          Retry
        </Button>
        <Button variant="ghost" onClick={() => window.location.reload()}>
          Reload window
        </Button>
      </div>
    </Centered>
  )
}

function CrashScreen({ error, onReset }: { error: Error; onReset: () => void }) {
  const details = `${error.name}: ${error.message}${error.stack ? `\n\n${error.stack}` : ''}`
  return (
    <Centered>
      <span className="flex size-11 items-center justify-center rounded-xl border border-danger/25 bg-danger-soft text-danger">
        <TriangleAlert size={20} strokeWidth={1.75} />
      </span>
      <h1 className="mt-4 text-[15px] font-semibold text-fg">Something went wrong</h1>
      <p className="mt-1 text-xs leading-[18px] text-subtle">
        The interface hit an unexpected error. Open consoles are saved; reloading usually fixes it.
      </p>
      <div className="mt-4 w-full text-left">
        <CodeBlock language="text" code={details} maxHeight={200} wrap={false} copyable={false} />
      </div>
      <div className="mt-5 flex gap-2">
        <Button variant="primary" leadingIcon={RotateCcw} onClick={() => window.location.reload()}>
          Reload window
        </Button>
        <Button variant="secondary" onClick={onReset}>
          Try again
        </Button>
        <Button
          variant="ghost"
          leadingIcon={Copy}
          onClick={() => void navigator.clipboard.writeText(details).catch(() => undefined)}
        >
          Copy details
        </Button>
      </div>
    </Centered>
  )
}
