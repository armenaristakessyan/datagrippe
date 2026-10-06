// restoreFocus with a minimal fake DOM (the unit project runs in node).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ api: { workspace: { save: vi.fn(), load: vi.fn() } } }))

class FakeElement {
  isConnected = true
  hidden = false
  inert = false
  focus() {
    if (this.isConnected && !this.hidden) fakeDocument.activeElement = this
  }
  getClientRects() {
    return this.hidden ? [] : [{}]
  }
  closest(selector: string) {
    return selector === '[inert]' && this.inert ? this : null
  }
}
const body = new FakeElement()
const fakeDocument: { body: FakeElement; activeElement: FakeElement | null } = { body, activeElement: body }
const globals = globalThis as Record<string, unknown>
globals.HTMLElement = FakeElement
globals.document = fakeDocument

const { focusIsOwned, restoreFocus } = await import('./focus')
const { registerEditor } = await import('./editor-registry')
const { useTabs } = await import('@/stores/tabs')

const editorFocus = vi.fn()
registerEditor('tab-1', { focus: editorFocus } as never)

beforeEach(() => {
  fakeDocument.activeElement = body
  editorFocus.mockClear()
  useTabs.setState({ tabs: [], activeTabId: 'tab-1' })
})
afterAll(() => {
  delete globals.HTMLElement
  delete globals.document
})

describe('restoreFocus', () => {
  it('returns the focus to the element focused before the overlay opened', () => {
    const button = new FakeElement()
    restoreFocus(button as unknown as Element)
    expect(fakeDocument.activeElement).toBe(button)
    expect(editorFocus).not.toHaveBeenCalled()
  })

  it('falls back to the active editor when that element is gone, hidden or inert', () => {
    for (const patch of [{ isConnected: false }, { hidden: true }, { inert: true }]) {
      fakeDocument.activeElement = body
      restoreFocus(Object.assign(new FakeElement(), patch) as unknown as Element)
    }
    restoreFocus(null)
    expect(editorFocus).toHaveBeenCalledTimes(4)
  })

  it('does nothing when something else already took the focus (a new dialog, a new tab)', () => {
    const dialog = new FakeElement()
    fakeDocument.activeElement = dialog
    expect(focusIsOwned()).toBe(true)
    restoreFocus(new FakeElement() as unknown as Element)
    expect(fakeDocument.activeElement).toBe(dialog)
    expect(editorFocus).not.toHaveBeenCalled()
  })
})
