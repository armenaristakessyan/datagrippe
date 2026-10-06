import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/ipc'

vi.mock('electron', () => ({ Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() } }))

const { buildMenuTemplate, MENU_ACCELERATORS, PALETTE_ALT_ACCELERATOR } = await import('./menu')

const ALL_COMMANDS = Object.keys(MENU_ACCELERATORS) as MenuCommand[]

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])])
}

function clickAll(): MenuCommand[] {
  const sent: MenuCommand[] = []
  const template = buildMenuTemplate({ platform: 'darwin', appName: 'DataGrippe', send: (c) => sent.push(c) })
  for (const item of flatten(template)) {
    if (item.click) (item.click as () => void)()
  }
  return sent
}

describe('menu', () => {
  it('sends every menu command', () => {
    const sent = new Set(clickAll())
    for (const command of ALL_COMMANDS) expect(sent.has(command)).toBe(true)
    expect(ALL_COMMANDS).toHaveLength(21)
    // Commands without a shortcut are menu items too.
    expect(sent.has('import-dbeaver')).toBe(true)
  })

  it('binds each accelerator once (plus the hidden palette alternate)', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const items = flatten(buildMenuTemplate({ platform, appName: 'DataGrippe', send: () => undefined }))
      const accelerators = items.map((i) => i.accelerator).filter((a): a is string => typeof a === 'string')
      expect(new Set(accelerators).size).toBe(accelerators.length)
      for (const accel of Object.values(MENU_ACCELERATORS)) expect(accelerators).toContain(accel)
      const alt = items.find((i) => i.accelerator === PALETTE_ALT_ACCELERATOR)
      expect(alt?.visible).toBe(false)
    }
    expect(MENU_ACCELERATORS['run-statement']).toBe('CmdOrCtrl+Enter')
    expect(MENU_ACCELERATORS['command-palette']).toBe('CmdOrCtrl+K')
  })

  it('has the macOS app menu and standard edit roles', () => {
    const mac = buildMenuTemplate({ platform: 'darwin', appName: 'DataGrippe', send: () => undefined, developerTools: true })
    expect(mac.map((m) => m.label)).toEqual(['DataGrippe', 'File', 'Edit', 'Query', 'View', 'Window', 'Help'])
    const roles = flatten(mac).map((i) => i.role)
    for (const role of ['about', 'services', 'hide', 'quit', 'undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll', 'togglefullscreen', 'toggleDevTools', 'zoomIn']) {
      expect(roles).toContain(role)
    }
    const win = buildMenuTemplate({ platform: 'win32', appName: 'DataGrippe', send: () => undefined })
    expect(win.map((m) => m.label)).toEqual(['File', 'Edit', 'Query', 'View', 'Window', 'Help'])
  })

  it('ships the Developer menu (reload, DevTools) only in development builds', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const roles = flatten(buildMenuTemplate({ platform, appName: 'DataGrippe', send: () => undefined })).map((i) => i.role)
      for (const role of ['reload', 'forceReload', 'toggleDevTools']) expect(roles).not.toContain(role)
      const labels = flatten(buildMenuTemplate({ platform, appName: 'DataGrippe', send: () => undefined })).map((i) => i.label)
      expect(labels).not.toContain('Developer')
    }
  })
})
