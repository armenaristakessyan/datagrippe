import { describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '@shared/types'
import {
  applyParsed,
  changeDialect,
  effectiveName,
  emptyForm,
  formFromConfig,
  formSecrets,
  formToInput,
  isDirty,
  lastVaultDefaults,
  newVaultDefaults,
  prefillVault,
  suggestName,
  suggestsSafety,
  typeSecret,
  updateForm,
  validateForm,
  validateVault,
  vaultSecretStored,
  type ConnectionForm,
} from './connection-form'
import { fillPromptedSecret, promptedVaultSecret, vaultPromptOpening } from './vault-prompt'

const saved: ConnectionConfig = {
  id: 'abc',
  name: 'Prod',
  dialect: 'postgres',
  host: 'db.internal',
  port: 5432,
  database: 'shop',
  user: 'app',
  savePassword: true,
  hasPassword: true,
  ssl: { mode: 'verify-full', caPath: '/etc/ca.pem' },
  ssh: { enabled: true, host: 'bastion', port: 2222, username: 'ops', authMethod: 'privateKey', privateKeyPath: '/k' },
  color: 'red',
  group: 'Production',
  readOnly: true,
  productionGuard: true,
  options: { connectTimeoutMs: 20000, defaultSchema: 'sales' },
  createdAt: '',
  updatedAt: '',
}

describe('name suggestion', () => {
  it('follows host and database until the user types a name', () => {
    let form = updateForm(emptyForm(), { host: 'db.example.com' })
    expect(form.name).toBe('db.example.com')
    form = updateForm(form, { database: 'shop' })
    expect(form.name).toBe('shop@db.example.com')
    form = updateForm(form, { name: 'Shop prod' })
    form = updateForm(form, { database: 'other' })
    expect(form.name).toBe('Shop prod')
  })

  it('hands the name back to the suggestion when cleared', () => {
    let form = updateForm(updateForm(emptyForm(), { name: 'Mine' }), { name: '' })
    expect(form.nameEdited).toBe(false)
    expect(form.name).toBe('')
    expect(effectiveName(form)).toBe('localhost')
    form = updateForm(form, { host: 'h2' })
    expect(form.name).toBe('h2')
  })

  it('includes the SQL Server instance', () => {
    expect(suggestName({ dialect: 'mssql', host: 'srv', database: '', instanceName: 'SQLEXPRESS' })).toBe('srv\\SQLEXPRESS')
    expect(suggestName({ dialect: 'postgres', host: 'srv', database: 'db', instanceName: 'ignored' })).toBe('db@srv')
  })
})

describe('dialect switch', () => {
  it('updates an untouched port and the default SSL mode', () => {
    const form = changeDialect(emptyForm('postgres'), 'mssql')
    expect(form.port).toBe(1433)
    expect(form.ssl.mode).toBe('require')
    expect(changeDialect(form, 'postgres').port).toBe(5432)
  })

  it('keeps a port the user changed', () => {
    const form = updateForm(emptyForm('postgres'), { port: 6543, portEdited: true })
    expect(changeDialect(form, 'mssql').port).toBe(6543)
  })

  it('treats a port equal to the old default as untouched', () => {
    const form = updateForm(emptyForm('postgres'), { port: 5432, portEdited: true })
    expect(changeDialect(form, 'mssql').port).toBe(1433)
  })
})

describe('secrets', () => {
  it('only sends secrets that changed', () => {
    const form = formFromConfig(saved)
    expect(formToInput(form, 'abc').secrets).toBeUndefined()
    const typed = { ...form, password: typeSecret(form.password, 'new') }
    expect(formToInput(typed, 'abc').secrets).toEqual({ password: 'new' })
  })

  it('distinguishes clearing from leaving empty', () => {
    const form = formFromConfig(saved)
    expect(typeSecret(form.password, '')).toEqual({ value: '', action: 'keep' })
    const cleared = { ...form, password: { value: '', action: 'clear' as const } }
    expect(formToInput(cleared).secrets).toEqual({ password: '' })
    expect(typeSecret(cleared.password, '')).toEqual({ value: '', action: 'clear' })
    expect(typeSecret(cleared.password, 'x')).toEqual({ value: 'x', action: 'set' })
  })

  it('sends SSH secrets only for the active auth method', () => {
    const form = formFromConfig(saved)
    const withBoth = { ...form, ssh: { ...form.ssh, password: typeSecret(form.ssh.password, 'pw'), passphrase: typeSecret(form.ssh.passphrase, 'pp') } }
    expect(formToInput(withBoth).secrets).toEqual({ sshPassphrase: 'pp' })
    expect(formToInput({ ...withBoth, ssh: { ...withBoth.ssh, authMethod: 'password' } }).secrets).toEqual({ sshPassword: 'pw' })
    expect(formToInput({ ...withBoth, ssh: { ...withBoth.ssh, enabled: false } }).secrets).toBeUndefined()
  })
})

describe('round trip', () => {
  it('converts a saved connection to a form and back', () => {
    const input = formToInput(formFromConfig(saved), 'abc')
    expect(input).toEqual({
      id: 'abc',
      name: 'Prod',
      dialect: 'postgres',
      host: 'db.internal',
      port: 5432,
      database: 'shop',
      user: 'app',
      savePassword: true,
      ssl: { mode: 'verify-full', caPath: '/etc/ca.pem' },
      ssh: { enabled: true, host: 'bastion', port: 2222, username: 'ops', authMethod: 'privateKey', privateKeyPath: '/k' },
      color: 'red',
      group: 'Production',
      readOnly: true,
      productionGuard: true,
      options: { connectTimeoutMs: 20000, defaultSchema: 'sales' },
    })
  })

  it('drops dialect-specific fields of the other dialect', () => {
    const form = updateForm(emptyForm('postgres'), { instanceName: 'X', ssl: { mode: 'require', caPath: '', certPath: '/c', keyPath: '/k' } })
    expect(formToInput(form).options.instanceName).toBeUndefined()
    const mssql = changeDialect(form, 'mssql')
    expect(formToInput(mssql).ssl).toEqual({ mode: 'require' })
    expect(formToInput(mssql).options.instanceName).toBe('X')
  })

  it('detects changes', () => {
    const initial = formFromConfig(saved)
    expect(isDirty(initial, { ...initial })).toBe(false)
    expect(isDirty(initial, updateForm(initial, { host: 'other' }))).toBe(true)
    expect(isDirty(initial, { ...initial, password: typeSecret(initial.password, 'x') })).toBe(true)
  })
})

describe('validation', () => {
  it('reports required fields and ranges', () => {
    const form = updateForm(emptyForm(), { host: '', port: 0, connectTimeoutSec: 0 })
    expect(validateForm(form)).toEqual({
      name: expect.any(String),
      host: expect.any(String),
      port: expect.any(String),
      timeout: expect.any(String),
    })
    expect(validateForm(emptyForm())).toEqual({})
  })

  it('validates SSH only when enabled', () => {
    const form = emptyForm()
    const ssh = { ...form, ssh: { ...form.ssh, enabled: true } }
    expect(Object.keys(validateForm(ssh)).sort()).toEqual(['sshHost', 'sshKey', 'sshUser'])
    expect(Object.keys(validateForm({ ...ssh, ssh: { ...ssh.ssh, authMethod: 'agent' } })).sort()).toEqual(['sshHost', 'sshUser'])
  })
})

describe('connection strings', () => {
  it('fill the form and switch dialect', () => {
    const form = applyParsed(emptyForm('postgres'), {
      dialect: 'mssql',
      host: 'sql',
      port: 1444,
      database: 'hr',
      user: 'sa',
      password: 'pw',
      sslMode: 'disable',
      instanceName: 'INST',
      connectTimeoutMs: 30000,
    })
    expect(form).toMatchObject({
      dialect: 'mssql',
      host: 'sql',
      port: 1444,
      portEdited: true,
      database: 'hr',
      user: 'sa',
      password: { value: 'pw', action: 'set' },
      instanceName: 'INST',
      connectTimeoutSec: 30,
      name: 'hr@sql\\INST',
    })
    expect(form.ssl.mode).toBe('disable')
  })

  it('keep fields the string does not mention', () => {
    const base = updateForm(emptyForm('postgres'), { user: 'me', name: 'Mine' })
    const form = applyParsed(base, { dialect: 'postgres', host: 'h' })
    expect(form.user).toBe('me')
    expect(form.name).toBe('Mine')
    expect(form.port).toBe(5432)
  })
})

describe('safety suggestion', () => {
  it('nudges red connections that are not fully protected', () => {
    expect(suggestsSafety({ color: 'red', readOnly: false, productionGuard: true })).toBe(true)
    expect(suggestsSafety({ color: 'red', readOnly: true, productionGuard: true })).toBe(false)
    expect(suggestsSafety({ color: 'green', readOnly: false, productionGuard: false })).toBe(false)
  })
})

const savedVault: ConnectionConfig = {
  ...saved,
  id: 'vlt',
  user: '',
  savePassword: false,
  hasPassword: false,
  authMode: 'vault',
  vault: {
    address: 'https://vault.example.com',
    namespace: 'team-a',
    loginMethod: 'oidc',
    authMount: 'okta',
    oidcRole: 'dba',
    secretPath: 'database/creds/readonly',
    revokeOnDisconnect: false,
    caPath: '/etc/vault-ca.pem',
  },
  updatedAt: '2026-10-01T10:00:00.000Z',
}

function vaultForm(patch: Partial<ConnectionForm['vault']> = {}): ConnectionForm {
  const form = updateForm(emptyForm(), { host: 'pg-main.example.internal', database: 'app', authMode: 'vault' })
  return {
    ...form,
    vault: { ...form.vault, address: 'https://vault.example.com', secretPath: 'database/creds/readonly', ...patch },
  }
}

describe('vault: serialization', () => {
  it('round-trips a saved Vault connection', () => {
    const form = formFromConfig(savedVault)
    expect(form.authMode).toBe('vault')
    expect(form.storedAuthMode).toBe('vault')
    const input = formToInput(form, savedVault.id)
    expect(input.authMode).toBe('vault')
    expect(input.vault).toEqual(savedVault.vault)
    expect(input.user).toBe('')
    expect(input.secrets).toBeUndefined()
    expect(isDirty(form, formFromConfig(savedVault))).toBe(false)
  })

  it('normalizes what was typed and drops the fields of other sign-in methods', () => {
    const input = formToInput(
      vaultForm({
        address: ' https://vault.example.com/v1/ ',
        namespace: '/team-a/',
        loginMethod: 'ldap',
        authMount: 'ldap',
        oidcRole: 'ignored',
        username: ' jane ',
        secretPath: '/database/creds/readonly/',
      }),
    )
    expect(input.vault).toEqual({
      address: 'https://vault.example.com',
      namespace: 'team-a',
      loginMethod: 'ldap',
      username: 'jane',
      secretPath: 'database/creds/readonly',
      revokeOnDisconnect: true,
    })
  })

  it('keeps a custom mount and the KV keys', () => {
    const input = formToInput(vaultForm({ loginMethod: 'userpass', username: 'svc', authMount: 'people', usernameKey: 'user', passwordKey: 'pass' }))
    expect(input.vault).toMatchObject({ authMount: 'people', usernameKey: 'user', passwordKey: 'pass' })
  })

  it('keeps the OIDC role / mount of the token method only for its browser fallback', () => {
    const fallback = formToInput(vaultForm({ loginMethod: 'token', authMount: 'okta', oidcRole: 'dba' }))
    expect(fallback.vault).toMatchObject({ loginMethod: 'token', authMount: 'okta', oidcRole: 'dba' })
    expect(fallback.vault?.oidcFallback).toBeUndefined()
    // The default mount ("oidc") is not stored.
    expect(formToInput(vaultForm({ loginMethod: 'token', authMount: 'oidc' })).vault?.authMount).toBeUndefined()
    const off = formToInput(vaultForm({ loginMethod: 'token', authMount: 'okta', oidcRole: 'dba', oidcFallback: false }))
    expect(off.vault?.oidcFallback).toBe(false)
    expect(off.vault?.authMount).toBeUndefined()
    expect(off.vault?.oidcRole).toBeUndefined()
  })

  it('sends Vault secrets of the active sign-in method only', () => {
    const typed = { value: 's3cret', action: 'set' as const }
    expect(formToInput(vaultForm({ loginMethod: 'token', token: { value: 'hvs.x', action: 'set' }, password: typed })).secrets).toEqual({
      vaultToken: 'hvs.x',
    })
    expect(formToInput(vaultForm({ loginMethod: 'ldap', username: 'j', password: typed })).secrets).toEqual({ vaultPassword: 's3cret' })
  })

  it('sends the Vault password with savePassword: main stores it or keeps it in memory', () => {
    const form = vaultForm({ loginMethod: 'userpass', username: 'j', password: { value: 'pw', action: 'set' }, savePassword: false })
    expect(formToInput(form)).toMatchObject({ savePassword: false, secrets: { vaultPassword: 'pw' } })
    expect(formToInput({ ...form, vault: { ...form.vault, password: { value: '', action: 'clear' } } }).secrets).toEqual({ vaultPassword: '' })
  })

  it('knows whether a Vault secret is stored when editing', () => {
    const form = formFromConfig({ ...savedVault, hasVaultSecret: true })
    expect(vaultSecretStored(form)).toBe(true)
    expect(vaultSecretStored(formFromConfig(savedVault))).toBe(false)
    // The stored secret belongs to the saved sign-in method.
    expect(vaultSecretStored({ ...form, vault: { ...form.vault, loginMethod: 'ldap' } })).toBe(false)
  })

  it('keeps both sets of values while switching modes; only the selected one is saved', () => {
    let form = formFromConfig(saved)
    form = updateForm(form, { authMode: 'vault' })
    form = { ...form, vault: { ...form.vault, address: 'https://vault.example.com', secretPath: 'database/creds/ro' } }
    const asVault = formToInput(form, saved.id)
    expect(asVault.authMode).toBe('vault')
    expect(asVault.user).toBe('')
    // The stored database password of the former password connection is no longer used.
    expect(asVault.secrets).toEqual({ password: '' })
    const back = updateForm(form, { authMode: 'password' })
    expect(back.user).toBe('app')
    expect(back.vault.address).toBe('https://vault.example.com')
    const asPassword = formToInput(back, saved.id)
    expect(asPassword.authMode).toBeUndefined()
    expect(asPassword.vault).toBeUndefined()
    expect(asPassword.user).toBe('app')
    expect(isDirty(formFromConfig(saved), back)).toBe(false)
  })

  it('forgets stored Vault secrets when a Vault connection switches to a password', () => {
    const form = updateForm(formFromConfig(savedVault), { authMode: 'password', user: 'app' })
    expect(formToInput(form).secrets).toEqual({ vaultToken: '', vaultPassword: '' })
  })
})

describe('vault: validation', () => {
  it('requires an http(s) address and a secret path', () => {
    expect(validateVault(vaultForm({ address: '', secretPath: '' }).vault)).toEqual({
      vaultAddress: expect.stringContaining('required'),
      vaultSecretPath: expect.stringContaining('required'),
    })
    expect(validateVault(vaultForm({ address: 'vault.example.com' }).vault).vaultAddress).toContain('https://')
    expect(validateVault(vaultForm({ address: 'https://vault.example.com/?x=1' }).vault).vaultAddress).toContain('query')
    expect(validateVault(vaultForm({ address: 'https://u:p@vault.example.com' }).vault).vaultAddress).toContain('password')
    expect(validateVault(vaultForm({ address: 'ftp://vault.example.com' }).vault).vaultAddress).toBeDefined()
    expect(validateVault(vaultForm({ address: 'http://127.0.0.1:8200' }).vault)).toEqual({})
  })

  it('rejects the /v1/ prefix and spaces in the secret path', () => {
    expect(validateVault(vaultForm({ secretPath: '/v1/database/creds/ro' }).vault).vaultSecretPath).toContain('/v1/')
    expect(validateVault(vaultForm({ secretPath: 'v1/secret/data/app' }).vault).vaultSecretPath).toContain('/v1/')
    expect(validateVault(vaultForm({ secretPath: 'database/creds/read only' }).vault).vaultSecretPath).toContain('spaces')
    expect(validateVault(vaultForm({ secretPath: 'v1x/kv/app' }).vault)).toEqual({})
    expect(validateVault(vaultForm({ secretPath: 'database/../sys' }).vault).vaultSecretPath).toContain('invalid')
    expect(validateVault(vaultForm({ secretPath: 'kv/a?b' }).vault).vaultSecretPath).toContain('invalid')
    expect(validateVault(vaultForm({ authMount: 'my mount!' }).vault).vaultMount).toContain('invalid')
  })

  it('applies the rules main added: https for remote servers, no system paths, distinct secret keys', () => {
    expect(validateVault(vaultForm({ address: 'http://vault.example.com' }).vault).vaultAddress).toContain('https://')
    expect(validateVault(vaultForm({ secretPath: 'auth/token/lookup-self' }).vault).vaultSecretPath).toContain('not a secret path')
    expect(validateVault(vaultForm({ usernameKey: 'password' }).vault).vaultKeys).toContain('must differ')
    expect(validateForm(vaultForm({ usernameKey: 'password' })).vaultKeys).toBeDefined()
  })

  it('saves the API address of one copied from the Vault web UI', () => {
    const input = formToInput(vaultForm({ address: 'https://vault.example.com/ui/vault/secrets' }))
    expect(input.vault?.address).toBe('https://vault.example.com')
  })

  it('requires a username for LDAP and userpass', () => {
    expect(validateVault(vaultForm({ loginMethod: 'ldap' }).vault).vaultUser).toBeDefined()
    expect(validateVault(vaultForm({ loginMethod: 'userpass', username: 'jane' }).vault)).toEqual({})
    expect(validateVault(vaultForm({ loginMethod: 'oidc' }).vault)).toEqual({})
  })

  it('only applies in Vault mode, where the database user is not needed', () => {
    const form = vaultForm({ address: '' })
    expect(validateForm(form).vaultAddress).toBeDefined()
    expect(validateForm({ ...form, authMode: 'password' }).vaultAddress).toBeUndefined()
  })
})

describe('vault: prefill from the last Vault connection', () => {
  it('reuses the server settings of the most recently updated one, never the secret path', () => {
    const older = { ...savedVault, id: 'old', updatedAt: '2026-01-01T00:00:00.000Z', vault: { ...savedVault.vault!, address: 'https://old.example.com' } }
    const defaults = lastVaultDefaults([saved, older, savedVault])
    expect(defaults).toEqual({
      address: 'https://vault.example.com',
      namespace: 'team-a',
      loginMethod: 'oidc',
      authMount: 'okta',
      oidcRole: 'dba',
      username: '',
      caPath: '/etc/vault-ca.pem',
      oidcFallback: true,
    })
    const form = prefillVault(emptyForm(), defaults)
    expect(form.authMode).toBe('password')
    expect(form.vault.address).toBe('https://vault.example.com')
    expect(form.vault.secretPath).toBe('')
  })

  it('does nothing without Vault connections', () => {
    expect(lastVaultDefaults([saved])).toBeNull()
    expect(prefillVault(emptyForm(), null)).toEqual(emptyForm())
  })

  it('starts from the vault CLI environment when no Vault connection exists', () => {
    const env = { source: 'login-shell' as const, address: 'https://vault.example.shared', cliTokenFile: true }
    expect(newVaultDefaults([saved], env)).toEqual({ address: 'https://vault.example.shared', namespace: '', loginMethod: 'token', oidcFallback: true })
    // ~/.vault-token alone: the CLI token, the address is still to type.
    expect(newVaultDefaults([saved], { source: 'none', cliTokenFile: true })).toMatchObject({ address: '', loginMethod: 'token' })
    expect(newVaultDefaults([saved], { source: 'none', cliTokenFile: false })).toBeNull()
    // An existing Vault connection wins over the environment.
    expect(newVaultDefaults([savedVault], env)?.address).toBe('https://vault.example.com')
  })
})

describe('vault: prompted secrets while testing', () => {
  it('recognizes the Vault secrets main asks for', () => {
    expect(promptedVaultSecret({ ok: false, error: { message: 'x', kind: 'needs-password', secretField: 'vaultToken' } })).toBe('vaultToken')
    expect(promptedVaultSecret({ ok: false, error: { message: 'x', kind: 'needs-password', secretField: 'vaultPassword' } })).toBe('vaultPassword')
    expect(promptedVaultSecret({ ok: false, error: { message: 'x', kind: 'needs-password' } })).toBeNull()
    expect(promptedVaultSecret({ ok: false, error: { message: 'x', kind: 'vault' } })).toBeNull()
    expect(promptedVaultSecret({ ok: true })).toBeNull()
  })

  it('fills the prompted secret into the form', () => {
    const form = fillPromptedSecret(vaultForm({ loginMethod: 'ldap', username: 'j' }), 'vaultPassword', 'pw')
    expect(form.vault.password).toEqual({ value: 'pw', action: 'set' })
    expect(fillPromptedSecret(vaultForm(), 'vaultToken', 'hvs.t').vault.token).toEqual({ value: 'hvs.t', action: 'set' })
  })

  it('never turns a stored Vault password into "clear" with an empty answer', () => {
    const stored = formFromConfig({ ...saved, savePassword: true, hasVaultSecret: true, authMode: 'vault', vault: { address: 'https://vault.example.internal', loginMethod: 'userpass', username: 'alice', secretPath: 'database/creds/ro' } })
    const form = fillPromptedSecret(stored, 'vaultPassword', '')
    expect(form).toBe(stored)
    expect(formSecrets(form)?.vaultPassword).toBeUndefined()
  })

  it('opens the prompt with the rejection of a stored secret, like the explorer connect flow', () => {
    const missing = { message: 'Vault password required', kind: 'needs-password' as const, secretField: 'vaultPassword' as const }
    const rejected = { ...missing, message: 'Vault rejected the password for alice', detail: 'invalid username or password (400)' }
    // A stored password, VAULT_TOKEN or ~/.vault-token was refused: main says so in `detail`.
    expect(vaultPromptOpening({ error: rejected }, false)).toEqual(rejected)
    // A value typed for this attempt and refused.
    expect(vaultPromptOpening({ error: missing }, true)).toEqual(missing)
    // Merely missing: a clean prompt.
    expect(vaultPromptOpening({ error: missing }, false)).toBeUndefined()
    expect(vaultPromptOpening({ error: { message: 'x', kind: 'vault' } }, true)).toBeUndefined()
  })
})
