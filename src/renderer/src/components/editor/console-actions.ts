// Console actions shared by the toolbar, the command registry and Monaco keybindings.
import { toast } from '@/components/ui'
import { getEditor } from '@/lib/editor-registry'
import { useConsoles } from '@/stores/consoles'
import { createTriggerGuard } from './run-guard'

/** Per-tab handle on the results panel (registered by ConsoleView). */
export interface ResultsController {
  toggle: () => void
  expand: () => void
}

const resultsControllers = new Map<string, ResultsController>()

export function registerResultsController(tabId: string, controller: ResultsController): () => void {
  resultsControllers.set(tabId, controller)
  return () => {
    if (resultsControllers.get(tabId) === controller) resultsControllers.delete(tabId)
  }
}

export function toggleResults(tabId: string): void {
  resultsControllers.get(tabId)?.toggle()
}

const runGuard = createTriggerGuard(150)

export type RunMode = 'statement' | 'script'

function nothingToRun(): void {
  toast.info('Nothing to run', { description: 'Place the caret in a statement or select the SQL to run.' })
}

/** Run the statement at the caret (or the selection), or the whole script. Ignores repeats within 150 ms. */
export function runConsole(tabId: string, mode: RunMode): void {
  if (!runGuard.accept(`${tabId}:run`)) return
  const runtime = useConsoles.getState().runtime(tabId)
  if (runtime.status === 'running') return
  const editor = getEditor(tabId)
  if (!editor) return
  const target =
    mode === 'statement'
      ? editor.getRunTarget()
      : (editor.getSelection() ?? { sql: editor.getText(), offset: 0 })
  if (!target || !target.sql.trim()) {
    nothingToRun()
    return
  }
  editor.hideWidgets()
  editor.clearMarkers()
  editor.flash(target.offset, target.offset + target.sql.length)
  resultsControllers.get(tabId)?.expand()
  void useConsoles.getState().execute(tabId, target.sql, target.offset)
}

export function explainConsole(tabId: string, analyze: boolean): void {
  if (!runGuard.accept(`${tabId}:explain`)) return
  const editor = getEditor(tabId)
  if (!editor) return
  const target = editor.getRunTarget()
  if (!target || !target.sql.trim()) {
    nothingToRun()
    return
  }
  editor.hideWidgets()
  editor.clearMarkers()
  editor.flash(target.offset, target.offset + target.sql.length)
  resultsControllers.get(tabId)?.expand()
  void useConsoles.getState().explain(tabId, target.sql, analyze)
}

export function formatConsole(tabId: string): void {
  getEditor(tabId)?.format()
}
