import { describe, expect, it } from 'vitest'
import type { ConnectionConfig, ConnectionInput, DbeaverImportCandidate } from '@shared/types'
import {
  applySuggestions,
  buildInput,
  candidateKey,
  discoveryTargets,
  candidateTarget,
  defaultTemplate,
  defaultWorkspaceLabel,
  EMPTY_VAULT_SETTINGS,
  expandSecretPath,
  fillFromCandidates,
  groupCandidates,
  groupSelectionState,
  inferTemplate,
  initialOverrides,
  initialSelection,
  isValidVaultAddress,
  majorityVaultDialect,
  normalizeSecretPath,
  panelVaultConfig,
  roleOfPath,
  rowSecretPath,
  selectedCandidates,
  setSelected,
  shortenPath,
  unknownTokens,
  usedTokens,
  validateImport,
  vaultDefaultsFrom,
  visibleNotes,
  withEnvironment,
  type VaultImportSettings,
} from './dbeaver-import'

const FILE = '/Users/me/Library/DBeaverData/workspace6/General/.dbeaver/data-sources-prod.json'

function input(patch: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    name: 'conn',
    dialect: 'postgres',
    host: 'pg.example.cloud',
    port: 5432,
    database: 'app',
    user: '',
    savePassword: false,
    ssl: { mode: 'prefer' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
    color: 'none',
    readOnly: false,
    productionGuard: false,
    options: {},
    ...patch,
  }
}

function vaultInput(patch: Partial<ConnectionInput> = {}): ConnectionInput {
  return input({ authMode: 'vault', vault: { address: '', loginMethod: 'oidc', secretPath: '' }, ...patch })
}

function candidate(id: string, patch: Partial<DbeaverImportCandidate> = {}): DbeaverImportCandidate {
  return {
    sourceId: id,
    sourceFile: FILE,
    sourceName: id,
    sourceFolder: 'PROD',
    sourceProvider: 'postgresql',
    input: vaultInput({ name: id, database: id }),
    notes: [],
    ...patch,
  }
}

const analytics = candidate('postgres-jdbc-prod-analytics', {
  sourceName: 'PGSQL - Analytics - warehouse',
  input: vaultInput({ name: 'PGSQL - Analytics - warehouse', host: 'pg-analytics.example.cloud', database: 'warehouse' }),
})
const payments = candidate('postgres-jdbc-prod-payments', {
  sourceName: 'PGSQL - All Payments DBs',
  input: vaultInput({ host: 'pg-payments.example.cloud', database: 'payments-prod' }),
})
const legacy = candidate('sqlserver-prod-billing-legacy', {
  sourceName: 'SQL SERVER - billing-prod',
  sourceProvider: 'sqlserver',
  input: vaultInput({ dialect: 'mssql', host: 'mssql-prod.example.cloud', port: 1433, database: 'billing-prod' }),
})
const local = candidate('local', { sourceFolder: undefined, input: input({ host: 'localhost', database: 'dev' }) })
const mysql = candidate('mysql', { sourceFolder: 'DEV', sourceProvider: 'mysql', input: null, notes: ['MySQL is not supported'] })
const dup = candidate('dup', { sourceFolder: 'DEV', input: input({ database: 'dup' }), duplicateOf: 'existing-1' })

const settings: VaultImportSettings = {
  ...EMPTY_VAULT_SETTINGS,
  address: 'https://vault.example.internal/',
  template: 'database/creds/{database}-readonly',
}

describe('secret path template', () => {
  const values = { database: 'warehouse', name: 'PGSQL - Analytics', host: 'pg.example.cloud' }

  it('expands every supported token, case-insensitively', () => {
    expect(expandSecretPath('database/creds/{database}-readonly', values)).toBe('database/creds/warehouse-readonly')
    expect(expandSecretPath('kv/{HOST}/{name}/{database}', values)).toBe('kv/pg.example.cloud/PGSQL - Analytics/warehouse')
    expect(expandSecretPath('static/path', values)).toBe('static/path')
  })

  it('keeps unknown tokens and reports them once', () => {
    expect(expandSecretPath('db/{role}/{database}', values)).toBe('db/{role}/warehouse')
    expect(unknownTokens('db/{role}/{role}/{database}/{}')).toEqual(['{role}', '{}'])
    expect(unknownTokens('db/{Database}')).toEqual([])
  })

  it('infers a template from an existing secret path', () => {
    expect(inferTemplate('database/creds/warehouse-readonly', { database: 'warehouse', host: 'h.example' })).toBe('database/creds/{database}-readonly')
    expect(inferTemplate('kv/data/pg.example.cloud', { database: 'x', host: 'pg.example.cloud' })).toBe('kv/data/{host}')
    expect(inferTemplate('database/creds/shared', { database: 'app', host: 'h' })).toBe('')
    expect(inferTemplate('', { database: 'app', host: 'h' })).toBe('')
  })

  it('only replaces the database name in the last segment (the mount is shared)', () => {
    expect(inferTemplate('app-database/creds/app-mssql-ro', { database: 'app', host: 'h.example' })).toBe('app-database/creds/{database}-mssql-ro')
    expect(inferTemplate('app-database/creds/shared-ro', { database: 'app', host: 'h.example' })).toBe('')
  })

  it('lists the supported tokens a template uses', () => {
    expect(usedTokens('kv/{HOST}/{database}/{role}/{host}')).toEqual(['host', 'database'])
    expect(usedTokens('static/path')).toEqual([])
  })

  it('normalizes secret paths', () => {
    expect(normalizeSecretPath(' /v1/database/creds/app/ ')).toBe('database/creds/app')
    expect(normalizeSecretPath('database/creds/app')).toBe('database/creds/app')
  })

  it('uses the row edit over the template', () => {
    const overrides = new Map([[candidateKey(payments), 'database/creds/payments-ro']])
    expect(rowSecretPath(payments, settings.template, overrides)).toBe('database/creds/payments-ro')
    expect(rowSecretPath(analytics, settings.template, overrides)).toBe('database/creds/warehouse-readonly')
  })

  it('keeps secret paths the scan filled in as row edits', () => {
    const filled = candidate('filled', { input: vaultInput({ vault: { address: '', loginMethod: 'oidc', secretPath: 'database/creds/x' } }) })
    expect([...initialOverrides([filled, analytics, local]).entries()]).toEqual([[candidateKey(filled), 'database/creds/x']])
  })
})

describe('grouping and selection', () => {
  const all = [analytics, local, mysql, payments, dup, legacy]

  it('groups by folder A–Z, without folder last, file order inside', () => {
    const groups = groupCandidates(all)
    expect(groups.map((g) => g.label)).toEqual(['DEV', 'PROD', 'No folder'])
    expect(groups[1]!.candidates.map((c) => c.sourceId)).toEqual([analytics.sourceId, payments.sourceId, legacy.sourceId])
  })

  it('filters on every word of the query', () => {
    expect(groupCandidates(all, 'sql server').flatMap((g) => g.candidates.map((c) => c.sourceId))).toEqual([legacy.sourceId])
    expect(groupCandidates(all, 'payments-prod').flatMap((g) => g.candidates.map((c) => c.sourceId))).toEqual([payments.sourceId])
    expect(groupCandidates(all, 'nothing-matches')).toEqual([])
  })

  it('pre-selects importable rows that are not duplicates', () => {
    const selected = initialSelection(all)
    expect(selected.has(candidateKey(analytics))).toBe(true)
    expect(selected.has(candidateKey(local))).toBe(true)
    expect(selected.has(candidateKey(mysql))).toBe(false)
    expect(selected.has(candidateKey(dup))).toBe(false)
    expect(selected.size).toBe(4)
  })

  it('tracks group checkbox state, ignoring unsupported rows', () => {
    const [devGroup, prodGroup] = groupCandidates(all)
    let selected = initialSelection(all)
    expect(groupSelectionState(prodGroup!, selected)).toBe(true)
    expect(groupSelectionState(devGroup!, selected)).toBe(false)
    selected = setSelected(selected, devGroup!.candidates, true)
    expect(selected.has(candidateKey(mysql))).toBe(false)
    expect(groupSelectionState(devGroup!, selected)).toBe(true)
    selected = setSelected(selected, [analytics], false)
    expect(groupSelectionState(prodGroup!, selected)).toBe('indeterminate')
    selected = setSelected(selected, prodGroup!.candidates, false)
    expect(groupSelectionState(prodGroup!, selected)).toBe(false)
    expect(selectedCandidates(all, selected).map((c) => c.sourceId)).toEqual(['local', 'dup'])
  })

  it('describes targets', () => {
    expect(candidateTarget(analytics)).toBe('pg-analytics.example.cloud:5432/warehouse')
    expect(candidateTarget(mysql)).toBe('mysql')
  })
})

describe('validation', () => {
  const all = [analytics, payments, legacy, local]
  const selected = initialSelection(all)

  it('needs a selection', () => {
    const v = validateImport(all, new Set(), settings, new Map())
    expect(v.ok).toBe(false)
    expect(v.empty).toBe(true)
  })

  it('does not ask for Vault settings when no selected row uses Vault', () => {
    const v = validateImport(all, new Set([candidateKey(local)]), EMPTY_VAULT_SETTINGS, new Map())
    expect(v).toMatchObject({ ok: true, vault: false })
  })

  it('accepts a complete Vault configuration', () => {
    expect(validateImport(all, selected, settings, new Map())).toMatchObject({ ok: true, vault: true, rows: {} })
  })

  it('validates the address', () => {
    expect(isValidVaultAddress('https://vault.example.internal:8200/')).toBe(true)
    expect(isValidVaultAddress('http://127.0.0.1:58200')).toBe(true)
    expect(isValidVaultAddress('vault.example.internal')).toBe(false)
    expect(isValidVaultAddress('ftp://vault')).toBe(false)
    expect(isValidVaultAddress('https://')).toBe(false)
    expect(validateImport(all, selected, { ...settings, address: '' }, new Map()).summary).toBe('Enter the Vault address.')
    expect(validateImport(all, selected, { ...settings, address: 'vault' }, new Map()).address).toMatch(/full URL/)
  })

  it('requires a username for ldap / userpass', () => {
    const v = validateImport(all, selected, { ...settings, loginMethod: 'ldap' }, new Map())
    expect(v.username).toBeDefined()
    expect(validateImport(all, selected, { ...settings, loginMethod: 'ldap', username: 'me' }, new Map()).ok).toBe(true)
  })

  it('requires a secret path on every selected Vault row', () => {
    const v = validateImport(all, selected, { ...settings, template: '' }, new Map([[candidateKey(payments), 'database/creds/payments']]))
    expect(Object.keys(v.rows).sort()).toEqual([candidateKey(analytics), candidateKey(legacy)].sort())
    expect(v.summary).toBe('2 connections need a valid secret path.')
    const one = validateImport(all, selected, { ...settings, template: '' }, new Map([[candidateKey(payments), 'x'], [candidateKey(legacy), 'y']]))
    expect(one.summary).toBe('One connection needs a valid secret path.')
  })

  it('applies the main process rules to the address and the secret paths', () => {
    expect(validateImport(all, selected, { ...settings, address: 'https://u:p@vault.example.internal' }, new Map()).address).toMatch(/password/)
    const v = validateImport(all, selected, settings, new Map([[candidateKey(payments), 'v1/database/creds/x y']]))
    expect(v.rows[candidateKey(payments)]).toMatch(/spaces/)
    expect(v.ok).toBe(false)
  })

  it('flags a row whose template token has no value instead of importing "database/creds/-readonly"', () => {
    const noDatabase = candidate('sqlserver-prod-reporting', {
      sourceName: 'SQL SERVER - reporting',
      sourceProvider: 'sqlserver',
      input: vaultInput({ dialect: 'mssql', host: 'mssql-prod.example.cloud', port: 1433, database: '' }),
    })
    const key = candidateKey(noDatabase)
    const v = validateImport([noDatabase], new Set([key]), settings, new Map())
    expect(v.ok).toBe(false)
    expect(v.rows[key]).toBe('This connection has no {database}: type its secret path')
    // A path typed on the row is accepted.
    expect(validateImport([noDatabase], new Set([key]), settings, new Map([[key, 'database/creds/reporting-ro']])).ok).toBe(true)
    // A template without {database} is fine for it.
    expect(validateImport([noDatabase], new Set([key]), { ...settings, template: 'database/creds/{host}' }, new Map()).ok).toBe(true)
  })

  it('rejects unknown template tokens', () => {
    const v = validateImport(all, selected, { ...settings, template: 'database/creds/{role}' }, new Map())
    expect(v.ok).toBe(false)
    expect(v.template).toMatch(/\{role\}/)
  })
})

describe('buildInput', () => {
  it('fills the Vault config and keeps the DBeaver folder as group', () => {
    const out = buildInput(analytics, { ...settings, namespace: ' team ', authMount: 'okta', oidcRole: 'dev', username: 'ignored' }, new Map())
    expect(out.group).toBe('PROD')
    expect(out.authMode).toBe('vault')
    expect(out.vault).toEqual({
      address: 'https://vault.example.internal',
      namespace: 'team',
      loginMethod: 'oidc',
      authMount: 'okta',
      oidcRole: 'dev',
      username: undefined,
      secretPath: 'database/creds/warehouse-readonly',
      caPath: undefined,
    })
  })

  it('keeps only the fields of the chosen sign-in method', () => {
    // The token method keeps the OIDC mount / role of its browser fallback…
    const out = buildInput(payments, { ...settings, loginMethod: 'token', authMount: 'okta', oidcRole: 'x', username: 'y' }, new Map())
    expect(out.vault).toMatchObject({ loginMethod: 'token', authMount: 'okta', oidcRole: 'x', username: undefined })
    expect(out.vault?.oidcFallback).toBeUndefined()
    // …and drops them without it.
    const off = buildInput(payments, { ...settings, loginMethod: 'token', authMount: 'okta', oidcRole: 'x', oidcFallback: false }, new Map())
    expect(off.vault).toMatchObject({ loginMethod: 'token', authMount: undefined, oidcRole: undefined, oidcFallback: false })
    const ldap = buildInput(payments, { ...settings, loginMethod: 'ldap', username: ' me ', oidcRole: 'x' }, new Map())
    expect(ldap.vault).toMatchObject({ loginMethod: 'ldap', username: 'me', oidcRole: undefined })
  })

  it('leaves password connections untouched', () => {
    const out = buildInput(local, settings, new Map())
    expect(out.authMode).toBeUndefined()
    expect(out.vault).toBeUndefined()
    expect(out.group).toBeUndefined()
  })

  it('refuses unsupported candidates', () => {
    expect(() => buildInput(mysql, settings, new Map())).toThrow()
  })
})

describe('vaultDefaultsFrom', () => {
  const base = {
    dialect: 'postgres' as const,
    port: 5432,
    user: '',
    savePassword: false,
    hasPassword: false,
    ssl: { mode: 'prefer' as const },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' as const },
    color: 'none' as const,
    readOnly: false,
    productionGuard: false,
    options: {},
    createdAt: '2026-01-01T00:00:00Z',
  }
  const older: ConnectionConfig = {
    ...base,
    id: 'a',
    name: 'Old',
    host: 'h1',
    database: 'one',
    updatedAt: '2026-01-01T00:00:00Z',
    authMode: 'vault',
    vault: { address: 'https://old.example.internal', loginMethod: 'token', secretPath: 'database/creds/one' },
  }
  const newer: ConnectionConfig = {
    ...base,
    id: 'b',
    name: 'New',
    host: 'h2',
    database: 'two',
    updatedAt: '2026-03-01T00:00:00Z',
    authMode: 'vault',
    vault: {
      address: 'https://vault.example.internal',
      namespace: 'ns',
      loginMethod: 'oidc',
      authMount: 'okta',
      oidcRole: 'reader',
      secretPath: 'database/creds/two-readonly',
      caPath: '/ca.pem',
    },
  }
  const plain: ConnectionConfig = { ...base, id: 'c', name: 'Plain', host: 'h3', database: 'x', updatedAt: '2026-05-01T00:00:00Z' }

  it('copies the most recent Vault connection', () => {
    expect(vaultDefaultsFrom([older, plain, newer])).toEqual({
      address: 'https://vault.example.internal',
      namespace: 'ns',
      loginMethod: 'oidc',
      authMount: 'okta',
      oidcRole: 'reader',
      username: '',
      template: 'database/creds/{database}-readonly',
      oidcFallback: true,
      // "two-readonly" names its database: not a role other connections share.
      role: 'read_only',
      caPath: '/ca.pem',
      caFrom: 'https://vault.example.internal',
    })
  })

  it('applies the CA bundle only to the Vault it came from', () => {
    const defaults = vaultDefaultsFrom([newer])
    const same = buildInput(analytics, { ...defaults, address: 'HTTPS://vault.example.internal:443/' }, new Map())
    expect(same.vault?.caPath).toBe('/ca.pem')
    // Another address: Node's default trust store (a CA bundle would replace it).
    const other = buildInput(analytics, { ...defaults, address: 'https://vault.example.cloud' }, new Map())
    expect(other.vault?.address).toBe('https://vault.example.cloud')
    expect(other.vault?.caPath).toBeUndefined()
  })

  it('prefers the template of connections of the same engine', () => {
    const mssqlNewest: ConnectionConfig = {
      ...newer,
      id: 'e',
      dialect: 'mssql',
      database: 'three',
      updatedAt: '2026-06-01T00:00:00Z',
      vault: { ...newer.vault!, secretPath: 'three-database/creds/three-mssql-ro' },
    }
    expect(vaultDefaultsFrom([newer, mssqlNewest]).template).toBe('three-database/creds/{database}-mssql-ro')
    expect(vaultDefaultsFrom([newer, mssqlNewest], 'postgres').template).toBe('database/creds/{database}-readonly')
    expect(defaultTemplate([mssqlNewest], 'postgres')).toBe('three-database/creds/{database}-mssql-ro')
    expect(majorityVaultDialect([analytics, payments, legacy, local])).toBe('postgres')
    expect(majorityVaultDialect([local])).toBeUndefined()
  })

  it('takes the template from the most recent path it can be inferred from', () => {
    const custom: ConnectionConfig = {
      ...newer,
      id: 'd',
      updatedAt: '2026-04-01T00:00:00Z',
      vault: { ...newer.vault!, address: 'https://latest.example.internal', secretPath: 'database/creds/custom-ro' },
    }
    expect(vaultDefaultsFrom([older, custom, newer])).toMatchObject({
      address: 'https://latest.example.internal',
      template: 'database/creds/{database}-readonly',
    })
    expect(vaultDefaultsFrom([older, custom])).toMatchObject({ template: 'database/creds/{database}' })
  })

  it('falls back to empty settings', () => {
    expect(vaultDefaultsFrom([plain])).toEqual(EMPTY_VAULT_SETTINGS)
  })
})

describe('defaultWorkspaceLabel', () => {
  it('names the workspace the default scan looks at', () => {
    expect(defaultWorkspaceLabel('darwin')).toBe('~/Library/DBeaverData/workspace6')
    expect(defaultWorkspaceLabel('win32')).toBe('%APPDATA%\\DBeaverData\\workspace6')
    expect(defaultWorkspaceLabel('linux')).toBe('~/.local/share/DBeaverData/workspace6')
  })
})

describe('shortenPath', () => {
  it('keeps the last segments', () => {
    expect(shortenPath(FILE)).toBe('…/.dbeaver/data-sources-prod.json')
    expect(shortenPath('C:\\Users\\me\\.dbeaver\\data-sources.json')).toBe('…\\.dbeaver\\data-sources.json')
    expect(shortenPath('data-sources.json')).toBe('data-sources.json')
  })
})

describe('scan hints', () => {
  it('fills empty Vault settings from the first hinted candidate', () => {
    const hinted = candidate('hinted', {
      input: vaultInput({ vault: { address: 'https://vault.example.internal', namespace: 'team', loginMethod: 'ldap', username: 'me', secretPath: '' } }),
    })
    expect(fillFromCandidates(EMPTY_VAULT_SETTINGS, [local, analytics, hinted])).toMatchObject({
      address: 'https://vault.example.internal',
      namespace: 'team',
      loginMethod: 'ldap',
      username: 'me',
    })
    const mine = { ...EMPTY_VAULT_SETTINGS, address: 'https://other.example.internal' }
    expect(fillFromCandidates(mine, [hinted])).toBe(mine)
    expect(fillFromCandidates(EMPTY_VAULT_SETTINGS, [analytics])).toBe(EMPTY_VAULT_SETTINGS)
  })

  it('never takes the token sign-in method, or replaces a chosen one, from the file', () => {
    const token = candidate('token-hint', {
      input: vaultInput({ vault: { address: 'https://vault.example.internal', loginMethod: 'token', secretPath: '' } }),
    })
    expect(fillFromCandidates(EMPTY_VAULT_SETTINGS, [token]).loginMethod).toBe(EMPTY_VAULT_SETTINGS.loginMethod)
    const ldap = candidate('ldap-hint', {
      input: vaultInput({ vault: { address: 'https://vault.example.internal', loginMethod: 'ldap', secretPath: '' } }),
    })
    const chosen = { ...EMPTY_VAULT_SETTINGS, loginMethod: 'userpass' as const }
    expect(fillFromCandidates(chosen, [ldap]).loginMethod).toBe('userpass')
  })

  it('hides the notes the dialog handles itself', () => {
    const c = candidate('notes', {
      notes: [
        'Set the Vault address and secret path',
        'Vault sign-in uses OIDC (browser) by default: change it if your Vault uses another method',
        'Marked as production',
        'Vault address ("vault.address"), sign-in method ("vault.auth.method") taken from the DBeaver authentication settings',
        'Only one SSH tunnel is imported',
      ],
    })
    expect(visibleNotes(c)).toEqual(['Only one SSH tunnel is imported'])
    expect(visibleNotes({ ...local, notes: ['Enter the password when connecting', 'Marked as production'] })).toEqual(['Enter the password when connecting'])
  })
})

describe('vault CLI environment and path suggestions', () => {
  it('starts from VAULT_ADDR of the shell and the CLI token (browser as fallback) when no Vault connection exists', () => {
    const env = { source: 'login-shell' as const, address: 'https://vault.example.shared', cliTokenFile: true }
    expect(withEnvironment(EMPTY_VAULT_SETTINGS, env)).toMatchObject({ address: 'https://vault.example.shared', loginMethod: 'token', oidcFallback: true })
    // Settings already pointing at a Vault win; an empty environment changes nothing.
    expect(withEnvironment(settings, env)).toBe(settings)
    expect(withEnvironment(EMPTY_VAULT_SETTINGS, { source: 'none', cliTokenFile: false })).toBe(EMPTY_VAULT_SETTINGS)
    expect(withEnvironment(EMPTY_VAULT_SETTINGS, null)).toBe(EMPTY_VAULT_SETTINGS)
  })

  it('describes each Vault row as a discovery target (folder = environment hint)', () => {
    expect(discoveryTargets([analytics, local, legacy])).toEqual([
      { key: candidateKey(analytics), dialect: 'postgres', host: 'pg-analytics.example.cloud', database: 'warehouse', name: 'PGSQL - Analytics - warehouse', group: 'PROD' },
      { key: candidateKey(legacy), dialect: 'mssql', host: 'mssql-prod.example.cloud', database: 'billing-prod', name: 'SQL SERVER - billing-prod', group: 'PROD' },
    ])
  })

  it('builds the Vault settings sent for discovery (no secret path)', () => {
    expect(panelVaultConfig({ ...settings, loginMethod: 'token', oidcRole: 'reader', authMount: 'okta', username: 'x' })).toEqual({
      address: 'https://vault.example.internal',
      loginMethod: 'token',
      authMount: 'okta',
      oidcRole: 'reader',
      secretPath: '',
    })
    expect(panelVaultConfig({ ...settings, loginMethod: 'token', oidcFallback: false, oidcRole: 'reader' })).toEqual({
      address: 'https://vault.example.internal',
      loginMethod: 'token',
      oidcFallback: false,
      secretPath: '',
    })
    expect(panelVaultConfig({ ...settings, loginMethod: 'userpass', username: ' jane ' })).toMatchObject({ loginMethod: 'userpass', username: 'jane' })
  })

  it('fills rows from suggestions, keeps typed paths, and replaces untouched earlier suggestions', () => {
    const a = candidateKey(analytics)
    const p = candidateKey(payments)
    const l = candidateKey(legacy)
    const suggestion = (key: string, path: string) => ({ key, path, mount: path.replace(/\/creds\/.*$/, ''), score: 0.9, reason: 'r' })
    const typed = new Map([[p, 'my/own/creds/path']])
    const first = applySuggestions(typed, new Map(), [suggestion(a, 'm1/creds/read_only'), suggestion(p, 'm2/creds/read_only')])
    expect(first.overrides.get(a)).toBe('m1/creds/read_only')
    expect(first.overrides.get(p)).toBe('my/own/creds/path') // typed: kept
    expect([...first.suggested.keys()]).toEqual([a])

    // A second run (other role): the untouched suggestion is replaced; a row edited since is kept.
    const edited = new Map(first.overrides)
    edited.set(l, 'typed/after/creds/x')
    const second = applySuggestions(edited, first.suggested, [suggestion(a, 'm1/creds/reporting'), suggestion(l, 'm3/creds/reporting')])
    expect(second.overrides.get(a)).toBe('m1/creds/reporting')
    expect(second.overrides.get(l)).toBe('typed/after/creds/x')
    expect([...second.suggested.keys()]).toEqual([a])

    // A suggestion that no longer comes back leaves its row empty again (not a stale path).
    const third = applySuggestions(second.overrides, second.suggested, [])
    expect(third.overrides.has(a)).toBe(false)
  })

  it('reads the role of a creds path', () => {
    expect(roleOfPath('gcp/prod/data/acme/server/creds/read_only')).toBe('read_only')
    expect(roleOfPath('secret/data/db')).toBe('read_only')
  })
})
