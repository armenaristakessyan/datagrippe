import { Explorer } from '@/components/explorer/Explorer'
import { Button, EmptyState, ErrorBoundary } from '@/components/ui'
import { markRegion } from '@/lib/recency'

export function Sidebar() {
  return (
    <aside
      aria-label="Database explorer"
      className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg bg-panel"
      onPointerDownCapture={() => markRegion('explorer')}
      onKeyDownCapture={() => markRegion('explorer')}
    >
      <div className="flex h-10 shrink-0 items-center px-3">
        <h2 className="text-sm font-semibold text-fg">Database Explorer</h2>
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
