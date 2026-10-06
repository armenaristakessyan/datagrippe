import type { DbErrorInfo } from '@shared/types'
import { DriverError } from '../errors'

/** Fields of a server ErrorResponse as parsed by pg-protocol (DatabaseError). */
export interface PgServerError extends Error {
  code: string
  severity?: string
  detail?: string
  hint?: string
  position?: string
  where?: string
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'ECONNABORTED',
])

/**
 * SQLSTATEs the server sends when it terminates a live session (always with severity FATAL, which can be
 * localized by lc_messages, hence the code check). Connect-time failures go through toConnectionError.
 */
const TERMINATION_SQLSTATES = new Set(['57P01', '57P02', '57P03'])

/** Severities after which the server closes the connection. */
const FATAL_SEVERITIES = new Set(['FATAL', 'PANIC'])

/** Message used when the pool cannot hand out a connection in time (pg-pool's own wording). */
const POOL_TIMEOUT_MESSAGE = /timeout exceeded when trying to connect/i

const CONNECTION_MESSAGE =
  /connection terminated|timeout expired|connection timeout|does not support ssl|server closed the connection|not queryable|client was closed|self[- ]signed|certificate|ssl/i

/** A pg DatabaseError (ErrorResponse from the server), recognised structurally. */
export function isServerError(error: unknown): error is PgServerError {
  if (!(error instanceof Error)) return false
  const e = error as Error & { code?: unknown; severity?: unknown }
  return typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && typeof e.severity === 'string'
}

function nodeErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const code = (error as Error & { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Whether an error raised on an established connection means that connection is gone.
 * Server errors decide by severity, not by SQLSTATE: a statement can legitimately fail with 3D000
 * (DROP DATABASE of a missing database) or class 08 (dblink, postgres_fdw, RAISE … USING ERRCODE)
 * while the session stays perfectly usable.
 */
export function isConnectionLevel(error: unknown): boolean {
  if (isServerError(error)) {
    return FATAL_SEVERITIES.has((error.severity ?? '').toUpperCase()) || TERMINATION_SQLSTATES.has(error.code)
  }
  const code = nodeErrorCode(error)
  if (code && NETWORK_CODES.has(code)) return true
  return error instanceof Error && CONNECTION_MESSAGE.test(error.message)
}

/** DbErrorInfo for a server error; `position` is the 1-based offset inside the statement sent. */
export function serverErrorInfo(error: PgServerError): DbErrorInfo {
  const position = error.position !== undefined ? Number.parseInt(error.position, 10) : undefined
  return {
    message: error.message,
    code: error.code,
    severity: error.severity,
    detail: error.detail,
    hint: error.hint,
    // Where it happened inside server-side code: "PL/pgSQL function f() line 3 at RAISE", "SQL statement …".
    context: error.where?.trim() || undefined,
    position: position !== undefined && Number.isFinite(position) ? position : undefined,
    kind: 'database',
  }
}

function describeNetworkError(error: Error, code: string | undefined): string {
  switch (code) {
    case 'ECONNREFUSED':
      return `Connection refused (${error.message.replace(/^connect ECONNREFUSED\s*/, '') || 'is the server running?'})`
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Host not found: ${error.message.replace(/^getaddrinfo \w+\s*/, '')}`
    case 'ETIMEDOUT':
      return 'Connection timed out'
    default:
      return error.message || String(error)
  }
}

/** Errors raised while establishing a connection: always kind 'connection'. */
export function toConnectionError(error: unknown): DriverError {
  if (error instanceof DriverError) return error
  if (isServerError(error)) {
    return DriverError.of('connection', error.message, {
      code: error.code,
      severity: error.severity,
      detail: error.detail,
      hint: error.hint,
    })
  }
  if (error instanceof Error) {
    const code = nodeErrorCode(error)
    return DriverError.of('connection', describeNetworkError(error, code), { code })
  }
  return DriverError.of('connection', String(error))
}

/** Errors raised by a query on an established connection. */
export function toDriverError(error: unknown): DriverError {
  if (error instanceof DriverError) return error
  if (error instanceof Error && !isServerError(error) && POOL_TIMEOUT_MESSAGE.test(error.message)) {
    return DriverError.of(
      'connection',
      'Timed out waiting for a free connection: the explorer / table editor connections are all busy with other queries.',
    )
  }
  if (isConnectionLevel(error)) return toConnectionError(error)
  if (isServerError(error)) return new DriverError(serverErrorInfo(error))
  if (error instanceof Error) return DriverError.of('internal', error.message || String(error), { code: nodeErrorCode(error) })
  return DriverError.of('internal', String(error))
}
