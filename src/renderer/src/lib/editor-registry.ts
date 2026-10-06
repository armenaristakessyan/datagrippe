// Live handles to mounted SQL editors, keyed by console tab id. Lets commands (menu, palette,
// toolbar buttons) act on the active editor without prop drilling.

export interface EditorSqlSlice {
  sql: string
  /** Offset of `sql` inside the full editor text. */
  offset: number
}

export interface EditorHandle {
  getText: () => string
  /** Selected text, or null when the selection is empty. */
  getSelection: () => EditorSqlSlice | null
  /** Statement under the caret (see statementAtOffset in @shared/sql). */
  getStatementAtCursor: () => EditorSqlSlice | null
  /** Selection if any, otherwise the statement at cursor. */
  getRunTarget: () => EditorSqlSlice | null
  setText: (text: string) => void
  insertText: (text: string) => void
  /** Insert a Monaco snippet ($1 / ${1:default} / $0 tab stops) at the caret, replacing the selection. */
  insertSnippet: (body: string) => void
  format: () => void
  focus: () => void
  /** Close Monaco's transient widgets (suggest list) — e.g. before a run triggered from the menu. */
  hideWidgets: () => void
  /** Write pending (debounced) text to the tab store now. */
  flush: () => void
  /** Highlight a range (offsets into the full text), e.g. an error position. */
  markError: (start: number, end: number, message: string) => void
  clearMarkers: () => void
  /** Briefly highlight a range (offsets into the full text), e.g. the SQL that was just executed. */
  flash: (start: number, end: number) => void
}

const editors = new Map<string, EditorHandle>()

export function registerEditor(tabId: string, handle: EditorHandle): () => void {
  editors.set(tabId, handle)
  return () => {
    if (editors.get(tabId) === handle) editors.delete(tabId)
  }
}

/** Write the pending text of every mounted editor to the tabs store (before the window unloads). */
export function flushAllEditors(): void {
  for (const handle of editors.values()) {
    try {
      handle.flush()
    } catch {
      // a disposed editor has nothing pending
    }
  }
}

export function getEditor(tabId: string | null | undefined): EditorHandle | undefined {
  return tabId ? editors.get(tabId) : undefined
}
