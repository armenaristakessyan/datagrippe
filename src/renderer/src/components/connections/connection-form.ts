// Connection dialog form model: defaults, conversion from/to the persisted shape, validation,
// name suggestion and connection-string application. Pure; the dialog holds one ConnectionForm.
import {
  DEFAULT_PORT,
  DEFAULT_VAULT_AUTH_MOUNT,
  type ConnectionAuthMode,
  type ConnectionColor,
  type ConnectionConfig,
  type ConnectionInput,
  type ConnectionSecrets,
  type Dialect,
  type SshAuthMethod,
  type SslMode,
  type VaultConfig,
  type VaultDefaults,
  type VaultLoginMethod,
} from '@shared/types'
import { environmentVaultSettings, isVaultPath, normalizeVaultAddress, vaultAddressError, vaultSecretKeysError, vaultSecretPathError } from '@/components/vault/config'
import type { ParsedConnection } from '@/lib/connection-string'

/**
 * keep  = leave what main has stored (secrets: undefined)
 * set   = send `value`
 * clear = send '' (removes the stored secret)
 */
export interface SecretField {
  value: string
  action: 'keep' | 'set' | 'clear'
}

/** Vault settings of the form (VaultConfig + the secrets typed for it). Kept while in password mode. */
export interface VaultForm {
  address: string
  namespace: string
  loginMethod: VaultLoginMethod
  /** '' = the method's default mount (DEFAULT_VAULT_AUTH_MOUNT). */
  authMount: string
  oidcRole: string
  username: string
  secretPath: string
  usernameKey: string
  passwordKey: string
  revokeOnDisconnect: boolean
  caPath: string
  /** ldap / userpass password (secrets.vaultPassword). */
  password: SecretField
  /**
   * Store the Vault password / token typed or prompted (else kept in memory until quit).
   * Saved as ConnectionConfig.savePassword, which main applies to the Vault secrets in Vault mode.
   */
  savePassword: boolean
  /** Editing: main has the Vault secret of `storedMethod` stored (ConnectionConfig.hasVaultSecret). */
  secretStored: boolean
  /** Sign-in method of the saved connection (null when new). */
  storedMethod: VaultLoginMethod | null
  /** Token for the 'token' method when VAULT_TOKEN / ~/.vault-token are not usable (secrets.vaultToken). */
  token: SecretField
  /**
   * 'token' method: sign in with the browser (OIDC, authMount / oidcRole) when the CLI token is missing or
   * expired, like `vault login -method=oidc` (VaultConfig.oidcFallback).
   */
  oidcFallback: boolean
}

export interface ConnectionForm {
  dialect: Dialect
  name: string
  /** The user typed a name: stop suggesting one. */
  nameEdited: boolean
  color: ConnectionColor
  group: string
  host: string
  port: number | null
  /** The user changed the port: switching dialect keeps it. */
  portEdited: boolean
  database: string
  user: string
  password: SecretField
  /** Editing: a password is stored in main (shown as a placeholder). */
  passwordStored: boolean
  savePassword: boolean
  ssl: { mode: SslMode; caPath: string; certPath: string; keyPath: string }
  ssh: {
    enabled: boolean
    host: string
    port: number | null
    username: string
    authMethod: SshAuthMethod
    privateKeyPath: string
    password: SecretField
    passphrase: SecretField
  }
  applicationName: string
  /** Seconds, null = default (15 s). */
  connectTimeoutSec: number | null
  instanceName: string
  defaultSchema: string
  /** PostgreSQL session time zone: '' = server default, 'local' = this computer's zone, else a zone name. */
  timeZone: string
  showSystemObjects: boolean
  readOnly: boolean
  productionGuard: boolean
  authMode: ConnectionAuthMode
  /** Auth mode of the saved connection (editing): switching away clears the other mode's stored secrets. */
  storedAuthMode: ConnectionAuthMode | null
  vault: VaultForm
}

export type FieldKey =
  | 'name'
  | 'host'
  | 'port'
  | 'sshHost'
  | 'sshPort'
  | 'sshUser'
  | 'sshKey'
  | 'timeout'
  | 'vaultAddress'
  | 'vaultUser'
  | 'vaultSecretPath'
  | 'vaultMount'
  | 'vaultKeys'
export type FormErrors = Partial<Record<FieldKey, string>>
export type SectionId = 'general' | 'ssl' | 'ssh' | 'advanced'

export const FIELD_SECTION: Record<FieldKey, SectionId> = {
  name: 'general',
  host: 'general',
  port: 'general',
  sshHost: 'ssh',
  sshPort: 'ssh',
  sshUser: 'ssh',
  sshKey: 'ssh',
  timeout: 'advanced',
  vaultAddress: 'general',
  vaultUser: 'general',
  vaultSecretPath: 'general',
  vaultMount: 'general',
  vaultKeys: 'general',
}

const keep = (): SecretField => ({ value: '', action: 'keep' })

export function emptyForm(dialect: Dialect = 'postgres'): ConnectionForm {
  return {
    dialect,
    name: '',
    nameEdited: false,
    color: 'none',
    group: '',
    host: 'localhost',
    port: DEFAULT_PORT[dialect],
    portEdited: false,
    database: '',
    user: '',
    password: keep(),
    passwordStored: false,
    savePassword: true,
    ssl: { mode: dialect === 'mssql' ? 'require' : 'prefer', caPath: '', certPath: '', keyPath: '' },
    ssh: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      authMethod: 'privateKey',
      privateKeyPath: '',
      password: keep(),
      passphrase: keep(),
    },
    applicationName: '',
    connectTimeoutSec: null,
    instanceName: '',
    defaultSchema: '',
    timeZone: '',
    showSystemObjects: false,
    readOnly: false,
    productionGuard: false,
    authMode: 'password',
    storedAuthMode: null,
    vault: emptyVaultForm(),
  }
}

export function emptyVaultForm(): VaultForm {
  return {
    address: '',
    namespace: '',
    loginMethod: 'oidc',
    authMount: '',
    oidcRole: '',
    username: '',
    secretPath: '',
    usernameKey: '',
    passwordKey: '',
    revokeOnDisconnect: true,
    caPath: '',
    password: keep(),
    savePassword: true,
    secretStored: false,
    storedMethod: null,
    token: keep(),
    oidcFallback: true,
  }
}

function vaultFormFromConfig(v: VaultConfig, savePassword: boolean, secretStored: boolean): VaultForm {
  return {
    ...emptyVaultForm(),
    address: v.address,
    namespace: v.namespace ?? '',
    loginMethod: v.loginMethod,
    authMount: v.authMount ?? '',
    oidcRole: v.oidcRole ?? '',
    username: v.username ?? '',
    secretPath: v.secretPath,
    usernameKey: v.usernameKey ?? '',
    passwordKey: v.passwordKey ?? '',
    revokeOnDisconnect: v.revokeOnDisconnect ?? true,
    caPath: v.caPath ?? '',
    savePassword,
    secretStored,
    storedMethod: v.loginMethod,
    oidcFallback: v.oidcFallback !== false,
  }
}

export function formFromConfig(c: ConnectionConfig): ConnectionForm {
  return {
    dialect: c.dialect,
    name: c.name,
    nameEdited: true,
    color: c.color,
    group: c.group ?? '',
    host: c.host,
    port: c.port,
    portEdited: c.port !== DEFAULT_PORT[c.dialect],
    database: c.database,
    user: c.user,
    password: keep(),
    passwordStored: c.hasPassword,
    savePassword: c.savePassword,
    ssl: { mode: c.ssl.mode, caPath: c.ssl.caPath ?? '', certPath: c.ssl.certPath ?? '', keyPath: c.ssl.keyPath ?? '' },
    ssh: {
      enabled: c.ssh.enabled,
      host: c.ssh.host,
      port: c.ssh.port,
      username: c.ssh.username,
      authMethod: c.ssh.authMethod,
      privateKeyPath: c.ssh.privateKeyPath ?? '',
      password: keep(),
      passphrase: keep(),
    },
    applicationName: c.options.applicationName ?? '',
    connectTimeoutSec: c.options.connectTimeoutMs ? Math.round(c.options.connectTimeoutMs / 1000) : null,
    instanceName: c.options.instanceName ?? '',
    defaultSchema: c.options.defaultSchema ?? '',
    timeZone: c.options.timeZone ?? '',
    showSystemObjects: c.options.showSystemObjects ?? false,
    readOnly: c.readOnly,
    productionGuard: c.productionGuard,
    authMode: c.authMode === 'vault' && c.vault ? 'vault' : 'password',
    storedAuthMode: c.authMode === 'vault' && c.vault ? 'vault' : 'password',
    vault: c.authMode === 'vault' && c.vault ? vaultFormFromConfig(c.vault, c.savePassword, c.hasVaultSecret === true) : emptyVaultForm(),
  }
}

/**
 * The Vault server settings of the most recently saved Vault connection (to prefill a new one):
 * address, namespace, sign-in method, mount, role, username and CA. Never the secret path.
 */
export function lastVaultDefaults(connections: readonly ConnectionConfig[]): Partial<VaultForm> | null {
  let best: ConnectionConfig | null = null
  for (const c of connections) {
    if (c.authMode !== 'vault' || !c.vault?.address) continue
    if (!best || c.updatedAt > best.updatedAt) best = c
  }
  const v = best?.vault
  if (!v) return null
  return {
    address: v.address,
    namespace: v.namespace ?? '',
    loginMethod: v.loginMethod,
    authMount: v.authMount ?? '',
    oidcRole: v.oidcRole ?? '',
    username: v.username ?? '',
    caPath: v.caPath ?? '',
    oidcFallback: v.oidcFallback !== false,
  }
}

/**
 * What a new connection's Vault settings start from: the last Vault connection saved, else the vault CLI's
 * environment (VAULT_ADDR from the shell profile, ~/.vault-token from `vault login`).
 */
export function newVaultDefaults(connections: readonly ConnectionConfig[], environment: VaultDefaults | null): Partial<VaultForm> | null {
  return lastVaultDefaults(connections) ?? environmentVaultSettings(environment)
}

/** The stored Vault secret (editing) belongs to the current sign-in method. */
export function vaultSecretStored(form: ConnectionForm): boolean {
  return form.storedAuthMode === 'vault' && form.vault.secretStored && form.vault.storedMethod === form.vault.loginMethod
}

/** Prefill the (untouched) Vault settings of a new connection. */
export function prefillVault(form: ConnectionForm, defaults: Partial<VaultForm> | null): ConnectionForm {
  if (!defaults) return form
  return { ...form, vault: { ...form.vault, ...defaults } }
}

/** "database@host" (or the host alone); the instance is part of the host for SQL Server. */
export function suggestName(form: Pick<ConnectionForm, 'dialect' | 'host' | 'database' | 'instanceName'>): string {
  const host = form.host.trim()
  const instance = form.dialect === 'mssql' ? form.instanceName.trim() : ''
  const target = instance ? `${host}\\${instance}` : host
  const database = form.database.trim()
  if (database && target) return `${database}@${target}`
  return database || target
}

/**
 * Apply a patch, keeping the suggested name in sync until the user edits it. Clearing the name hands it
 * back to the suggestion (shown as placeholder now, filled in on the next host / database change).
 */
export function updateForm(form: ConnectionForm, patch: Partial<ConnectionForm>): ConnectionForm {
  const next = { ...form, ...patch }
  if ('name' in patch) {
    if (!('nameEdited' in patch)) next.nameEdited = (patch.name ?? '').trim() !== ''
    return next
  }
  if (!next.nameEdited) next.name = suggestName(next)
  return next
}

/** Name that will be saved: the typed one, else the suggestion. */
export function effectiveName(form: ConnectionForm): string {
  return form.name.trim() || suggestName(form)
}

/** Switch dialect: the port follows unless the user changed it; the SSL default follows too when untouched. */
export function changeDialect(form: ConnectionForm, dialect: Dialect): ConnectionForm {
  if (dialect === form.dialect) return form
  const portUntouched = !form.portEdited || form.port === DEFAULT_PORT[form.dialect]
  const defaultSsl = form.dialect === 'mssql' ? 'require' : 'prefer'
  return updateForm(form, {
    dialect,
    port: portUntouched ? DEFAULT_PORT[dialect] : form.port,
    portEdited: portUntouched ? false : form.portEdited,
    ssl: form.ssl.mode === defaultSsl ? { ...form.ssl, mode: dialect === 'mssql' ? 'require' : 'prefer' } : form.ssl,
  })
}

/** Fill the form from a parsed connection string (only the parts the string contains). */
export function applyParsed(form: ConnectionForm, parsed: ParsedConnection): ConnectionForm {
  let next = changeDialect(form, parsed.dialect)
  const patch: Partial<ConnectionForm> = {}
  if (parsed.host !== undefined) patch.host = parsed.host
  if (parsed.port !== undefined) {
    patch.port = parsed.port
    patch.portEdited = parsed.port !== DEFAULT_PORT[parsed.dialect]
  }
  if (parsed.database !== undefined) patch.database = parsed.database
  if (parsed.user !== undefined) patch.user = parsed.user
  if (parsed.password !== undefined) patch.password = { value: parsed.password, action: 'set' }
  if (parsed.sslMode !== undefined) patch.ssl = { ...next.ssl, mode: parsed.sslMode }
  if (parsed.instanceName !== undefined) patch.instanceName = parsed.instanceName
  if (parsed.applicationName !== undefined) patch.applicationName = parsed.applicationName
  if (parsed.connectTimeoutMs !== undefined) patch.connectTimeoutSec = Math.max(1, Math.round(parsed.connectTimeoutMs / 1000))
  next = updateForm(next, patch)
  return next
}

/** Typing in a secret field: non-empty → set; emptied → back to keep (or clear if it was cleared before). */
export function typeSecret(field: SecretField, value: string): SecretField {
  if (value !== '') return { value, action: 'set' }
  return { value: '', action: field.action === 'clear' ? 'clear' : 'keep' }
}

const isPort = (n: number | null): n is number => n !== null && Number.isInteger(n) && n >= 1 && n <= 65535

export function validateForm(form: ConnectionForm): FormErrors {
  const errors: FormErrors = {}
  if (!effectiveName(form)) errors.name = 'Give the connection a name.'
  if (!form.host.trim()) errors.host = 'Host is required.'
  else if (/\s/.test(form.host.trim())) errors.host = 'Host cannot contain spaces.'
  if (!isPort(form.port)) errors.port = 'Port must be between 1 and 65535.'
  if (form.connectTimeoutSec !== null && (form.connectTimeoutSec < 1 || form.connectTimeoutSec > 600)) {
    errors.timeout = 'Between 1 and 600 seconds.'
  }
  if (form.ssh.enabled) {
    if (!form.ssh.host.trim()) errors.sshHost = 'SSH host is required.'
    if (!isPort(form.ssh.port)) errors.sshPort = 'Port must be between 1 and 65535.'
    if (!form.ssh.username.trim()) errors.sshUser = 'SSH user is required.'
    if (form.ssh.authMethod === 'privateKey' && !form.ssh.privateKeyPath.trim()) errors.sshKey = 'Choose a private key file.'
  }
  if (form.authMode === 'vault') Object.assign(errors, validateVault(form.vault))
  return errors
}

/** Same rules as the main process (src/main/vault/config.ts): it rejects what fails here. */
export function validateVault(v: VaultForm): FormErrors {
  const errors: FormErrors = {}
  const address = vaultAddressError(v.address)
  if (address) errors.vaultAddress = address
  const path = vaultSecretPathError(v.secretPath.trim().replace(/^\/+|\/+$/g, ''))
  if (path) errors.vaultSecretPath = path
  if ((v.loginMethod === 'ldap' || v.loginMethod === 'userpass') && !v.username.trim()) errors.vaultUser = 'Vault username is required.'
  const mount = v.authMount.trim().replace(/^\/+|\/+$/g, '')
  const mountUsed = v.loginMethod !== 'token' || v.oidcFallback
  if (mountUsed && mount && !isVaultPath(mount)) errors.vaultMount = 'Mount path contains invalid characters.'
  const keys = vaultSecretKeysError(v.usernameKey, v.passwordKey)
  if (keys) errors.vaultKeys = keys
  return errors
}

const secretValue = (field: SecretField): string | undefined =>
  field.action === 'set' ? field.value : field.action === 'clear' ? '' : undefined

/** Secrets sent with the input (main stores them, or keeps them in memory when savePassword is off). */
export function formSecrets(form: ConnectionForm): ConnectionSecrets | undefined {
  const secrets: ConnectionSecrets = {}
  const vault = form.authMode === 'vault'
  if (vault) {
    const v = form.vault
    if (v.loginMethod === 'token') {
      const token = secretValue(v.token)
      if (token !== undefined) secrets.vaultToken = token
    }
    if (v.loginMethod === 'ldap' || v.loginMethod === 'userpass') {
      const password = secretValue(v.password)
      if (password !== undefined) secrets.vaultPassword = password
    }
    // Switching a saved password connection to Vault: its database password is no longer used.
    if (form.storedAuthMode === 'password' && form.passwordStored) secrets.password = ''
  } else {
    const password = secretValue(form.password)
    if (password !== undefined) secrets.password = password
    // Switching a saved Vault connection back to a password: forget what was stored for Vault.
    if (form.storedAuthMode === 'vault') {
      secrets.vaultToken = ''
      secrets.vaultPassword = ''
    }
  }
  if (form.ssh.enabled && form.ssh.authMethod === 'password') {
    const v = secretValue(form.ssh.password)
    if (v !== undefined) secrets.sshPassword = v
  }
  if (form.ssh.enabled && form.ssh.authMethod === 'privateKey') {
    const v = secretValue(form.ssh.passphrase)
    if (v !== undefined) secrets.sshPassphrase = v
  }
  return Object.keys(secrets).length > 0 ? secrets : undefined
}

const opt = (s: string) => (s.trim() ? s.trim() : undefined)

const trimSlashes = (s: string) => s.trim().replace(/^\/+|\/+$/g, '')

export function vaultConfigFromForm(v: VaultForm): VaultConfig {
  const login = v.loginMethod
  const userLogin = login === 'ldap' || login === 'userpass'
  // The token method keeps the OIDC mount / role of its browser fallback.
  const fallback = login === 'token' && v.oidcFallback
  const mount = login === 'token' && !fallback ? '' : trimSlashes(v.authMount)
  const defaultMount = login === 'token' ? DEFAULT_VAULT_AUTH_MOUNT.oidc : DEFAULT_VAULT_AUTH_MOUNT[login]
  return {
    // Like main: no trailing slash, no /v1 suffix, nothing from /ui on.
    address: normalizeVaultAddress(v.address),
    namespace: opt(trimSlashes(v.namespace)),
    loginMethod: login,
    authMount: mount && mount !== defaultMount ? mount : undefined,
    oidcRole: login === 'oidc' || fallback ? opt(v.oidcRole) : undefined,
    ...(login === 'token' && !v.oidcFallback ? { oidcFallback: false } : {}),
    username: userLogin ? opt(v.username) : undefined,
    secretPath: trimSlashes(v.secretPath),
    usernameKey: opt(v.usernameKey),
    passwordKey: opt(v.passwordKey),
    revokeOnDisconnect: v.revokeOnDisconnect,
    caPath: opt(v.caPath),
  }
}

export function formToInput(form: ConnectionForm, id?: string): ConnectionInput {
  const vault = form.authMode === 'vault'
  const input: ConnectionInput = {
    name: effectiveName(form),
    dialect: form.dialect,
    host: form.host.trim(),
    port: form.port ?? DEFAULT_PORT[form.dialect],
    database: form.database.trim(),
    // In Vault mode the user comes from Vault; savePassword applies to the Vault token / password.
    user: vault ? '' : form.user.trim(),
    savePassword: vault ? form.vault.savePassword : form.savePassword,
    ssl: {
      mode: form.ssl.mode,
      caPath: opt(form.ssl.caPath),
      certPath: form.dialect === 'postgres' ? opt(form.ssl.certPath) : undefined,
      keyPath: form.dialect === 'postgres' ? opt(form.ssl.keyPath) : undefined,
    },
    ssh: {
      enabled: form.ssh.enabled,
      host: form.ssh.host.trim(),
      port: form.ssh.port ?? 22,
      username: form.ssh.username.trim(),
      authMethod: form.ssh.authMethod,
      privateKeyPath: form.ssh.authMethod === 'privateKey' ? opt(form.ssh.privateKeyPath) : undefined,
    },
    color: form.color,
    group: opt(form.group),
    readOnly: form.readOnly,
    productionGuard: form.productionGuard,
    options: {
      applicationName: opt(form.applicationName),
      connectTimeoutMs: form.connectTimeoutSec !== null ? form.connectTimeoutSec * 1000 : undefined,
      instanceName: form.dialect === 'mssql' ? opt(form.instanceName) : undefined,
      defaultSchema: opt(form.defaultSchema),
      timeZone: form.dialect === 'postgres' && form.timeZone.trim().toLowerCase() !== 'server' ? opt(form.timeZone) : undefined,
      showSystemObjects: form.showSystemObjects || undefined,
    },
  }
  if (vault) {
    input.authMode = 'vault'
    input.vault = vaultConfigFromForm(form.vault)
  }
  if (id) input.id = id
  const secrets = formSecrets(form)
  if (secrets) input.secrets = secrets
  return stripUndefined(input)
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value) || value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = stripUndefined(v)
  return out as T
}

/** True when saving would change something (secrets typed count as changes). */
export function isDirty(initial: ConnectionForm, current: ConnectionForm): boolean {
  return JSON.stringify(formToInput(initial)) !== JSON.stringify(formToInput(current))
}

/** Red usually means production: nudge towards read-only + confirmations. */
export function suggestsSafety(form: Pick<ConnectionForm, 'color' | 'readOnly' | 'productionGuard'>): boolean {
  return form.color === 'red' && !(form.readOnly && form.productionGuard)
}
