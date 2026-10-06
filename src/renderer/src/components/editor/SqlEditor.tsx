// Thin React wrapper over monaco.editor.create: one model per console tab (inmemory://console/<tabId>),
// content synced to the tab (debounced), an EditorHandle in the editor registry, statement highlight,
// run flash and error markers.
import { useCallback, useEffect, useRef, useState } from 'react'
import { RotateCcw, TriangleAlert } from 'lucide-react'
import type { Dialect } from '@shared/types'
import { formatSql, statementAtOffset, splitStatements } from '@shared/sql'
import { Button, EmptyState, Skeleton } from '@/components/ui'
import { cn } from '@/lib/cn'
import { registerEditor, type EditorHandle, type EditorSqlSlice } from '@/lib/editor-registry'
import { consoleModelUri, EDITOR_FONT_FAMILY_STACK, LANGUAGE_ID, loadMonaco, MONACO_THEME, setModelEnv, type Monaco, type MonacoApi } from '@/lib/monaco'
import { literalSnippetBody, snippetPreview, userSnippets } from '@/lib/monaco/snippets'
import { isMac } from '@/lib/platform'
import { catalogFor, useCatalog } from '@/stores/catalog'
import { useConsoles } from '@/stores/consoles'
import { useSettings } from '@/stores/settings'
import { useTabs, type ConsoleTab } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { shortcutInWords } from './console-utils'
import './editor.css'

export interface SqlEditorActions {
  runStatement: () => void
  runScript: () => void
  explain: (analyze: boolean) => void
}

export interface SqlEditorProps {
  tab: ConsoleTab
  dialect: Dialect
  /** Database used for completion (the tab's, else the connection default). */
  database: string | undefined
  actions: SqlEditorActions
  className?: string
}

const CONTENT_DEBOUNCE_MS = 250
const HIGHLIGHT_DEBOUNCE_MS = 60
const FLASH_MS = 750
/** Above this size the statement highlight is skipped (splitting on every caret move would be wasteful). */
const HIGHLIGHT_MAX_LENGTH = 400_000
const MARKER_OWNER = 'datagrippe'

type LoadState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string }

/** Monaco's snippet controller (editor contribution 'snippetController2'). */
interface SnippetInserter extends Monaco.editor.IEditorContribution {
  insert: (template: string) => void
}

function lineHeightFor(fontSize: number): number {
  return Math.round(fontSize * 1.6)
}

export function SqlEditor({ tab, dialect, database, actions, className }: SqlEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<MonacoApi | null>(null)
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const settings = useSettings((s) => s.settings)

  // Latest props for long-lived Monaco callbacks.
  const latest = useRef({ tab, dialect, database, actions })
  latest.current = { tab, dialect, database, actions }

  /** Content last written to (or received from) the tab store. */
  const syncedContent = useRef(tab.content)
  const flushContent = useRef<() => void>(() => undefined)

  useEffect(() => {
    let disposed = false
    const cleanups: (() => void)[] = []
    // Monaco disposables are class instances (their dispose() needs `this`): keep the objects, not the methods.
    const track = (...disposables: Monaco.IDisposable[]) => {
      for (const d of disposables) cleanups.push(() => d.dispose())
    }
    setLoad({ status: 'loading' })

    loadMonaco()
      .then((monaco) => {
        const container = containerRef.current
        if (disposed || !container) return
        monacoRef.current = monaco
        const { tab: current, dialect: currentDialect } = latest.current
        const uri = monaco.Uri.parse(consoleModelUri(current.id))
        const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(current.content, LANGUAGE_ID[currentDialect], uri)
        if (model.getLanguageId() !== LANGUAGE_ID[currentDialect]) monaco.editor.setModelLanguage(model, LANGUAGE_ID[currentDialect])
        syncedContent.current = model.getValue()
        const s = useSettings.getState().settings
        model.updateOptions({ tabSize: s.editorTabSize, indentSize: s.editorTabSize, insertSpaces: true })

        const editor = monaco.editor.create(container, {
          model,
          theme: MONACO_THEME[useUi.getState().resolvedTheme],
          automaticLayout: true,
          fontFamily: EDITOR_FONT_FAMILY_STACK,
          fontSize: s.editorFontSize,
          lineHeight: lineHeightFor(s.editorFontSize),
          fontLigatures: false,
          letterSpacing: 0,
          lineNumbers: 'on',
          lineNumbersMinChars: 3,
          lineDecorationsWidth: 10,
          glyphMargin: false,
          folding: true,
          showFoldingControls: 'mouseover',
          minimap: { enabled: s.editorMinimap, renderCharacters: false, showSlider: 'mouseover', maxColumn: 100 },
          wordWrap: s.editorWordWrap ? 'on' : 'off',
          padding: { top: 10, bottom: 10 },
          cursorSmoothCaretAnimation: 'on',
          cursorBlinking: 'smooth',
          cursorWidth: 2,
          roundedSelection: true,
          renderLineHighlight: 'all',
          renderLineHighlightOnlyWhenFocus: false,
          scrollBeyondLastLine: false,
          fixedOverflowWidgets: true,
          overviewRulerBorder: false,
          overviewRulerLanes: 2,
          hideCursorInOverviewRuler: true,
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false, alwaysConsumeMouseWheel: false },
          smoothScrolling: true,
          renderWhitespace: 'selection',
          guides: { indentation: true, highlightActiveIndentation: false },
          bracketPairColorization: { enabled: false },
          matchBrackets: 'near',
          occurrencesHighlight: 'singleFile',
          selectionHighlight: true,
          quickSuggestions: { other: true, comments: false, strings: false },
          quickSuggestionsDelay: 40,
          suggestOnTriggerCharacters: true,
          wordBasedSuggestions: 'off',
          acceptSuggestionOnEnter: 'smart',
          tabCompletion: 'on',
          snippetSuggestions: 'inline',
          suggest: { showWords: false, showSnippets: true, preview: false, insertMode: 'replace', localityBonus: true, selectionMode: 'always' },
          hover: { delay: 450, above: false },
          contextmenu: true,
          dragAndDrop: true,
          emptySelectionClipboard: true,
          copyWithSyntaxHighlighting: false,
          stickyScroll: { enabled: false },
          'semanticHighlighting.enabled': false,
          placeholder: `Write SQL — ${shortcutInWords('CmdOrCtrl+Enter')} runs the statement at the caret, ${shortcutInWords('CmdOrCtrl+Shift+Enter')} the whole script`,
          ariaLabel: `SQL editor, ${current.title}`,
        })
        editorRef.current = editor

        // --- content sync -------------------------------------------------
        let contentTimer: ReturnType<typeof setTimeout> | undefined
        const writeContent = () => {
          if (contentTimer) clearTimeout(contentTimer)
          contentTimer = undefined
          if (model.isDisposed()) return
          const value = model.getValue()
          if (value === syncedContent.current) return
          syncedContent.current = value
          useTabs.getState().updateConsole(latest.current.tab.id, { content: value })
        }
        flushContent.current = writeContent

        // --- decorations ----------------------------------------------------
        const statementDecorations = editor.createDecorationsCollection()
        const flashDecorations = editor.createDecorationsCollection()
        const errorDecorations = editor.createDecorationsCollection()

        let hasMarkers = false
        const clearMarkers = () => {
          if (!hasMarkers || model.isDisposed()) return
          monaco.editor.setModelMarkers(model, MARKER_OWNER, [])
          errorDecorations.clear()
          hasMarkers = false
        }
        let highlightTimer: ReturnType<typeof setTimeout> | undefined
        let flashTimer: ReturnType<typeof setTimeout> | undefined

        const rangeOf = (start: number, end: number): Monaco.Range => {
          const a = model.getPositionAt(start)
          const b = model.getPositionAt(Math.max(start, end))
          return new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column)
        }

        const updateStatementHighlight = () => {
          highlightTimer = undefined
          if (model.isDisposed()) return
          const selection = editor.getSelection()
          const text = model.getValue()
          if (!selection || !selection.isEmpty() || text.length > HIGHLIGHT_MAX_LENGTH) {
            statementDecorations.clear()
            return
          }
          const d = latest.current.dialect
          let statement: ReturnType<typeof statementAtOffset> = null
          let count = 0
          try {
            count = splitStatements(text, d).length
            statement = count > 1 ? statementAtOffset(text, model.getOffsetAt(selection.getPosition()), d) : null
          } catch {
            statement = null
          }
          if (!statement) {
            statementDecorations.clear()
            return
          }
          const range = rangeOf(statement.start, statement.end)
          statementDecorations.set([
            {
              range: new monaco.Range(range.startLineNumber, 1, range.endLineNumber, 1),
              options: { isWholeLine: true, className: 'dg-stmt-line', linesDecorationsClassName: 'dg-stmt-gutter' },
            },
          ])
        }
        const scheduleHighlight = () => {
          if (highlightTimer) clearTimeout(highlightTimer)
          highlightTimer = setTimeout(updateStatementHighlight, HIGHLIGHT_DEBOUNCE_MS)
        }

        cleanups.push(() => {
          if (highlightTimer) clearTimeout(highlightTimer)
          if (flashTimer) clearTimeout(flashTimer)
        })
        track(
          editor.onDidChangeModelContent(() => {
            clearMarkers()
            if (contentTimer) clearTimeout(contentTimer)
            contentTimer = setTimeout(writeContent, CONTENT_DEBOUNCE_MS)
            scheduleHighlight()
          }),
          editor.onDidChangeCursorSelection(scheduleHighlight),
          editor.onDidBlurEditorText(writeContent),
        )
        scheduleHighlight()

        // --- actions (fallback keybindings; the native menu owns the same accelerators) ------------
        const K = monaco.KeyMod
        const C = monaco.KeyCode
        track(
          editor.addAction({
            id: 'datagrippe.runStatement',
            label: 'Run statement',
            keybindings: [K.CtrlCmd | C.Enter],
            contextMenuGroupId: '0_run',
            contextMenuOrder: 1,
            run: () => latest.current.actions.runStatement(),
          }),
          editor.addAction({
            id: 'datagrippe.runScript',
            label: 'Run script',
            keybindings: [K.CtrlCmd | K.Shift | C.Enter],
            contextMenuGroupId: '0_run',
            contextMenuOrder: 2,
            run: () => latest.current.actions.runScript(),
          }),
          editor.addAction({
            id: 'datagrippe.explain',
            label: 'Explain plan',
            contextMenuGroupId: '0_run',
            contextMenuOrder: 3,
            run: () => latest.current.actions.explain(false),
          }),
          editor.addAction({
            id: 'datagrippe.saveSnippet',
            label: 'Save as snippet…',
            contextMenuGroupId: '1_modification',
            contextMenuOrder: 1,
            run: () => {
              const target = handle.getRunTarget()
              useConsoles.getState().openSnippets(latest.current.tab.id, {
                view: 'edit',
                draft: { name: '', abbreviation: '', body: literalSnippetBody(target?.sql ?? '') },
              })
            },
          }),
          editor.addAction({
            id: 'datagrippe.format',
            label: 'Format SQL',
            keybindings: [K.CtrlCmd | K.Alt | C.KeyL],
            contextMenuGroupId: '1_modification',
            contextMenuOrder: 0,
            run: () => handle.format(),
          }),
        )

        // ⌘K is a chord prefix in Monaco (⌘K ⌘C…): let it reach the native menu (command palette) instead.
        const onKeyDown = (event: KeyboardEvent) => {
          const mod = isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
          if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') event.stopPropagation()
        }
        container.addEventListener('keydown', onKeyDown, true)
        cleanups.push(() => container.removeEventListener('keydown', onKeyDown, true))

        // --- handle -----------------------------------------------------------
        const slice = (start: number, end: number): EditorSqlSlice => ({ sql: model.getValue().slice(start, end), offset: start })
        const formatOptions = () => {
          const st = useSettings.getState().settings
          return { keywordCase: st.formatKeywordCase, tabWidth: st.editorTabSize }
        }
        const replaceAll = (text: string, source: string) => {
          editor.pushUndoStop()
          editor.executeEdits(source, [{ range: model.getFullModelRange(), text, forceMoveMarkers: true }])
          editor.pushUndoStop()
        }

        const handle: EditorHandle = {
          getText: () => model.getValue(),
          getSelection: () => {
            const sel = editor.getSelection()
            if (!sel || sel.isEmpty()) return null
            const start = model.getOffsetAt(sel.getStartPosition())
            const end = model.getOffsetAt(sel.getEndPosition())
            return slice(start, end)
          },
          getStatementAtCursor: () => {
            const position = editor.getPosition()
            if (!position) return null
            try {
              const statement = statementAtOffset(model.getValue(), model.getOffsetAt(position), latest.current.dialect)
              return statement ? { sql: statement.text, offset: statement.start } : null
            } catch {
              return null
            }
          },
          getRunTarget: () => {
            const selection = handle.getSelection()
            if (selection && selection.sql.trim()) return selection
            return handle.getStatementAtCursor()
          },
          setText: (text) => {
            replaceAll(text, 'setText')
            writeContent()
          },
          insertText: (text) => {
            const sel = editor.getSelection()
            const position = editor.getPosition() ?? model.getPositionAt(model.getValueLength())
            const range = sel ?? new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column)
            editor.pushUndoStop()
            editor.executeEdits('insertText', [{ range, text, forceMoveMarkers: true }])
            editor.pushUndoStop()
            editor.focus()
          },
          insertSnippet: (body) => {
            editor.focus()
            const controller = editor.getContribution<SnippetInserter>('snippetController2')
            if (controller && typeof controller.insert === 'function') controller.insert(body)
            else handle.insertText(snippetPreview(body))
          },
          format: () => {
            const d = latest.current.dialect
            const sel = editor.getSelection()
            if (sel && !sel.isEmpty()) {
              const text = model.getValueInRange(sel)
              const formatted = formatSql(text, d, formatOptions())
              if (formatted === text) return
              const startOffset = model.getOffsetAt(sel.getStartPosition())
              editor.pushUndoStop()
              editor.executeEdits('format', [{ range: sel, text: formatted, forceMoveMarkers: true }])
              editor.pushUndoStop()
              const a = model.getPositionAt(startOffset)
              const b = model.getPositionAt(startOffset + formatted.length)
              editor.setSelection(new monaco.Selection(a.lineNumber, a.column, b.lineNumber, b.column))
              return
            }
            const text = model.getValue()
            const formatted = formatSql(text, d, formatOptions())
            if (formatted === text) return
            const line = editor.getPosition()?.lineNumber ?? 1
            replaceAll(formatted, 'format')
            const target = Math.min(line, model.getLineCount())
            editor.setPosition({ lineNumber: target, column: model.getLineMaxColumn(target) })
          },
          focus: () => editor.focus(),
          hideWidgets: () => {
            // The run shortcut is a native-menu accelerator Monaco never sees: close the suggest list
            // ourselves, or the next Enter would accept a stale suggestion.
            editor.trigger('datagrippe', 'hideSuggestWidget', null)
          },
          flush: () => writeContent(),
          markError: (start, end, message) => {
            if (model.isDisposed()) return
            const range = rangeOf(start, Math.min(Math.max(end, start + 1), model.getValueLength()))
            monaco.editor.setModelMarkers(model, MARKER_OWNER, [
              {
                severity: monaco.MarkerSeverity.Error,
                message,
                startLineNumber: range.startLineNumber,
                startColumn: range.startColumn,
                endLineNumber: range.endLineNumber,
                endColumn: range.endColumn,
              },
            ])
            errorDecorations.set([{ range, options: { inlineClassName: 'dg-error-range', stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }])
            hasMarkers = true
            editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth)
          },
          clearMarkers,
          flash: (start, end) => {
            if (model.isDisposed() || end <= start) return
            if (flashTimer) clearTimeout(flashTimer)
            flashDecorations.set([{ range: rangeOf(start, end), options: { className: 'dg-flash' } }])
            flashTimer = setTimeout(() => flashDecorations.clear(), FLASH_MS)
          },
        }
        cleanups.push(registerEditor(current.id, handle))

        // --- language services context ---------------------------------------------
        cleanups.push(
          setModelEnv(uri.toString(), {
            completion: () => {
              const { tab: t, dialect: d, database: db } = latest.current
              const catalog = catalogFor(t.connectionId, db)
              // SQL Server has no session default schema: unqualified names resolve in the login's default
              // schema whatever the toolbar shows, so the picked schema only ranks completions (and they
              // are inserted qualified). PostgreSQL's picker sets search_path, so it is the default schema.
              const snippets = userSnippets()
              if (d === 'mssql') return { dialect: d, catalog, defaultSchema: catalog?.defaultSchema, preferredSchema: t.schema, snippets }
              return { dialect: d, catalog, defaultSchema: t.schema ?? catalog?.defaultSchema, snippets }
            },
            ensureCatalog: () => {
              const { tab: t, database: db } = latest.current
              return db ? useCatalog.getState().load(t.connectionId, db) : Promise.resolve(undefined)
            },
            format: formatOptions,
          }),
        )

        cleanups.push(() => {
          writeContent()
          flushContent.current = () => undefined
          editorRef.current = null
          editor.dispose()
        })
        setLoad({ status: 'ready' })
      })
      .catch((error: unknown) => {
        if (!disposed) setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      })

    return () => {
      disposed = true
      // Each cleanup runs even if another throws: a failure must not leak timers or crash the unmount.
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup()
        } catch (error) {
          console.warn('SQL editor cleanup failed', error)
        }
      }
    }
  }, [tab.id, attempt])

  // External content changes (history "open in console", file reload…) replace the text with an undo stop.
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || tab.content === syncedContent.current) return
    if (tab.content === model.getValue()) {
      syncedContent.current = tab.content
      return
    }
    syncedContent.current = tab.content
    editor.pushUndoStop()
    editor.executeEdits('external', [{ range: model.getFullModelRange(), text: tab.content, forceMoveMarkers: true }])
    editor.pushUndoStop()
  }, [tab.content, load.status])

  // Dialect follows the connection.
  useEffect(() => {
    const monaco = monacoRef.current
    const model = editorRef.current?.getModel()
    if (monaco && model && model.getLanguageId() !== LANGUAGE_ID[dialect]) monaco.editor.setModelLanguage(model, LANGUAGE_ID[dialect])
  }, [dialect, load.status])

  // Settings.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.updateOptions({
      fontSize: settings.editorFontSize,
      lineHeight: lineHeightFor(settings.editorFontSize),
      wordWrap: settings.editorWordWrap ? 'on' : 'off',
      minimap: { enabled: settings.editorMinimap, renderCharacters: false, showSlider: 'mouseover', maxColumn: 100 },
    })
    editor.getModel()?.updateOptions({ tabSize: settings.editorTabSize, indentSize: settings.editorTabSize, insertSpaces: true })
  }, [settings.editorFontSize, settings.editorWordWrap, settings.editorMinimap, settings.editorTabSize, load.status])

  // Save pending text when the window goes away.
  useEffect(() => {
    const flush = () => flushContent.current()
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  return (
    <div className={cn('dg-sql-editor relative h-full min-h-0 w-full bg-surface', className)}>
      {/* monaco-component: Monaco defines its theme colors on that class. The context menu (fixedOverflowWidgets) is
          rendered in this container, outside .monaco-editor: without it the menu has no background. */}
      <div ref={containerRef} className="monaco-component absolute inset-0" data-testid="sql-editor" />
      {load.status === 'loading' && <EditorSkeleton />}
      {load.status === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface">
          <EmptyState
            tone="danger"
            icon={TriangleAlert}
            title="The editor failed to load"
            description={load.message}
            action={
              <Button variant="primary" leadingIcon={RotateCcw} onClick={retry}>
                Retry
              </Button>
            }
          />
        </div>
      )}
    </div>
  )
}

const SKELETON_WIDTHS = ['46%', '62%', '38%', '0', '54%', '30%']

function EditorSkeleton() {
  return (
    <div className="pointer-events-none absolute inset-0 animate-fade-in bg-surface pt-[10px]" aria-busy="true" aria-label="Loading editor">
      {SKELETON_WIDTHS.map((width, i) => (
        <div key={i} className="flex h-[21px] items-center gap-4 pl-4">
          <Skeleton width={14} height={8} className="opacity-60" />
          {width !== '0' && <Skeleton width={width} height={9} />}
        </div>
      ))}
    </div>
  )
}
