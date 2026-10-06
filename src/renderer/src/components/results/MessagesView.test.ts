import { describe, expect, it } from 'vitest'
import type { ExecutionResult, StatementResult } from '@shared/types'
import { messageEntries, messagesText } from './MessagesView'

function result(partial: Partial<StatementResult>): StatementResult {
  return { index: 0, sql: 'select 1', offset: 0, kind: 'command', columns: [], rows: [], rowCount: null, hasMore: false, durationMs: 1, ...partial }
}

const execution: ExecutionResult = {
  executionId: 'e',
  cancelled: false,
  results: [
    result({ index: 0, sql: 'create temp table t (a int)', command: 'CREATE TABLE' }),
    result({ index: 1, sql: 'insert into t values (1), (2)', command: 'INSERT', rowCount: 2 }),
    result({ index: 2, sql: "do $$ begin raise notice 'hi'; end $$", command: 'DO' }),
  ],
  messages: [
    { level: 'info', text: 'CREATE TABLE · 1 ms', at: 1000 },
    { level: 'info', text: 'INSERT · 2 rows affected · 1 ms', at: 1001 },
    { level: 'notice', text: 'hi', at: 1002 },
    { level: 'info', text: 'DO · 1 ms', at: 1003 },
  ],
} as unknown as ExecutionResult

describe('messages', () => {
  it('lists every statement once, in place of its summary line', () => {
    expect(messageEntries(execution).map((e) => (e.type === 'message' ? e.message.text : `#${e.index}`))).toEqual(['#0', '#1', 'hi', '#2'])
  })
  it('does not repeat the command in the statement line', () => {
    const text = messagesText(execution, 'postgres')
    expect(text).toContain('[1] CREATE TABLE (1 ms)')
    expect(text).not.toContain('CREATE TABLE — CREATE TABLE completed')
    expect(text).toContain('[2] INSERT — 2 rows affected')
    expect(text).toContain('NOTICE  hi')
  })
})
