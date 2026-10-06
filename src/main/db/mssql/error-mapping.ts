// tedious / mssql errors → DriverError / DbErrorInfo.

import type { DbErrorInfo } from '@shared/types'
import { isSignificant, tokenize } from '@shared/sql/lexer'
import { DriverError } from '../errors'

/** Fields carried by tedious RequestError / ERROR tokens and mssql RequestError. */
export interface SqlErrorFields {
  message: string
  number?: number
  class?: number
  state?: number
  lineNumber?: number
  procName?: string
}

const CONNECTION_CODES = new Set([
  'ELOGIN',
  'ESOCKET',
  'ETIMEOUT',
  'EINSTLOOKUP',
  'ECONNCLOSED',
  'ECLOSE',
  'ENOTOPEN',
  'EENCRYPT',
  'EALREADYCONNECTED',
  'EALREADYCONNECTING',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ECONNRESET',
])

function field(error: object, name: string): unknown {
  return (error as Record<string, unknown>)[name]
}

function numberField(error: object, name: string): number | undefined {
  const value = field(error, name)
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringField(error: object, name: string): string | undefined {
  const value = field(error, name)
  return typeof value === 'string' && value !== '' ? value : undefined
}

const MODULE_KINDS = new Set(['PROC', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'VIEW'])

function unquoteName(text: string): string {
  if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1).replace(text.startsWith('[') ? /]]/g : /""/g, text.startsWith('[') ? ']' : '"')
  }
  return text
}

/**
 * True when `sql` creates or alters the module `procName` (CREATE [OR ALTER] / ALTER PROCEDURE…):
 * errors raised while compiling it are numbered by the lines of the batch itself.
 */
export function definesModule(sql: string, procName: string): boolean {
  const tokens = tokenize(sql, 'mssql').filter(isSignificant)
  const wanted = procName.toLowerCase()
  for (let i = 0; i < tokens.length; i++) {
    const head = tokens[i]
    if (head?.upper !== 'CREATE' && head?.upper !== 'ALTER') continue
    let j = i + 1
    if (tokens[j]?.upper === 'OR' && tokens[j + 1]?.upper === 'ALTER') j += 2
    if (!MODULE_KINDS.has(tokens[j]?.upper ?? '')) continue
    // Multi-part name: the last identifier before anything that is not a dot.
    let last: string | undefined
    for (let k = j + 1; k < tokens.length; k++) {
      const token = tokens[k]
      if (!token) break
      if (token.kind === 'word' || token.kind === 'quoted-ident') {
        last = unquoteName(sql.slice(token.start, token.end))
        if (sql[tokens[k + 1]?.start ?? -1] !== '.') break
        k += 1
        continue
      }
      break
    }
    if (last?.toLowerCase() === wanted) return true
  }
  return false
}

/**
 * Error info for one SQL Server error message (severity ≥ 11). An error raised inside a stored
 * procedure, function or trigger is numbered by the lines of that module, not of the batch: its
 * line goes to `detail` ("Line 5 of dbo.p") so the editor does not underline an unrelated line of
 * the calling batch — unless `batchSql` is the CREATE / ALTER of that very module.
 */
export function sqlErrorInfo(error: SqlErrorFields, batchSql?: string): DbErrorInfo {
  const info: DbErrorInfo = { message: error.message, kind: 'database' }
  if (error.number !== undefined) info.code = String(error.number)
  if (error.class !== undefined) info.severity = String(error.class)
  const line = error.lineNumber !== undefined && error.lineNumber > 0 ? error.lineNumber : undefined
  if (error.procName) {
    const own = batchSql !== undefined && definesModule(batchSql, error.procName)
    if (line !== undefined && own) info.line = line
    info.detail = line !== undefined && !own ? `Line ${line} of ${error.procName}` : `In ${error.procName}`
  } else if (line !== undefined) {
    info.line = line
  }
  return info
}

/** Unwrap mssql's `originalError` and tedious' AggregateError to the first SQL error. */
function innermost(error: object): object {
  let current: object = error
  for (let depth = 0; depth < 5; depth++) {
    if (current instanceof AggregateError && current.errors.length > 0) {
      const first: unknown = current.errors[0]
      if (typeof first === 'object' && first !== null) {
        current = first
        continue
      }
    }
    const original = field(current, 'originalError')
    if (typeof original === 'object' && original !== null && numberField(current, 'number') === undefined) {
      current = original
      continue
    }
    break
  }
  return current
}

/**
 * Map anything tedious/mssql throws. `loginNumber` is the server error number captured from the
 * ERROR token received during login (tedious' ConnectionError does not carry it).
 */
export function toDriverError(error: unknown, loginNumber?: number): DriverError {
  if (error instanceof DriverError) return error
  if (typeof error !== 'object' || error === null) {
    return DriverError.of('internal', String(error))
  }
  const outer = error
  const inner = innermost(error)
  const message = stringField(inner, 'message') ?? stringField(outer, 'message') ?? String(error)
  const code = stringField(outer, 'code') ?? stringField(inner, 'code')
  const number = numberField(inner, 'number') ?? numberField(outer, 'number')

  if (code === 'ECANCEL') return DriverError.of('cancelled', 'Statement cancelled', { code })
  if (code !== undefined && CONNECTION_CODES.has(code) && number === undefined) {
    const extra: Partial<DbErrorInfo> = { code: loginNumber !== undefined ? String(loginNumber) : code }
    return DriverError.of('connection', message, extra)
  }
  if (number !== undefined) {
    return new DriverError(
      sqlErrorInfo({
        message,
        number,
        class: numberField(inner, 'class'),
        state: numberField(inner, 'state'),
        lineNumber: numberField(inner, 'lineNumber'),
        procName: stringField(inner, 'procName'),
      }),
    )
  }
  return DriverError.of('internal', message, code ? { code } : {})
}
