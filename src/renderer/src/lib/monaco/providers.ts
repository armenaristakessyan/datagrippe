// Monaco adapters for the pure completion / hover logic and the SQL formatter.
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import { formatSql } from '@shared/sql'
import { computeCompletions, hoverAt, type SqlCompletionKind } from './completion'
import { LANGUAGE_ID, modelEnv } from './env'

type MonacoApi = typeof Monaco

const CATALOG_WAIT_MS = 1500

function kindMap(monaco: MonacoApi): Record<SqlCompletionKind, Monaco.languages.CompletionItemKind> {
  const K = monaco.languages.CompletionItemKind
  return {
    column: K.Field,
    table: K.Struct,
    view: K.Interface,
    cte: K.Struct,
    alias: K.Variable,
    schema: K.Module,
    function: K.Function,
    routine: K.Method,
    keyword: K.Keyword,
    type: K.TypeParameter,
    snippet: K.Snippet,
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function completionProvider(monaco: MonacoApi): Monaco.languages.CompletionItemProvider {
  const kinds = kindMap(monaco)
  return {
    triggerCharacters: ['.'],
    provideCompletionItems: async (model, position) => {
      const env = modelEnv(model.uri.toString())
      if (!env) return { suggestions: [] }
      if (!env.completion().catalog) await Promise.race([env.ensureCatalog().catch(() => undefined), delay(CATALOG_WAIT_MS)])
      if (model.isDisposed()) return { suggestions: [] }
      const text = model.getValue()
      const offset = model.getOffsetAt(position)
      const result = computeCompletions(text, offset, env.completion())
      if (!result) return { suggestions: [] }
      const start = model.getPositionAt(result.from)
      const end = model.getPositionAt(Math.max(result.to, offset))
      const insert = new monaco.Range(start.lineNumber, start.column, position.lineNumber, position.column)
      const replace = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column)
      const suggestions = result.items.map(
        (item): Monaco.languages.CompletionItem => ({
          label: item.description || item.detail ? { label: item.label, detail: item.description ? `  ${item.description}` : undefined, description: item.detail } : item.label,
          kind: kinds[item.kind],
          detail: item.detail,
          documentation: item.documentation ? { value: item.documentation } : undefined,
          insertText: item.insertText,
          insertTextRules: item.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          sortText: item.sortText,
          filterText: item.filterText,
          range: { insert, replace },
          command: item.retrigger ? { id: 'editor.action.triggerSuggest', title: 'Suggest' } : undefined,
        }),
      )
      return { suggestions }
    },
  }
}

function hoverProvider(monaco: MonacoApi): Monaco.languages.HoverProvider {
  return {
    provideHover: (model, position) => {
      const env = modelEnv(model.uri.toString())
      if (!env) return null
      const offset = model.getOffsetAt(position)
      const info = hoverAt(model.getValue(), offset, env.completion())
      if (!info) return null
      const start = model.getPositionAt(info.from)
      const end = model.getPositionAt(info.to)
      return {
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        contents: [{ value: info.markdown }],
      }
    },
  }
}

function formatProviders(): [Monaco.languages.DocumentFormattingEditProvider, Monaco.languages.DocumentRangeFormattingEditProvider] {
  return [
    {
      displayName: 'SQL formatter',
      provideDocumentFormattingEdits: (model) => {
        const env = modelEnv(model.uri.toString())
        if (!env) return []
        const text = model.getValue()
        const formatted = formatSql(text, env.completion().dialect, env.format())
        return formatted === text ? [] : [{ range: model.getFullModelRange(), text: formatted }]
      },
    },
    {
      displayName: 'SQL formatter',
      provideDocumentRangeFormattingEdits: (model, range) => {
        const env = modelEnv(model.uri.toString())
        if (!env) return []
        const text = model.getValueInRange(range)
        const formatted = formatSql(text, env.completion().dialect, env.format())
        return formatted === text ? [] : [{ range, text: formatted }]
      },
    },
  ]
}

/** Register completion, hover and formatting for both SQL languages. Call once. */
export function registerSqlProviders(monaco: MonacoApi): Monaco.IDisposable[] {
  const disposables: Monaco.IDisposable[] = []
  for (const language of Object.values(LANGUAGE_ID)) {
    const [doc, range] = formatProviders()
    disposables.push(
      monaco.languages.registerCompletionItemProvider(language, completionProvider(monaco)),
      monaco.languages.registerHoverProvider(language, hoverProvider(monaco)),
      monaco.languages.registerDocumentFormattingEditProvider(language, doc),
      monaco.languages.registerDocumentRangeFormattingEditProvider(language, range),
    )
  }
  return disposables
}
