// Vault login: token sources (VAULT_TOKEN, ~/.vault-token, stored token) with an OIDC browser fallback, OIDC
// browser flow (same as `vault login -method=oidc`), ldap / userpass. Tokens are cached in memory per Vault
// identity; tokens from an interactive sign-in are also kept encrypted (VaultTokenStore) until they expire.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_VAULT_AUTH_MOUNT, type ConnectionSecrets, type VaultConfig, type VaultLoginEvent, type VaultTokenSource } from '@shared/types'
import { DriverError } from '../db/errors'
import { PERSISTED_TOKEN_SOURCES, type VaultTokenStoreLike } from '../store/vault-tokens'
import { isJsonObject, isTokenRejected, VaultClient, VaultError, type VaultAuthBlock } from './client'
import { authMountOf, vaultIdentityKey, vaultServerKey } from './config'
import type { VaultEnvironment } from './environment'
import { oidcResultPage } from './oidc-page'

export const OIDC_CALLBACK_PORT = 8250
export const OIDC_TIMEOUT_MS = 5 * 60_000
/** Error code of a VaultError raised when a browser sign-in is needed but not allowed (background renewal). */
export const LOGIN_REQUIRED_CODE = 'VAULT_LOGIN_REQUIRED'
/** A cached token is dropped this long before it expires. */
const TOKEN_EXPIRY_MARGIN_MS = 30_000

export interface VaultToken {
  token: string
  source: VaultTokenSource
  /** Epoch ms (local clock) when the token expires; undefined = no expiry (root tokens). */
  expiresAt?: number
  /** TTL granted when obtained / last renewed, in seconds. */
  ttlSec?: number
  renewable: boolean
  /** TTL to ask for when renewing (auth/token/renew-self), seconds: the TTL the token was created with. */
  incrementSec?: number
  /** Vault will not extend this token past expiresAt (max TTL reached). */
  final?: boolean
  /** Token cache key (vaultIdentityKey). */
  key: string
  /** Served from the in-memory cache (vs. obtained by this call). */
  cached: boolean
  obtainedAt: number
}

export interface LoginOptions {
  /** Allow a browser sign-in (OIDC). Background renewals pass false. */
  interactive: boolean
  signal?: AbortSignal
}

export interface VaultAuthDeps {
  emit?: (event: VaultLoginEvent) => void
  /** Opens the OIDC sign-in page in the user's browser (Electron shell.openExternal). */
  openExternal?: (url: string) => Promise<void>
  env?: () => Record<string, string | undefined>
  homeDir?: () => string
  now?: () => number
  oidcPort?: number
  oidcTimeoutMs?: number
  requestTimeoutMs?: number
  log?: Pick<Console, 'warn' | 'error'>
  /**
   * The user's ambient Vault token (VAULT_TOKEN, ~/.vault-token) is about to be sent to a Vault server while the
   * vault CLI's VAULT_ADDR is unknown: ask the user (native dialog). 'always' = remember for this server.
   * Absent = never.
   */
  confirmAmbientToken?: (request: { address: string; namespace?: string; sources: ('env' | 'cli')[] }) => Promise<boolean | 'always'>
  /**
   * The vault CLI's environment (VAULT_ADDR / VAULT_NAMESPACE / VAULT_CACERT, read from the login shell when the
   * app was started from Finder). Absent: the process environment (env()) only.
   */
  environment?: () => Promise<VaultEnvironment>
  /** Encrypted interactive sign-ins + servers trusted with the CLI token, across restarts. Absent: memory only. */
  tokenStore?: VaultTokenStoreLike
}

interface OidcFlow {
  controller: AbortController
}

/** A login shared by every caller of the same identity; aborted once no caller waits for it any more. */
interface PendingLogin {
  promise: Promise<VaultToken>
  controller: AbortController
  waiters: number
  settled: boolean
}

/** The token can be extended by auth/token/renew-self. */
export function canExtendToken(token: VaultToken): boolean {
  return token.renewable && token.final !== true && token.expiresAt !== undefined
}

/** When a renewable token is renewed: in the last third of its TTL. */
export function tokenRenewAt(token: VaultToken): number | undefined {
  if (token.expiresAt === undefined) return undefined
  const ttlMs = (token.ttlSec ?? 0) * 1000
  return token.expiresAt - ttlMs / 3
}

/** Resolve with `promise`, or reject as soon as `signal` aborts. */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function abortError(signal: AbortSignal): DriverError {
  const reason: unknown = signal.reason
  return reason instanceof DriverError ? reason : DriverError.of('cancelled', 'Vault sign-in was cancelled.')
}

function describeServer(config: VaultConfig): string {
  return config.namespace ? `${config.address} (namespace ${config.namespace})` : config.address
}

/** The OIDC settings a token-method connection falls back to (auth mount "oidc" unless set, optional role). */
export function oidcFallbackConfig(config: VaultConfig): VaultConfig {
  return { ...config, loginMethod: 'oidc', authMount: config.authMount || DEFAULT_VAULT_AUTH_MOUNT.oidc }
}

/** Seconds → epoch ms from a local reference time (clock-skew tolerant: never uses Vault's absolute times). */
function expiryFrom(start: number, ttlSec: unknown): number | undefined {
  return typeof ttlSec === 'number' && Number.isFinite(ttlSec) && ttlSec > 0 ? start + ttlSec * 1000 : undefined
}

export class VaultAuth {
  private readonly deps: VaultAuthDeps
  private readonly now: () => number
  private readonly log: Pick<Console, 'warn' | 'error'>
  private readonly cache = new Map<string, VaultToken>()
  private readonly pending = new Map<string, PendingLogin>()
  /** Background token renewals in flight, by token (several connections may share one token). */
  private readonly renewals = new Map<string, Promise<VaultToken>>()
  /** Vault servers (vaultServerKey) the user allowed / refused to receive the ambient token, for this run. */
  private readonly ambientApproved = new Set<string>()
  private readonly ambientRefused = new Set<string>()
  /** Running OIDC flows (one at a time: the callback port is shared). */
  private readonly flows = new Set<OidcFlow>()
  private oidcQueue: Promise<unknown> = Promise.resolve()
  /** The vault CLI's environment once resolved (VAULT_CACERT for synchronous client() calls). */
  private cliEnv: VaultEnvironment | null = null

  constructor(deps: VaultAuthDeps = {}) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? console
  }

  private processEnv(): Record<string, string | undefined> {
    return this.deps.env ? this.deps.env() : process.env
  }

  /** VAULT_ADDR / VAULT_NAMESPACE / VAULT_CACERT as the vault CLI sees them (process environment first). */
  async environment(): Promise<VaultEnvironment> {
    if (this.cliEnv) return this.cliEnv
    const env = this.processEnv()
    let resolved: VaultEnvironment
    if (this.deps.environment) {
      try {
        resolved = await this.deps.environment()
      } catch (error) {
        this.log.warn('[vault] cannot read the vault CLI environment', error instanceof Error ? error.message : error)
        resolved = { source: 'none' }
      }
    } else {
      resolved = { source: env.VAULT_ADDR?.trim() ? 'env' : 'none' }
      if (env.VAULT_ADDR?.trim()) resolved.address = env.VAULT_ADDR.trim()
      if (env.VAULT_NAMESPACE?.trim()) resolved.namespace = env.VAULT_NAMESPACE.trim()
      if (env.VAULT_CACERT?.trim()) resolved.caCert = env.VAULT_CACERT.trim()
    }
    this.cliEnv = resolved
    return resolved
  }

  client(config: VaultConfig): VaultClient {
    const fallbackCaPath = this.cliEnv?.caCert ?? this.processEnv().VAULT_CACERT?.trim()
    return new VaultClient({
      address: config.address,
      namespace: config.namespace,
      caPath: config.caPath,
      ...(fallbackCaPath ? { fallbackCaPath } : {}),
      timeoutMs: this.deps.requestTimeoutMs,
    })
  }

  /**
   * A usable token for this identity: cached, renewed or obtained by logging in. One login at a time per identity:
   * concurrent callers share it, each caller's `signal` only stops its own wait, and the login itself is aborted
   * once no caller waits for it any more (e.g. a disconnect during an OIDC browser sign-in).
   */
  async getToken(config: VaultConfig, secrets: ConnectionSecrets, options: LoginOptions): Promise<VaultToken> {
    await this.environment()
    const key = vaultIdentityKey(config)
    const cached = (await this.fromCache(config, key, options.signal)) ?? (await this.fromStore(config, key, options.signal))
    if (cached) return cached
    if (options.signal?.aborted) throw abortError(options.signal)
    let entry = this.pending.get(key)
    if (!entry) {
      const controller = new AbortController()
      const created: PendingLogin = { controller, waiters: 0, settled: false, promise: Promise.resolve() as unknown as Promise<VaultToken> }
      created.promise = this.login(config, secrets, key, { interactive: options.interactive, signal: controller.signal }).finally(() => {
        created.settled = true
        if (this.pending.get(key) === created) this.pending.delete(key)
      })
      // Waiters that gave up must not leave an unhandled rejection behind.
      created.promise.catch(() => undefined)
      entry = created
      this.pending.set(key, entry)
    }
    const shared = entry
    shared.waiters++
    try {
      return await raceSignal(shared.promise, options.signal)
    } finally {
      shared.waiters--
      if (shared.waiters === 0 && !shared.settled && options.signal?.aborted) {
        if (this.pending.get(key) === shared) this.pending.delete(key)
        shared.controller.abort(abortError(options.signal))
      }
    }
  }

  /**
   * Extend a token that backs live leases (auth/token/renew-self): Vault revokes every lease of a token when the
   * token expires. A renewal another holder made meanwhile is reused. Rejects when Vault refuses (token gone).
   */
  async renewToken(config: VaultConfig, token: VaultToken): Promise<VaultToken> {
    const cached = this.cache.get(token.key)
    let current = token
    if (cached && cached.token === token.token && (cached.expiresAt ?? Infinity) > (token.expiresAt ?? Infinity)) current = { ...cached, cached: true }
    if (!canExtendToken(current)) return current
    const due = tokenRenewAt(current)
    if (due !== undefined && this.now() < due) return current
    const running = this.renewals.get(current.token)
    if (running) return running
    const promise = this.renewSelf(config, current).finally(() => this.renewals.delete(current.token))
    this.renewals.set(current.token, promise)
    return promise
  }

  private async renewSelf(config: VaultConfig, token: VaultToken): Promise<VaultToken> {
    const increment = token.incrementSec ?? token.ttlSec
    const start = this.now()
    const response = await this.client(config).request('POST', 'auth/token/renew-self', {
      token: token.token,
      body: increment ? { increment } : {},
    })
    const auth = response.body?.auth
    const granted = typeof auth?.lease_duration === 'number' && auth.lease_duration > 0 ? auth.lease_duration : undefined
    const renewed: VaultToken = {
      ...token,
      expiresAt: expiryFrom(start, granted) ?? token.expiresAt,
      ttlSec: granted ?? token.ttlSec,
      renewable: auth?.renewable === true,
      // Vault grants less than asked once the token's max TTL caps it (1 s tolerance).
      final: auth?.renewable !== true || (granted !== undefined && increment !== undefined && granted + 1 < increment),
      cached: true,
    }
    const cached = this.cache.get(token.key)
    if (cached && cached.token === token.token) this.cache.set(token.key, { ...renewed, cached: false })
    this.persist(renewed)
    return renewed
  }

  /** Drop a token Vault rejected (403 on a cached token). */
  invalidate(token: VaultToken): void {
    const current = this.cache.get(token.key)
    if (current && current.token === token.token) this.cache.delete(token.key)
    const stored = this.deps.tokenStore?.getToken(token.key, this.now())
    if (stored && stored.token === token.token) this.deps.tokenStore?.deleteToken(token.key)
  }

  /**
   * Forget every token DataGrippe holds for this Vault server (+ namespace): memory, saved sign-ins, and the
   * permission to use the vault CLI token there. Never touches ~/.vault-token.
   */
  logout(address: string, namespace?: string): void {
    const server = vaultServerKey(address, namespace)
    const prefix = `${server}|`
    for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) this.cache.delete(key)
    this.deps.tokenStore?.deleteTokens(prefix)
    this.deps.tokenStore?.untrust(server)
    this.ambientApproved.delete(server)
    this.ambientRefused.delete(server)
  }

  /** Abort pending OIDC browser sign-ins (callers fail with kind 'cancelled'). */
  cancelLogin(): void {
    for (const flow of this.flows) flow.controller.abort(DriverError.of('cancelled', 'Vault sign-in was cancelled.'))
  }

  dispose(): void {
    this.cancelLogin()
    this.cache.clear()
  }

  /** True while the token is accepted by Vault (lookup-self). Network failures are reported as errors. */
  async checkToken(config: VaultConfig, token: VaultToken, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.client(config).request('GET', 'auth/token/lookup-self', { token: token.token, signal })
      return true
    } catch (error) {
      if (isTokenRejected(error)) return false
      throw error
    }
  }

  // -------------------------------------------------------------------------

  private async fromCache(config: VaultConfig, key: string, signal?: AbortSignal): Promise<VaultToken | null> {
    const entry = this.cache.get(key)
    if (!entry) return null
    const now = this.now()
    if (entry.expiresAt !== undefined && now >= entry.expiresAt - TOKEN_EXPIRY_MARGIN_MS) {
      this.cache.delete(key)
      return null
    }
    // Renew a renewable token in the last third of its TTL (best effort; a failure means "log in again").
    if (entry.renewable && entry.expiresAt !== undefined && entry.ttlSec) {
      const remaining = entry.expiresAt - now
      if (remaining < (entry.ttlSec * 1000) / 3) {
        try {
          const start = this.now()
          const increment = entry.incrementSec ?? entry.ttlSec
          const response = await this.client(config).request('POST', 'auth/token/renew-self', { token: entry.token, body: increment ? { increment } : {}, signal })
          const auth = response.body?.auth
          const granted = typeof auth?.lease_duration === 'number' && auth.lease_duration > 0 ? auth.lease_duration : undefined
          const renewed: VaultToken = {
            ...entry,
            expiresAt: expiryFrom(start, granted) ?? entry.expiresAt,
            ttlSec: granted ?? entry.ttlSec,
            renewable: auth?.renewable === true,
            final: auth?.renewable !== true || (granted !== undefined && increment !== undefined && granted + 1 < increment),
          }
          this.cache.set(key, renewed)
          this.persist(renewed)
          return { ...renewed, cached: true }
        } catch (error) {
          if (error instanceof DriverError && error.info.kind === 'cancelled') throw error
          this.log.warn(`[vault] renewing the token for ${config.address} failed: ${error instanceof Error ? error.message : String(error)}`)
          if (entry.expiresAt - this.now() < TOKEN_EXPIRY_MARGIN_MS * 2 || isTokenRejected(error)) {
            this.cache.delete(key)
            if (isTokenRejected(error)) this.deps.tokenStore?.deleteToken(key)
            return null
          }
        }
      }
    }
    return { ...entry, cached: true }
  }

  private remember(token: VaultToken): VaultToken {
    this.cache.set(token.key, { ...token, cached: false })
    this.persist(token)
    return token
  }

  /** Keep a token from an interactive sign-in (encrypted) so the next app start does not sign in again. */
  private persist(token: VaultToken): void {
    const store = this.deps.tokenStore
    if (!store || token.expiresAt === undefined || !PERSISTED_TOKEN_SOURCES.includes(token.source)) return
    try {
      store.setToken(token.key, {
        token: token.token,
        source: token.source,
        expiresAt: token.expiresAt,
        ...(token.ttlSec !== undefined ? { ttlSec: token.ttlSec } : {}),
        ...(token.incrementSec !== undefined ? { incrementSec: token.incrementSec } : {}),
        renewable: token.renewable,
        ...(token.final ? { final: true } : {}),
        obtainedAt: token.obtainedAt,
      })
    } catch (error) {
      this.log.warn('[vault] cannot save the Vault sign-in', error instanceof Error ? error.message : error)
    }
  }

  /**
   * A sign-in saved by a previous run: used when Vault still accepts it (lookup-self, which also refreshes its
   * remaining TTL); dropped otherwise. Network failures surface as errors (the same Vault is needed anyway).
   */
  private async fromStore(config: VaultConfig, key: string, signal?: AbortSignal): Promise<VaultToken | null> {
    const store = this.deps.tokenStore
    const saved = store?.getToken(key, this.now() + TOKEN_EXPIRY_MARGIN_MS)
    if (!store || !saved) return null
    const start = this.now()
    try {
      const response = await this.client(config).request('GET', 'auth/token/lookup-self', { token: saved.token, signal })
      const data = isJsonObject(response.body?.data) ? response.body.data : {}
      const ttl = typeof data.ttl === 'number' && data.ttl > 0 ? data.ttl : undefined
      const token: VaultToken = {
        token: saved.token,
        source: saved.source,
        expiresAt: expiryFrom(start, ttl) ?? saved.expiresAt,
        ttlSec: ttl ?? saved.ttlSec,
        ...(saved.incrementSec !== undefined ? { incrementSec: saved.incrementSec } : {}),
        renewable: data.renewable === true,
        ...(saved.final ? { final: true } : {}),
        key,
        cached: false,
        obtainedAt: saved.obtainedAt,
      }
      this.cache.set(key, token)
      return { ...token, cached: true }
    } catch (error) {
      if (!isTokenRejected(error)) throw error
      store.deleteToken(key)
      return null
    }
  }

  private async login(config: VaultConfig, secrets: ConnectionSecrets, key: string, options: LoginOptions): Promise<VaultToken> {
    switch (config.loginMethod) {
      case 'token':
        return this.remember(await this.tokenLogin(config, secrets, key, options))
      case 'ldap':
      case 'userpass':
        return this.remember(await this.passwordLogin(config, secrets, key, options.signal))
      case 'oidc':
        if (!options.interactive) {
          throw new VaultError(`Sign in to Vault again (${describeServer(config)}) to renew the database credentials.`, 'config', undefined, {
            code: LOGIN_REQUIRED_CODE,
          })
        }
        return this.remember(await this.queueOidc(config, key, options.signal))
      default:
        throw DriverError.of('invalid-input', 'Unknown Vault login method.')
    }
  }

  // --- token ---------------------------------------------------------------

  private readCliToken(): string | undefined {
    try {
      const home = this.deps.homeDir ? this.deps.homeDir() : homedir()
      const value = readFileSync(join(home, '.vault-token'), 'utf8').trim()
      return value || undefined
    } catch {
      return undefined
    }
  }

  /**
   * The ambient token (VAULT_TOKEN, ~/.vault-token) belongs to the Vault server the CLI uses (VAULT_ADDR): it is
   * only sent to that server, or to one the user approved for this run (native dialog, interactive logins only).
   * The address may come from the renderer or an imported DBeaver file: it must not receive the user's token.
   */
  private async ambientAllowed(config: VaultConfig, sources: ('env' | 'cli')[], interactive: boolean): Promise<boolean> {
    if (sources.length === 0) return false
    const target = vaultServerKey(config.address, config.namespace)
    // VAULT_ADDR (process environment, else the login shell — what the terminal's vault CLI uses) names the server
    // the token belongs to: that server receives it without asking, any other server never does.
    const cli = await this.environment()
    if (cli.address) return vaultServerKey(cli.address, cli.namespace) === target
    if (this.ambientApproved.has(target) || this.deps.tokenStore?.isTrusted(target)) return true
    if (this.ambientRefused.has(target) || !interactive || !this.deps.confirmAmbientToken) return false
    let answer: boolean | 'always' = false
    try {
      answer = await this.deps.confirmAmbientToken({ address: config.address, ...(config.namespace ? { namespace: config.namespace } : {}), sources })
    } catch (error) {
      this.log.warn('[vault] cannot ask about the Vault CLI token', error instanceof Error ? error.message : error)
    }
    if (answer === 'always') this.deps.tokenStore?.trust(target)
    ;(answer ? this.ambientApproved : this.ambientRefused).add(target)
    return answer !== false
  }

  private async tokenLogin(config: VaultConfig, secrets: ConnectionSecrets, key: string, options: LoginOptions): Promise<VaultToken> {
    const signal = options.signal
    const env = this.processEnv()
    const envToken = env.VAULT_TOKEN?.trim() || undefined
    const cliToken = this.readCliToken()
    const sources = [...(envToken ? (['env'] as const) : []), ...(cliToken ? (['cli'] as const) : [])]
    const ambient = await this.ambientAllowed(config, sources, options.interactive)
    const candidates: { token: string | undefined; source: VaultTokenSource; label: string }[] = [
      ...(ambient
        ? [
            { token: envToken, source: 'env' as const, label: 'VAULT_TOKEN' },
            { token: cliToken, source: 'cli' as const, label: '~/.vault-token' },
          ]
        : []),
      { token: secrets.vaultToken?.trim() || undefined, source: 'stored', label: 'the saved token' },
    ]
    const rejected: string[] = []
    const client = this.client(config)
    for (const candidate of candidates) {
      if (!candidate.token) continue
      const start = this.now()
      try {
        const response = await client.request('GET', 'auth/token/lookup-self', { token: candidate.token, signal })
        const data = isJsonObject(response.body?.data) ? response.body.data : {}
        const ttl = typeof data.ttl === 'number' ? data.ttl : undefined
        const creationTtl = typeof data.creation_ttl === 'number' && data.creation_ttl > 0 ? data.creation_ttl : undefined
        return {
          token: candidate.token,
          source: candidate.source,
          expiresAt: expiryFrom(start, ttl),
          ttlSec: ttl && ttl > 0 ? ttl : undefined,
          ...(creationTtl ? { incrementSec: creationTtl } : {}),
          renewable: data.renewable === true,
          key,
          cached: false,
          obtainedAt: start,
        }
      } catch (error) {
        if (!isTokenRejected(error)) throw error
        rejected.push(candidate.label)
      }
    }
    const rejectedNote = rejected.length > 0 ? `Vault rejected ${rejected.join(', ')} (expired or revoked).` : ''
    if (config.oidcFallback !== false) {
      // Like `vault login -method=oidc`: the token is missing or expired, sign in with the browser instead.
      if (!options.interactive) {
        throw new VaultError(
          `The Vault token for ${describeServer(config)} expired: run vault login -method=oidc, or reconnect to sign in from DataGrippe.`,
          'config',
          undefined,
          { code: LOGIN_REQUIRED_CODE },
        )
      }
      try {
        return await this.queueOidc(oidcFallbackConfig(config), key, signal)
      } catch (error) {
        if (error instanceof DriverError && error.info.kind === 'cancelled') throw error
        const reason = error instanceof Error ? error.message : String(error)
        throw DriverError.of('needs-password', `Vault token required for ${describeServer(config)}`, {
          secretField: 'vaultToken',
          detail: [rejectedNote, `Browser sign-in (OIDC) failed: ${reason}`].filter(Boolean).join(' '),
        })
      }
    }
    throw DriverError.of('needs-password', `Vault token required for ${describeServer(config)}`, {
      secretField: 'vaultToken',
      ...(rejectedNote ? { detail: rejectedNote } : {}),
    })
  }

  // --- ldap / userpass -----------------------------------------------------

  private async passwordLogin(config: VaultConfig, secrets: ConnectionSecrets, key: string, signal?: AbortSignal): Promise<VaultToken> {
    const username = config.username ?? ''
    const password = secrets.vaultPassword
    const who = `${username} on ${describeServer(config)}`
    if (!username) throw DriverError.of('invalid-input', 'Vault user name is required for LDAP / userpass login.')
    if (!password) throw DriverError.of('needs-password', `Vault password required for ${who}`, { secretField: 'vaultPassword' })
    const mount = authMountOf(config)
    const start = this.now()
    try {
      const response = await this.client(config).request('POST', `auth/${mount}/login/${encodeURIComponent(username)}`, {
        body: { password },
        signal,
        redact: [password],
      })
      return this.tokenFromAuth(response.body?.auth, config.loginMethod as 'ldap' | 'userpass', key, start, `auth/${mount}/login`)
    } catch (error) {
      // A wrong password is a 400 ("invalid username or password", LDAP "failed to bind"). A 403 is Vault's answer
      // for an auth mount that does not exist: prompting for the password again would never help.
      if (error instanceof VaultError && error.failure === 'http' && error.status === 403) {
        throw new VaultError(
          `Vault refused the sign-in at auth/${mount} (permission denied). Check the auth mount: "${mount}" may not exist on ${describeServer(config)}.`,
          'http',
          403,
        )
      }
      if (error instanceof VaultError && error.failure === 'http' && (error.status === 400 || error.status === 401)) {
        throw DriverError.of('needs-password', `Vault rejected the password for ${who}`, {
          secretField: 'vaultPassword',
          code: error.info.code,
          detail: error.message,
        })
      }
      throw error
    }
  }

  private tokenFromAuth(auth: VaultAuthBlock | null | undefined, source: VaultTokenSource, key: string, start: number, path: string): VaultToken {
    const token = typeof auth?.client_token === 'string' ? auth.client_token : ''
    if (!token) throw new VaultError(`Vault: ${path} returned no client token`, 'json')
    const ttl = typeof auth?.lease_duration === 'number' && auth.lease_duration > 0 ? auth.lease_duration : undefined
    return {
      token,
      source,
      expiresAt: expiryFrom(start, ttl),
      ttlSec: ttl,
      ...(ttl ? { incrementSec: ttl } : {}),
      renewable: auth?.renewable === true,
      key,
      cached: false,
      obtainedAt: start,
    }
  }

  // --- OIDC ----------------------------------------------------------------

  /**
   * OIDC flows run one after the other: they share the callback port. A queued flow is registered right away so
   * cancelLogin() also stops the ones still waiting for their turn (no browser opens after "Cancel").
   */
  private queueOidc(config: VaultConfig, key: string, signal?: AbortSignal): Promise<VaultToken> {
    const flow: OidcFlow = { controller: new AbortController() }
    this.flows.add(flow)
    const start = () => this.oidcLogin(config, key, flow, signal)
    const run = this.oidcQueue.then(start, start).finally(() => this.flows.delete(flow))
    this.oidcQueue = run.catch(() => undefined)
    return run
  }

  private emit(config: VaultConfig, event: Omit<VaultLoginEvent, 'address' | 'namespace'>): void {
    try {
      this.deps.emit?.({ address: config.address, ...(config.namespace ? { namespace: config.namespace } : {}), ...event })
    } catch (error) {
      this.log.warn('[vault] cannot emit a login event', error)
    }
  }

  private async oidcLogin(config: VaultConfig, key: string, flow: OidcFlow, outerSignal?: AbortSignal): Promise<VaultToken> {
    const signal = outerSignal ? AbortSignal.any([flow.controller.signal, outerSignal]) : flow.controller.signal
    if (signal.aborted) {
      // Cancelled while queued behind another sign-in.
      const failure = abortError(signal)
      if (failure.info.kind === 'cancelled') this.emit(config, { state: 'cancelled' })
      throw failure
    }
    const port = this.deps.oidcPort ?? OIDC_CALLBACK_PORT
    const timeoutMs = this.deps.oidcTimeoutMs ?? OIDC_TIMEOUT_MS
    const timer = setTimeout(
      () => flow.controller.abort(new VaultError(`Vault sign-in timed out after ${Math.round(timeoutMs / 60_000) || 1} min. Try again.`, 'timeout')),
      timeoutMs,
    )
    timer.unref?.()
    let callback: CallbackServer | undefined
    let started = false
    try {
      const redirectUri = `http://localhost:${port}/oidc/callback`
      const mount = authMountOf(config)
      const clientNonce = randomBytes(20).toString('base64url')
      const client = this.client(config)
      const authUrlResponse = await client.request('POST', `auth/${mount}/oidc/auth_url`, {
        body: { role: config.oidcRole ?? '', redirect_uri: redirectUri, client_nonce: clientNonce },
        signal,
      })
      const data = isJsonObject(authUrlResponse.body?.data) ? authUrlResponse.body.data : {}
      const authUrl = typeof data.auth_url === 'string' ? data.auth_url : ''
      if (!authUrl) {
        throw new VaultError(
          `Vault returned no OIDC sign-in URL. Check the OIDC role${config.oidcRole ? ` "${config.oidcRole}"` : ''} and that ${redirectUri} is an allowed redirect URI.`,
          'http',
        )
      }
      let parsed: URL
      try {
        parsed = new URL(authUrl)
      } catch {
        throw new VaultError('Vault returned an invalid OIDC sign-in URL.', 'json')
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new VaultError('Vault returned a non-http(s) OIDC sign-in URL.', 'json')
      const state = parsed.searchParams.get('state')
      if (!state) throw new VaultError('Vault returned an OIDC sign-in URL without a state parameter.', 'json')

      // Listen only once Vault agreed to an OIDC sign-in (a server without OIDC never opens the port), and
      // before the browser can reach the callback.
      callback = await CallbackServer.listen(port)
      if (signal.aborted) throw abortError(signal)
      const result = callback.waitFor(state, signal)
      started = true
      try {
        await (this.deps.openExternal ?? (async () => undefined))(authUrl)
        this.emit(config, { state: 'browser-opened', url: authUrl })
      } catch (error) {
        this.log.warn('[vault] cannot open the browser for the OIDC sign-in', error instanceof Error ? error.message : error)
        this.emit(config, { state: 'browser-opened', url: authUrl, message: 'Open this link in your browser to sign in to Vault.' })
      }

      const reply = await result
      const start = this.now()
      try {
        const exchange = await client.request('GET', `auth/${mount}/oidc/callback`, {
          query: { code: reply.code, state: reply.state, client_nonce: clientNonce },
          signal,
        })
        const token = this.tokenFromAuth(exchange.body?.auth, 'oidc', key, start, `auth/${mount}/oidc/callback`)
        reply.respond(200, oidcResultPage(true))
        this.emit(config, { state: 'completed' })
        return token
      } catch (error) {
        reply.respond(500, oidcResultPage(false, error instanceof DriverError ? error.message : 'Vault did not accept the sign-in.'))
        throw error
      }
    } catch (error) {
      const failure = signal.aborted ? abortError(signal) : error
      const cancelled = failure instanceof DriverError && failure.info.kind === 'cancelled'
      if (started || cancelled) {
        this.emit(config, cancelled ? { state: 'cancelled' } : { state: 'failed', message: failure instanceof Error ? failure.message : String(failure) })
      }
      throw failure
    } finally {
      clearTimeout(timer)
      await callback?.close()
    }
  }
}

/** The background renewal needs an interactive sign-in. */
export function isLoginRequired(error: unknown): boolean {
  return error instanceof DriverError && error.info.code === LOGIN_REQUIRED_CODE
}

// ---------------------------------------------------------------------------
// OIDC callback server (127.0.0.1 and ::1 — "localhost" may resolve to either)
// ---------------------------------------------------------------------------

interface CallbackReply {
  code: string
  state: string
  respond: (status: number, html: string) => void
}

class CallbackServer {
  private readonly servers: http.Server[]
  private handler: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null = null

  private constructor(servers: http.Server[]) {
    this.servers = servers
    for (const server of servers) {
      server.on('request', (req, res) => {
        if (this.handler) this.handler(req, res)
        else sendPage(res, 410, oidcResultPage(false, 'This Vault sign-in is no longer pending.'))
      })
    }
  }

  static async listen(port: number): Promise<CallbackServer> {
    const busy = () => new VaultError(`Port ${port} is in use — is another Vault login in progress?`, 'config')
    const bind = (host: string) =>
      new Promise<http.Server>((resolve, reject) => {
        const server = http.createServer()
        server.once('error', reject)
        server.listen({ port, host, exclusive: true }, () => {
          server.removeListener('error', reject)
          resolve(server)
        })
      })
    const servers: http.Server[] = []
    try {
      servers.push(await bind('127.0.0.1'))
    } catch (error) {
      throw (error as { code?: unknown })?.code === 'EADDRINUSE' ? busy() : new VaultError(`Cannot listen on 127.0.0.1:${port} for the Vault sign-in.`, 'config')
    }
    try {
      servers.push(await bind('::1'))
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      if (code === 'EADDRINUSE') {
        await Promise.all(servers.map((s) => closeServer(s)))
        throw busy()
      }
      // No IPv6 loopback on this machine: 127.0.0.1 alone serves "localhost".
    }
    return new CallbackServer(servers)
  }

  /** Resolve with the first GET /oidc/callback carrying the expected state; everything else is refused. */
  waitFor(expectedState: string, signal: AbortSignal): Promise<CallbackReply> {
    return new Promise<CallbackReply>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError(signal))
        return
      }
      const onAbort = () => {
        this.handler = null
        reject(abortError(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.handler = (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (req.method !== 'GET' || url.pathname !== '/oidc/callback') {
          sendPage(res, 404, oidcResultPage(false, 'Not found.'))
          return
        }
        const state = url.searchParams.get('state') ?? ''
        if (state !== expectedState) {
          // Not our sign-in (stale tab, forged request): refuse and keep waiting for the real one.
          sendPage(res, 400, oidcResultPage(false, 'This sign-in link does not match the pending Vault login. Start the login again from DataGrippe.'))
          return
        }
        const providerError = url.searchParams.get('error')
        const code = url.searchParams.get('code') ?? ''
        this.handler = null
        signal.removeEventListener('abort', onAbort)
        if (providerError || !code) {
          const description = (url.searchParams.get('error_description') ?? providerError ?? 'no authorization code').slice(0, 200)
          sendPage(res, 400, oidcResultPage(false, `The identity provider refused the sign-in: ${description}`))
          reject(new VaultError(`Vault sign-in failed: ${description}`, 'http'))
          return
        }
        resolve({ code, state, respond: (status, html) => sendPage(res, status, html) })
      }
    })
  }

  async close(): Promise<void> {
    this.handler = null
    await Promise.all(this.servers.map((server) => closeServer(server)))
  }
}

function sendPage(res: http.ServerResponse, status: number, html: string): void {
  if (res.headersSent || res.writableEnded) return
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    Connection: 'close',
  })
  res.end(html)
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })
}
