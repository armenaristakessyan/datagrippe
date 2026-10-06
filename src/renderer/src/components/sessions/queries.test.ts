import { describe, expect, it } from 'vitest'
import type { ColumnMeta } from '@shared/types'
import { actionSucceeded, filterSessions, isActive, parseSessions, sessionActionSql, SESSIONS_SQL, supportsCancel } from './queries'

const names = ['pid', 'user_name', 'database_name', 'application_name', 'client', 'state', 'wait', 'blocked_by', 'state_ms', 'transaction_ms', 'in_transaction', 'query', 'is_self']
const columns: ColumnMeta[] = names.map((name) => ({ name, dataType: 'text' }))

describe('parseSessions', () => {
  it('maps columns by name and normalises types', () => {
    const sessions = parseSessions({
      columns,
      rows: [
        [42, 'app', 'shop', 'psql', '10.0.0.1', 'active', 'Lock: relation', '7, 8', 1500.5, 3000, true, 'UPDATE t SET x = 1', false],
        ['53', 'sa', 'master', 'DataGrippe', null, 'running', null, null, '12', null, 0, 'SELECT 1', 1],
        [null, 'ghost', null, null, null, null, null, null, null, null, false, null, false],
      ],
    })
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).toEqual({
      pid: 42,
      user: 'app',
      database: 'shop',
      application: 'psql',
      client: '10.0.0.1',
      state: 'active',
      wait: 'Lock: relation',
      blockedBy: '7, 8',
      stateMs: 1500.5,
      transactionMs: 3000,
      inTransaction: true,
      query: 'UPDATE t SET x = 1',
      self: false,
    })
    expect(sessions[1]).toMatchObject({ pid: 53, client: null, stateMs: 12, inTransaction: false, self: true })
  })
})

describe('filterSessions', () => {
  const sessions = parseSessions({
    columns,
    rows: [
      [1, 'app', 'shop', 'api', null, 'active', null, null, 1, null, false, 'SELECT * FROM orders', false],
      [2, 'etl', 'dwh', 'airflow', null, 'idle', null, null, 1, null, false, 'COMMIT', false],
      [3, 'etl', 'dwh', 'airflow', null, 'idle in transaction', null, null, 1, 5, true, 'UPDATE facts', false],
    ],
  })
  it('matches user, database, application and query, case-insensitively', () => {
    expect(filterSessions(sessions, 'ORDERS', false).map((s) => s.pid)).toEqual([1])
    expect(filterSessions(sessions, 'dwh', false).map((s) => s.pid)).toEqual([2, 3])
    expect(filterSessions(sessions, '3', false).map((s) => s.pid)).toEqual([3])
  })
  it('hides idle sessions but keeps idle ones holding a transaction', () => {
    expect(filterSessions(sessions, '', true).map((s) => s.pid)).toEqual([1, 3])
  })
  it('knows the active states of both engines', () => {
    expect(isActive(sessions[0]!)).toBe(true)
    expect(isActive({ ...sessions[0]!, state: 'suspended' })).toBe(true)
    expect(isActive({ ...sessions[0]!, state: 'sleeping' })).toBe(false)
  })
})

describe('session actions', () => {
  it('builds the cancel / terminate statements', () => {
    expect(sessionActionSql('postgres', 'cancel', 123)).toBe('SELECT pg_cancel_backend(123) AS done')
    expect(sessionActionSql('postgres', 'terminate', 123)).toBe('SELECT pg_terminate_backend(123) AS done')
    expect(sessionActionSql('mssql', 'terminate', 57)).toBe('KILL 57')
    expect(supportsCancel('mssql')).toBe(false)
    expect(() => sessionActionSql('mssql', 'cancel', 57)).toThrow(/terminate it instead/)
  })
  it('never interpolates anything but a positive integer', () => {
    expect(() => sessionActionSql('postgres', 'terminate', 1.5)).toThrow()
    expect(() => sessionActionSql('postgres', 'terminate', -1)).toThrow()
    expect(() => sessionActionSql('mssql', 'terminate', Number.NaN)).toThrow()
  })
  it('reads whether PostgreSQL signalled the backend', () => {
    expect(actionSucceeded('postgres', { kind: 'rows', rows: [[true]] })).toBe(true)
    expect(actionSucceeded('postgres', { kind: 'rows', rows: [[false]] })).toBe(false)
    expect(actionSucceeded('mssql', { kind: 'command', rows: [] })).toBe(true)
    expect(actionSucceeded('mssql', { kind: 'error', rows: [] })).toBe(false)
  })
  it('lists sessions with one statement per dialect', () => {
    expect(SESSIONS_SQL.postgres).toMatch(/FROM pg_stat_activity/)
    expect(SESSIONS_SQL.mssql).toMatch(/FROM sys\.dm_exec_sessions/)
    expect(SESSIONS_SQL.postgres).not.toMatch(/;\s*\S/)
  })
})
