import { useMemo, type ReactNode } from 'react'
import { RotateCcw, TriangleAlert } from 'lucide-react'
import { ConsoleView } from '@/components/editor/ConsoleView'
import { SessionsView } from '@/components/sessions/SessionsView'
import { TableDataView } from '@/components/table/TableDataView'
import { TableStructureView } from '@/components/table/TableStructureView'
import { Button, EmptyState, ErrorBoundary } from '@/components/ui'
import { useTabs, type Tab } from '@/stores/tabs'

/**
 * Console tabs stay mounted (hidden with display:none) so Monaco keeps undo history, scroll and
 * selection; table / structure / sessions tabs mount only while active.
 */
export function TabContent() {
  const tabs = useTabs((s) => s.tabs)
  const activeTabId = useTabs((s) => s.activeTabId)
  const active = tabs.find((t) => t.id === activeTabId)
  // Stable DOM order: reordering tabs must not move (and possibly reset) mounted editors.
  const consoles = useMemo(() => tabs.filter((t) => t.kind === 'console').sort((a, b) => (a.id < b.id ? -1 : 1)), [tabs])

  return (
    <div className="relative min-h-0 flex-1 bg-surface">
      {consoles.map((tab) =>
        tab.kind === 'console' ? (
          <div
            key={tab.id}
            role="tabpanel"
            aria-label={tab.title}
            className="absolute inset-0 flex flex-col"
            style={{ display: tab.id === activeTabId ? 'flex' : 'none' }}
          >
            <TabBoundary tab={tab}>
              <ConsoleView tab={tab} />
            </TabBoundary>
          </div>
        ) : null,
      )}
      {active && active.kind !== 'console' && (
        <div key={active.id} role="tabpanel" aria-label={active.title} className="absolute inset-0 flex flex-col">
          <TabBoundary tab={active}>
            {active.kind === 'sessions' ? (
              <SessionsView tab={active} />
            ) : active.kind === 'table' ? (
              <TableDataView tab={active} />
            ) : (
              <TableStructureView tab={active} />
            )}
          </TabBoundary>
        </div>
      )}
    </div>
  )
}

function TabBoundary({ tab, children }: { tab: Tab; children: ReactNode }) {
  return (
    <ErrorBoundary
      name={`tab:${tab.kind}`}
      resetKeys={[tab.id]}
      fallback={(error, reset) => (
        <EmptyState
          tone="danger"
          icon={TriangleAlert}
          title="This tab crashed"
          description={error.message || 'An unexpected error occurred while rendering this view.'}
          action={
            <>
              <Button variant="primary" leadingIcon={RotateCcw} onClick={reset}>
                Reload tab
              </Button>
              <Button variant="ghost" onClick={() => useTabs.getState().closeTab(tab.id)}>
                Close tab
              </Button>
            </>
          }
        />
      )}
    >
      {children}
    </ErrorBoundary>
  )
}
