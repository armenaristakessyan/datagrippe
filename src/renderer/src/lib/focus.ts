// Where keyboard focus goes when an overlay (palette, dialog, sheet) closes.
//
// Radix returns focus to the element that was focused when its FocusScope mounted. That is often
// wrong here: an `autoFocus` input inside the overlay is already focused by then (so focus "returns"
// to a removed node and lands on <body>), and an overlay opened from the native menu or another
// overlay has no sensible trigger at all. The helpers below remember the element focused *before*
// the overlay rendered and fall back to the active console's editor, so the keyboard-first flow
// (⌘K → Esc → keep typing) never strands the caret on <body>.
import { useCallback, useRef } from 'react'
import { getEditor } from './editor-registry'
import { useTabs } from '@/stores/tabs'

/** Element focused right now, or null when nothing meaningful is (body / detached). */
function meaningfulFocus(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || active === document.body || !active.isConnected) return null
  return active
}

/** True when something other than <body> owns the focus (a new dialog, a freshly mounted editor…). */
export function focusIsOwned(): boolean {
  return meaningfulFocus() !== null
}

/** Focus the active console's editor; false when the active tab has none. */
export function focusActiveEditor(): boolean {
  const editor = getEditor(useTabs.getState().activeTabId)
  if (!editor) return false
  editor.focus()
  return true
}

function canTakeFocus(el: HTMLElement): boolean {
  if (!el.isConnected || el === document.body) return false
  // Hidden (display:none tab panels, collapsed sidebar) or inert subtrees cannot take focus.
  if (el.closest('[inert]')) return false
  return el.getClientRects().length > 0
}

/**
 * Put the focus back after an overlay closed: on `previous` when it can still take it, else on the
 * active editor. Does nothing when something else already took the focus meanwhile.
 */
export function restoreFocus(previous: Element | null | undefined): void {
  if (focusIsOwned()) return
  if (previous instanceof HTMLElement && canTakeFocus(previous)) {
    previous.focus({ preventScroll: true })
    if (document.activeElement === previous) return
  }
  focusActiveEditor()
}

/**
 * After an action ran (palette entry, dialog answer): if it left the focus on <body>, give it to the
 * active editor. Waits a frame so targets that mount (a new tab's editor, a dialog) can claim it.
 */
export function focusWorkspaceSoon(): void {
  requestAnimationFrame(() => {
    if (!focusIsOwned()) focusActiveEditor()
  })
}

/**
 * Remember what had the focus when `open` turns true — captured during render, i.e. before any
 * `autoFocus` inside the overlay runs — and return an `onCloseAutoFocus` handler that restores it.
 * Pass `skip` to leave the focus alone for one close (an action moved it somewhere on purpose).
 */
export function useReturnFocus(open: boolean): (event: Event, skip?: boolean) => void {
  const previous = useRef<Element | null>(null)
  const wasOpen = useRef(false)
  if (open && !wasOpen.current && typeof document !== 'undefined') previous.current = document.activeElement
  wasOpen.current = open
  return useCallback((event: Event, skip?: boolean) => {
    event.preventDefault()
    const target = previous.current
    previous.current = null
    if (skip) {
      focusWorkspaceSoon()
      return
    }
    restoreFocus(target)
  }, [])
}

// ---------------------------------------------------------------------------
// Moving between the regions of the window (palette commands "Focus editor / results / explorer")
// ---------------------------------------------------------------------------

function firstVisible<T extends HTMLElement>(root: ParentNode, selector: string): T | undefined {
  for (const el of root.querySelectorAll<T>(selector)) if (el.getClientRects().length > 0 && !el.closest('[inert]')) return el
  return undefined
}

/** The results of the active tab: its data grid, else the plan tree, else the results tab strip. */
export function focusResults(): boolean {
  const main = document.querySelector('main') ?? document
  const target =
    firstVisible(main, 'section[aria-label="Results"] [role="grid"][tabindex]') ??
    firstVisible(main, '[role="grid"][tabindex]') ??
    firstVisible(main, '[role="tree"][aria-label="Query plan"]') ??
    firstVisible(main, 'section[aria-label="Results"] [role="tab"][aria-selected="true"]') ??
    firstVisible(main, 'section[aria-label="Results"] [tabindex="0"]')
  if (!target) return false
  target.focus()
  return document.activeElement === target || target.contains(document.activeElement)
}

/** The explorer tree (selecting its first row when nothing is selected), else its empty-state action. */
export function focusExplorerTree(selectFirst: (rowId: string) => void, hasSelection: boolean): boolean {
  const tree = firstVisible(document, '[role="tree"][aria-label="Database explorer"]')
  if (tree) {
    if (!hasSelection) {
      const first = tree.querySelector<HTMLElement>('[role="treeitem"][data-row-id]')
      const id = first?.dataset.rowId
      if (id) selectFirst(id)
    }
    tree.focus()
    return true
  }
  const action = firstVisible(document, 'aside[aria-label="Database explorer"] button')
  action?.focus()
  return action !== undefined
}

/**
 * Close the topmost open overlay (dialog, sheet, palette, menu) the way Escape would, so each one
 * runs its own close logic (unsaved-changes guards included). False when none is open.
 */
export function closeTopmostOverlay(): boolean {
  if (typeof document === 'undefined') return false
  const open = [
    ...document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]'),
  ]
  const top = open[open.length - 1]
  if (!top) return false
  const active = document.activeElement
  const source = active instanceof HTMLElement && top.contains(active) ? active : top
  source.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
  return true
}
