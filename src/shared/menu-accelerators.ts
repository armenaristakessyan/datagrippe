// Accelerators of the native menu (src/main/menu.ts), the single source of truth for global
// shortcuts. The renderer imports them for display only and never binds the same keys.
import type { MenuCommand } from './ipc'

/** Menu commands without a keyboard shortcut. */
export type UnacceleratedMenuCommand = 'import-dbeaver' | 'import-datagrip'

export const MENU_ACCELERATORS: Record<Exclude<MenuCommand, UnacceleratedMenuCommand>, string> = {
  'new-console': 'CmdOrCtrl+T',
  'new-connection': 'CmdOrCtrl+Shift+N',
  'open-file': 'CmdOrCtrl+O',
  'save-file': 'CmdOrCtrl+S',
  'save-file-as': 'CmdOrCtrl+Shift+S',
  'close-tab': 'CmdOrCtrl+W',
  'next-tab': 'Ctrl+Tab',
  'previous-tab': 'Ctrl+Shift+Tab',
  'run-statement': 'CmdOrCtrl+Enter',
  'run-script': 'CmdOrCtrl+Shift+Enter',
  'cancel-query': 'CmdOrCtrl+.',
  'format-sql': 'CmdOrCtrl+Alt+L',
  'command-palette': 'CmdOrCtrl+K',
  'go-to-object': 'CmdOrCtrl+P',
  'toggle-sidebar': 'CmdOrCtrl+B',
  'toggle-results': 'CmdOrCtrl+J',
  'open-settings': 'CmdOrCtrl+,',
  'open-history': 'CmdOrCtrl+Y',
  'focus-explorer': 'CmdOrCtrl+1',
  'focus-editor': 'CmdOrCtrl+2',
  'focus-results': 'CmdOrCtrl+3',
}

/** Hidden alternates (menu items with visible: false). */
export const ALTERNATE_ACCELERATORS = {
  'command-palette': 'CmdOrCtrl+Shift+P',
  /** macOS browser-style tab cycling. */
  'next-tab': 'Cmd+Shift+]',
  'previous-tab': 'Cmd+Shift+[',
} as const satisfies Partial<Record<MenuCommand, string>>
