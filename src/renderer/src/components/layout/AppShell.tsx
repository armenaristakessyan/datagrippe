// Window chrome: title bar, resizable sidebar + tabbed main area, status bar, global overlays.
// (<Toaster/> is mounted by App so boot-time toasts are not lost.)
import { useEffect, useRef } from 'react'
import { CommandPalette } from '@/components/palette/CommandPalette'
import { ConnectionDialog } from '@/components/connections/ConnectionDialog'
import { HistoryPanel } from '@/components/history/HistoryPanel'
import { DbeaverImportDialog } from '@/components/import/DbeaverImportDialog'
import { ImportCsvDialog } from '@/components/table/ImportCsvDialog'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { VaultLoginOverlay } from '@/components/vault/VaultLoginOverlay'
import { SplitGroup, SplitHandle, SplitPanel, usePanelRef } from '@/components/ui'
import { markRegion } from '@/lib/recency'
import { useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { DialogHost } from './DialogHost'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { TabBar } from './TabBar'
import { TabContent } from './TabContent'
import { TitleBar } from './TitleBar'
import { useGlobalCommands } from './useGlobalCommands'
import { WelcomeScreen } from './WelcomeScreen'

export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 480
export const SIDEBAR_DEFAULT = 272

function initialSidebarWidth(): number {
  const stored = useTabs.getState().layout.sidebarWidth
  return typeof stored === 'number' && Number.isFinite(stored)
    ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(stored)))
    : SIDEBAR_DEFAULT
}

export function AppShell() {
  useGlobalCommands()
  const sidebarVisible = useUi((s) => s.sidebarVisible)
  const panel = usePanelRef()
  const width = useRef(initialSidebarWidth())
  const defaultWidth = useRef(width.current)

  // Restore the persisted visibility once, then mirror changes into the workspace layout.
  useEffect(() => {
    const stored = useTabs.getState().layout.sidebarVisible
    if (stored === false) useUi.getState().setSidebarVisible(false)
    return useUi.subscribe((state, prev) => {
      if (state.sidebarVisible !== prev.sidebarVisible) useTabs.getState().setLayout('sidebarVisible', state.sidebarVisible)
    })
  }, [])

  // ui.sidebarVisible drives the collapsible panel.
  useEffect(() => {
    const handle = panel.current
    if (!handle) return
    if (sidebarVisible && handle.isCollapsed()) handle.expand()
    if (!sidebarVisible && !handle.isCollapsed()) handle.collapse()
  }, [sidebarVisible, panel])

  return (
    <div className="flex h-full flex-col bg-app text-fg">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <SplitGroup
          orientation="horizontal"
          onLayoutChanged={(_layout, meta) => {
            if (meta.isUserInteraction && !panel.current?.isCollapsed()) {
              useTabs.getState().setLayout('sidebarWidth', Math.round(width.current))
            }
          }}
        >
          <SplitPanel
            id="sidebar"
            panelRef={panel}
            defaultSize={defaultWidth.current}
            minSize={SIDEBAR_MIN}
            maxSize={SIDEBAR_MAX}
            collapsible
            collapsedSize={0}
            groupResizeBehavior="preserve-pixel-size"
            onResize={(size) => {
              const collapsed = size.inPixels < 1
              if (!collapsed) width.current = size.inPixels
              const visible = useUi.getState().sidebarVisible
              if (collapsed === visible) useUi.getState().setSidebarVisible(!collapsed)
            }}
          >
            <Sidebar />
          </SplitPanel>
          <SplitHandle direction="vertical" />
          <SplitPanel id="main" minSize={420}>
            <Main />
          </SplitPanel>
        </SplitGroup>
      </div>
      <StatusBar />

      <ConnectionDialog />
      <CommandPalette />
      <SettingsDialog />
      <HistoryPanel />
      <DbeaverImportDialog />
      <VaultLoginOverlay />
      <ImportCsvDialog />
      <DialogHost />
    </div>
  )
}

function Main() {
  const hasTabs = useTabs((s) => s.tabs.length > 0)
  return (
    <main
      className="flex h-full min-w-0 flex-col bg-surface"
      // Working in a tab makes its connection the target of the next "New console".
      onPointerDownCapture={() => markRegion('workspace')}
      onKeyDownCapture={() => markRegion('workspace')}
    >
      {hasTabs ? (
        <>
          <TabBar />
          <TabContent />
        </>
      ) : (
        <WelcomeScreen />
      )}
    </main>
  )
}
