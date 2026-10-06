// The inline cell editor that is open right now (at most one: it holds the keyboard focus).
// Actions that read pending edits without a blur first — a native-menu accelerator such as ⌘S
// "Submit table changes" — call commitOpenCellEditor() so the text being typed is not lost.

type Committer = () => void

let open: Committer | null = null

/** Register the open editor's commit function; returns the unregister function. */
export function registerOpenCellEditor(commit: Committer): () => void {
  open = commit
  return () => {
    if (open === commit) open = null
  }
}

/** Commit the open inline editor (synchronously). Returns true when an editor was open. */
export function commitOpenCellEditor(): boolean {
  const commit = open
  if (!commit) return false
  open = null
  commit()
  return true
}
