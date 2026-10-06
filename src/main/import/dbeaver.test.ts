import { promises as fsp, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig, ConnectionInput, DbeaverImportCandidate, DbeaverScanResult } from '@shared/types'
import { validateConnectionInput } from '../store/connections'
import {
  defaultDbeaverWorkspaceDirs,
  isDataSourcesFileName,
  MAX_DATA_SOURCES_BYTES,
  scanDbeaver,
  type DbeaverFs,
} from './dbeaver'

const FIXTURES = join(__dirname, '__fixtures__', 'dbeaver')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

const CREDENTIALS_CONTENT = 'binary-encrypted-credentials-FIXTURE'

let home: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dg-dbeaver-')))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

function write(path: string, content: string | Buffer): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

/** ~/Library/DBeaverData/workspace6/<project>/.dbeaver */
function dotDbeaver(project: string): string {
  return join(home, 'Library', 'DBeaverData', 'workspace6', project, '.dbeaver')
}

/** A workspace like the user's: General (prod + credentials + other DBeaver files), Other, corrupt Broken. */
function userWorkspace(): { general: string; other: string; broken: string } {
  const general = dotDbeaver('General')
  write(join(general, 'data-sources-prod.json'), fixture('user-prod.json'))
  write(join(general, 'credentials-config.json'), CREDENTIALS_CONTENT)
  write(join(general, 'credentials-config-prod.json'), CREDENTIALS_CONTENT)
  write(join(general, 'project-settings.json'), '{}')
  write(join(general, 'data-sources.json.bak'), '{}')
  const other = dotDbeaver('Other')
  write(join(other, 'data-sources.json'), fixture('url-only.json'))
  write(join(other, 'credentials-config.json'), CREDENTIALS_CONTENT)
  const broken = dotDbeaver('Broken')
  write(join(broken, 'data-sources.json'), fixture('corrupt.json'))
  mkdirSync(join(home, 'Library', 'DBeaverData', 'workspace6', '.metadata'), { recursive: true })
  return { general, other, broken }
}

/** Real fs, recording every path handed to readFile. */
function recordingFs(): { fs: DbeaverFs; reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    fs: {
      stat: (p) => fsp.stat(p),
      readdir: (p) => fsp.readdir(p),
      realpath: (p) => fsp.realpath(p),
      readFile: (p) => {
        reads.push(p)
        return fsp.readFile(p)
      },
    },
  }
}

const scan = (path?: string, existing: readonly ConnectionConfig[] = [], fs?: DbeaverFs): Promise<DbeaverScanResult> =>
  scanDbeaver(path, existing, { homeDir: home, platform: 'darwin', env: {}, ...(fs ? { fs } : {}) })

function byId(result: DbeaverScanResult, id: string): DbeaverImportCandidate {
  const found = result.candidates.find((c) => c.sourceId === id)
  if (!found) throw new Error(`candidate ${id} not found`)
  return found
}

function inputOf(result: DbeaverScanResult, id: string): ConnectionInput {
  const input = byId(result, id).input
  if (!input) throw new Error(`candidate ${id} has no input`)
  return input
}

/** Passes the app's validation once the Vault fields the user still has to fill are set. */
function expectValid(input: ConnectionInput): void {
  const completed: ConnectionInput =
    input.authMode === 'vault' && input.vault
      ? {
          ...input,
          vault: {
            ...input.vault,
            address: input.vault.address || 'https://vault.example.internal',
            secretPath: input.vault.secretPath || 'database/creds/role',
          },
        }
      : input
  const meta = { id: 'x', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
  expect(() => validateConnectionInput(completed, meta)).not.toThrow()
}

describe('file discovery', () => {
  it('finds data-sources*.json in every project of the default macOS workspace and nothing else', async () => {
    const { general, other, broken } = userWorkspace()
    const { fs, reads } = recordingFs()
    const result = await scan(undefined, [], fs)
    expect(reads.sort()).toEqual(
      [join(broken, 'data-sources.json'), join(general, 'data-sources-prod.json'), join(other, 'data-sources.json')].sort(),
    )
    expect(result.files.sort()).toEqual([join(general, 'data-sources-prod.json'), join(other, 'data-sources.json')].sort())
    expect(result.candidates).toHaveLength(9)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/Could not read .*Broken.*data-sources\.json: invalid JSON/)
  })

  it('never opens credentials-config*.json through node:fs (spy on the real module)', async () => {
    const { general } = userWorkspace()
    const readFile = vi.spyOn(fsp, 'readFile')
    const open = vi.spyOn(fsp, 'open')
    await scan()
    await scan(general)
    await scan(join(general, 'credentials-config.json'))
    const paths = [...readFile.mock.calls, ...open.mock.calls].map((call) => String(call[0]))
    expect(paths.length).toBeGreaterThan(0)
    for (const path of paths) expect(isDataSourcesFileName(basename(path))).toBe(true)
    expect(paths.some((p) => /credentials/i.test(p))).toBe(false)
  })

  it('refuses a file that is not a data-sources file without reading it', async () => {
    const { general } = userWorkspace()
    const { fs, reads } = recordingFs()
    const result = await scan(join(general, 'credentials-config.json'), [], fs)
    expect(reads).toEqual([])
    expect(result.candidates).toEqual([])
    expect(result.files).toEqual([])
    expect(result.warnings[0]).toMatch(/credentials-config\.json is not a DBeaver connections file/)
  })

  it('skips a data-sources symlink that points to another file', async () => {
    const dir = dotDbeaver('Linked')
    write(join(dir, 'credentials-config.json'), CREDENTIALS_CONTENT)
    symlinkSync(join(dir, 'credentials-config.json'), join(dir, 'data-sources.json'))
    const { fs, reads } = recordingFs()
    const result = await scan(dir, [], fs)
    expect(reads).toEqual([])
    expect(result.warnings.join('\n')).toMatch(/links to credentials-config\.json/)
  })

  it('accepts a file, a .dbeaver folder, a project, a workspace, the DBeaverData folder and ~', async () => {
    const { general } = userWorkspace()
    const project = join(general, '..')
    const workspace = join(project, '..')
    const dataDir = join(workspace, '..')
    const prodFile = join(general, 'data-sources-prod.json')
    expect((await scan(prodFile)).files).toEqual([prodFile])
    expect((await scan(general)).files).toEqual([prodFile])
    expect((await scan(project)).files).toEqual([prodFile])
    expect((await scan('~/Library/DBeaverData/workspace6/General')).files).toEqual([prodFile])
    expect((await scan(workspace)).files).toHaveLength(2)
    expect((await scan(dataDir)).files).toHaveLength(2)
  })

  it('warns when nothing is found', async () => {
    const missing = await scan()
    expect(missing.candidates).toEqual([])
    expect(missing.warnings[0]).toMatch(/No DBeaver workspace found \(looked in .*Library\/DBeaverData\/workspace6\)/)
    expect((await scan(join(home, 'nope'))).warnings[0]).toMatch(/was not found/)
    mkdirSync(join(home, 'empty'))
    expect((await scan(join(home, 'empty'))).warnings[0]).toMatch(/No DBeaver data-sources\*\.json file found/)
    mkdirSync(join(home, 'Library', 'DBeaverData', 'workspace6', 'General'), { recursive: true })
    expect((await scan()).warnings[0]).toMatch(/No DBeaver connections found/)
  })

  it('tolerates a BOM, skips very large files and non-object documents', async () => {
    const dir = dotDbeaver('General')
    write(join(dir, 'data-sources.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(fixture('user-prod.json'))]))
    write(join(dir, 'data-sources-big.json'), Buffer.alloc(MAX_DATA_SOURCES_BYTES + 1, 0x20))
    write(join(dir, 'data-sources-array.json'), '[]')
    write(join(dir, 'data-sources-bad.json'), '{"connections": []}')
    write(join(dir, 'data-sources-empty.json'), '{"folders": {}}')
    const { fs, reads } = recordingFs()
    const result = await scan(dir, [], fs)
    expect(result.candidates).toHaveLength(4)
    expect(reads.some((p) => p.endsWith('data-sources-big.json'))).toBe(false)
    const warnings = result.warnings.join('\n')
    expect(warnings).toMatch(/data-sources-big\.json: larger than 5 MB/)
    expect(warnings).toMatch(/data-sources-array\.json: not a DBeaver connections file/)
    expect(warnings).toMatch(/data-sources-bad\.json: "connections" is not an object/)
    expect(result.files.map((f) => basename(f)).sort()).toEqual(['data-sources-bad.json', 'data-sources-empty.json', 'data-sources.json'])
  })
})

describe('default locations', () => {
  it('follows each platform convention', () => {
    expect(defaultDbeaverWorkspaceDirs({ platform: 'darwin', homeDir: '/Users/me', env: {} })).toEqual([
      '/Users/me/Library/DBeaverData/workspace6',
    ])
    expect(defaultDbeaverWorkspaceDirs({ platform: 'win32', homeDir: 'C:\\Users\\me', env: { APPDATA: 'D:\\Roaming' } })).toEqual([
      'D:\\Roaming\\DBeaverData\\workspace6',
    ])
    expect(defaultDbeaverWorkspaceDirs({ platform: 'win32', homeDir: 'C:\\Users\\me', env: {} })).toEqual([
      'C:\\Users\\me\\AppData\\Roaming\\DBeaverData\\workspace6',
    ])
    const linux = defaultDbeaverWorkspaceDirs({ platform: 'linux', homeDir: '/home/me', env: {} })
    expect(linux[0]).toBe('/home/me/.local/share/DBeaverData/workspace6')
    expect(linux).toContain('/home/me/.var/app/io.dbeaver.DBeaverCommunity/data/DBeaverData/workspace6')
    expect(defaultDbeaverWorkspaceDirs({ platform: 'linux', homeDir: '/home/me', env: { XDG_DATA_HOME: '/data' } })[0]).toBe(
      '/data/DBeaverData/workspace6',
    )
    expect(defaultDbeaverWorkspaceDirs({ platform: 'linux', homeDir: '/home/me', env: { XDG_DATA_HOME: 'relative' } })[0]).toBe(
      '/home/me/.local/share/DBeaverData/workspace6',
    )
  })
})

describe("the user's DBeaver connections (sanitized)", () => {
  async function userResult(existing: readonly ConnectionConfig[] = []): Promise<DbeaverScanResult> {
    const file = write(join(dotDbeaver('General'), 'data-sources-prod.json'), fixture('user-prod.json'))
    return scan(file, existing)
  }

  it('imports the 4 Vault connections, ordered by folder then name', async () => {
    const result = await userResult()
    expect(result.warnings).toEqual([])
    expect(result.candidates.map((c) => c.sourceName)).toEqual([
      'PGSQL - All Payments DBs - pg-payments.example.cloud',
      'PGSQL - Analytics - warehouse',
      'PGSQL - Ledger - @pg-ledger.example.cloud',
      'SQL SERVER - billing-prod',
    ])
    for (const c of result.candidates) {
      expect(c.sourceFolder).toBe('PROD')
      expect(c.sourceFile).toBe(result.files[0])
      const input = c.input
      if (!input) throw new Error('missing input')
      expect(input.authMode).toBe('vault')
      expect(input.vault).toEqual({ address: '', loginMethod: 'oidc', secretPath: '', revokeOnDisconnect: true })
      expect(input.savePassword).toBe(false)
      expect(input.group).toBe('PROD')
      expect(input.color).toBe('red')
      expect(input.productionGuard).toBe(true)
      expect(input.readOnly).toBe(false)
      expect(input.ssh.enabled).toBe(false)
      expect(input.user).toBe('')
      expect(c.notes).toContain('Set the Vault address and secret path')
      expect(c.notes).toContain('Marked as production')
      expect(c.notes.some((n) => /OIDC/.test(n))).toBe(true)
      expect(c.notes).not.toContain('Enter the password when connecting')
      expectValid(input)
    }
  })

  it('maps host, port, database, SSL and system objects', async () => {
    const result = await userResult()
    expect(inputOf(result, 'postgres-jdbc-prod-analytics')).toMatchObject({
      dialect: 'postgres',
      host: 'pg-analytics.example.cloud',
      port: 5432,
      database: 'warehouse',
      ssl: { mode: 'prefer' },
      options: {},
    })
    expect(inputOf(result, 'postgres-jdbc-prod-payments')).toMatchObject({ database: 'payments-prod', options: {} })
    expect(inputOf(result, 'postgres-jdbc-prod-ledger').database).toBe('postgres')
    expect(inputOf(result, 'sqlserver-prod-billing-legacy')).toMatchObject({
      dialect: 'mssql',
      host: 'mssql-prod.example.cloud',
      port: 1433,
      database: 'billing-prod',
      ssl: { mode: 'require' },
      options: { showSystemObjects: true },
    })
    expect(byId(result, 'sqlserver-prod-billing-legacy').sourceProvider).toBe('sqlserver')
  })

  it('flags connections that already exist (same dialect, host, port, database)', async () => {
    const existing = [
      existingConnection('c1', { dialect: 'postgres', host: 'PG-ANALYTICS.example.cloud', port: 5432, database: 'warehouse' }),
      existingConnection('c2', { dialect: 'postgres', host: 'pg-payments.example.cloud', port: 5433, database: 'payments-prod' }),
      existingConnection('c3', { dialect: 'postgres', host: 'pg-ledger.example.cloud', port: 5432, database: '' }),
      existingConnection('c4', { dialect: 'mssql', host: 'mssql-prod.example.cloud', port: 1433, database: 'BILLING-PROD' }),
      existingConnection('c5', { dialect: 'mssql', host: 'pg-analytics.example.cloud', port: 5432, database: 'warehouse' }),
    ]
    const result = await userResult(existing)
    expect(byId(result, 'postgres-jdbc-prod-analytics').duplicateOf).toBe('c1')
    expect(byId(result, 'postgres-jdbc-prod-payments').duplicateOf).toBeUndefined()
    expect(byId(result, 'postgres-jdbc-prod-ledger').duplicateOf).toBe('c3')
    expect(byId(result, 'sqlserver-prod-billing-legacy').duplicateOf).toBe('c4')
  })
})

describe('mapping rules (synthetic DBeaver file)', () => {
  async function synthetic(): Promise<DbeaverScanResult> {
    const file = write(join(dotDbeaver('General'), 'data-sources.json'), fixture('synthetic.json'))
    return scan(file)
  }

  it('maps an SSH tunnel with a key, the PostgreSQL SSL handler, folders, read-only and type colors', async () => {
    const result = await synthetic()
    const c = byId(result, 'pg-ssh-ssl')
    expect(c.input).toEqual({
      name: 'Analytics warehouse',
      dialect: 'postgres',
      host: 'warehouse.example.internal',
      port: 6432,
      database: 'analytics',
      user: 'analyst',
      savePassword: false,
      ssl: { mode: 'verify-full', caPath: '/certs/ca.pem', certPath: '/certs/client.pem', keyPath: '/certs/client.pk8' },
      ssh: {
        enabled: true,
        host: 'bastion.example.internal',
        port: 2222,
        username: 'jump',
        authMethod: 'privateKey',
        privateKeyPath: '/home/me/.ssh/id_ed25519',
      },
      color: 'green',
      group: 'Team/Analytics',
      readOnly: true,
      productionGuard: false,
      authMode: 'password',
      options: { defaultSchema: 'marts' },
    })
    expect(c.notes).toEqual(
      expect.arrayContaining([
        'Enter the password when connecting',
        expect.stringMatching(/verify-ca.*verify-full/),
        expect.stringMatching(/client key must be a PEM/),
        expect.stringMatching(/SSH key passphrase/),
      ]),
    )
    expect(c.notes).not.toContain('Marked as production')
    expectValid(c.input as ConnectionInput)
  })

  it('keeps an incomplete SSH tunnel disabled with a note', async () => {
    const c = byId(await synthetic(), 'pg-ssh-incomplete')
    expect(c.input?.ssh).toEqual({ enabled: false, host: 'bastion.example.internal', port: 22, username: '', authMethod: 'password' })
    expect(c.notes).toContain('SSH tunnel via bastion.example.internal: set the SSH user, then enable the tunnel')
    expect(c.input?.ssl).toEqual({ mode: 'prefer' })
    expect(c.input?.color).toBe('blue')
    expect(c.notes).toContain('Set the user name (DBeaver keeps it with its saved credentials)')
  })

  it('maps SSH agent auth, driver sslmode, and notes unsupported handlers and jump hosts', async () => {
    const c = byId(await synthetic(), 'pg-ssh-agent')
    expect(c.input).toMatchObject({
      host: '10.0.0.5',
      port: 5432,
      ssl: { mode: 'disable' },
      ssh: { enabled: true, host: 'gw.example.internal', port: 22, username: 'ops', authMethod: 'agent' },
      color: 'none',
    })
    expect(c.notes).toEqual(
      expect.arrayContaining([expect.stringMatching(/jump hosts are not imported/), 'Network handler "socks_proxy" is not supported']),
    )
  })

  it('splits a SQL Server named instance and maps encrypt=true to verify-full', async () => {
    const c = byId(await synthetic(), 'mssql-instance')
    expect(c.input).toMatchObject({
      dialect: 'mssql',
      host: 'erp.example.internal',
      port: 1433,
      database: 'erp',
      user: 'erp_reader',
      ssl: { mode: 'verify-full' },
      options: { instanceName: 'SQLEXPRESS' },
      color: 'red',
      productionGuard: true,
      authMode: 'password',
    })
    expect(c.notes).toEqual(expect.arrayContaining(['Marked as production', expect.stringMatching(/trust stores are not imported/)]))
  })

  it('detects production from connection types (prod id, red color, confirm-execute, name)', async () => {
    const result = await synthetic()
    for (const id of ['mssql-instance', 'mssql-critical', 'pg-careful', 'pg-live']) {
      expect(inputOf(result, id)).toMatchObject({ color: 'red', productionGuard: true })
      expect(byId(result, id).notes).toContain('Marked as production')
    }
    for (const id of ['pg-ssh-ssl', 'pg-preprod', 'greenplum-1']) expect(inputOf(result, id).productionGuard).toBe(false)
  })

  it('maps unsupported auth models to password mode with a note', async () => {
    const result = await synthetic()
    const ntlm = byId(result, 'mssql-critical')
    expect(ntlm.input).toMatchObject({ authMode: 'password', options: { showSystemObjects: false }, ssl: { mode: 'require' } })
    expect(ntlm.notes).toContain('DBeaver authentication "sqlserver_ntlm" is not supported: using a user name and password')
    expect(byId(result, 'pg-kerberos').notes).toContain(
      'DBeaver authentication "postgres_kerberos" is not supported: using a user name and password',
    )
    const pgpass = byId(result, 'pg-preprod')
    expect(pgpass.notes).toContain('DBeaver read the password from .pgpass: enter it when connecting')
    expect(pgpass.notes).toContain('Invalid port "not-a-port": using 5432')
    expect(pgpass.input).toMatchObject({ port: 5432, color: 'purple', group: 'Staging', options: { showSystemObjects: true } })
  })

  it('uses non-secret Vault hints from auth-properties and never secrets', async () => {
    const result = await synthetic()
    const hinted = byId(result, 'pg-vault-hints')
    expect(hinted.input?.authMode).toBe('vault')
    expect(hinted.input?.vault).toEqual({
      address: 'https://vault.example.internal:8200',
      namespace: 'admin/data',
      loginMethod: 'ldap',
      authMount: 'corp-ldap',
      username: 'jdoe',
      secretPath: 'database/creds/readonly',
      revokeOnDisconnect: true,
    })
    expect(hinted.notes.some((n) => /taken from the DBeaver authentication settings/.test(n))).toBe(true)
    expect(hinted.notes.some((n) => /^Set the Vault/.test(n))).toBe(false)

    const role = byId(result, 'pg-vault-role')
    expect(role.input?.vault).toEqual({ address: '', loginMethod: 'oidc', secretPath: 'database/creds/analytics-ro', revokeOnDisconnect: true })
    expect(role.notes).toEqual(
      expect.arrayContaining(['Set the Vault address', 'Vault sign-in method "approle" is not supported: using OIDC']),
    )
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/NOT_IMPORTED/)
  })

  it('imports PostgreSQL-compatible engines with a note and rejects the others', async () => {
    const result = await synthetic()
    const gp = byId(result, 'greenplum-1')
    expect(gp.input?.dialect).toBe('postgres')
    expect(gp.notes[0]).toMatch(/Greenplum connection imported as PostgreSQL/)
    for (const [id, provider] of [
      ['redshift-1', 'redshift'],
      ['mysql-1', 'mysql'],
    ]) {
      const c = byId(result, id)
      expect(c.input).toBeNull()
      expect(c.notes).toEqual([`Unsupported provider ${provider}`])
      expect(c.sourceProvider).toBe(provider)
    }
  })

  it('falls back on localhost and the DBeaver id for a connection without host or name', async () => {
    const c = byId(await synthetic(), 'pg-no-host')
    expect(c.sourceName).toBe('pg-no-host')
    expect(c.input).toMatchObject({ name: 'pg-no-host', host: 'localhost', port: 5432, database: 'postgres', user: 'me' })
    expect(c.notes).toContain('No host in the DBeaver connection: using localhost')
  })

  it('warns about invalid entries, keeps a stable order and produces valid inputs', async () => {
    const result = await synthetic()
    expect(result.warnings).toEqual([expect.stringMatching(/Skipped connection broken-entry .*invalid entry/)])
    const order = result.candidates.map((c) => `${c.sourceFolder ?? ''}|${c.sourceName}`)
    expect(order).toEqual([
      '|Agent tunnel',
      '|Billing',
      '|Careful one',
      '|Greenplum',
      '|Kerberized',
      '|Legacy ERP',
      '|Live one',
      '|pg-no-host',
      '|Redshift',
      '|Shop',
      '|Vault role only',
      '|Vault with hints',
      'Staging|Billing preprod',
      'Staging|Reporting',
      'Team/Analytics|Analytics warehouse',
    ])
    expect((await synthetic()).candidates).toEqual(result.candidates)
    for (const c of result.candidates) if (c.input) expectValid(c.input)
  })
})

describe('JDBC URL configurations', () => {
  async function urls(): Promise<DbeaverScanResult> {
    const file = write(join(dotDbeaver('General'), 'data-sources.json'), fixture('url-only.json'))
    return scan(file)
  }

  it('parses PostgreSQL URLs (params, multi-host) without importing passwords', async () => {
    const result = await urls()
    expect(inputOf(result, 'pg-url-only')).toMatchObject({
      host: 'url-host.example.internal',
      port: 5433,
      database: 'urldb',
      user: 'url_user',
      ssl: { mode: 'require' },
    })
    expect(JSON.stringify(result)).not.toMatch(/NOT_IMPORTED_URL_PASSWORD/)
    const multi = byId(result, 'pg-multihost')
    expect(multi.input).toMatchObject({ host: 'a.example.internal', port: 5432, database: 'app' })
    expect(multi.notes).toContain('Only the first host of the URL is used (2 hosts listed)')
  })

  it('parses SQL Server URLs (serverName, instance, braces, encrypt) and jTDS URLs', async () => {
    const result = await urls()
    expect(inputOf(result, 'mssql-url')).toMatchObject({
      dialect: 'mssql',
      host: 'mssql-url.example.internal',
      port: 1433,
      database: 'sales',
      ssl: { mode: 'disable' },
    })
    expect(inputOf(result, 'mssql-url-instance')).toMatchObject({
      host: 'inst-host.example.internal',
      port: 1444,
      database: 'odd;name',
      ssl: { mode: 'require' },
      options: { instanceName: 'REPORTING' },
    })
    expect(inputOf(result, 'mssql-jtds')).toMatchObject({ host: 'jtds.example.internal', port: 1500, database: 'inventory', ssl: { mode: 'require' } })
    for (const c of result.candidates) if (c.input) expectValid(c.input)
  })
})

function existingConnection(id: string, patch: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    id,
    name: id,
    dialect: 'postgres',
    host: 'localhost',
    port: 5432,
    database: '',
    user: '',
    savePassword: false,
    hasPassword: false,
    ssl: { mode: 'prefer' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'privateKey' },
    color: 'none',
    readOnly: false,
    productionGuard: false,
    options: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  }
}
