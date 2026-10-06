// Per-connection lease bookkeeping for Vault-issued database credentials.
//
// - The current lease is renewed in the last third of its duration (sys/leases/renew).
// - Vault revokes every lease of a token when that token expires: the token that issued the current lease is
//   renewed too (auth/token/renew-self), and the credentials' effective expiry is min(lease, token).
// - When they cannot be extended (lease or token not renewable, max TTL reached, renewal failed) the state
//   becomes 'expiring' and new credentials are issued shortly before expiry (min(60 s, 10 %), at least 1 s).
// - Database static roles (static-creds) are re-read right after their next password rotation.
// - New credentials are swapped in for new server connections (`rotated()`); sessions opened earlier keep
//   their lease (holders), and a superseded lease is revoked once no holder uses it. Shortly before a
//   superseded dynamic lease ends (Vault drops its user), its holders are moved to the current credentials
//   (`retire()`).
// - All times come from the local clock (receipt time + durations): tolerant to clock skew with Vault. Times
//   are absolute, so a timer that fired late (sleep) or a resync() acts right away.
// - Timers are unref'd and cleared by close().
import { randomUUID } from 'node:crypto'
import type { VaultLeaseState, VaultStatus } from '@shared/types'
import { DriverError } from '../db/errors'
import { credentialsInfo, type IssuedCredentials } from './credentials'
import { canExtendToken, tokenRenewAt, type VaultToken } from './login'

/** Retry a failed re-issue after this delay (unless the failure needs the user: sign-in, password). */
export const REISSUE_RETRY_MS = 30_000
/** Credentials this close to expiry are refreshed before opening a new server connection. */
export const REFRESH_BEFORE_USE_MS = 2_000
/** A database static role is re-read this long after its announced rotation (Vault rotates on a ~5 s tick). */
export const STATIC_REREAD_DELAY_MS = 2_000
/** Holders of a superseded lease are moved at least this long before it ends. */
export const RETIRE_MARGIN_MS = 5_000

export interface LeaseRecord {
  key: string
  creds: IssuedCredentials
  /** Token that issued the lease (renew / revoke). */
  token: VaultToken
  /** Renewal increment requested (the lease's first duration), seconds. */
  incrementSec?: number
  /** Server connections using these credentials ('metadata', session ids). */
  holders: Set<string>
  superseded: boolean
  revoked: boolean
  /** Vault will not extend the lease any further (max TTL). */
  capped?: boolean
}

export interface RenewResult {
  leaseDurationSec: number
  renewable: boolean
}

export interface LeaseOps {
  renew(lease: LeaseRecord, incrementSec: number): Promise<RenewResult>
  /** Extend the token that issued the lease (auth/token/renew-self). Absent = tokens are not renewed. */
  renewToken?(lease: LeaseRecord): Promise<VaultToken>
  /** Background re-issue (never opens a browser). `previous` = the credentials being replaced. */
  reissue(previous?: LeaseRecord): Promise<{ creds: IssuedCredentials; token: VaultToken }>
  revoke(lease: LeaseRecord): Promise<void>
  /** New credentials were installed: reopen the metadata pool with them. */
  rotated(): Promise<void>
  /** A superseded lease still held by sessions is about to end: move them to the current credentials. */
  retire?(lease: LeaseRecord): Promise<void>
  emit(status: VaultStatus): void
  now(): number
  /** The failure needs the user (browser sign-in, password): retrying in the background is pointless. */
  needsUser(error: unknown): boolean
  /** Replacing the Vault token needs a browser sign-in (OIDC). */
  interactiveLogin?: boolean
  /** Extra information for the status (e.g. revocation not allowed by the Vault policy). */
  note?(): string | undefined
  log: Pick<Console, 'warn' | 'error'>
}

/** How long before expiry a lease that cannot be extended is replaced. */
export function reissueMarginMs(durationSec: number | undefined): number {
  const durationMs = (durationSec ?? 0) * 1000
  return Math.min(60_000, Math.max(1_000, durationMs * 0.1))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Local wall-clock time for messages ("14:05"). */
export function clock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** The token bounds a dynamic lease (Vault revokes the lease with its token). */
function tokenBound(lease: LeaseRecord): number | undefined {
  return lease.creds.kind === 'dynamic' ? lease.token.expiresAt : undefined
}

/** When the credentials stop working: min(lease expiry, issuing token expiry) for a lease, the rotation for a static role. */
export function effectiveExpiry(lease: LeaseRecord): number | undefined {
  const own = lease.creds.expiresAt
  const token = tokenBound(lease)
  if (own === undefined) return token
  return token === undefined ? own : Math.min(own, token)
}

/** The token (not the lease) ends the credentials first. */
function tokenBinds(lease: LeaseRecord): boolean {
  const token = tokenBound(lease)
  return token !== undefined && (lease.creds.expiresAt === undefined || token < lease.creds.expiresAt)
}

/** Lease renewal time: last third of the duration last granted. */
function leaseRenewAt(lease: LeaseRecord): number | undefined {
  const expiresAt = lease.creds.expiresAt
  if (expiresAt === undefined) return undefined
  const durationMs = lease.creds.leaseDurationSec !== undefined ? lease.creds.leaseDurationSec * 1000 : expiresAt - lease.creds.issuedAt
  return expiresAt - Math.max(0, durationMs) / 3
}

/** The same static credentials again (static role not rotated yet, KV secret unchanged). */
function sameStatic(lease: LeaseRecord, creds: IssuedCredentials): boolean {
  return lease.creds.kind === 'static' && creds.kind === 'static' && creds.username === lease.creds.username && creds.password === lease.creds.password
}

function marginFor(lease: LeaseRecord): number {
  return reissueMarginMs(tokenBinds(lease) ? lease.token.ttlSec : lease.incrementSec)
}

export class ConnectionLeases {
  readonly connectionId: string
  current: LeaseRecord | null = null
  private readonly ops: LeaseOps
  private readonly revokeLeases: boolean
  private readonly leases = new Map<string, LeaseRecord>()
  private readonly revocations = new Set<Promise<void>>()
  /** Superseded leases with holders: timer moving them to the current credentials before they end. */
  private readonly retireTimers = new Map<string, NodeJS.Timeout>()
  private state: VaultLeaseState = 'valid'
  private message: string | undefined
  private expiring = false
  private timer: NodeJS.Timeout | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(connectionId: string, revokeLeases: boolean, ops: LeaseOps) {
    this.connectionId = connectionId
    this.revokeLeases = revokeLeases
    this.ops = ops
  }

  /** Make these credentials current; the previous lease is superseded (revoked once unused). */
  install(creds: IssuedCredentials, token: VaultToken): LeaseRecord {
    const lease: LeaseRecord = {
      key: randomUUID(),
      creds,
      token,
      incrementSec: creds.leaseDurationSec,
      holders: new Set(),
      superseded: false,
      revoked: false,
    }
    const previous = this.current
    this.leases.set(lease.key, lease)
    this.current = lease
    this.expiring = false
    this.state = 'valid'
    this.message = undefined
    if (previous) {
      previous.superseded = true
      this.maybeRevoke(previous)
      if (this.leases.has(previous.key)) this.armRetire(previous)
    }
    this.schedule()
    this.emitStatus()
    return lease
  }

  lease(key: string): LeaseRecord | undefined {
    return this.leases.get(key)
  }

  retain(key: string, holder: string): void {
    this.leases.get(key)?.holders.add(holder)
  }

  release(key: string, holder: string): void {
    const lease = this.leases.get(key)
    if (!lease) return
    lease.holders.delete(holder)
    this.maybeRevoke(lease)
  }

  status(): VaultStatus {
    const lease = this.current
    let info = lease ? credentialsInfo(lease.creds, lease.token.source) : null
    // The real deadline: the issuing token may end the lease first.
    const deadline = lease ? effectiveExpiry(lease) : undefined
    if (info && deadline !== undefined && (info.expiresAt === undefined || deadline < info.expiresAt)) info = { ...info, expiresAt: deadline }
    const status: VaultStatus = { connectionId: this.connectionId, state: this.state, info }
    const message = this.message ?? (this.state === 'valid' ? this.ops.note?.() : undefined)
    if (message) status.message = message
    return status
  }

  /** Send the status again (its note changed). */
  publish(): void {
    this.emitStatus()
  }

  /** The current credentials are expired (or about to): refresh them before opening a server connection. */
  needsRefresh(): boolean {
    const lease = this.current
    if (!lease) return true
    if (this.state === 'expired') return true
    const expiresAt = effectiveExpiry(lease)
    if (expiresAt === undefined) return false
    // A static role keeps its password until the rotation: refreshing earlier reads the same one.
    const margin = lease.creds.kind === 'static' ? 0 : REFRESH_BEFORE_USE_MS
    return this.ops.now() >= expiresAt - margin
  }

  /** Re-arm the timers from the wall clock (after sleep): overdue renewals / re-issues run now. */
  resync(): void {
    if (this.closed) return
    this.schedule()
    for (const lease of this.leases.values()) if (lease !== this.current && this.retireTimers.has(lease.key)) this.armRetire(lease)
  }

  /**
   * Issue new credentials now (manual refresh, expired credentials) and install them. With `ifNeeded`, a
   * refresh that another caller completed meanwhile is not repeated.
   */
  refresh(issue: () => Promise<{ creds: IssuedCredentials; token: VaultToken }>, { ifNeeded = false }: { ifNeeded?: boolean } = {}): Promise<LeaseRecord> {
    return this.serialize(async () => {
      if (this.closed) throw DriverError.of('connection', 'The connection was closed.')
      if (ifNeeded && this.current && !this.needsRefresh()) return this.current
      const { creds, token } = await issue()
      if (this.closed) {
        this.revokeOrphan(creds, token)
        throw DriverError.of('connection', 'The connection was closed.')
      }
      const current = this.current
      if (current && sameStatic(current, creds)) {
        // Same static password: nothing to switch to (the metadata pool keeps its connections).
        current.creds.expiresAt = creds.expiresAt
        this.schedule()
        this.emitStatus()
        return current
      }
      const lease = this.install(creds, token)
      await this.rotate()
      return lease
    })
  }

  /** Stop timers; revoke every lease still alive when `revoke` (and the connection allows it). */
  async close(revoke: boolean): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const timer of this.retireTimers.values()) clearTimeout(timer)
    this.retireTimers.clear()
    if (revoke && this.revokeLeases) {
      for (const lease of this.leases.values()) {
        if (lease.revoked || lease.creds.kind !== 'dynamic') continue
        lease.revoked = true
        this.track(lease)
      }
    }
    this.leases.clear()
    this.current = null
    await Promise.allSettled([...this.revocations])
  }

  // -------------------------------------------------------------------------

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  private setState(state: VaultLeaseState, message?: string): void {
    this.state = state
    this.message = message
    this.emitStatus()
  }

  private emitStatus(): void {
    if (this.closed) return
    try {
      this.ops.emit(this.status())
    } catch (error) {
      this.ops.log.warn('[vault] cannot emit a lease status', error)
    }
  }

  private maybeRevoke(lease: LeaseRecord): void {
    if (!lease.superseded || lease.holders.size > 0 || lease.revoked) return
    this.leases.delete(lease.key)
    this.clearRetire(lease.key)
    if (lease.creds.kind !== 'dynamic' || !this.revokeLeases) return
    lease.revoked = true
    this.track(lease)
  }

  private track(lease: LeaseRecord): void {
    const promise = this.ops
      .revoke(lease)
      .catch((error: unknown) => this.ops.log.warn(`[vault] revoking a lease of ${this.connectionId} failed: ${messageOf(error)}`))
      .finally(() => this.revocations.delete(promise))
    this.revocations.add(promise)
  }

  private revokeOrphan(creds: IssuedCredentials, token: VaultToken): void {
    if (creds.kind !== 'dynamic' || !this.revokeLeases) return
    this.track({ key: randomUUID(), creds, token, holders: new Set(), superseded: true, revoked: true })
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.closed) return
    const lease = this.current
    if (!lease) return
    const at = this.nextActionAt(lease)
    if (at === undefined) return
    this.arm(Math.max(0, at - this.ops.now()), () => this.tick(lease))
  }

  /** Absolute time of the next renewal / re-issue / re-read of the current credentials. */
  private nextActionAt(lease: LeaseRecord): number | undefined {
    if (lease.creds.kind === 'static') {
      return lease.creds.expiresAt === undefined ? undefined : lease.creds.expiresAt + STATIC_REREAD_DELAY_MS
    }
    const end = effectiveExpiry(lease)
    if (end === undefined) return undefined
    if (this.expiring) return end - marginFor(lease)
    const times = [leaseRenewAt(lease), tokenBound(lease) !== undefined ? tokenRenewAt(lease.token) : undefined].filter((t): t is number => t !== undefined)
    return times.length > 0 ? Math.min(...times) : undefined
  }

  private arm(delayMs: number, fn: () => Promise<void>): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.serialize(fn).catch((error: unknown) => this.ops.log.error('[vault] lease timer failed', error))
    }, delayMs)
    this.timer.unref?.()
  }

  private markExpiring(message: string): void {
    this.expiring = true
    this.setState('expiring', message)
  }

  private tokenEndMessage(lease: LeaseRecord): string {
    const end = lease.token.expiresAt ?? 0
    if (this.ops.interactiveLogin) return `The Vault sign-in cannot be extended: sign in to Vault again before ${clock(end)} to keep the database credentials.`
    return `The Vault token cannot be renewed past ${clock(end)}: new credentials will be issued before then.`
  }

  private async tick(lease: LeaseRecord): Promise<void> {
    if (this.closed || this.current !== lease) return
    if (lease.creds.kind === 'static') {
      // Database static role: Vault rotated (or is about to rotate) the password; read it again.
      await this.reissue(lease)
      return
    }
    if (!this.expiring) {
      const now = this.ops.now()
      const tokenDue = tokenBound(lease) !== undefined && now >= (tokenRenewAt(lease.token) ?? Infinity)
      if (tokenDue) {
        if (canExtendToken(lease.token) && this.ops.renewToken) await this.renewToken(lease)
        else if (tokenBinds(lease)) this.markExpiring(this.tokenEndMessage(lease))
        if (this.closed || this.current !== lease) return
      }
      const leaseDue = !this.expiring && this.ops.now() >= (leaseRenewAt(lease) ?? Infinity)
      if (leaseDue) {
        if (lease.creds.renewable && !lease.capped) await this.renew(lease)
        else this.markExpiring('The lease cannot be renewed: new credentials will be issued before it expires.')
        if (this.closed || this.current !== lease) return
      }
      const end = effectiveExpiry(lease) ?? 0
      // Not expiring, or still time to wait before re-issuing (a timer that fired late has none).
      if (!this.expiring || this.ops.now() < end - marginFor(lease)) {
        this.schedule()
        return
      }
    }
    await this.reissue(lease)
  }

  private async renewToken(lease: LeaseRecord): Promise<void> {
    const renewToken = this.ops.renewToken
    if (!renewToken) return
    try {
      const token = await renewToken(lease)
      if (this.closed) return
      // Every lease issued by this token (current and superseded) lives as long as it.
      for (const other of this.leases.values()) if (other.token.token === token.token) other.token = token
      lease.token = token
      if (this.current !== lease) return
      if (!canExtendToken(token) && tokenBinds(lease)) this.markExpiring(this.tokenEndMessage(lease))
      else this.emitStatus() // new deadline
    } catch (error) {
      if (this.closed || this.current !== lease) return
      this.markExpiring(`Vault token renewal failed (${messageOf(error)}): new credentials will be issued before it expires.`)
    }
  }

  private async renew(lease: LeaseRecord): Promise<void> {
    const increment = lease.incrementSec ?? lease.creds.leaseDurationSec ?? 3600
    this.setState('renewing')
    const start = this.ops.now()
    try {
      const result = await this.ops.renew(lease, increment)
      if (this.closed || this.current !== lease) return
      const duration = Math.max(0, result.leaseDurationSec)
      lease.creds.leaseDurationSec = duration
      lease.creds.expiresAt = start + duration * 1000
      lease.creds.renewable = result.renewable
      // Vault grants less than asked when the role's max TTL caps the lease (1 s tolerance).
      if (!result.renewable || duration + 1 < increment) {
        lease.capped = true
        this.markExpiring('The lease reached its maximum TTL: new credentials will be issued before it expires.')
      } else {
        this.setState('valid')
      }
    } catch (error) {
      if (this.closed || this.current !== lease) return
      this.markExpiring(`Lease renewal failed (${messageOf(error)}): new credentials will be issued before it expires.`)
    }
  }

  private async reissue(lease: LeaseRecord): Promise<void> {
    if (this.closed || this.current !== lease) return
    const expiresAt = effectiveExpiry(lease)
    const dynamic = lease.creds.kind === 'dynamic'
    if (dynamic && expiresAt !== undefined && this.ops.now() >= expiresAt) this.setState('expired', 'The database credentials expired.')
    try {
      const { creds, token } = await this.ops.reissue(lease)
      if (this.closed || this.current !== lease) {
        this.revokeOrphan(creds, token)
        return
      }
      if (sameStatic(lease, creds)) {
        // Static role not rotated yet (Vault rotates on a ~5 s tick): keep the record (its holders), read again soon.
        lease.creds.expiresAt = Math.max(creds.expiresAt ?? 0, this.ops.now())
        this.schedule()
        this.emitStatus()
        return
      }
      this.install(creds, token)
      await this.rotate()
    } catch (error) {
      if (this.closed || this.current !== lease) return
      const expired = expiresAt !== undefined && this.ops.now() >= expiresAt
      this.setState(expired ? 'expired' : 'error', `New credentials could not be issued: ${messageOf(error)}`)
      if (!this.ops.needsUser(error)) this.arm(REISSUE_RETRY_MS, () => this.reissue(lease))
    }
  }

  // --- superseded leases -----------------------------------------------------

  private clearRetire(key: string): void {
    const timer = this.retireTimers.get(key)
    if (timer) clearTimeout(timer)
    this.retireTimers.delete(key)
  }

  /** Watch a superseded dynamic lease that sessions still use: Vault drops its user when it ends. */
  private armRetire(lease: LeaseRecord): void {
    this.clearRetire(lease.key)
    if (this.closed || lease.creds.kind !== 'dynamic' || !this.ops.retire) return
    const end = effectiveExpiry(lease)
    if (end === undefined) return
    const at = end - Math.max(RETIRE_MARGIN_MS, marginFor(lease))
    const timer = setTimeout(() => {
      this.retireTimers.delete(lease.key)
      void this.retire(lease).catch((error: unknown) => this.ops.log.error('[vault] moving sessions to new credentials failed', error))
    }, Math.max(0, at - this.ops.now()))
    timer.unref?.()
    this.retireTimers.set(lease.key, timer)
  }

  private async retire(lease: LeaseRecord): Promise<void> {
    if (this.closed || !this.leases.has(lease.key) || lease.holders.size === 0) return
    const margin = Math.max(RETIRE_MARGIN_MS, marginFor(lease))
    const end = effectiveExpiry(lease)
    if (end === undefined) return
    // Renewed meanwhile (shared token): wait.
    if (end - this.ops.now() > margin) {
      this.armRetire(lease)
      return
    }
    // Keep it alive when Vault still allows it (a session may be in a transaction).
    if (!tokenBinds(lease) && lease.creds.renewable && !lease.capped) {
      const increment = lease.incrementSec ?? lease.creds.leaseDurationSec ?? 3600
      const start = this.ops.now()
      try {
        const result = await this.ops.renew(lease, increment)
        const duration = Math.max(0, result.leaseDurationSec)
        lease.creds.leaseDurationSec = duration
        lease.creds.expiresAt = start + duration * 1000
        lease.creds.renewable = result.renewable
        if (!result.renewable || duration + 1 < increment) lease.capped = true
        if (!this.closed && (effectiveExpiry(lease) ?? 0) - this.ops.now() > margin * 2) {
          this.armRetire(lease)
          return
        }
      } catch (error) {
        this.ops.log.warn(`[vault] renewing a superseded lease of ${this.connectionId} failed: ${messageOf(error)}`)
      }
    }
    if (this.closed || !this.leases.has(lease.key) || lease.holders.size === 0) return
    await this.ops.retire?.(lease)
  }

  private async rotate(): Promise<void> {
    try {
      await this.ops.rotated()
    } catch (error) {
      this.ops.log.warn(`[vault] switching ${this.connectionId} to new credentials failed: ${messageOf(error)}`)
      if (!this.closed) this.setState(this.state, `New credentials were issued but the explorer could not reconnect: ${messageOf(error)}`)
    }
  }
}
