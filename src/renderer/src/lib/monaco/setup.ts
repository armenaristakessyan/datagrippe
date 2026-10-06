// Monaco, bundled locally (the CSP forbids remote scripts): the editor API, only the contributions a SQL
// console needs, the two SQL grammars and the editor worker. Loaded lazily through ./index.ts.
import * as monaco from 'monaco-editor/editor/editor.api.js'
import 'monaco-editor/features/codicon/register.js'
import 'monaco-editor/features/bracketMatching/register.js'
import 'monaco-editor/features/caretOperations/register.js'
import 'monaco-editor/features/clipboard/register.js'
import 'monaco-editor/features/comment/register.js'
import 'monaco-editor/features/contextmenu/register.js'
import 'monaco-editor/features/cursorUndo/register.js'
import 'monaco-editor/features/dnd/register.js'
import 'monaco-editor/features/find/register.js'
import 'monaco-editor/features/folding/register.js'
import 'monaco-editor/features/format/register.js'
import 'monaco-editor/features/hover/register.js'
import 'monaco-editor/features/indentation/register.js'
import 'monaco-editor/features/inlineProgress/register.js'
import 'monaco-editor/features/lineSelection/register.js'
import 'monaco-editor/features/linesOperations/register.js'
import 'monaco-editor/features/multicursor/register.js'
import 'monaco-editor/features/placeholderText/register.js'
import 'monaco-editor/features/readOnlyMessage/register.js'
import 'monaco-editor/features/smartSelect/register.js'
import 'monaco-editor/features/snippet/register.js'
import 'monaco-editor/features/suggest/register.js'
import 'monaco-editor/features/wordHighlighter/register.js'
import 'monaco-editor/features/wordOperations/register.js'
import 'monaco-editor/features/wordPartOperations/register.js'
// Core pieces editor.main.js adds on top of the feature registrations (the suggest widget lives here).
import 'monaco-editor/editor/browser/coreCommands.js'
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js'
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js'
import 'monaco-editor/editor/common/standaloneStrings.js'
import { conf as pgsqlConf, language as pgsqlLanguage } from 'monaco-editor/languages/definitions/pgsql/pgsql.js'
import { conf as tsqlConf, language as tsqlLanguage } from 'monaco-editor/languages/definitions/sql/sql.js'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import { onTabClosed } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { consoleModelUri, LANGUAGE_ID } from './env'
import { extendMssqlLanguage, extendPgsqlLanguage } from './grammar'
import { registerSqlProviders } from './providers'
import { applyMonacoTheme } from './theme'

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

/** The editor font must be loaded before Monaco measures glyphs, or the caret drifts. */
async function loadEditorFont(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return
  try {
    await Promise.all([
      document.fonts.load("13px 'JetBrains Mono Variable'"),
      document.fonts.load("bold 13px 'JetBrains Mono Variable'"),
    ])
    await document.fonts.ready
  } catch {
    // fall back to the next family in the stack
  }
  monaco.editor.remeasureFonts()
}

let initialized: Promise<typeof monaco> | null = null

export function initMonaco(): Promise<typeof monaco> {
  initialized ??= (async () => {
    // Monaco's pgsql and T-SQL ('sql') grammars, extended (see grammar.ts). They are registered here
    // rather than through Monaco's lazy register.js so its loader cannot replace the extended grammar.
    monaco.languages.register({ id: LANGUAGE_ID.postgres, aliases: ['PostgreSQL', 'postgres'] })
    monaco.languages.setLanguageConfiguration(LANGUAGE_ID.postgres, pgsqlConf)
    monaco.languages.setMonarchTokensProvider(LANGUAGE_ID.postgres, extendPgsqlLanguage(pgsqlLanguage))
    monaco.languages.register({ id: LANGUAGE_ID.mssql, extensions: ['.sql'], aliases: ['SQL', 'T-SQL'] })
    monaco.languages.setLanguageConfiguration(LANGUAGE_ID.mssql, tsqlConf)
    monaco.languages.setMonarchTokensProvider(LANGUAGE_ID.mssql, extendMssqlLanguage(tsqlLanguage))
    registerSqlProviders(monaco)
    applyMonacoTheme(monaco, useUi.getState().resolvedTheme)
    // Themes are global in Monaco: follow the app theme (the <html> class is already applied when the store updates).
    useUi.subscribe((state, prev) => {
      if (state.resolvedTheme !== prev.resolvedTheme) applyMonacoTheme(monaco, state.resolvedTheme)
    })
    // One model per console tab; it lives as long as the tab (editors come and go with React).
    onTabClosed((tab) => {
      if (tab.kind === 'console') monaco.editor.getModel(monaco.Uri.parse(consoleModelUri(tab.id)))?.dispose()
    })
    await loadEditorFont()
    return monaco
  })()
  return initialized
}
