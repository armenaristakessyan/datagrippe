// Token-level checks on T-SQL text that the statement splitter cannot answer: T-SQL does not need ';'
// between statements, so "SELECT … FROM big\nSELECT 'second'" is one unit for splitStatementsFine.

import { classifyStatement } from '@shared/sql'
import { isSignificant, tokenize, type Token } from '@shared/sql/lexer'

/**
 * Keywords that can only start a new statement when they appear outside parentheses. Words that also
 * occur inside a query at depth 0 (END of CASE, OFFSET … FETCH, MERGE JOIN hints) are left out.
 */
const STATEMENT_STARTERS = new Set([
  'ALTER',
  'BACKUP',
  'BEGIN',
  'BREAK',
  'BULK',
  'CHECKPOINT',
  'CLOSE',
  'COMMIT',
  'CONTINUE',
  'CREATE',
  'DBCC',
  'DEALLOCATE',
  'DECLARE',
  'DELETE',
  'DENY',
  'DISABLE',
  'DROP',
  'ENABLE',
  'EXEC',
  'EXECUTE',
  'GOTO',
  'GRANT',
  'IF',
  'INSERT',
  'KILL',
  'OPEN',
  'PRINT',
  'RAISERROR',
  'READTEXT',
  'RECONFIGURE',
  'RESTORE',
  'RETURN',
  'REVERT',
  'REVOKE',
  'ROLLBACK',
  'SAVE',
  'SET',
  'SETUSER',
  'SHUTDOWN',
  'THROW',
  'TRUNCATE',
  'UPDATE',
  'UPDATETEXT',
  'USE',
  'WAITFOR',
  'WHILE',
  'WRITETEXT',
])

/** A depth-0 SELECT after one of these continues the same query (set operators). */
const SET_OPERATORS = new Set(['UNION', 'ALL', 'EXCEPT', 'INTERSECT'])

function punct(sql: string, token: Token): string {
  return token.kind === 'punct' ? sql[token.start] ?? '' : ''
}

/**
 * True when `sql` is exactly one read-only query (SELECT or WITH … SELECT): one top-level SELECT
 * (set operators aside), no other statement before or after it, no ';' followed by more text.
 * Only such a batch may be paged by re-running it: anything else must run to completion once.
 */
export function isSingleReadOnlyQuery(sql: string): boolean {
  const tokens = tokenize(sql, 'mssql').filter(isSignificant)
  const first = tokens[0]
  if (!first || (first.upper !== 'SELECT' && first.upper !== 'WITH')) return false
  let depth = 0
  let selects = 0
  let ended = false
  let previous: Token | undefined
  for (const token of tokens) {
    if (ended) return false
    const p = punct(sql, token)
    if (p === '(') depth += 1
    else if (p === ')') depth -= 1
    else if (p === ';' && depth === 0) ended = true
    else if (depth === 0 && token.kind === 'word') {
      if (token.upper === 'SELECT') {
        if (!previous || previous.kind !== 'word' || !SET_OPERATORS.has(previous.upper)) selects += 1
      } else if (STATEMENT_STARTERS.has(token.upper)) {
        return false
      }
    }
    if (depth < 0) return false
    previous = token
  }
  if (selects !== 1 || depth !== 0) return false
  const classification = classifyStatement(sql, 'mssql')
  return classification.readOnly && (classification.command === 'SELECT' || classification.command === 'WITH')
}
