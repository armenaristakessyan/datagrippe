// Console commands (palette + native menu targets). They act on the ACTIVE console tab. Query commands
// are registered while at least one console is mounted; file commands always (Open works without tabs).
import {
  BookmarkPlus,
  CircleStop,
  Eraser,
  FileInput,
  GitCommitHorizontal,
  ListTree,
  Gauge,
  PanelBottom,
  Play,
  RefreshCw,
  Save,
  ScrollText,
  TextQuote,
  ToggleLeft,
  Undo2,
  WandSparkles,
} from 'lucide-react'
import { pickConsoleConnection } from '@/components/layout/useGlobalCommands'
import { toast } from '@/components/ui'
import { api, errorInfo } from '@/lib/api'
import { registerCommands, runCommand, type Command } from '@/lib/commands'
import { getEditor } from '@/lib/editor-registry'
import { literalSnippetBody } from '@/lib/monaco/snippets'
import { MENU_ACCELERATORS } from '@/lib/shortcuts'
import { useCatalog } from '@/stores/catalog'
import { displayedAutoCommit, useConsoles, wantsManualCommit } from '@/stores/consoles'
import { defaultDatabase } from '@/stores/explorer'
import { activeTab, useTabs, type ConsoleTab } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { explainConsole, formatConsole, runConsole, toggleResults } from './console-actions'
import { fileBaseName, suggestedFileName } from './console-utils'

/** Accelerators of the native menu (src/main/menu.ts), for display. */
export const CONSOLE_SHORTCUTS = {
  runStatement: MENU_ACCELERATORS['run-statement'],
  runScript: MENU_ACCELERATORS['run-script'],
  cancel: MENU_ACCELERATORS['cancel-query'],
  format: MENU_ACCELERATORS['format-sql'],
  toggleResults: MENU_ACCELERATORS['toggle-results'],
  openFile: MENU_ACCELERATORS['open-file'],
  saveFile: MENU_ACCELERATORS['save-file'],
  history: MENU_ACCELERATORS['open-history'],
} as const

function activeConsole(): ConsoleTab | undefined {
  const tab = activeTab()
  return tab?.kind === 'console' ? tab : undefined
}

const onConsole = () => activeConsole() !== undefined
const runtimeOf = (tab: ConsoleTab | undefined) => (tab ? useConsoles.getState().runtime(tab.id) : undefined)

function withConsole(run: (tab: ConsoleTab) => void | Promise<void>): () => void | Promise<void> {
  return () => {
    const tab = activeConsole()
    if (tab) return run(tab)
  }
}

const SQL_FILTERS = [
  { name: 'SQL', extensions: ['sql'] },
  { name: 'All files', extensions: ['*'] },
]

async function openFile(): Promise<void> {
  let result: Awaited<ReturnType<typeof api.files.openText>>
  try {
    result = await api.files.openText()
  } catch (error) {
    toast.error('Could not open the file', error)
    return
  }
  if (!result) return
  // The file is already open: focus its console instead of opening an independent copy.
  const open = useTabs.getState().tabs.find((t): t is ConsoleTab => t.kind === 'console' && t.filePath === result.path)
  if (open) {
    useTabs.getState().setActive(open.id)
    const unsaved = open.savedContent !== undefined && open.content !== open.savedContent
    if (unsaved) {
      if (result.content !== open.content) toast.info(`${fileBaseName(result.path)} is already open`, { description: 'Its unsaved changes are kept.' })
    } else if (result.content !== open.content) {
      // Unchanged in the console but changed on disk: show what the file holds now.
      useTabs.getState().updateConsole(open.id, { content: result.content, savedContent: result.content })
    }
    getEditor(open.id)?.focus()
    return
  }
  const connectionId = pickConsoleConnection()
  if (!connectionId) {
    toast.info('Add a connection first', { description: 'A console needs a connection to run the file.' })
    useUi.getState().openConnectionDialog()
    return
  }
  const fromTab = activeTab()
  const sameConnection = fromTab?.connectionId === connectionId
  useTabs.getState().openConsole({
    connectionId,
    database: sameConnection ? fromTab?.database : undefined,
    schema: sameConnection && fromTab?.kind === 'console' ? fromTab.schema : undefined,
    content: result.content,
    filePath: result.path,
    title: fileBaseName(result.path),
  })
}

async function saveFile(): Promise<void> {
  const tab = activeTab()
  if (!tab) return
  if (tab.kind !== 'console') {
    if (tab.kind === 'table') runCommand('submit-table-changes')
    return
  }
  if (tab.filePath) await saveConsoleInPlace(tab, tab.filePath)
  else await saveConsoleAs(tab)
}

/** Cmd+S on a console bound to a file: write it in place (falls back to the dialog when that fails). */
async function saveConsoleInPlace(tab: ConsoleTab, filePath: string): Promise<void> {
  const editor = getEditor(tab.id)
  editor?.flush()
  const content = editor?.getText() ?? tab.content
  try {
    const path = await api.files.writeText({ path: filePath, content })
    useTabs.getState().updateConsole(tab.id, { filePath: path, content, savedContent: content })
    toast.success(`Saved ${fileBaseName(path)}`, { duration: 1600 })
  } catch (error) {
    const kind = errorInfo(error).kind
    // The file is gone or cannot be written in place: ask where to save it.
    if (kind === 'invalid-input' || kind === 'not-found') await saveConsoleAs(tab)
    else toast.error(`Could not save ${fileBaseName(filePath)}`, error)
  }
}

/** Save the console's text through the save dialog (pointed at its file when it has one). */
async function saveConsoleAs(tab: ConsoleTab): Promise<void> {
  const editor = getEditor(tab.id)
  editor?.flush()
  const content = editor?.getText() ?? tab.content
  try {
    const path = await api.files.saveText({ defaultName: suggestedFileName(tab), content, filters: SQL_FILTERS })
    if (!path) return
    useTabs.getState().updateConsole(tab.id, { filePath: path, title: fileBaseName(path), content, savedContent: content })
    toast.success(`Saved ${fileBaseName(path)}`)
  } catch (error) {
    toast.error('Could not save the file', error)
  }
}

export function buildFileCommands(): Command[] {
  return [
    {
      id: 'open-file',
      title: 'Open SQL file…',
      group: 'File',
      icon: FileInput,
      shortcut: CONSOLE_SHORTCUTS.openFile,
      keywords: ['load', 'script', 'import'],
      run: openFile,
    },
    {
      id: 'save-file',
      title: 'Save file',
      group: 'File',
      icon: Save,
      shortcut: CONSOLE_SHORTCUTS.saveFile,
      keywords: ['write', 'export', 'script'],
      when: () => {
        const kind = activeTab()?.kind
        return kind === 'console' || kind === 'table'
      },
      run: saveFile,
    },
    {
      id: 'save-file-as',
      title: 'Save file as…',
      group: 'File',
      icon: Save,
      shortcut: MENU_ACCELERATORS['save-file-as'],
      keywords: ['write', 'export', 'script', 'copy', 'rename'],
      when: () => activeTab()?.kind === 'console',
      run: withConsole(saveConsoleAs),
    },
  ]
}

export function buildConsoleCommands(): Command[] {
  return [
    {
      id: 'run-statement',
      title: 'Run statement',
      group: 'Query',
      icon: Play,
      shortcut: CONSOLE_SHORTCUTS.runStatement,
      keywords: ['execute', 'query', 'selection'],
      when: onConsole,
      run: withConsole((tab) => runConsole(tab.id, 'statement')),
    },
    {
      id: 'run-script',
      title: 'Run script',
      group: 'Query',
      icon: ScrollText,
      shortcut: CONSOLE_SHORTCUTS.runScript,
      keywords: ['execute', 'all', 'batch'],
      when: onConsole,
      run: withConsole((tab) => runConsole(tab.id, 'script')),
    },
    {
      id: 'cancel-query',
      title: 'Cancel query',
      group: 'Query',
      icon: CircleStop,
      shortcut: CONSOLE_SHORTCUTS.cancel,
      keywords: ['stop', 'abort', 'kill'],
      // Also gives up on a session that is still connecting (unresponsive host).
      when: () => {
        const status = runtimeOf(activeConsole())?.status
        return status === 'running' || status === 'connecting'
      },
      run: withConsole((tab) => useConsoles.getState().cancel(tab.id)),
    },
    {
      id: 'format-sql',
      title: 'Format SQL',
      group: 'Query',
      icon: WandSparkles,
      shortcut: CONSOLE_SHORTCUTS.format,
      keywords: ['beautify', 'pretty', 'indent', 'reformat'],
      when: onConsole,
      run: withConsole((tab) => formatConsole(tab.id)),
    },
    {
      id: 'explain',
      title: 'Explain plan',
      group: 'Query',
      icon: ListTree,
      keywords: ['query plan', 'execution plan', 'showplan'],
      when: onConsole,
      run: withConsole((tab) => explainConsole(tab.id, false)),
    },
    {
      id: 'explain-analyze',
      title: 'Explain analyze',
      group: 'Query',
      icon: Gauge,
      keywords: ['actual plan', 'profile', 'statistics'],
      when: onConsole,
      run: withConsole((tab) => explainConsole(tab.id, true)),
    },
    {
      id: 'toggle-results',
      title: 'Toggle results',
      group: 'View',
      icon: PanelBottom,
      shortcut: CONSOLE_SHORTCUTS.toggleResults,
      keywords: ['hide', 'show', 'panel', 'output'],
      when: onConsole,
      run: withConsole((tab) => toggleResults(tab.id)),
    },
    {
      id: 'commit',
      title: 'Commit transaction',
      group: 'Query',
      icon: GitCommitHorizontal,
      keywords: ['transaction', 'save'],
      when: () => runtimeOf(activeConsole())?.transaction.inTransaction === true,
      run: withConsole((tab) => useConsoles.getState().commit(tab.id)),
    },
    {
      id: 'rollback',
      title: 'Roll back transaction',
      group: 'Query',
      icon: Undo2,
      keywords: ['transaction', 'undo', 'revert', 'rollback'],
      when: () => runtimeOf(activeConsole())?.transaction.inTransaction === true,
      run: withConsole((tab) => useConsoles.getState().rollback(tab.id)),
    },
    {
      id: 'toggle-autocommit',
      title: 'Toggle auto-commit',
      group: 'Query',
      icon: ToggleLeft,
      keywords: ['transaction', 'manual', 'autocommit'],
      when: onConsole,
      run: withConsole((tab) => {
        const autoCommit = displayedAutoCommit(useConsoles.getState().runtime(tab.id), wantsManualCommit(tab.id))
        return useConsoles.getState().setAutoCommit(tab.id, !autoCommit)
      }),
    },
    {
      id: 'insert-snippet',
      title: 'Insert snippet…',
      group: 'Query',
      icon: TextQuote,
      keywords: ['template', 'live template', 'saved query', 'favorite', 'bookmark'],
      when: onConsole,
      run: withConsole((tab) => useConsoles.getState().openSnippets(tab.id)),
    },
    {
      id: 'save-snippet',
      title: 'Save as snippet…',
      group: 'Query',
      icon: BookmarkPlus,
      keywords: ['template', 'live template', 'saved query', 'favorite', 'bookmark', 'selection'],
      when: onConsole,
      run: withConsole((tab) => {
        const target = getEditor(tab.id)?.getRunTarget()
        useConsoles.getState().openSnippets(tab.id, { view: 'edit', draft: { name: '', abbreviation: '', body: literalSnippetBody(target?.sql ?? '') } })
      }),
    },
    {
      id: 'clear-parameter-values',
      title: 'Forget query parameter values',
      group: 'Query',
      icon: Eraser,
      keywords: ['parameters', 'placeholders', 'variables', 'bind', 'reset'],
      when: onConsole,
      run: withConsole((tab) => {
        useConsoles.getState().clearParameterValues(tab.id)
        toast.success('Parameter values forgotten', { description: 'The next run with placeholders asks again with empty values.' })
      }),
    },
    {
      id: 'refresh-completions',
      title: 'Refresh autocompletion',
      group: 'Query',
      icon: RefreshCw,
      keywords: ['catalog', 'metadata', 'reload', 'suggestions'],
      when: onConsole,
      run: withConsole(async (tab) => {
        const database = tab.database ?? defaultDatabase(tab.connectionId)
        if (!database) return
        const data = await useCatalog.getState().load(tab.connectionId, database, true)
        const state = useCatalog.getState().catalogs[`${tab.connectionId}|${database}`]
        if (state?.status === 'error') toast.error('Could not load the catalog', state.error)
        else if (data) toast.success('Autocompletion refreshed', { description: `${data.schemas.reduce((n, s) => n + s.objects.length, 0)} objects in ${database}` })
      }),
    },
  ]
}

registerCommands(buildFileCommands())

let mounted = 0
let unregister: (() => void) | null = null

/** Keep the console commands registered while at least one console is mounted. */
export function retainConsoleCommands(): () => void {
  mounted += 1
  if (mounted === 1) unregister = registerCommands(buildConsoleCommands())
  let released = false
  return () => {
    if (released) return
    released = true
    mounted -= 1
    if (mounted === 0) {
      unregister?.()
      unregister = null
    }
  }
}
