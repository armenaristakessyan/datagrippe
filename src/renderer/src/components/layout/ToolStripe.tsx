// Tool window stripes on the window edges (as in JetBrains IDEs): the database explorer on the left, the query
// history on the right.
import { Database, History } from 'lucide-react'
import { IconButton } from '@/components/ui'
import { MENU_ACCELERATORS } from '@/lib/shortcuts'
import { useUi } from '@/stores/ui'

export function ToolStripe({ side }: { side: 'left' | 'right' }) {
  const sidebarVisible = useUi((s) => s.sidebarVisible)
  const toggleSidebar = useUi((s) => s.toggleSidebar)
  const historyOpen = useUi((s) => s.historyOpen)
  const setHistoryOpen = useUi((s) => s.setHistoryOpen)
  return (
    <nav aria-label={side === 'left' ? 'Tool windows' : 'Side tool windows'} className="flex w-10 shrink-0 flex-col items-center gap-1">
      {side === 'left' ? (
        <IconButton
          icon={Database}
          label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
          shortcut={MENU_ACCELERATORS['toggle-sidebar']}
          tooltipSide="right"
          size="md"
          active={sidebarVisible}
          onClick={toggleSidebar}
        />
      ) : (
        <IconButton
          icon={History}
          label="Query history"
          shortcut={MENU_ACCELERATORS['open-history']}
          tooltipSide="left"
          size="md"
          active={historyOpen}
          onClick={() => setHistoryOpen(!historyOpen)}
        />
      )}
    </nav>
  )
}
