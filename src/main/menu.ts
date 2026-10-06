// Native application menu. Its accelerators are the single source of truth for global shortcuts:
// each item sends `event:menu` {command} to the renderer, which runs the matching command.
import { Menu, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/ipc'
import { ALTERNATE_ACCELERATORS, MENU_ACCELERATORS } from '@shared/menu-accelerators'

export { MENU_ACCELERATORS }

/** Secondary accelerator for the command palette (hidden menu item). */
export const PALETTE_ALT_ACCELERATOR = ALTERNATE_ACCELERATORS['command-palette']

export interface MenuOptions {
  platform: NodeJS.Platform
  appName: string
  send: (command: MenuCommand) => void
  openUserData?: () => void
  /**
   * Show View ▸ Developer (Reload, Force reload, Toggle DevTools). Only for development builds: a reload
   * drops every console tab, and DevTools give full IPC access to anyone at the keyboard.
   */
  developerTools?: boolean
}

export function buildMenuTemplate({ platform, appName, send, openUserData, developerTools = false }: MenuOptions): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin'
  const item = (command: MenuCommand, label: string): MenuItemConstructorOptions => ({
    label,
    accelerator: (MENU_ACCELERATORS as Partial<Record<MenuCommand, string>>)[command],
    click: () => send(command),
  })
  const sep: MenuItemConstructorOptions = { type: 'separator' }
  const hidden = (command: MenuCommand, label: string, accelerator: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    visible: false,
    acceleratorWorksWhenHidden: true,
    click: () => send(command),
  })

  const appMenu: MenuItemConstructorOptions = {
    label: appName,
    submenu: [
      { role: 'about', label: `About ${appName}` },
      sep,
      item('open-settings', 'Settings…'),
      sep,
      { role: 'services' },
      sep,
      { role: 'hide', label: `Hide ${appName}` },
      { role: 'hideOthers' },
      { role: 'unhide' },
      sep,
      { role: 'quit', label: `Quit ${appName}` },
    ],
  }

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      item('new-console', 'New console'),
      item('new-connection', 'New connection…'),
      item('import-dbeaver', 'Import from DBeaver…'),
      sep,
      item('open-file', 'Open file…'),
      item('save-file', 'Save'),
      item('save-file-as', 'Save as…'),
      sep,
      item('close-tab', 'Close tab'),
      ...(mac ? [] : [sep, item('open-settings', 'Settings…'), sep, { role: 'quit' } as MenuItemConstructorOptions]),
    ],
  }

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo', accelerator: 'Shift+CmdOrCtrl+Z' },
      sep,
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(mac ? [{ role: 'pasteAndMatchStyle' } as MenuItemConstructorOptions] : []),
      { role: 'delete' },
      { role: 'selectAll' },
    ],
  }

  const queryMenu: MenuItemConstructorOptions = {
    label: 'Query',
    submenu: [
      item('run-statement', 'Run statement'),
      item('run-script', 'Run script'),
      item('cancel-query', 'Cancel query'),
      sep,
      item('format-sql', 'Format SQL'),
    ],
  }

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      item('toggle-sidebar', 'Toggle sidebar'),
      item('toggle-results', 'Toggle results'),
      sep,
      item('command-palette', 'Command palette…'),
      hidden('command-palette', 'Command palette (alternate)', PALETTE_ALT_ACCELERATOR),
      item('go-to-object', 'Go to object…'),
      item('open-history', 'Query history'),
      sep,
      item('focus-explorer', 'Focus explorer'),
      item('focus-editor', 'Focus editor'),
      item('focus-results', 'Focus results'),
      sep,
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      sep,
      { role: 'togglefullscreen' },
      ...(developerTools
        ? [
            sep,
            {
              label: 'Developer',
              submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }],
            } as MenuItemConstructorOptions,
          ]
        : []),
    ],
  }

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    role: 'window',
    submenu: [
      item('next-tab', 'Next tab'),
      item('previous-tab', 'Previous tab'),
      ...(mac
        ? [
            hidden('next-tab', 'Next tab (alternate)', ALTERNATE_ACCELERATORS['next-tab']),
            hidden('previous-tab', 'Previous tab (alternate)', ALTERNATE_ACCELERATORS['previous-tab']),
          ]
        : []),
      sep,
      { role: 'minimize' },
      { role: 'zoom' },
      ...(mac ? [sep, { role: 'front' } as MenuItemConstructorOptions] : []),
    ],
  }

  const helpMenu: MenuItemConstructorOptions = {
    label: 'Help',
    role: 'help',
    submenu: [
      { label: 'Show all commands', click: () => send('command-palette') },
      ...(openUserData ? [{ label: 'Open data folder', click: openUserData }] : []),
      ...(mac ? [] : [sep, { role: 'about', label: `About ${appName}` } as MenuItemConstructorOptions]),
    ],
  }

  return [...(mac ? [appMenu] : []), fileMenu, editMenu, queryMenu, viewMenu, windowMenu, helpMenu]
}

export function installMenu(options: MenuOptions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(options)))
}
