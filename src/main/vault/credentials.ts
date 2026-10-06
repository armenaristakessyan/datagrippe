// Read database credentials from a Vault secret: database secrets engine (dynamic, with a lease),
// KV v2 or KV v1 (static). The response shape decides.
import type { VaultConfig, VaultCredentialsInfo, VaultTokenSource } from '@shared/types'
import { isJsonObject, VaultError, type VaultBody, type VaultClient } from './client'

export interface IssuedCredentials {
  username: string
  password: string
  kind: 'dynamic' | 'static'
  /** Dynamic only. */
  leaseId?: string
  /** Latest lease duration granted (seconds). */
  leaseDurationSec?: number
  renewable?: boolean
  /** Epoch ms (local clock) when the credentials were requested. */
  issuedAt: number
  /**
   * Epoch ms (local clock) when the credentials stop working: lease expiry (dynamic), next password rotation
   * (database static role, `static-creds`). Undefined for a KV secret.
   */
  expiresAt?: number
}

export const DEFAULT_USERNAME_KEY = 'username'
export const DEFAULT_PASSWORD_KEY = 'password'

function keysOf(fields: Record<string, unknown>): string {
  const keys = Object.keys(fields).sort()
  return keys.length > 0 ? keys.map((k) => `"${k}"`).join(', ') : 'none'
}

/** Database static role answer (`<mount>/static-creds/<role>`): no lease, the password rotates after data.ttl seconds. */
function rotationTtlSec(data: Record<string, unknown>): number | undefined {
  if (typeof data.ttl !== 'number' || !Number.isFinite(data.ttl) || data.ttl < 0) return undefined
  if (!('rotation_period' in data) && !('last_vault_rotation' in data) && !('rotation_schedule' in data)) return undefined
  return data.ttl
}

/**
 * Parse a secret read from `path` (values are never put in error messages, only key names). `token` (the Vault
 * token that read it) must never come back as a user name or password: that would hand it to the renderer.
 */
export function parseSecret(body: VaultBody | null, config: VaultConfig, issuedAt: number, token?: string): IssuedCredentials {
  const path = config.secretPath
  const data = body?.data
  if (!isJsonObject(data)) throw new VaultError(`Vault: the secret at ${path} has no data`, 'json')
  const usernameKey = config.usernameKey || DEFAULT_USERNAME_KEY
  const passwordKey = config.passwordKey || DEFAULT_PASSWORD_KEY
  const leaseId = typeof body?.lease_id === 'string' ? body.lease_id : ''

  let fields: Record<string, unknown>
  let kind: IssuedCredentials['kind']
  let engine: string
  if (leaseId) {
    fields = data
    kind = 'dynamic'
    engine = 'dynamic secret'
  } else if (isJsonObject(data.metadata) && 'data' in data) {
    if (!isJsonObject(data.data)) {
      throw new VaultError(`Vault: the latest version of the KV secret at ${path} is deleted or destroyed`, 'json')
    }
    fields = data.data
    kind = 'static'
    engine = 'KV v2 secret'
  } else {
    fields = data
    kind = 'static'
    engine = 'secret'
  }

  const username = fields[usernameKey]
  const password = fields[passwordKey]
  const missing = [
    typeof username === 'string' && username !== '' ? null : usernameKey,
    typeof password === 'string' ? null : passwordKey,
  ].filter((k): k is string => k !== null)
  if (missing.length > 0) {
    const what = missing.map((k) => `"${k}"`).join(' and ')
    throw new VaultError(`Vault: the ${engine} at ${path} has no ${what} key (available keys: ${keysOf(fields)})`, 'json')
  }

  if (token && (username === token || password === token)) {
    throw new VaultError(`Vault: the secret at ${path} returned the Vault token itself: it is not a database secret`, 'json')
  }

  const creds: IssuedCredentials = { username: username as string, password: password as string, kind, issuedAt }
  const rotationTtl = kind === 'static' && engine === 'secret' ? rotationTtlSec(data) : undefined
  if (rotationTtl !== undefined) creds.expiresAt = issuedAt + rotationTtl * 1000
  if (kind === 'dynamic') {
    creds.leaseId = leaseId
    const duration = typeof body?.lease_duration === 'number' && body.lease_duration > 0 ? body.lease_duration : undefined
    if (duration) {
      creds.leaseDurationSec = duration
      creds.expiresAt = issuedAt + duration * 1000
    }
    creds.renewable = body?.renewable === true
  }
  return creds
}

/** GET the secret and parse it. Adds a KV v2 hint to a 404 on a path without "data/". */
export async function readCredentials(
  client: VaultClient,
  token: string,
  config: VaultConfig,
  options: { now: () => number; signal?: AbortSignal },
): Promise<IssuedCredentials> {
  const issuedAt = options.now()
  try {
    const response = await client.request('GET', config.secretPath, { token, signal: options.signal })
    return parseSecret(response.body, config, issuedAt, token)
  } catch (error) {
    if (error instanceof VaultError && error.status === 404 && !/(^|\/)(data|creds|static-creds)\//.test(config.secretPath)) {
      throw new VaultError(`${error.message}. For a KV v2 secret the path includes "data/" (e.g. secret/data/my-app).`, 'http', 404)
    }
    throw error
  }
}

/** Renderer-safe view (no password). */
export function credentialsInfo(creds: IssuedCredentials, tokenSource: VaultTokenSource): VaultCredentialsInfo {
  const info: VaultCredentialsInfo = { username: creds.username, kind: creds.kind, tokenSource, issuedAt: creds.issuedAt }
  if (creds.expiresAt !== undefined) info.expiresAt = creds.expiresAt
  if (creds.leaseDurationSec !== undefined) info.leaseDurationSec = creds.leaseDurationSec
  if (creds.renewable !== undefined) info.renewable = creds.renewable
  return info
}
