import { describe, expect, it } from 'vitest'
import { formatShortcut, parseAccelerator, shortcutTokens } from './shortcuts'

describe('shortcutTokens', () => {
  it('renders mac symbols in canonical order', () => {
    expect(shortcutTokens('CmdOrCtrl+Shift+Enter', true)).toEqual(['⇧', '⌘', '↵'])
    expect(shortcutTokens('Shift+CmdOrCtrl+N', true)).toEqual(['⇧', '⌘', 'N'])
    expect(shortcutTokens('Ctrl+Alt+Shift+Cmd+K', true)).toEqual(['⌃', '⌥', '⇧', '⌘', 'K'])
    expect(shortcutTokens('CmdOrCtrl+,', true)).toEqual(['⌘', ','])
    expect(shortcutTokens('Escape', true)).toEqual(['⎋'])
  })
  it('renders words elsewhere', () => {
    expect(shortcutTokens('CmdOrCtrl+Shift+Enter', false)).toEqual(['Ctrl', 'Shift', 'Enter'])
    expect(shortcutTokens('Alt+F1', false)).toEqual(['Alt', 'F1'])
    expect(shortcutTokens('CommandOrControl+PageDown', false)).toEqual(['Ctrl', 'PgDn'])
  })
  it('handles the plus key', () => {
    expect(shortcutTokens('CmdOrCtrl++', true)).toEqual(['⌘', '+'])
    expect(shortcutTokens('CmdOrCtrl+Plus', false)).toEqual(['Ctrl', '+'])
  })
  it('passes symbolic strings through', () => {
    expect(shortcutTokens('⌘↵', false)).toEqual(['⌘', '↵'])
    expect(parseAccelerator('⇧⌘N')).toBeNull()
  })
})

describe('formatShortcut', () => {
  it('joins tokens per platform', () => {
    expect(formatShortcut('CmdOrCtrl+Shift+N', true)).toBe('⇧⌘N')
    expect(formatShortcut('CmdOrCtrl+Shift+N', false)).toBe('Ctrl+Shift+N')
    expect(formatShortcut('CmdOrCtrl+k', false)).toBe('Ctrl+K')
    expect(formatShortcut('⌘↵', false)).toBe('⌘↵')
    expect(formatShortcut('', true)).toBe('')
  })
})
