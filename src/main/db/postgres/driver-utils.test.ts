import { describe, expect, it } from 'vitest'
import type { ResolvedConnection } from '../types'
import { DriverError } from '../errors'
import { compareObjects, isSystemSchema } from './catalog'
import { buildChange, referencedColumns } from './changes'
import { clientConfig, initialTls } from './connect'
import { parseCommandTag } from './cursor'
import { decodeTriggerType } from './details'
import { isConnectionLevel, isServerError, serverErrorInfo, toConnectionError, toDriverError } from './errors'
import { OID, pgTypes, toCell } from './values'

const parse = (oid: number, text: string) => pgTypes.getTypeParser(oid, 'text')(text)

describe('value parsers', () => {
  it('converts only booleans and exact numbers', () => {
    expect(parse(OID.bool, 't')).toBe(true)
    expect(parse(OID.bool, 'f')).toBe(false)
    expect(parse(OID.int2, '-32768')).toBe(-32768)
    expect(parse(OID.int4, '2147483647')).toBe(2147483647)
    expect(parse(OID.oid, '4294967295')).toBe(4294967295)
    expect(parse(OID.float8, '1.5')).toBe(1.5)
    expect(parse(OID.float4, '-2.25')).toBe(-2.25)
    expect(parse(OID.float8, 'NaN')).toBe('NaN')
    expect(parse(OID.float8, 'Infinity')).toBe('Infinity')
    expect(parse(OID.float4, '-Infinity')).toBe('-Infinity')
    expect(parse(OID.int8, '9223372036854775807')).toBe('9223372036854775807')
    expect(parse(1700, '0.1000000000')).toBe('0.1000000000')
    expect(parse(1184, '2024-01-15 09:30:00+00')).toBe('2024-01-15 09:30:00+00')
    expect(parse(3802, '{"a": 1}')).toBe('{"a": 1}')
    expect(parse(1007, '{1,2}')).toBe('{1,2}')
  })

  it('narrows unknown values to cells', () => {
    expect(toCell(undefined)).toBeNull()
    expect(toCell(null)).toBeNull()
    expect(toCell('x')).toBe('x')
    expect(toCell(1)).toBe(1)
    expect(toCell(false)).toBe(false)
    expect(toCell({ a: 1 })).toBe('[object Object]')
  })
})

describe('parseCommandTag', () => {
  it('splits verb and row count', () => {
    expect(parseCommandTag('UPDATE 3')).toEqual({ command: 'UPDATE', rowCount: 3 })
    expect(parseCommandTag('INSERT 0 1')).toEqual({ command: 'INSERT', rowCount: 1 })
    expect(parseCommandTag('SELECT 0')).toEqual({ command: 'SELECT', rowCount: 0 })
    expect(parseCommandTag('CREATE TABLE')).toEqual({ command: 'CREATE TABLE', rowCount: null })
    expect(parseCommandTag('DROP MATERIALIZED VIEW')).toEqual({ command: 'DROP MATERIALIZED VIEW', rowCount: null })
    expect(parseCommandTag('COPY 12')).toEqual({ command: 'COPY', rowCount: 12 })
  })
})

describe('buildChange', () => {
  it('parameterizes updates and renders a display twin', () => {
    const built = buildChange('public', 'Mixed Case Table', {
      type: 'update',
      key: { id: 7, tenant: null },
      values: { 'Weird Column': "it's", order: 2, flag: true },
    })
    expect(built).toEqual({
      type: 'update',
      text: 'UPDATE public."Mixed Case Table" SET "Weird Column" = $1, "order" = $2, flag = $3 WHERE id = $4 AND tenant IS NULL',
      values: ["it's", 2, true, 7],
      display: `UPDATE public."Mixed Case Table" SET "Weird Column" = 'it''s', "order" = 2, flag = TRUE WHERE id = 7 AND tenant IS NULL;`,
      keyLabel: 'id = 7, tenant = NULL',
    })
  })

  it('omits default columns from inserts', () => {
    expect(buildChange('s', 't', { type: 'insert', values: { id: { $default: true }, name: 'x' } })).toMatchObject({
      text: 'INSERT INTO s.t (name) VALUES ($1)',
      values: ['x'],
    })
    expect(buildChange('s', 't', { type: 'insert', values: { id: { $default: true } } })).toMatchObject({
      text: 'INSERT INTO s.t DEFAULT VALUES',
      values: [],
    })
  })

  it('builds deletes and skips empty updates', () => {
    expect(buildChange('s', 't', { type: 'delete', key: { a: 1, b: 'x' } })).toMatchObject({
      text: 'DELETE FROM s.t WHERE a = $1 AND b = $2',
      values: [1, 'x'],
    })
    expect(buildChange('s', 't', { type: 'update', key: { a: 1 }, values: {} })).toBeNull()
    expect(() => buildChange('s', 't', { type: 'delete', key: {} })).toThrow(DriverError)
  })

  it('collects referenced columns', () => {
    const columns = referencedColumns([
      { type: 'update', key: { id: 1 }, values: { a: 1 } },
      { type: 'insert', values: { b: 2 } },
      { type: 'delete', key: { c: 3 } },
    ])
    expect([...columns].sort()).toEqual(['a', 'b', 'c', 'id'])
  })
})

describe('catalog helpers', () => {
  it('recognises system schemas', () => {
    expect(['pg_catalog', 'information_schema', 'pg_toast', 'pg_toast_temp_1', 'pg_temp_3'].every(isSystemSchema)).toBe(true)
    expect(['public', 'sales', 'pg_custom'].some(isSystemSchema)).toBe(false)
  })

  it('sorts by kind, then name, then signature', () => {
    const objects = [
      { schema: 's', name: 'b', kind: 'function' as const, signature: '(x int)' },
      { schema: 's', name: 'z', kind: 'table' as const },
      { schema: 's', name: 'b', kind: 'function' as const, signature: '()' },
      { schema: 's', name: 'a', kind: 'type' as const },
      { schema: 's', name: 'a', kind: 'view' as const },
    ].sort(compareObjects)
    expect(objects.map((o) => `${o.kind}:${o.name}${o.signature ?? ''}`)).toEqual([
      'table:z',
      'view:a',
      'function:b()',
      'function:b(x int)',
      'type:a',
    ])
  })

  it('decodes trigger types', () => {
    expect(decodeTriggerType(19)).toEqual({ timing: 'BEFORE', events: ['UPDATE'] }) // ROW | BEFORE | UPDATE
    expect(decodeTriggerType(4 | 8 | 32)).toEqual({ timing: 'AFTER', events: ['INSERT', 'DELETE', 'TRUNCATE'] })
    expect(decodeTriggerType(64 | 1 | 4)).toEqual({ timing: 'INSTEAD OF', events: ['INSERT'] })
  })
})

function connection(overrides: Partial<ResolvedConnection['config']> = {}, password?: string): ResolvedConnection {
  return {
    config: {
      id: 'c',
      name: 'c',
      dialect: 'postgres',
      host: 'db.example.com',
      port: 5432,
      database: 'app',
      user: 'me',
      savePassword: false,
      hasPassword: false,
      ssl: { mode: 'disable' },
      ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
      color: 'none',
      readOnly: false,
      productionGuard: false,
      options: {},
      createdAt: '',
      updatedAt: '',
      ...overrides,
    },
    secrets: password === undefined ? {} : { password },
    host: '127.0.0.1',
    port: 6543,
  }
}

describe('client configuration', () => {
  it('dials the resolved host and applies defaults', () => {
    const config = clientConfig(connection({}, 'pw'), 'other', false)
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 6543,
      user: 'me',
      password: 'pw',
      database: 'other',
      application_name: 'DataGrippe',
      connectionTimeoutMillis: 15_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
      ssl: false,
    })
    expect(config.options).toBeUndefined()
    expect(config.types).toBe(pgTypes)
  })

  it('omits an unknown password and honours options', () => {
    const config = clientConfig(connection({ options: { applicationName: 'x', connectTimeoutMs: 500 } }), 'app', false)
    expect('password' in config).toBe(false)
    expect(config).toMatchObject({ application_name: 'x', connectionTimeoutMillis: 500 })
  })

  it('passes a session time zone as a startup option', () => {
    const withZone = (timeZone: string) => {
      // ConnectionOptions.timeZone is read structurally (the option is optional in the settings).
      const options = { connectTimeoutMs: 500, timeZone }
      return clientConfig(connection({ options }), 'app', false).options
    }
    expect(withZone('Europe/Paris')).toBe('-c TimeZone=Europe/Paris')
    expect(withZone('server')).toBeUndefined()
    expect(withZone('  ')).toBeUndefined()
    expect(withZone('local')).toBe(`-c TimeZone=${Intl.DateTimeFormat().resolvedOptions().timeZone}`)
    expect(withZone('UTC+1 x\\y')).toBe('-c TimeZone=UTC+1\\ x\\\\y')
  })

  it('maps sslmode to TLS options', () => {
    expect(initialTls(connection({ ssl: { mode: 'disable' } }))).toBe(false)
    expect(initialTls(connection({ ssl: { mode: 'prefer' } }))).toEqual({ rejectUnauthorized: false })
    expect(initialTls(connection({ ssl: { mode: 'require' } }))).toEqual({ rejectUnauthorized: false })
    const verify = initialTls(connection({ ssl: { mode: 'verify-full' } }))
    expect(verify).toMatchObject({ rejectUnauthorized: true, servername: 'db.example.com' })
    expect(() => initialTls(connection({ ssl: { mode: 'verify-full', caPath: '/nonexistent/ca.pem' } }))).toThrow(DriverError)
  })
})

describe('error mapping', () => {
  const serverError = (code: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error('boom'), { code, severity: 'ERROR', ...extra })

  it('maps SQL errors to database errors', () => {
    const error = serverError('42703', { position: '8', hint: 'h', detail: 'd' })
    expect(isServerError(error)).toBe(true)
    expect(serverErrorInfo(error as never)).toEqual({
      message: 'boom',
      code: '42703',
      severity: 'ERROR',
      detail: 'd',
      hint: 'h',
      position: 8,
      kind: 'database',
    })
    expect(toDriverError(error).info.kind).toBe('database')
  })

  it('maps connection-level failures to connection errors', () => {
    expect(toDriverError(serverError('28P01', { severity: 'FATAL' })).info).toMatchObject({ kind: 'connection', code: '28P01' })
    expect(toDriverError(serverError('3D000', { severity: 'FATAL' })).info).toMatchObject({ kind: 'connection', code: '3D000' })
    expect(toDriverError(serverError('XX000', { severity: 'PANIC' })).info.kind).toBe('connection')
    // Termination codes are recognised even when the severity is localized (lc_messages).
    expect(toDriverError(serverError('57P01', { severity: 'SCHWERWIEGEND' })).info.kind).toBe('connection')
    expect(toConnectionError(serverError('3D000')).info).toMatchObject({ kind: 'connection', code: '3D000' })
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' })
    expect(toDriverError(refused).info).toMatchObject({ kind: 'connection', code: 'ECONNREFUSED' })
    expect(toDriverError(new Error('Connection terminated unexpectedly')).info.kind).toBe('connection')
    expect(toConnectionError(new Error('anything')).info.kind).toBe('connection')
    expect(toDriverError(new Error('weird')).info.kind).toBe('internal')
    expect(toDriverError(new Error('timeout exceeded when trying to connect')).info).toMatchObject({
      kind: 'connection',
      message: expect.stringContaining('free connection'),
    })
  })

  it('keeps statement errors with connection-like SQLSTATEs on a live session as database errors', () => {
    // DROP DATABASE of a missing database, dblink / postgres_fdw failures, RAISE … USING ERRCODE = '08001'.
    for (const code of ['3D000', '08001', '08006', '28000', '53300']) {
      expect(isConnectionLevel(serverError(code))).toBe(false)
      expect(toDriverError(serverError(code)).info).toMatchObject({ kind: 'database', code })
    }
  })

  it('reports the server context separately from the detail', () => {
    const where = 'PL/pgSQL function boom() line 1 at RETURN'
    expect(serverErrorInfo(serverError('22012', { where }) as never)).toMatchObject({ context: where, detail: undefined })
    expect(serverErrorInfo(serverError('22012', { where, detail: 'd' }) as never)).toMatchObject({ context: where, detail: 'd' })
  })
})
