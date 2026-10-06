// Server activity: the SQL that lists sessions (pg_stat_activity / sys.dm_exec_*), the parsing of its
// result into ServerSession records, and the statements that cancel or end another session.
import type { CellValue, Dialect, StatementResult } from '@shared/types'

export interface ServerSession {
  /** Backend pid (PostgreSQL) or session_id / SPID (SQL Server). */
  pid: number
  user: string | null
  database: string | null
  application: string | null
  client: string | null
  /** active, idle, idle in transaction… (PostgreSQL); running, sleeping, suspended… (SQL Server). */
  state: string | null
  wait: string | null
  /** Sessions holding the locks this one waits for ("123, 456"). */
  blockedBy: string | null
  /** Time in the current state (running query, idle…), ms. */
  stateMs: number | null
  /** Age of the open transaction, ms; null when none. */
  transactionMs: number | null
  inTransaction: boolean
  query: string | null
  /** The session this view itself uses. */
  self: boolean
}

/** Marks the statements of this view in logs and pg_stat_activity. */
const TAG = '/* DataGrippe: server sessions */'

export const SESSIONS_SQL: Record<Dialect, string> = {
  postgres: `${TAG}
SELECT a.pid,
  a.usename AS user_name,
  a.datname AS database_name,
  a.application_name,
  host(a.client_addr) AS client,
  a.state,
  CASE WHEN a.wait_event IS NULL THEN NULL ELSE a.wait_event_type || ': ' || a.wait_event END AS wait,
  NULLIF(array_to_string(pg_blocking_pids(a.pid), ', '), '') AS blocked_by,
  (EXTRACT(EPOCH FROM clock_timestamp() - COALESCE(CASE WHEN a.state = 'active' THEN a.query_start END, a.state_change)) * 1000)::float8 AS state_ms,
  (EXTRACT(EPOCH FROM clock_timestamp() - a.xact_start) * 1000)::float8 AS transaction_ms,
  a.xact_start IS NOT NULL AS in_transaction,
  a.query,
  a.pid = pg_backend_pid() AS is_self
FROM pg_stat_activity a
WHERE a.backend_type = 'client backend'
ORDER BY a.pid = pg_backend_pid(), a.state IS DISTINCT FROM 'active', a.query_start NULLS LAST, a.pid`,
  mssql: `${TAG}
SELECT s.session_id AS pid,
  s.login_name AS user_name,
  DB_NAME(COALESCE(r.database_id, s.database_id)) AS database_name,
  s.program_name AS application_name,
  COALESCE(c.client_net_address, s.host_name) AS client,
  COALESCE(r.status, s.status) AS state,
  r.wait_type AS wait,
  CASE WHEN r.blocking_session_id > 0 THEN CAST(r.blocking_session_id AS nvarchar(20)) END AS blocked_by,
  CAST(DATEDIFF_BIG(MILLISECOND, COALESCE(r.start_time, s.last_request_end_time, s.login_time), SYSDATETIME()) AS float) AS state_ms,
  CAST(DATEDIFF_BIG(MILLISECOND, tx.transaction_begin_time, SYSDATETIME()) AS float) AS transaction_ms,
  CAST(CASE WHEN s.open_transaction_count > 0 THEN 1 ELSE 0 END AS bit) AS in_transaction,
  t.text AS query,
  CAST(CASE WHEN s.session_id = @@SPID THEN 1 ELSE 0 END AS bit) AS is_self
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
LEFT JOIN sys.dm_exec_connections c ON c.session_id = s.session_id AND c.parent_connection_id IS NULL
OUTER APPLY (
  SELECT MIN(at.transaction_begin_time) AS transaction_begin_time
  FROM sys.dm_tran_session_transactions st
  JOIN sys.dm_tran_active_transactions at ON at.transaction_id = st.transaction_id
  WHERE st.session_id = s.session_id
) tx
OUTER APPLY sys.dm_exec_sql_text(COALESCE(r.sql_handle, c.most_recent_sql_handle)) t
WHERE s.is_user_process = 1
ORDER BY CASE WHEN s.session_id = @@SPID THEN 1 ELSE 0 END, CASE WHEN r.session_id IS NULL THEN 1 ELSE 0 END, s.session_id`,
}

const text = (v: CellValue | undefined): string | null => (v === null || v === undefined || v === '' ? null : String(v))
const num = (v: CellValue | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
const bool = (v: CellValue | undefined): boolean => v === true || v === 1 || v === '1' || v === 't' || v === 'true'

/** Turn the rows of SESSIONS_SQL into sessions (columns are looked up by name). */
export function parseSessions(result: Pick<StatementResult, 'columns' | 'rows'>): ServerSession[] {
  const index = new Map(result.columns.map((c, i) => [c.name.toLowerCase(), i]))
  const at = (row: CellValue[], name: string) => {
    const i = index.get(name)
    return i === undefined ? undefined : row[i]
  }
  const out: ServerSession[] = []
  for (const row of result.rows) {
    const pid = num(at(row, 'pid'))
    if (pid === null) continue
    const transactionMs = num(at(row, 'transaction_ms'))
    out.push({
      pid,
      user: text(at(row, 'user_name')),
      database: text(at(row, 'database_name')),
      application: text(at(row, 'application_name')),
      client: text(at(row, 'client')),
      state: text(at(row, 'state')),
      wait: text(at(row, 'wait')),
      blockedBy: text(at(row, 'blocked_by')),
      stateMs: num(at(row, 'state_ms')),
      transactionMs,
      inTransaction: bool(at(row, 'in_transaction')) || transactionMs !== null,
      query: text(at(row, 'query')),
      self: bool(at(row, 'is_self')),
    })
  }
  return out
}

/** Running something right now (as opposed to idle / sleeping). */
export function isActive(session: ServerSession): boolean {
  const state = session.state?.toLowerCase() ?? ''
  return state === 'active' || state === 'running' || state === 'runnable' || state === 'suspended'
}

/** Case-insensitive match on user, database, application, client, state and query; plus the idle filter. */
export function filterSessions(sessions: readonly ServerSession[], query: string, hideIdle: boolean): ServerSession[] {
  const needle = query.trim().toLowerCase()
  return sessions.filter((s) => {
    if (hideIdle && !isActive(s) && !s.inTransaction) return false
    if (!needle) return true
    return [String(s.pid), s.user, s.database, s.application, s.client, s.state, s.wait, s.query].some((v) => v?.toLowerCase().includes(needle))
  })
}

export type SessionAction = 'cancel' | 'terminate'

/** SQL Server cannot cancel another session's request without ending the session (KILL). */
export function supportsCancel(dialect: Dialect): boolean {
  return dialect === 'postgres'
}

/** Statement that cancels the running query of / ends the session `pid`. */
export function sessionActionSql(dialect: Dialect, action: SessionAction, pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid session id: ${pid}`)
  if (dialect === 'mssql') {
    if (action === 'cancel') throw new Error('SQL Server cannot cancel another session’s query; terminate it instead.')
    return `KILL ${pid}`
  }
  return action === 'cancel' ? `SELECT pg_cancel_backend(${pid}) AS done` : `SELECT pg_terminate_backend(${pid}) AS done`
}

/** False when the server answered that nothing was signalled (PostgreSQL returns false). */
export function actionSucceeded(dialect: Dialect, result: Pick<StatementResult, 'kind' | 'rows'> | undefined): boolean {
  if (!result || result.kind === 'error') return false
  if (dialect === 'mssql') return true
  const value = result.rows[0]?.[0]
  return bool(value ?? null)
}
