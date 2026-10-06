// Vault facade used by the session manager: login + credentials + per-connection leases.
// Secrets (tokens, passwords) stay in main-process memory; only VaultCredentialsInfo / VaultStatus
// (no password, no token) leave this module towards the renderer.
import type { ConnectionSecrets, VaultConfig, VaultDiscoverResult, VaultDiscoverTarget, VaultLoginEvent, VaultStatus, VaultTestResult } from '@shared/types'
import { DriverError, toErrorInfo } from '../db/errors'
import { isJsonObject, isPermissionDenied, isTokenRejected, VaultError } from './client'
import { vaultIdentityKey } from './config'
import { credentialsInfo, readCredentials, type IssuedCredentials } from './credentials'
import { databaseMounts, DEFAULT_DISCOVERY_ROLE, suggestPaths } from './discovery'
import { clock, ConnectionLeases, type LeaseRecord, type RenewResult } from './leases'
import { canExtendToken, isLoginRequired, LOGIN_REQUIRED_CODE, VaultAuth, type VaultAuthDeps, type VaultToken } from './login'

/** Default time allowed to revoke a lease (disconnect, delete, shutdown). */
export const REVOKE_TIMEOUT_MS = 2_000
/** Shown when the Vault policy does not allow sys/leases/revoke (Vault's default policy does not). */
export const REVOKE_DENIED_NOTE =
  'Your Vault policy does not allow revoking leases (sys/leases/revoke): the temporary database user stays until its lease expires, even after disconnecting.'

/** Vault refused to revoke because of the policy (not because the token is gone). */
export class RevokeDeniedError extends VaultError {
  constructor() {
    super('Vault: permission denied on sys/leases/revoke (403): the policy does not allow revoking leases', 'http', 403)
    this.name = 'RevokeDeniedError'
  }
}

const TOKEN_SOURCE_HINT: Record<VaultToken['source'], string> = {
  env: 'the token from VAULT_TOKEN',
  cli: 'the vault CLI token (~/.vault-token, from "vault login")',
  stored: 'the token saved for this connection',
  oidc: 'an OIDC sign-in',
  ldap: 'an LDAP sign-in',
  userpass: 'a userpass sign-in',
}

/**
 * A secret read refused with 403 says which token was used (VAULT_TOKEN and ~/.vault-token take precedence over a
 * typed token), so the user knows whose policy to check. Never includes the token itself.
 */
export function withTokenSource(error: unknown, token: Pick<VaultToken, 'source'>): unknown {
  if (!isPermissionDenied(error) || !(error instanceof VaultError) || error.info.detail) return error
  const detail = `DataGrippe used ${TOKEN_SOURCE_HINT[token.source]}: check that its Vault policy can read this path.`
  return new VaultError(error.message, error.failure, error.status, { ...error.info, detail })
}

export interface ActiveCredentials {
  /** Lease bookkeeping id (retain / release). */
  leaseKey: string
  username: string
  password: string
}

export interface VaultServiceDeps extends Omit<VaultAuthDeps, 'emit'> {
  onLogin?: (event: VaultLoginEvent) => void
  onStatus?: (status: VaultStatus) => void
  revokeTimeoutMs?: number
  /** Inject a pre-built VaultAuth (tests). */
  auth?: VaultAuth
}

export interface AcquireOptions {
  /** Latest secrets of the connection (background re-issue with a stored ldap password / token). */
  secrets: () => ConnectionSecrets
  /** New credentials were installed (background re-issue, refresh): reopen the metadata pool. */
  onRotated: () => Promise<void>
  /** A superseded lease that sessions still use is about to end: move them to the current credentials. */
  onLeaseEnding?: (leaseKey: string) => Promise<void>
  signal?: AbortSignal
}

export interface IssueOptions {
  interactive: boolean
  signal?: AbortSignal
  /** A token about to expire for good: issuing with it again would only give credentials dying with it. */
  avoidToken?: VaultToken
}

interface ConnectionEntry {
  vault: VaultConfig
  leases: ConnectionLeases
  secrets: () => ConnectionSecrets
}

interface Issued {
  creds: IssuedCredentials
  token: VaultToken
}

function needsUser(error: unknown): boolean {
  return isLoginRequired(error) || (error instanceof DriverError && (error.info.kind === 'needs-password' || error.info.kind === 'invalid-input'))
}

export class VaultService {
  readonly auth: VaultAuth
  private readonly deps: VaultServiceDeps
  private readonly now: () => number
  private readonly log: Pick<Console, 'warn' | 'error'>
  private readonly connections = new Map<string, ConnectionEntry>()
  /** Vault identities (vaultIdentityKey) whose policy denies sys/leases/revoke (true) or allows it (false). */
  private readonly revokeDenied = new Map<string, boolean>()

  constructor(deps: VaultServiceDeps = {}) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? console
    this.auth = deps.auth ?? new VaultAuth({ ...deps, emit: deps.onLogin })
  }

  // -------------------------------------------------------------------------
  // Issue / renew / revoke
  // -------------------------------------------------------------------------

  /** Log in (cached token when possible) and read the secret. A cached token Vault no longer accepts is dropped once. */
  async issue(vault: VaultConfig, secrets: ConnectionSecrets, options: IssueOptions): Promise<Issued> {
    const client = this.auth.client(vault)
    if (options.avoidToken) this.auth.invalidate(options.avoidToken)
    let token = await this.auth.getToken(vault, secrets, options)
    if (options.avoidToken && token.token === options.avoidToken.token) {
      // VAULT_TOKEN / ~/.vault-token / the saved token is still the one that cannot be extended.
      const at = options.avoidToken.expiresAt
      const when = at === undefined ? '' : ` at ${clock(at)}`
      throw new VaultError(`The Vault token expires${when} and cannot be renewed: sign in to Vault again (vault login) or save a new token.`, 'config', undefined, {
        code: LOGIN_REQUIRED_CODE,
      })
    }
    const read = async (t: VaultToken) => {
      try {
        return await readCredentials(client, t.token, vault, { now: this.now, signal: options.signal })
      } catch (error) {
        throw withTokenSource(error, t)
      }
    }
    try {
      return { creds: await read(token), token }
    } catch (error) {
      if (!isPermissionDenied(error) || !token.cached) throw error
      // 403 with a cached token: either the token expired / was revoked, or the policy denies the path.
      if (await this.auth.checkToken(vault, token, options.signal)) throw error
      this.auth.invalidate(token)
      token = await this.auth.getToken(vault, secrets, options)
      return { creds: await read(token), token }
    }
  }

  private async renew(vault: VaultConfig, secrets: () => ConnectionSecrets, lease: LeaseRecord, incrementSec: number): Promise<RenewResult> {
    const client = this.auth.client(vault)
    const call = async (token: string): Promise<RenewResult> => {
      const response = await client.request('PUT', 'sys/leases/renew', { token, body: { lease_id: lease.creds.leaseId, increment: incrementSec } })
      const body = response.body
      return {
        leaseDurationSec: typeof body?.lease_duration === 'number' ? body.lease_duration : 0,
        renewable: body?.renewable === true,
      }
    }
    try {
      return await call(lease.token.token)
    } catch (error) {
      if (!isTokenRejected(error)) throw error
      // The token that issued the lease is gone (expired): renew with a current token of the same identity.
      this.auth.invalidate(lease.token)
      const token = await this.auth.getToken(vault, secrets(), { interactive: false })
      lease.token = token
      return call(token.token)
    }
  }

  /**
   * Best effort, bounded by revokeTimeoutMs. A 403 is either a token Vault no longer accepts (retried with the
   * identity's current token) or a policy without sys/leases/revoke (RevokeDeniedError, remembered per identity).
   */
  async revoke(vault: VaultConfig, leaseId: string, token: VaultToken): Promise<void> {
    const timeoutMs = this.deps.revokeTimeoutMs ?? REVOKE_TIMEOUT_MS
    const client = this.auth.client(vault)
    const call = (t: string) => client.request('PUT', 'sys/leases/revoke', { token: t, body: { lease_id: leaseId }, timeoutMs })
    const denied = (): never => {
      this.setRevokeDenied(vault, true)
      throw new RevokeDeniedError()
    }
    try {
      await call(token.token)
      this.setRevokeDenied(vault, false)
      return
    } catch (error) {
      if (!isTokenRejected(error)) throw error
      if (isPermissionDenied(error) && (await this.auth.checkToken(vault, token).catch(() => false))) denied()
    }
    // Retry with the identity's cached token, never with a new interactive login.
    const current = await this.auth.getToken(vault, {}, { interactive: false }).catch(() => null)
    if (!current || current.token === token.token) throw new VaultError('Vault: the token that issued the lease is no longer valid; the lease could not be revoked', 'http', 403)
    try {
      await call(current.token)
      this.setRevokeDenied(vault, false)
    } catch (error) {
      if (isPermissionDenied(error)) denied()
      throw error
    }
  }

  private setRevokeDenied(vault: VaultConfig, denied: boolean): void {
    const key = vaultIdentityKey(vault)
    if (this.revokeDenied.get(key) === denied) return
    this.revokeDenied.set(key, denied)
    for (const entry of this.connections.values()) if (vaultIdentityKey(entry.vault) === key) entry.leases.publish()
  }

  private revokeNote(vault: VaultConfig): string | undefined {
    return vault.revokeOnDisconnect !== false && this.revokeDenied.get(vaultIdentityKey(vault)) === true ? REVOKE_DENIED_NOTE : undefined
  }

  /** Ask Vault once per identity whether the policy allows revoking (sys/capabilities-self, in the default policy). */
  private async checkRevokeCapability(vault: VaultConfig, token: VaultToken): Promise<void> {
    const key = vaultIdentityKey(vault)
    if (this.revokeDenied.has(key) || vault.revokeOnDisconnect === false) return
    try {
      const response = await this.auth.client(vault).request('POST', 'sys/capabilities-self', { token: token.token, body: { paths: ['sys/leases/revoke'] } })
      const body = response.body as Record<string, unknown> | null
      const data = isJsonObject(body?.data) ? body.data : body
      const raw = data?.['sys/leases/revoke'] ?? data?.capabilities
      if (!Array.isArray(raw)) return
      const caps = raw.filter((c): c is string => typeof c === 'string')
      if (!this.revokeDenied.has(key)) this.setRevokeDenied(vault, !caps.includes('root') && !caps.includes('update'))
    } catch {
      // Unknown: the first revocation tells.
    }
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  /** Log in, read the secret and make it the connection's current credentials (renewals start). */
  async acquire(connectionId: string, vault: VaultConfig, secrets: ConnectionSecrets, options: AcquireOptions): Promise<ActiveCredentials> {
    const { creds, token } = await this.issue(vault, secrets, { interactive: true, signal: options.signal })
    const previous = this.connections.get(connectionId)
    if (previous) {
      this.connections.delete(connectionId)
      await previous.leases.close(previous.vault.revokeOnDisconnect !== false)
    }
    const entry: ConnectionEntry = { vault, secrets: options.secrets, leases: undefined as unknown as ConnectionLeases }
    const onLeaseEnding = options.onLeaseEnding
    entry.leases = new ConnectionLeases(connectionId, vault.revokeOnDisconnect !== false, {
      renew: (lease, increment) => this.renew(entry.vault, entry.secrets, lease, increment),
      renewToken: (lease) => this.auth.renewToken(entry.vault, lease.token),
      reissue: (previous) => this.issue(entry.vault, entry.secrets(), { interactive: false, avoidToken: previous ? endingToken(previous) : undefined }),
      revoke: (lease) => (lease.creds.leaseId ? this.revoke(entry.vault, lease.creds.leaseId, lease.token) : Promise.resolve()),
      rotated: options.onRotated,
      ...(onLeaseEnding ? { retire: (lease: LeaseRecord) => onLeaseEnding(lease.key) } : {}),
      emit: (status) => this.deps.onStatus?.(status),
      now: this.now,
      needsUser,
      interactiveLogin: vault.loginMethod === 'oidc' || (vault.loginMethod === 'token' && vault.oidcFallback !== false),
      note: () => this.revokeNote(entry.vault),
      log: this.log,
    })
    this.connections.set(connectionId, entry)
    const lease = entry.leases.install(creds, token)
    if (creds.kind === 'dynamic') void this.checkRevokeCapability(vault, token)
    return { leaseKey: lease.key, username: creds.username, password: creds.password }
  }

  has(connectionId: string): boolean {
    return this.connections.has(connectionId)
  }

  current(connectionId: string): ActiveCredentials | null {
    const lease = this.connections.get(connectionId)?.leases.current
    return lease ? { leaseKey: lease.key, username: lease.creds.username, password: lease.creds.password } : null
  }

  retain(connectionId: string, leaseKey: string, holder: string): void {
    this.connections.get(connectionId)?.leases.retain(leaseKey, holder)
  }

  release(connectionId: string, leaseKey: string, holder: string): void {
    this.connections.get(connectionId)?.leases.release(leaseKey, holder)
  }

  status(connectionId: string): VaultStatus | null {
    return this.connections.get(connectionId)?.leases.status() ?? null
  }

  needsRefresh(connectionId: string): boolean {
    return this.connections.get(connectionId)?.leases.needsRefresh() ?? false
  }

  /**
   * Issue new credentials now (may sign in interactively unless `interactive` is false) and install them; the
   * metadata pool is reopened. With `ifNeeded`, only when the current ones are expired (or about to).
   */
  async refresh(connectionId: string, { ifNeeded = false, interactive = true }: { ifNeeded?: boolean; interactive?: boolean } = {}): Promise<VaultStatus> {
    const entry = this.connections.get(connectionId)
    if (!entry) throw DriverError.of('not-found', 'This connection is not connected.')
    await entry.leases.refresh(
      () => {
        // A token that cannot outlive the current lease is replaced (sign in again) rather than reused.
        const previous = entry.leases.current
        return this.issue(entry.vault, entry.secrets(), { interactive, avoidToken: previous ? endingToken(previous) : undefined })
      },
      { ifNeeded },
    )
    return entry.leases.status()
  }

  /** Re-arm every lease timer from the wall clock (after the machine woke up): overdue work runs now. */
  resync(): void {
    for (const entry of this.connections.values()) entry.leases.resync()
  }

  /**
   * Stop renewals and revoke the connection's leases (unless revokeOnDisconnect is false). With `leaseKey`, only
   * when that lease belongs to the current entry (a newer connect may already have replaced it).
   */
  async end(connectionId: string, leaseKey?: string): Promise<void> {
    const entry = this.connections.get(connectionId)
    if (!entry) return
    if (leaseKey !== undefined && !entry.leases.lease(leaseKey) && entry.leases.current?.key !== leaseKey) return
    this.connections.delete(connectionId)
    await entry.leases.close(entry.vault.revokeOnDisconnect !== false)
  }

  // -------------------------------------------------------------------------
  // Tests / misc
  // -------------------------------------------------------------------------

  /** Credentials for a one-off use (connections:test): a dynamic lease is revoked right after `fn`. */
  async withTestCredentials<T>(vault: VaultConfig, secrets: ConnectionSecrets, fn: (creds: IssuedCredentials) => Promise<T>): Promise<T> {
    const { creds, token } = await this.issue(vault, secrets, { interactive: true })
    try {
      return await fn(creds)
    } finally {
      if (creds.kind === 'dynamic' && creds.leaseId) {
        await this.revoke(vault, creds.leaseId, token).catch((error: unknown) =>
          this.log.warn(`[vault] revoking the test lease failed: ${error instanceof Error ? error.message : String(error)}`),
        )
      }
    }
  }

  /** vault:test — login + read (+ immediate revoke of a dynamic lease). Never throws. */
  async test(vault: VaultConfig, secrets: ConnectionSecrets): Promise<VaultTestResult> {
    const started = this.now()
    try {
      const { creds, token } = await this.issue(vault, secrets, { interactive: true })
      const latencyMs = Math.max(0, Math.round(this.now() - started))
      const warnings: string[] = []
      if (creds.kind === 'dynamic' && creds.leaseId) {
        await this.revoke(vault, creds.leaseId, token).catch((error: unknown) => {
          if (error instanceof RevokeDeniedError) {
            if (vault.revokeOnDisconnect !== false) warnings.push(REVOKE_DENIED_NOTE)
            return
          }
          this.log.warn(`[vault] revoking the test lease failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      return { ok: true, info: credentialsInfo(creds, token.source), latencyMs, ...(warnings.length > 0 ? { warnings } : {}) }
    } catch (error) {
      return { ok: false, error: toErrorInfo(error) }
    }
  }

  /**
   * vault:discover — sign in (same rules as connecting) and suggest "<mount>/creds/<role>" for each target from the
   * database secrets engines the token can see (sys/internal/ui/mounts, allowed by Vault's default policy).
   * A refused listing becomes a warning; sign-in problems (password, cancel) are thrown for the UI to handle.
   */
  async discover(vault: VaultConfig, secrets: ConnectionSecrets, targets: VaultDiscoverTarget[], role: string = DEFAULT_DISCOVERY_ROLE): Promise<VaultDiscoverResult> {
    const client = this.auth.client(vault)
    let token = await this.auth.getToken(vault, secrets, { interactive: true })
    const list = (t: VaultToken) => client.request('GET', 'sys/internal/ui/mounts', { token: t.token })
    let body: unknown
    try {
      body = (await list(token)).body
    } catch (error) {
      if (isPermissionDenied(error) && token.cached && !(await this.auth.checkToken(vault, token))) {
        // A saved / cached token Vault no longer accepts: sign in again once.
        this.auth.invalidate(token)
        token = await this.auth.getToken(vault, secrets, { interactive: true })
        body = (await list(token)).body
      } else if (error instanceof VaultError && error.failure === 'http' && error.status !== undefined && [403, 404, 405].includes(error.status)) {
        return {
          mounts: [],
          suggestions: [],
          warnings: [`Vault did not list its secrets engines (${error.status}): type the secret path, e.g. <mount>/creds/${role}.`],
        }
      } else {
        throw error
      }
    }
    const mounts = databaseMounts(body)
    const { suggestions, ranking } = suggestPaths(mounts, targets, role)
    const warnings = mounts.length === 0 ? ['Your Vault token sees no database secrets engine: type the secret path by hand.'] : []
    return { mounts, suggestions, ranking, warnings }
  }

  logout(address: string, namespace?: string): void {
    this.auth.logout(address, namespace)
  }

  cancelLogin(): void {
    this.auth.cancelLogin()
  }

  /**
   * Stop every timer and pending login, and revoke the leases still alive (each bounded by revokeTimeoutMs): the
   * session manager's shutdown normally revoked them already, but it gives up waiting on slow database closes.
   */
  async dispose(): Promise<void> {
    this.auth.cancelLogin()
    const entries = [...this.connections.values()]
    this.connections.clear()
    await Promise.allSettled(entries.map((e) => e.leases.close(e.vault.revokeOnDisconnect !== false)))
  }
}

/** The lease's token cannot be extended past the lease's end: a re-issue must not reuse it. */
function endingToken(lease: LeaseRecord): VaultToken | undefined {
  const token = lease.token
  if (lease.creds.kind !== 'dynamic' || token.expiresAt === undefined || canExtendToken(token)) return undefined
  return lease.creds.expiresAt === undefined || token.expiresAt <= lease.creds.expiresAt ? token : undefined
}
