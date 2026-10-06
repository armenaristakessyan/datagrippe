import { describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '@shared/types'
import type { ResolvedConnection } from '../types'
import { mssqlConfig, resolveOptions, tediousConfig } from './config'

function resolved(overrides: Partial<ConnectionConfig> = {}, host?: string, port?: number): ResolvedConnection {
  const config: ConnectionConfig = {
    id: 'c',
    name: 'c',
    dialect: 'mssql',
    host: 'db.example.com',
    port: 1433,
    database: 'app',
    user: 'u',
    savePassword: true,
    hasPassword: true,
    ssl: { mode: 'require' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
    color: 'none',
    readOnly: false,
    productionGuard: false,
    options: {},
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
  return { config, secrets: { password: 'pw' }, host: host ?? config.host, port: port ?? config.port }
}

describe('resolveOptions', () => {
  it('uses host/port, defaults and SSL mode mapping', async () => {
    const options = await resolveOptions(resolved())
    expect(options).toMatchObject({
      server: 'db.example.com',
      port: 1433,
      database: 'app',
      userName: 'u',
      password: 'pw',
      encrypt: true,
      trustServerCertificate: true,
      appName: 'DataGrippe',
      connectTimeout: 15000,
    })
    expect((await resolveOptions(resolved({ ssl: { mode: 'disable' } }))).encrypt).toBe(false)
    expect((await resolveOptions(resolved({ ssl: { mode: 'prefer' } })))).toMatchObject({ encrypt: true, trustServerCertificate: true })
    expect((await resolveOptions(resolved({ ssl: { mode: 'verify-full' } })))).toMatchObject({ encrypt: true, trustServerCertificate: false })
  })

  it('dials a named instance unless a tunnel rewrote the address', async () => {
    const direct = await resolveOptions(resolved({ options: { instanceName: 'SQLEXPRESS' } }))
    expect(direct).toMatchObject({ instanceName: 'SQLEXPRESS', port: undefined })
    const tunnelled = await resolveOptions(resolved({ options: { instanceName: 'SQLEXPRESS' }, ssl: { mode: 'verify-full' } }, '127.0.0.1', 40000))
    expect(tunnelled).toMatchObject({ server: '127.0.0.1', port: 40000, instanceName: undefined, serverName: 'db.example.com' })
  })

  it('honours options and an explicit database, empty meaning the login default', async () => {
    const options = await resolveOptions(resolved({ options: { applicationName: 'Mine', connectTimeoutMs: 3000 } }), 'other')
    expect(options).toMatchObject({ appName: 'Mine', connectTimeout: 3000, database: 'other' })
    expect((await resolveOptions(resolved({ database: '' }))).database).toBeUndefined()
  })

  it('reports unreadable CA files', async () => {
    await expect(resolveOptions(resolved({ ssl: { mode: 'verify-full', caPath: '/nonexistent/ca.pem' } }))).rejects.toMatchObject({
      info: { kind: 'invalid-input' },
    })
  })
})

describe('driver configs', () => {
  it('builds tedious and mssql configurations', async () => {
    const options = await resolveOptions(resolved())
    const tedious = tediousConfig(options)
    expect(tedious.server).toBe('db.example.com')
    expect(tedious.options).toMatchObject({
      port: 1433,
      database: 'app',
      encrypt: true,
      trustServerCertificate: true,
      appName: 'DataGrippe',
      connectTimeout: 15000,
      requestTimeout: 0,
      useUTC: true,
      enableArithAbort: true,
    })
    const pool = mssqlConfig(options, 4)
    expect(pool).toMatchObject({ server: 'db.example.com', port: 1433, database: 'app', user: 'u', requestTimeout: 0, pool: { max: 4 } })
  })
})
