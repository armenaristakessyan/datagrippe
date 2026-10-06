// Runtime state of console tabs: server session, running query, results, transaction.
import { create } from 'zustand'
import type { DbErrorInfo, Dialect, ExecutionResult, ExplainResult, QueryMessage, SessionInfo, SetDatabaseOptions, TransactionState } from '@shared/types'
import { classifyStatement, splitStatements } from '@shared/sql'
import { isSignificant, tokenize, type Token } from '@shared/sql/lexer'
import {
  findParameters,
  substituteParameters,
  type ParameterValue,
  type SqlParameter,
} from '@/components/editor/sql-parameters'
import { toast } from '@/components/ui/Toaster'
import { api, ApiError, errorInfo, onEvent } from '@/lib/api'
import { useCatalog } from './catalog'
import { connectionById, useConnections } from './connections'
import { defaultDatabase, useExplorer } from './explorer'
import { useSettings } from './settings'
import { onTabClosed, registerCloseGuard, useTabs, type ConsoleTab } from './tabs'
import { useUi } from './ui'

export type ResultView = 'results' | 'messages' | 'explain'

export interface ConsoleRuntime {
  sessionId?: string
  /** Schema the session reported when it opened (fallback for the toolbar picker). */
  sessionSchema?: string
  status: 'idle' | 'connecting' | 'running'
  /** Epoch ms when the current run started. */
  runningSince?: number
  execution?: ExecutionResult
  /** Offset, in the editor text, of the SQL that produced `execution` (maps error positions back). */
  executionOffset: number
  /** Index into execution.results shown in the results panel. */
  activeResult: number
  resultView: ResultView
  /** Failure that prevented execution (connect error, read-only violation…). */
  error?: DbErrorInfo
  /** Server-reported transaction state of the session (the desired mode is `wantsManualCommit`). */
  transaction: TransactionState
  loadingMore: boolean
  explain?: ExplainResult
  /** The statement `explain` describes. */
  explainSql?: string
  explaining: boolean
  /** Server messages of the run in progress, as they arrive (replaced by execution.messages at the end). */
  liveMessages?: QueryMessage[]
}

/** Live messages kept per run (main sends at most 1000). */
const MAX_LIVE_MESSAGES = 1000

/** A question the console asks its user (rendered by the console's <ConsoleDialogs/>). */
export type ConsolePrompt =
  | {
      kind: 'parameters'
      parameters: SqlParameter[]
      sql: string
      dialect: Dialect
      initial: Record<string, ParameterValue>
      /** Values to substitute, 'as-is' to run the SQL unchanged, or null to cancel. */
      resolve: (answer: Record<string, ParameterValue> | 'as-is' | null) => void
    }
  | {
      kind: 'close-transaction'
      tabTitle: string
      connectionName?: string
      resolve: (choice: 'commit' | 'rollback' | 'cancel') => void
    }
  | {
      /** The snippets dialog: pick one to insert, or edit `draft` (a new snippet when it has no id). */
      kind: 'snippets'
      view: 'list' | 'edit'
      draft?: { id?: string; name: string; abbreviation: string; body: string }
    }

const EMPTY: ConsoleRuntime = {
  status: 'idle',
  executionOffset: 0,
  activeResult: 0,
  resultView: 'results',
  transaction: { autoCommit: true, inTransaction: false },
  loadingMore: false,
  explaining: false,
}

interface ConsolesState {
  runtimes: Record<string, ConsoleRuntime>
  /** Open dialogs per console tab. */
  prompts: Record<string, ConsolePrompt>
  runtime: (tabId: string) => ConsoleRuntime
  /** Open (or reuse) the tab's dedicated session. */
  ensureSession: (tabId: string) => Promise<string | null>
  /** Run SQL typed in the console. `offset` = position of `sql` inside the editor text. */
  execute: (tabId: string, sql: string, offset?: number) => Promise<void>
  /** Cancel the running query, or give up on a session that is still connecting. */
  cancel: (tabId: string) => Promise<void>
  fetchMore: (tabId: string, resultIndex: number) => Promise<void>
  explain: (tabId: string, sql: string, analyze: boolean) => Promise<void>
  setAutoCommit: (tabId: string, autoCommit: boolean) => Promise<void>
  commit: (tabId: string) => Promise<void>
  rollback: (tabId: string) => Promise<void>
  /** `discardTransaction`: the user agreed to roll back an open transaction (PostgreSQL reconnects). */
  setDatabase: (tabId: string, database: string, options?: SetDatabaseOptions) => Promise<void>
  setSchema: (tabId: string, schema: string) => Promise<void>
  /** Point the console at another connection (closes the current session). */
  switchConnection: (tabId: string, connectionId: string) => Promise<void>
  setActiveResult: (tabId: string, index: number) => void
  setResultView: (tabId: string, view: ResultView) => void
  /** Forget the session-level error shown above the results. */
  dismissError: (tabId: string) => void
  closeSession: (tabId: string) => Promise<void>
  /** Forget the parameter values remembered for the console (or for every console). */
  clearParameterValues: (tabId?: string) => void
  /** Remove an answered prompt (after its dialog's exit animation). */
  dismissPrompt: (tabId: string, prompt: ConsolePrompt) => void
  /** Open the snippets dialog of a console (does nothing while another dialog is open there). */
  openSnippets: (tabId: string, options?: { view?: 'list' | 'edit'; draft?: { id?: string; name: string; abbreviation: string; body: string } }) => void
}

function consoleTab(tabId: string): ConsoleTab | undefined {
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId)
  return tab?.kind === 'console' ? tab : undefined
}

// ---------------------------------------------------------------------------
// Desired transaction mode (kept apart from the server state so a lost session cannot reset it)
// ---------------------------------------------------------------------------

/** Workspace layout key holding the ids of the consoles in manual-commit mode (persisted with the tabs). */
export const MANUAL_COMMIT_KEY = 'console.manualCommit'

function manualCommitTabs(layout: Record<string, unknown> = useTabs.getState().layout): string[] {
  const value = layout[MANUAL_COMMIT_KEY]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** The user chose manual commit for this console. */
export function wantsManualCommit(tabId: string, layout?: Record<string, unknown>): boolean {
  return manualCommitTabs(layout).includes(tabId)
}

function setManualCommit(tabId: string, manual: boolean): void {
  const list = manualCommitTabs()
  if (list.includes(tabId) === manual) return
  useTabs.getState().setLayout(MANUAL_COMMIT_KEY, manual ? [...list, tabId] : list.filter((id) => id !== tabId))
}

/** Auto-commit as shown in the toolbar: the session's state when one is open, else the desired mode. */
export function displayedAutoCommit(runtime: ConsoleRuntime, manual: boolean): boolean {
  return runtime.sessionId ? runtime.transaction.autoCommit : !manual
}

/** A session loss while a transaction was open: say that its uncommitted work is gone. */
function lostTransactionError(base: DbErrorInfo, tabId: string): DbErrorInfo {
  const mode = wantsManualCommit(tabId) ? ' The console stays in manual-commit mode.' : ''
  return {
    ...base,
    message: `${base.message} — the open transaction was rolled back`,
    detail: [`Its uncommitted changes were lost.${mode}`, base.detail].filter(Boolean).join('\n'),
  }
}

// ---------------------------------------------------------------------------
// Execution side effects
// ---------------------------------------------------------------------------

/** Words that start a DDL statement: after them the completion catalog and the explorer are stale. */
const DDL_WORDS = new Set(['CREATE', 'ALTER', 'DROP', 'RENAME', 'TRUNCATE', 'IMPORT'])

/** `USE db` (SQL Server): the session switched database. Returns the database name. */
export function usedDatabase(sql: string): string | undefined {
  const match = /^\s*USE\s+(\[(?:[^\]]|\]\])+\]|"(?:[^"]|"")+"|[^\s;]+)\s*;?\s*$/i.exec(sql)
  if (!match) return undefined
  return unquoteName(match[1]!)
}

function unquoteName(raw: string): string {
  if (raw.startsWith('[')) return raw.slice(1, -1).replaceAll(']]', ']')
  if (raw.startsWith('"')) return raw.slice(1, -1).replaceAll('""', '"')
  return raw
}

const isPunct = (sql: string, t: Token | undefined, c: string) => !!t && t.kind === 'punct' && sql[t.start] === c

/** What a successful statement / batch did to the session context: the last `USE x`, and whether it ran DDL. */
function scanEffects(sql: string, dialect: Dialect): { database?: string; ddl: boolean } {
  const tokens = tokenize(sql, dialect).filter(isSignificant)
  let database: string | undefined
  let ddl = false
  let depth = 0
  /** Leading word of the current statement (SELECT / INSERT …), for SELECT … INTO. */
  let selecting = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    const prev = tokens[i - 1]
    if (isPunct(sql, t, '(')) depth++
    else if (isPunct(sql, t, ')')) depth = Math.max(0, depth - 1)
    else if (isPunct(sql, t, ';')) selecting = false
    if (t.kind !== 'word') continue
    const word = t.upper
    if (DDL_WORDS.has(word)) {
      // ALTER / DROP inside ALTER TABLE … are clauses of the same DDL statement; either way it is DDL.
      ddl = true
    } else if (word === 'COMMENT' && tokens[i + 1]?.upper === 'ON') {
      ddl = true
    } else if (word === 'SELECT' && depth === 0) {
      selecting = true
    } else if (word === 'INSERT' || word === 'UPDATE' || word === 'DELETE' || word === 'MERGE') {
      if (depth === 0) selecting = false
    } else if (word === 'INTO' && depth === 0 && selecting && prev?.upper !== 'INSERT' && prev?.upper !== 'MERGE') {
      // SELECT … INTO new_table (SQL Server, PostgreSQL); `INTO @var` (FETCH / SELECT into variables) is not DDL.
      const target = tokens[i + 1]
      if (target && !(target.kind === 'word' && target.upper.startsWith('@'))) ddl = true
    } else if (word === 'USE' && dialect === 'mssql') {
      const target = tokens[i + 1]
      if (target && (target.kind === 'word' || target.kind === 'quoted-ident')) database = unquoteName(sql.slice(target.start, target.end))
    }
  }
  return { database, ddl }
}

/** Side effects of a successful execution on the console's context (database switch, stale catalog). */
export function executionEffects(execution: ExecutionResult, dialect: Dialect): { database?: string; schemaChanged: boolean } {
  let database: string | undefined
  let schemaChanged = false
  for (const r of execution.results) {
    if (r.kind === 'error') continue
    // On SQL Server r.sql is the whole batch: scan every statement in it, not just the first.
    const effects = scanEffects(r.sql, dialect)
    if (effects.database) database = effects.database
    if (effects.ddl) schemaChanged = true
  }
  return { database, schemaChanged }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Consoles whose view is mounted and can show their dialogs. */
const promptHosts = new Map<string, number>()

/** Called by the console view: while registered, its dialogs (parameters, close) render there. */
export function registerConsolePromptHost(tabId: string): () => void {
  promptHosts.set(tabId, (promptHosts.get(tabId) ?? 0) + 1)
  return () => {
    const n = (promptHosts.get(tabId) ?? 1) - 1
    if (n <= 0) promptHosts.delete(tabId)
    else promptHosts.set(tabId, n)
  }
}

/** Settings › Query › Detect query parameters. */
function parameterDetectionEnabled(): boolean {
  return useSettings.getState().settings.detectParameters !== false
}

export const useConsoles = create<ConsolesState>((set, get) => {
  /** Update a console's runtime; writes for a tab that has been closed are dropped (no leaked results). */
  const patch = (tabId: string, p: Partial<ConsoleRuntime>) => {
    if (!consoleTab(tabId)) return
    set({ runtimes: { ...get().runtimes, [tabId]: { ...get().runtime(tabId), ...p } } })
  }

  const opening = new Map<string, Promise<string | null>>()
  /** Resolves the pending ensureSession of a tab with null (cancel while connecting, close, switch). */
  const aborts = new Map<string, () => void>()
  /** Tabs with a run / explain in flight (guard + connect + execute): a second trigger is ignored. */
  const busy = new Set<string>()
  /** Bumped when the tab's session is dropped: work started before is stale and must not touch the tab. */
  const generations = new Map<string, number>()
  /** Bumped when the user retargets the tab (connection / database): a run started before does not proceed. */
  const contexts = new Map<string, number>()
  /** Parameter values remembered per console. */
  const parameterValues = new Map<string, Record<string, ParameterValue>>()

  const generation = (tabId: string) => generations.get(tabId) ?? 0
  const bumpGeneration = (tabId: string) => generations.set(tabId, generation(tabId) + 1)
  const context = (tabId: string) => contexts.get(tabId) ?? 0
  const bumpContext = (tabId: string) => contexts.set(tabId, context(tabId) + 1)

  function abortOpening(tabId: string): void {
    aborts.get(tabId)?.()
    aborts.delete(tabId)
    opening.delete(tabId)
  }

  function ask(tabId: string, prompt: ConsolePrompt): void {
    set({ prompts: { ...get().prompts, [tabId]: prompt } })
  }

  /** Ask for the values of the placeholders in `sql`. Resolves to the SQL to run, or null when cancelled. */
  async function withParameters(tabId: string, sql: string): Promise<string | null> {
    const dialect = connectionById(consoleTab(tabId)?.connectionId)?.dialect
    if (!dialect || !promptHosts.has(tabId) || !parameterDetectionEnabled()) return sql
    let scan: ReturnType<typeof findParameters>
    try {
      scan = findParameters(sql, dialect)
    } catch {
      return sql
    }
    if (scan.parameters.length === 0) return sql
    const remembered = parameterValues.get(tabId) ?? {}
    const answer = await new Promise<Record<string, ParameterValue> | 'as-is' | null>((resolve) => {
      const prompt: ConsolePrompt = {
        kind: 'parameters',
        parameters: scan.parameters,
        sql,
        dialect,
        initial: remembered,
        resolve,
      }
      ask(tabId, prompt)
    })
    if (answer === null) return null
    if (answer === 'as-is') return sql
    parameterValues.set(tabId, { ...remembered, ...answer })
    return substituteParameters(sql, scan, answer, dialect)
  }

  async function guard(tabId: string, sql: string): Promise<boolean> {
    const tab = consoleTab(tabId)
    const connection = connectionById(tab?.connectionId)
    if (!connection?.productionGuard || !useSettings.getState().settings.confirmDestructive) return true
    // A read-only connection blocks every write before it reaches the server (main reports it):
    // offering "Run anyway" for a statement that cannot run would be misleading.
    if (connection.readOnly) return true
    let flagged: { sql: string; reason: string }[] = []
    try {
      flagged = splitStatements(sql, connection.dialect)
        .map((s) => ({ sql: s.text, c: classifyStatement(s.text, connection.dialect) }))
        .filter((s) => s.c.destructive)
        .map((s) => ({ sql: s.sql, reason: s.c.reason ?? s.c.command }))
    } catch {
      return true
    }
    if (flagged.length === 0) return true
    return useUi.getState().confirm({
      title: `Run destructive statement on “${connection.name}”?`,
      message: [...new Set(flagged.map((f) => f.reason))].join(' · '),
      detail: flagged.map((f) => f.sql).join(';\n\n'),
      confirmLabel: 'Run anyway',
      danger: true,
    })
  }

  /** Reload the completion catalog and the explorer's cached listings of the tab's database (after DDL). */
  function refreshAfterDdl(tabId: string): void {
    const tab = consoleTab(tabId)
    if (!tab) return
    const database = tab.database ?? defaultDatabase(tab.connectionId)
    if (!database) return
    void useCatalog.getState().load(tab.connectionId, database, true)
    void useExplorer.getState().refresh(tab.connectionId, database).catch(() => undefined)
  }

  /** Put a freshly opened / reconnected session in the console's desired commit mode. */
  async function applyCommitMode(tabId: string, info: SessionInfo): Promise<SessionInfo> {
    if (!wantsManualCommit(tabId) || !info.transaction.autoCommit) return info
    return { ...info, transaction: await api.session.setAutoCommit(info.sessionId, false) }
  }

  return {
    runtimes: {},
    prompts: {},
    runtime: (tabId) => get().runtimes[tabId] ?? EMPTY,

    ensureSession: (tabId) => {
      const existing = get().runtime(tabId).sessionId
      if (existing) return Promise.resolve(existing)
      const inflight = opening.get(tabId)
      if (inflight) return inflight
      const gen = generation(tabId)
      const stale = () => generation(tabId) !== gen || !consoleTab(tabId)
      const closeQuietly = (sessionId: string) => void api.session.close(sessionId).catch(() => undefined)

      const run = async (): Promise<string | null> => {
        const tab = consoleTab(tabId)
        if (!tab) return null
        if (!connectionById(tab.connectionId)) {
          patch(tabId, { error: { message: 'This console’s connection no longer exists.', detail: 'Choose another connection in the toolbar.', kind: 'not-found' } })
          return null
        }
        patch(tabId, { status: 'connecting', error: undefined })
        let opened: string | undefined
        try {
          const ok = await useConnections.getState().ensureConnected(tab.connectionId)
          if (stale()) return null
          if (!ok) {
            const runtime = useConnections.getState().runtime[tab.connectionId]
            // A cancelled password prompt is not an error; a failed connect is.
            const error: DbErrorInfo | undefined =
              runtime?.status === 'error' ? { message: 'Could not connect', detail: runtime.error, kind: 'connection' } : undefined
            patch(tabId, { status: 'idle', error })
            return null
          }
          const current = consoleTab(tabId) ?? tab
          const database = current.database ?? defaultDatabase(current.connectionId)
          let info = await api.session.open({ connectionId: current.connectionId, database })
          opened = info.sessionId
          if (stale()) {
            // the tab closed, switched connection or gave up while connecting
            closeQuietly(info.sessionId)
            return null
          }
          if (current.schema) info = await api.session.setSchema(info.sessionId, current.schema)
          info = await applyCommitMode(tabId, info)

          // Follow a database / schema picked in the toolbar while the session was opening.
          let reconcileError: DbErrorInfo | undefined
          const picked = consoleTab(tabId)
          if (!stale() && picked?.database && picked.database !== current.database && picked.database !== info.database) {
            try {
              info = await applyCommitMode(tabId, await api.session.setDatabase(info.sessionId, picked.database))
              opened = info.sessionId
            } catch (error) {
              reconcileError = errorInfo(error)
            }
          }
          const latest = consoleTab(tabId)
          if (!reconcileError && !stale() && latest?.schema && latest.schema !== current.schema && latest.schema !== info.schema) {
            try {
              info = await api.session.setSchema(info.sessionId, latest.schema)
            } catch (error) {
              reconcileError = errorInfo(error)
            }
          }
          if (stale()) {
            closeQuietly(info.sessionId)
            return null
          }
          const now = consoleTab(tabId)!
          if (now.database !== info.database || reconcileError) {
            useTabs.getState().updateConsole(tabId, { database: info.database, ...(reconcileError ? { schema: info.schema ?? current.schema } : {}) })
          }
          patch(tabId, { sessionId: info.sessionId, sessionSchema: info.schema, status: 'idle', transaction: info.transaction, error: reconcileError })
          return info.sessionId
        } catch (error) {
          if (opened) closeQuietly(opened)
          if (stale()) return null
          patch(tabId, { status: 'idle', error: errorInfo(error) })
          return null
        }
      }

      let abort: () => void = () => undefined
      const aborted = new Promise<null>((resolve) => (abort = () => resolve(null)))
      const promise: Promise<string | null> = Promise.race([run(), aborted]).finally(() => {
        if (opening.get(tabId) === promise) opening.delete(tabId)
        if (aborts.get(tabId) === abort) aborts.delete(tabId)
      })
      opening.set(tabId, promise)
      aborts.set(tabId, abort)
      return promise
    },

    execute: async (tabId, sql, offset = 0) => {
      if (!sql.trim() || busy.has(tabId) || get().runtime(tabId).status === 'running') return
      busy.add(tabId)
      try {
        const target = context(tabId)
        const prepared = await withParameters(tabId, sql)
        if (prepared === null) return
        if (!(await guard(tabId, prepared))) return
        const sessionId = await get().ensureSession(tabId)
        if (!sessionId) return
        // The user retargeted the console (connection / database) after pressing Run: do not run the
        // statement against something other than what it was written for.
        if (context(tabId) !== target) return
        const gen = generation(tabId)
        const view = get().runtime(tabId).resultView
        patch(tabId, {
          status: 'running',
          runningSince: Date.now(),
          error: undefined,
          explain: undefined,
          explainSql: undefined,
          liveMessages: [],
          resultView: view === 'explain' ? 'results' : view,
        })
        try {
          const execution = await api.session.execute(sessionId, prepared, { maxRows: useSettings.getState().settings.maxRows })
          if (generation(tabId) !== gen) return
          const rowsIndex = execution.results.findIndex((r) => r.kind === 'rows')
          const errorIndex = execution.results.findIndex((r) => r.kind === 'error')
          const activeResult = errorIndex >= 0 ? errorIndex : rowsIndex >= 0 ? rowsIndex : Math.max(0, execution.results.length - 1)
          const onlyCommands = execution.results.length > 0 && execution.results.every((r) => r.kind === 'command')
          patch(tabId, {
            status: 'idle',
            runningSince: undefined,
            liveMessages: undefined,
            execution,
            executionOffset: offset,
            activeResult,
            resultView: onlyCommands && execution.messages.length > 0 ? 'messages' : 'results',
            transaction: execution.transaction,
          })
          const tab = consoleTab(tabId)
          const dialect = connectionById(tab?.connectionId)?.dialect
          if (tab && dialect) {
            const effects = executionEffects(execution, dialect)
            if (effects.database && effects.database !== tab.database) {
              useTabs.getState().updateConsole(tabId, { database: effects.database, schema: undefined })
              void useCatalog.getState().load(tab.connectionId, effects.database)
            }
            if (effects.schemaChanged) refreshAfterDdl(tabId)
          }
        } catch (error) {
          if (generation(tabId) !== gen) return
          const info = errorInfo(error)
          const lost = error instanceof ApiError && (info.kind === 'connection' || info.kind === 'not-found')
          const hadTransaction = get().runtime(tabId).transaction.inTransaction
          patch(tabId, {
            status: 'idle',
            runningSince: undefined,
            liveMessages: undefined,
            error: lost && hadTransaction ? lostTransactionError(info, tabId) : info,
            ...(lost ? { sessionId: undefined, transaction: { autoCommit: !wantsManualCommit(tabId), inTransaction: false } } : {}),
          })
        }
      } finally {
        busy.delete(tabId)
      }
    },

    cancel: async (tabId) => {
      const { sessionId, status } = get().runtime(tabId)
      if (status === 'connecting') {
        // Give up on the pending connect: a session that opens later is closed right away.
        bumpGeneration(tabId)
        abortOpening(tabId)
        patch(tabId, { status: 'idle' })
        return
      }
      if (!sessionId || status !== 'running') return
      try {
        await api.session.cancel(sessionId)
      } catch (error) {
        // The statement keeps running: say so instead of leaving the user waiting on a silent Cancel.
        if (get().runtime(tabId).status === 'running') toast.error('Could not cancel the query', error)
      }
    },

    fetchMore: async (tabId, resultIndex) => {
      const runtime = get().runtime(tabId)
      const result = runtime.execution?.results[resultIndex]
      if (!runtime.sessionId || !result?.cursorId || !result.hasMore || runtime.loadingMore) return
      const gen = generation(tabId)
      patch(tabId, { loadingMore: true })
      try {
        const more = await api.session.fetchMore(runtime.sessionId, result.cursorId, useSettings.getState().settings.maxRows)
        const execution = get().runtime(tabId).execution
        if (generation(tabId) !== gen || !execution || execution.executionId !== runtime.execution?.executionId) {
          patch(tabId, { loadingMore: false })
          return
        }
        const results = execution.results.map((r, i) =>
          i === resultIndex
            ? { ...r, rows: [...r.rows, ...more.rows], rowCount: r.rows.length + more.rows.length, hasMore: more.hasMore }
            : r,
        )
        patch(tabId, { execution: { ...execution, results }, loadingMore: false })
      } catch (error) {
        if (generation(tabId) !== gen) return
        const info = errorInfo(error)
        const execution = get().runtime(tabId).execution
        // The cursor is gone (commit, rollback, idle release…): stop offering more rows everywhere.
        const gone = info.kind === 'not-found' && execution && execution.executionId === runtime.execution?.executionId
        patch(tabId, {
          loadingMore: false,
          error: info,
          ...(gone
            ? {
                execution: {
                  ...execution,
                  results: execution.results.map((r, i) => (i === resultIndex ? { ...r, hasMore: false, cursorId: undefined } : r)),
                },
              }
            : {}),
        })
      }
    },

    explain: async (tabId, sql, analyze) => {
      if (!sql.trim() || busy.has(tabId) || get().runtime(tabId).explaining || get().runtime(tabId).status === 'running') return
      busy.add(tabId)
      try {
        const target = context(tabId)
        const prepared = await withParameters(tabId, sql)
        if (prepared === null) return
        if (analyze && !(await guard(tabId, prepared))) return
        const sessionId = await get().ensureSession(tabId)
        if (!sessionId || context(tabId) !== target) return
        const gen = generation(tabId)
        patch(tabId, { explaining: true, error: undefined })
        try {
          const explain = await api.session.explain(sessionId, prepared, analyze)
          if (generation(tabId) !== gen) return
          // The plan replaces the previous output: result tabs of an older run would read as belonging to it.
          patch(tabId, { explain, explainSql: prepared.trim(), explaining: false, resultView: 'explain', execution: undefined, activeResult: 0 })
        } catch (error) {
          if (generation(tabId) !== gen) return
          patch(tabId, { explaining: false, error: errorInfo(error) })
        }
      } finally {
        busy.delete(tabId)
      }
    },

    setAutoCommit: async (tabId, autoCommit) => {
      setManualCommit(tabId, !autoCommit)
      const sessionId = await get().ensureSession(tabId)
      if (!sessionId) return
      if (get().runtime(tabId).transaction.autoCommit === autoCommit) return
      try {
        patch(tabId, { transaction: await api.session.setAutoCommit(sessionId, autoCommit), error: undefined })
      } catch (error) {
        patch(tabId, { error: errorInfo(error) })
      }
    },
    commit: async (tabId) => {
      const { sessionId } = get().runtime(tabId)
      if (!sessionId) return
      try {
        patch(tabId, { transaction: await api.session.commit(sessionId) })
      } catch (error) {
        patch(tabId, { error: errorInfo(error) })
      }
    },
    rollback: async (tabId) => {
      const { sessionId } = get().runtime(tabId)
      if (!sessionId) return
      try {
        patch(tabId, { transaction: await api.session.rollback(sessionId) })
      } catch (error) {
        patch(tabId, { error: errorInfo(error) })
      }
    },

    setDatabase: async (tabId, database, options) => {
      const { sessionId } = get().runtime(tabId)
      const previous = consoleTab(tabId)
      bumpContext(tabId)
      useTabs.getState().updateConsole(tabId, { database, schema: undefined })
      // No session yet: a session that is opening follows the new database once it is open (ensureSession).
      if (!sessionId) return
      const gen = generation(tabId)
      try {
        const info = await applyCommitMode(tabId, await api.session.setDatabase(sessionId, database, options))
        if (generation(tabId) !== gen) return
        patch(tabId, { sessionId: info.sessionId, sessionSchema: info.schema, transaction: info.transaction, error: undefined })
        if (info.database !== database) useTabs.getState().updateConsole(tabId, { database: info.database })
      } catch (error) {
        if (generation(tabId) !== gen) return
        // keep the tab on the database the session is actually using
        if (previous) useTabs.getState().updateConsole(tabId, { database: previous.database, schema: previous.schema })
        patch(tabId, { error: errorInfo(error) })
      }
    },
    setSchema: async (tabId, schema) => {
      const { sessionId } = get().runtime(tabId)
      const previous = consoleTab(tabId)?.schema
      useTabs.getState().updateConsole(tabId, { schema })
      if (!sessionId) return
      try {
        const info = await api.session.setSchema(sessionId, schema)
        patch(tabId, { transaction: info.transaction, sessionSchema: info.schema, error: undefined })
      } catch (error) {
        useTabs.getState().updateConsole(tabId, { schema: previous })
        patch(tabId, { error: errorInfo(error) })
      }
    },

    switchConnection: async (tabId, connectionId) => {
      const tab = consoleTab(tabId)
      if (!tab || tab.connectionId === connectionId) return
      bumpContext(tabId)
      await get().closeSession(tabId)
      useTabs.getState().updateConsole(tabId, { connectionId, database: undefined, schema: undefined })
    },

    setActiveResult: (tabId, activeResult) => patch(tabId, { activeResult, resultView: 'results' }),
    setResultView: (tabId, resultView) => patch(tabId, { resultView }),
    dismissError: (tabId) => patch(tabId, { error: undefined }),

    closeSession: async (tabId) => {
      const { sessionId } = get().runtime(tabId)
      bumpGeneration(tabId)
      abortOpening(tabId)
      const runtimes = { ...get().runtimes }
      delete runtimes[tabId]
      set({ runtimes })
      if (sessionId) await api.session.close(sessionId).catch(() => undefined)
    },

    clearParameterValues: (tabId) => {
      if (tabId) parameterValues.delete(tabId)
      else parameterValues.clear()
    },
    openSnippets: (tabId, options = {}) => {
      if (!consoleTab(tabId) || get().prompts[tabId]) return
      ask(tabId, { kind: 'snippets', view: options.view ?? 'list', draft: options.draft })
    },
    dismissPrompt: (tabId, prompt) => {
      if (get().prompts[tabId] !== prompt) return
      const prompts = { ...get().prompts }
      delete prompts[tabId]
      set({ prompts })
    },
  }
})

/** Ask what to do with a console's open transaction before its tab closes. Resolves false to keep the tab. */
async function confirmCloseWithTransaction(tab: ConsoleTab): Promise<boolean> {
  const store = useConsoles.getState()
  const runtime = store.runtime(tab.id)
  if (!runtime.sessionId || !runtime.transaction.inTransaction) return true
  useTabs.getState().setActive(tab.id)
  const connection = connectionById(tab.connectionId)
  let choice: 'commit' | 'rollback' | 'cancel'
  if (promptHosts.has(tab.id)) {
    choice = await new Promise((resolve) => {
      const prompt: ConsolePrompt = {
        kind: 'close-transaction',
        tabTitle: tab.title,
        connectionName: connection?.name,
        resolve,
      }
      useConsoles.setState({ prompts: { ...useConsoles.getState().prompts, [tab.id]: prompt } })
    })
  } else {
    // No console view to host the three-way dialog (e.g. the tab crashed): offer the safe choice only.
    const discard = await useUi.getState().confirm({
      title: `Close “${tab.title}” and roll back its transaction?`,
      message: 'The console has uncommitted changes. Closing it rolls them back.',
      confirmLabel: 'Roll back and close',
      danger: true,
    })
    choice = discard ? 'rollback' : 'cancel'
  }
  if (choice === 'cancel') return false
  const sessionId = useConsoles.getState().runtime(tab.id).sessionId
  if (!sessionId) return true
  if (choice === 'commit') {
    try {
      await api.session.commit(sessionId)
    } catch (error) {
      // Keep the tab: its changes are still pending and the user must decide again.
      useConsoles.setState({
        runtimes: { ...useConsoles.getState().runtimes, [tab.id]: { ...useConsoles.getState().runtime(tab.id), error: errorInfo(error) } },
      })
      return false
    }
    return true
  }
  await api.session.rollback(sessionId).catch(() => undefined)
  return true
}

/** Wire tab-close and session-lost events. Call once at startup. */
export function bindConsoleEvents(): () => void {
  const offGuard = registerCloseGuard((tab) => (tab.kind === 'console' ? confirmCloseWithTransaction(tab) : true))
  const offClose = onTabClosed((tab) => {
    if (tab.kind !== 'console') return
    void useConsoles.getState().closeSession(tab.id)
    useConsoles.getState().clearParameterValues(tab.id)
    setManualCommit(tab.id, false)
  })
  const offLost = onEvent('event:sessionClosed', ({ sessionId, reason }) => {
    const { runtimes } = useConsoles.getState()
    for (const [tabId, runtime] of Object.entries(runtimes)) {
      if (runtime.sessionId !== sessionId) continue
      // Nothing to click: the next run opens a new session (with the current credentials for a Vault connection).
      const error: DbErrorInfo = { message: 'Session closed', detail: reason, kind: 'connection', hint: 'Run a statement again to open a new session.' }
      useConsoles.setState({
        runtimes: {
          ...useConsoles.getState().runtimes,
          [tabId]: {
            ...runtime,
            sessionId: undefined,
            status: 'idle',
            runningSince: undefined,
            // The next session is opened in the desired mode again (ensureSession).
            transaction: { autoCommit: !wantsManualCommit(tabId), inTransaction: false },
            error: runtime.transaction.inTransaction ? lostTransactionError(error, tabId) : error,
          },
        },
      })
    }
  })
  // Notices / PRINT of a running script, shown live until the final result replaces them.
  const offMessages = onEvent('event:sessionMessages', ({ sessionId, messages }) => {
    const { runtimes } = useConsoles.getState()
    for (const [tabId, runtime] of Object.entries(runtimes)) {
      if (runtime.sessionId !== sessionId || runtime.status !== 'running' || !runtime.liveMessages) continue
      const liveMessages = [...runtime.liveMessages, ...messages].slice(0, MAX_LIVE_MESSAGES)
      useConsoles.setState({ runtimes: { ...useConsoles.getState().runtimes, [tabId]: { ...runtime, liveMessages } } })
    }
  })
  // Disconnecting a connection kills its sessions main-side; forget them here.
  const offConn = onEvent('event:connectionClosed', ({ connectionId }) => {
    const { runtimes } = useConsoles.getState()
    const tabs = useTabs.getState().tabs
    const next = { ...runtimes }
    for (const [tabId, runtime] of Object.entries(runtimes)) {
      const tab = tabs.find((t) => t.id === tabId)
      if (tab?.connectionId !== connectionId) continue
      next[tabId] = {
        ...runtime,
        sessionId: undefined,
        status: 'idle',
        runningSince: undefined,
        transaction: { autoCommit: !wantsManualCommit(tabId), inTransaction: false },
        error: runtime.transaction.inTransaction
          ? lostTransactionError({ message: 'Disconnected', detail: 'The connection was closed.', kind: 'connection' }, tabId)
          : runtime.error,
      }
    }
    useConsoles.setState({ runtimes: next })
  })
  return () => {
    offGuard()
    offClose()
    offLost()
    offMessages()
    offConn()
  }
}

