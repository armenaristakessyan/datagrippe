import { describe, expect, it } from 'vitest'
import { DriverError } from '../errors'
import { definesModule, sqlErrorInfo, toDriverError } from './error-mapping'

describe('sqlErrorInfo', () => {
  it('maps number, class and line', () => {
    expect(sqlErrorInfo({ message: 'Divide by zero', number: 8134, class: 16, lineNumber: 2, procName: '' })).toEqual({
      message: 'Divide by zero',
      kind: 'database',
      code: '8134',
      severity: '16',
      line: 2,
    })
    expect(sqlErrorInfo({ message: 'x', number: 1, lineNumber: 0, procName: '' })).toEqual({ message: 'x', kind: 'database', code: '1' })
  })

  it('reports the line of an error inside a module as a line of that module, not of the batch', () => {
    const inProc = sqlErrorInfo({ message: 'Divide by zero', number: 8134, class: 16, lineNumber: 5, procName: 'p' }, 'EXEC dbo.p')
    expect(inProc).toEqual({ message: 'Divide by zero', kind: 'database', code: '8134', severity: '16', detail: 'Line 5 of p' })
    expect(sqlErrorInfo({ message: 'x', number: 1, procName: 'p' })).toMatchObject({ detail: 'In p' })
    // Compiling CREATE / ALTER of the module itself: lines are lines of the batch.
    for (const batch of ['CREATE PROCEDURE dbo.p AS\nSELECT 1', 'create or alter proc [dbo].[p] as select 1', 'ALTER FUNCTION p() RETURNS int AS BEGIN RETURN 1 END']) {
      expect(sqlErrorInfo({ message: 'x', number: 102, lineNumber: 2, procName: 'p' }, batch), batch).toMatchObject({ line: 2, detail: 'In p' })
    }
  })
})

describe('definesModule', () => {
  it('matches the last part of the created module name', () => {
    expect(definesModule('CREATE TRIGGER sales.trg ON sales.orders AFTER UPDATE AS SELECT 1', 'trg')).toBe(true)
    expect(definesModule('-- CREATE PROCEDURE p\nEXEC p', 'p')).toBe(false)
    expect(definesModule('CREATE PROCEDURE other AS EXEC p', 'p')).toBe(false)
  })
})

describe('toDriverError', () => {
  it('maps connection failures, preferring the login error number', () => {
    const login = Object.assign(new Error("Login failed for user 'sa'."), { code: 'ELOGIN' })
    expect(toDriverError(login, 18456).info).toEqual({ message: "Login failed for user 'sa'.", kind: 'connection', code: '18456' })
    const socket = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ESOCKET' })
    expect(toDriverError(socket).info).toMatchObject({ kind: 'connection', code: 'ESOCKET' })
  })

  it('unwraps mssql originalError and AggregateError to the SQL error', () => {
    const inner = Object.assign(new Error('Invalid object name'), { number: 208, class: 16, lineNumber: 1 })
    const wrapped = Object.assign(new Error('Invalid object name'), { code: 'EREQUEST', originalError: inner })
    expect(toDriverError(wrapped).info).toMatchObject({ kind: 'database', code: '208', severity: '16', line: 1 })
    const aggregate = new AggregateError([inner, new Error('second')], 'many')
    expect(toDriverError(aggregate).info).toMatchObject({ kind: 'database', code: '208' })
  })

  it('maps cancellation and passes DriverErrors through', () => {
    expect(toDriverError(Object.assign(new Error('Canceled.'), { code: 'ECANCEL' })).info.kind).toBe('cancelled')
    const own = DriverError.of('not-found', 'nope')
    expect(toDriverError(own)).toBe(own)
    expect(toDriverError('weird').info).toEqual({ message: 'weird', kind: 'internal' })
  })
})

describe('loginFailure', () => {
  it('prefers the precise login error over the generic 18456', async () => {
    const { loginFailure } = await import('./connection')
    const error = Object.assign(new Error("Login failed for user 'sa'."), { code: 'ELOGIN' })
    const db = loginFailure(error, [
      { number: 4060, message: 'Cannot open database "nope" requested by the login. The login failed.' },
      { number: 18456, message: "Login failed for user 'sa'." },
    ]).info
    expect(db).toMatchObject({ kind: 'connection', code: '4060' })
    expect(db.message).toBe('Cannot open database "nope" requested by the login. Check that the database exists and that this login can open it.')
    expect(loginFailure(error, [{ number: 18456, message: "Login failed for user 'sa'." }]).info).toMatchObject({ code: '18456' })
  })
})
