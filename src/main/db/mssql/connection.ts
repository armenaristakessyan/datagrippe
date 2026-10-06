// Opening / closing a single tedious connection.

import type { Connection } from 'tedious'
import { DriverError } from '../errors'
import { tedious } from './tedious-runtime'
import { toDriverError } from './error-mapping'
import { tediousConfig, type CommonOptions } from './config'

/** The generic "Login failed for user …" that SQL Server sends after the precise login error. */
const GENERIC_LOGIN_FAILED = 18456
/** "Cannot open database "x" requested by the login. The login failed." */
const CANNOT_OPEN_DATABASE = 4060

export interface LoginErrorToken {
  number: number
  message: string
}

/**
 * The login error to report. SQL Server sends the precise cause first (4060 "Cannot open database
 * … requested by the login", 18486 account locked…) and then the generic 18456, and tedious keeps
 * only the last one: prefer the first token that is not 18456.
 */
export function loginFailure(error: unknown, tokens: LoginErrorToken[]): DriverError {
  const precise = tokens.find((token) => token.number !== GENERIC_LOGIN_FAILED)
  if (precise?.number === CANNOT_OPEN_DATABASE) {
    // Not a credential problem: say so instead of ending on "The login failed."
    const message = precise.message.replace(/\s*The login failed\.?\s*$/i, '')
    return DriverError.of('connection', `${message} Check that the database exists and that this login can open it.`, {
      code: String(precise.number),
      detail: precise.message,
    })
  }
  if (precise) return DriverError.of('connection', precise.message, { code: String(precise.number) })
  return toDriverError(error, tokens.at(-1)?.number)
}

/** Connect and resolve once logged in; rejects with a DriverError (kind 'connection'). */
export function openConnection(options: CommonOptions): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const connection = new tedious.Connection(tediousConfig(options))
    const tokens: LoginErrorToken[] = []
    let settled = false
    const onErrorMessage = (token: { number: number; message: string }): void => {
      tokens.push({ number: token.number, message: token.message })
    }
    const onError = (error: Error): void => {
      if (settled) return
      settled = true
      reject(loginFailure(error, tokens))
    }
    connection.on('errorMessage', onErrorMessage)
    connection.on('error', onError)
    connection.connect((error) => {
      connection.removeListener('errorMessage', onErrorMessage)
      if (settled) return
      settled = true
      if (error) {
        connection.removeListener('error', onError)
        // tedious may still emit 'error' on the failed socket; keep a no-op listener.
        connection.on('error', () => undefined)
        connection.close()
        reject(loginFailure(error, tokens))
        return
      }
      connection.removeListener('error', onError)
      resolve(connection)
    })
  })
}

/** Close the socket and wait for the 'end' event (bounded, so a dead socket cannot hang us). */
export function closeConnection(connection: Connection, timeoutMs = 3000): Promise<void> {
  if (connection.closed) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    connection.once('end', finish)
    try {
      connection.close()
    } catch {
      finish()
    }
  })
}
