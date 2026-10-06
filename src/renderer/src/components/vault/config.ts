// Vault settings shared by the connection dialog and the DBeaver import dialog: sign-in method labels and
// the same address / path rules as the main process (src/main/vault/config.ts), which rejects what fails here.
import type { VaultDefaults, VaultLoginMethod } from '@shared/types'

export const VAULT_METHOD_OPTIONS: { value: VaultLoginMethod; label: string; hint: string }[] = [
  { value: 'token', label: 'Vault CLI token (vault login)', hint: 'CLI' },
  { value: 'oidc', label: 'OIDC (browser SSO)', hint: 'Browser' },
  { value: 'ldap', label: 'LDAP', hint: 'Password' },
  { value: 'userpass', label: 'Userpass', hint: 'Password' },
]

/** Role appended to a database secrets engine mount by "Suggest": "<mount>/creds/<role>". */
export const DEFAULT_DISCOVERY_ROLE = 'read_only'

/** A role name main accepts (same rule as SessionManager.vaultDiscover). */
export function isDiscoveryRole(role: string): boolean {
  return /^[A-Za-z0-9_.@-]{1,128}$/.test(role)
}

/** "<mount>/creds/<role>". */
export function credsPath(mount: string, role: string): string {
  return `${mount.replace(/\/+$/, '')}/creds/${role.trim() || DEFAULT_DISCOVERY_ROLE}`
}

/**
 * Vault server settings of the user's environment (VAULT_ADDR from the shell profile, ~/.vault-token from
 * `vault login`), as a new Vault connection should start: the CLI token, with the browser as fallback.
 * Null when the environment names no Vault server and has no CLI token.
 */
export function environmentVaultSettings(
  defaults: VaultDefaults | null,
): { address: string; namespace: string; loginMethod: VaultLoginMethod; oidcFallback: boolean } | null {
  if (!defaults || (!defaults.address && !defaults.cliTokenFile)) return null
  return {
    address: defaults.address ?? '',
    namespace: defaults.namespace ?? '',
    // Like DBeaver's Vault plugin: reuse the token of `vault login`; the browser signs in when it expired.
    loginMethod: 'token',
    oidcFallback: true,
  }
}

/** Slash-separated segments of [A-Za-z0-9_.@:+=,-], no empty, "." or ".." segment. */
export function isVaultPath(path: string): boolean {
  return /^[A-Za-z0-9_.@:+=,\-/]+$/.test(path) && path.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
}

/** Why a Vault address is not accepted, or undefined. */
export function vaultAddressError(raw: string): string | undefined {
  const value = raw.trim()
  if (!value) return 'Vault address is required.'
  if (!/^https?:\/\//i.test(value)) return 'Start with https:// (or http://), e.g. https://vault.example.com.'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'This is not a valid URL.'
  }
  if (!url.hostname) return 'Include a host name.'
  if (url.username || url.password) return 'Leave the user name and password out of the address.'
  if (url.search || url.hash) return 'Remove the query string or fragment.'
  // Tokens, LDAP passwords and the issued database passwords would cross the network in clear.
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return 'Use https:// for a remote Vault server (http:// is only allowed on this machine).'
  }
  return undefined
}

/** localhost, *.localhost, 127.0.0.0/8 and ::1 (URL.hostname keeps IPv6 brackets). Same as main's isLoopbackHost. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
}

/**
 * Address as main stores it (normalizeVaultAddress in src/main/vault/client.ts): no trailing slash, no /v1 suffix,
 * and nothing from /ui on (an address copied from the Vault web UI). Invalid input is returned trimmed.
 */
export function normalizeVaultAddress(raw: string): string {
  const value = raw.trim()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return value.replace(/\/+$/, '')
  }
  if (!/^https?:$/.test(url.protocol) || url.search || url.hash || url.username || url.password) return value.replace(/\/+$/, '')
  const path = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/ui(\/.*)?$/i, '')
    .replace(/\/v1$/i, '')
  return `${url.protocol}//${url.host}${path}`
}

/** Why a secret path (leading / trailing slashes already removed) is not accepted, or undefined. */
export function vaultSecretPathError(path: string): string | undefined {
  if (!path) return 'Secret path is required, e.g. database/creds/readonly.'
  if (/^v1(\/|$)/i.test(path)) return 'Leave out the /v1/ prefix: database/creds/readonly.'
  if (/\s/.test(path)) return 'Secret path cannot contain spaces.'
  if (!isVaultPath(path)) return 'Secret path contains invalid characters.'
  // Vault's own APIs (token lookup, policies, identity, cubbyhole) are not database secrets: main refuses them.
  const system = /^(auth|sys|identity|cubbyhole|token)(\/|$)/i.exec(path)
  if (system) return `"${path.split('/')[0]}/…" is not a secret path: use a secrets engine path such as database/creds/my-role.`
  return undefined
}

/** Why the user name / password keys of a KV secret are not accepted (empty = the defaults), or undefined. */
export function vaultSecretKeysError(usernameKey: string, passwordKey: string): string | undefined {
  if ((usernameKey.trim() || 'username') === (passwordKey.trim() || 'password')) {
    return 'The user name key and the password key of the Vault secret must differ.'
  }
  return undefined
}

/** Comparable form of a Vault address: lower-cased origin (default port dropped) + path without trailing slashes. */
export function vaultAddressKey(raw: string): string {
  const value = raw.trim().replace(/\/+$/, '')
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`.toLowerCase()
  } catch {
    return value.toLowerCase()
  }
}

/** Both addresses name the same Vault server (an empty one matches nothing). */
export function sameVaultAddress(a: string | undefined, b: string | undefined): boolean {
  if (!a?.trim() || !b?.trim()) return false
  return vaultAddressKey(a) === vaultAddressKey(b)
}
