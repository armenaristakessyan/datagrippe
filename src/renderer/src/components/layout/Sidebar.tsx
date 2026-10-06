import { Explorer } from '@/components/explorer/Explorer'
import { Button, EmptyState, ErrorBoundary } from '@/components/ui'
import { markRegion } from '@/lib/recency'

export function Sidebar() {
  return (
    <aside
      aria-label="Database explorer"
      className="flex h-full min-w-0 flex-col bg-panel"
      onPointerDownCapture={() => markRegion('explorer')}
      onKeyDownCapture={() => markRegion('explorer')}
    >
      <div className="flex h-9 shrink-0 items-center border-b border-line px-3">
        <h2 className="text-2xs font-semibold uppercase tracking-[0.08em] text-subtle">Connections</h2>
      </div>
      <div className="relative min-h-0 flex-1">
        <ErrorBoundary
          name="explorer"
          fallback={(error, reset) => (
            <EmptyState
              size="compact"
              tone="danger"
              title="Explorer crashed"
              description={error.message}
              action={
                <Button size="xs" onClick={reset}>
                  Reload
                </Button>
              }
            />
          )}
        >
          <Explorer />
        </ErrorBoundary>
      </div>
    </aside>
  )
}
