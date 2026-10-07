import { Search, Settings2 } from 'lucide-react'
import { IconButton } from '@/components/ui'
import { isMac } from '@/lib/platform'
import { MENU_ACCELERATORS } from '@/lib/shortcuts'
import { useUi } from '@/stores/ui'

/** Width reserved for the macOS traffic lights (hiddenInset title bar). */
const MAC_TRAFFIC_LIGHTS = 78

export function TitleBar() {
  const mac = isMac()
  const openPalette = useUi((s) => s.openPalette)
  const setSettingsOpen = useUi((s) => s.setSettingsOpen)

  return (
    // The bar drags the window. Every descendant inherits `drag` and adds its own box to the drag area, in tree
    // order: a box spanning the bar placed after a no-drag control would make that control drag the window instead
    // of taking clicks. Keep each child to its own box.
    <header className="drag-region relative flex h-10 shrink-0 items-center bg-app pr-2" style={{ paddingLeft: mac ? MAC_TRAFFIC_LIGHTS : 8 }}>
      <div className="no-drag relative ml-auto flex items-center gap-0.5">
        <IconButton icon={Search} label="Search or run a command…" shortcut={MENU_ACCELERATORS['command-palette']} onClick={() => openPalette('commands')} />
        <IconButton icon={Settings2} label="Settings" shortcut={MENU_ACCELERATORS['open-settings']} onClick={() => setSettingsOpen(true)} />
      </div>
    </header>
  )
}
