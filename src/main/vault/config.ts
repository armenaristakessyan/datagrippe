// VaultConfig validation / normalization (used by the connections store and the Vault service).
import { DEFAULT_VAULT_AUTH_MOUNT, type VaultConfig, type VaultLoginMethod } from '@shared/types'
import { DriverError } from '../db/errors'
import { normalizeVaultAddress, normalizeVaultNamespace } from './client'

export const VAULT_LOGIN_METHODS: VaultLoginMethod[] = ['token', 'oidc', 'ldap', 'userpass']

function invalid(message: string): DriverError {
  return DriverError.of('invalid-input', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Auth / secret paths: slash-separated segments, no "..", no query / fragment / whitespace. */
const PATH_CHARS = /^[A-Za-z0-9_.@:+=,\-/]+$/

function cleanPath(raw: string): string {
  return raw.trim().replace(/^\/+/, '').replace(/\/+$/, '')
}

function checkPath(path: string, label: string): void {
  if (!PATH_CHARS.test(path) || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw invalid(`${label} contains invalid characters.`)
  }
}

/** Normalized secret path, or throws invalid-input. */
export function normalizeSecretPath(raw: unknown): string {
  const path = cleanPath(typeof raw === 'string' ? raw : '')
  if (!path) throw invalid('Vault secret path is required (e.g. database/creds/my-role).')
  if (/^v1(\/|$)/i.test(path)) throw invalid('Vault secret path must not start with /v1/ — use e.g. database/creds/my-role.')
  checkPath(path, 'Vault secret path')
  // Vault's own APIs (token lookup, policies, identity, cubbyhole) are not database secrets: reading them would
  // hand the token or other secrets to the renderer as a "user name".
  if (SYSTEM_PATH.test(path)) throw invalid(`"${path.split('/')[0]}/…" is not a secret path: use a secrets engine path such as database/creds/my-role.`)
  return path
}

const SYSTEM_PATH = /^(auth|sys|identity|cubbyhole|token)(\/|$)/i

/**
 * Validate a renderer-provided Vault configuration and return the persisted shape.
 * `lenient` (reading connections.json, or a connection not using Vault) keeps incomplete settings instead of throwing.
 */
export function validateVaultConfig(
  raw: unknown,
  { lenient = false, requireSecretPath = true }: { lenient?: boolean; requireSecretPath?: boolean } = {},
): VaultConfig {
  if (!isRecord(raw)) {
    if (lenient) return { address: '', loginMethod: 'token', secretPath: '' }
    throw invalid('Vault settings are required.')
  }
  const attempt = <T>(fn: () => T, fallback: T): T => {
    if (!lenient) return fn()
    try {
      return fn()
    } catch {
      return fallback
    }
  }
  const address = attempt(() => normalizeVaultAddress(typeof raw.address === 'string' ? raw.address : ''), optStr(raw.address) ?? '')
  const loginMethod = VAULT_LOGIN_METHODS.includes(raw.loginMethod as VaultLoginMethod) ? (raw.loginMethod as VaultLoginMethod) : null
  if (!loginMethod && !lenient) throw invalid('Unknown Vault login method.')
  const method: VaultLoginMethod = loginMethod ?? 'token'
  const secretPath = requireSecretPath
    ? attempt(() => normalizeSecretPath(raw.secretPath), optStr(raw.secretPath) ?? '')
    : optStr(raw.secretPath) === undefined
      ? ''
      : normalizeSecretPath(raw.secretPath)

  const config: VaultConfig = { address, loginMethod: method, secretPath }
  const namespace = normalizeVaultNamespace(typeof raw.namespace === 'string' ? raw.namespace : undefined)
  if (namespace) {
    attempt(() => checkPath(namespace, 'Vault namespace'), undefined)
    config.namespace = namespace
  }
  // The token method falls back to an OIDC browser sign-in (like `vault login -method=oidc`) unless disabled:
  // it keeps the OIDC mount and role for that.
  const oidcFallback = method === 'token' && raw.oidcFallback !== false
  if (method === 'token' && raw.oidcFallback === false) config.oidcFallback = false
  const mount = typeof raw.authMount === 'string' ? cleanPath(raw.authMount) : ''
  if (mount && (method !== 'token' || oidcFallback)) {
    attempt(() => checkPath(mount, 'Vault auth mount'), undefined)
    config.authMount = mount
  }
  const role = optStr(raw.oidcRole)
  if (role && (method === 'oidc' || oidcFallback)) config.oidcRole = role
  const username = optStr(raw.username)
  if (username && (method === 'ldap' || method === 'userpass')) config.username = username
  if ((method === 'ldap' || method === 'userpass') && !username && !lenient) throw invalid('Vault user name is required for LDAP / userpass login.')
  const usernameKey = optStr(raw.usernameKey)
  if (usernameKey) config.usernameKey = usernameKey
  const passwordKey = optStr(raw.passwordKey)
  if (passwordKey) config.passwordKey = passwordKey
  if ((usernameKey ?? 'username') === (passwordKey ?? 'password') && !lenient) {
    throw invalid('The user name key and the password key of the Vault secret must differ.')
  }
  if (raw.revokeOnDisconnect === false) config.revokeOnDisconnect = false
  const caPath = optStr(raw.caPath)
  if (caPath) config.caPath = caPath
  return config
}

/** Mount path of the auth method ("" for token, whose OIDC fallback uses oidcFallbackConfig). */
export function authMountOf(config: VaultConfig): string {
  if (config.loginMethod === 'token') return ''
  return config.authMount || DEFAULT_VAULT_AUTH_MOUNT[config.loginMethod]
}

/** Identifies a Vault server (+ namespace). */
export function vaultServerKey(address: string, namespace?: string): string {
  let normalized = address
  try {
    normalized = normalizeVaultAddress(address)
  } catch {
    // keep the raw value: it simply matches nothing
  }
  return `${normalized.toLowerCase()}|${normalizeVaultNamespace(namespace)}`
}

/** Identifies a Vault identity: server + login method + mount + role / user (token cache key). */
export function vaultIdentityKey(config: VaultConfig): string {
  const who = config.loginMethod === 'oidc' ? (config.oidcRole ?? '') : config.loginMethod === 'token' ? '' : (config.username ?? '')
  return `${vaultServerKey(config.address, config.namespace)}|${config.loginMethod}|${authMountOf(config)}|${who}`
}

/** Same Vault server and identity: a stored Vault token / password of one may be sent for the other. */
export function sameVaultIdentity(a: VaultConfig | undefined, b: VaultConfig | undefined): boolean {
  if (!a || !b) return false
  return vaultIdentityKey(a) === vaultIdentityKey(b)
}
