// Display formatting for keyboard shortcuts.
//
// Input is an Electron-accelerator-style string ("CmdOrCtrl+Shift+Enter", "Alt+F1", "CmdOrCtrl+,").
// Strings that are already symbolic ("⌘↵", "⇧⌘N") are passed through untouched, so Command.shortcut
// may hold either form. Mac renders symbols in Apple's canonical order (⌃⌥⇧⌘), others "Ctrl+Shift+N".
import { isMac } from './platform'

type Modifier = 'ctrl' | 'alt' | 'shift' | 'meta'

const MODIFIER_ALIASES: Record<string, Modifier | 'cmdOrCtrl'> = {
  cmdorctrl: 'cmdOrCtrl',
  commandorcontrol: 'cmdOrCtrl',
  mod: 'cmdOrCtrl',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  super: 'meta',
  win: 'meta',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  altgr: 'alt',
  shift: 'shift',
}

const MAC_ORDER: Modifier[] = ['ctrl', 'alt', 'shift', 'meta']
const OTHER_ORDER: Modifier[] = ['ctrl', 'alt', 'shift', 'meta']

const MAC_MODIFIER: Record<Modifier, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' }
const OTHER_MODIFIER: Record<Modifier, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' }

/** Key names → [mac symbol, other label]. Lookup is case-insensitive. */
const KEYS: Record<string, [string, string]> = {
  enter: ['↵', 'Enter'],
  return: ['↵', 'Enter'],
  escape: ['⎋', 'Esc'],
  esc: ['⎋', 'Esc'],
  backspace: ['⌫', 'Backspace'],
  delete: ['⌦', 'Del'],
  del: ['⌦', 'Del'],
  tab: ['⇥', 'Tab'],
  space: ['Space', 'Space'],
  up: ['↑', '↑'],
  down: ['↓', '↓'],
  left: ['←', '←'],
  right: ['→', '→'],
  arrowup: ['↑', '↑'],
  arrowdown: ['↓', '↓'],
  arrowleft: ['←', '←'],
  arrowright: ['→', '→'],
  pageup: ['⇞', 'PgUp'],
  pagedown: ['⇟', 'PgDn'],
  home: ['↖', 'Home'],
  end: ['↘', 'End'],
  plus: ['+', '+'],
  minus: ['-', '-'],
}

/** Strings containing a modifier symbol are already formatted for display. */
const SYMBOLIC = /[⌘⇧⌥⌃]/

export interface ParsedShortcut {
  modifiers: Modifier[]
  key: string
}

/** Parse an accelerator; returns null for already-symbolic strings or empty input. */
export function parseAccelerator(accelerator: string, mac = isMac()): ParsedShortcut | null {
  const input = accelerator.trim()
  if (!input || SYMBOLIC.test(input)) return null
  // "CmdOrCtrl++" → the key is "+"
  const parts = input.endsWith('++') ? [...input.slice(0, -2).split('+'), '+'] : input.split('+')
  const modifiers = new Set<Modifier>()
  let key = ''
  for (const raw of parts) {
    const part = raw.trim()
    if (!part) continue
    const alias = MODIFIER_ALIASES[part.toLowerCase()]
    if (alias === 'cmdOrCtrl') modifiers.add(mac ? 'meta' : 'ctrl')
    else if (alias) modifiers.add(alias)
    else key = part
  }
  return { modifiers: [...modifiers], key }
}

function keyLabel(key: string, mac: boolean): string {
  const known = KEYS[key.toLowerCase()]
  if (known) return mac ? known[0] : known[1]
  return key.length === 1 ? key.toUpperCase() : key
}

/**
 * Tokens of a shortcut, one per keycap: mac ["⇧", "⌘", "N"], others ["Ctrl", "Shift", "N"].
 * Symbolic input ("⌘↵") is split into its characters.
 */
export function shortcutTokens(shortcut: string, mac = isMac()): string[] {
  const parsed = parseAccelerator(shortcut, mac)
  if (!parsed) return [...shortcut.trim()].filter((c) => c.trim() !== '')
  const order = mac ? MAC_ORDER : OTHER_ORDER
  const labels = mac ? MAC_MODIFIER : OTHER_MODIFIER
  const tokens = order.filter((m) => parsed.modifiers.includes(m)).map((m) => labels[m])
  if (parsed.key) tokens.push(keyLabel(parsed.key, mac))
  return tokens
}

/** Single display string: mac "⇧⌘N", others "Ctrl+Shift+N". */
export function formatShortcut(shortcut: string, mac = isMac()): string {
  const parsed = parseAccelerator(shortcut, mac)
  if (!parsed) return shortcut.trim()
  return shortcutTokens(shortcut, mac).join(mac ? '' : '+')
}

/** The accelerators of the native menu (src/main/menu.ts). Display-only; never bind them in the renderer. */
export { MENU_ACCELERATORS } from '@shared/menu-accelerators'
