import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultStatus } from '@shared/types'
import { DriverError } from '../db/errors'
import type { IssuedCredentials } from './credentials'
import { ConnectionLeases, REISSUE_RETRY_MS, reissueMarginMs, STATIC_REREAD_DELAY_MS, type LeaseOps, type RenewResult } from './leases'
import type { VaultToken } from './login'

const quiet = { warn: () => undefined, error: () => undefined }
const token: VaultToken = { token: 'tok', source: 'oidc', renewable: true, key: 'k', cached: false, obtainedAt: 0 }

function creds(username: string, durationSec = 60, renewable = true): IssuedCredentials {
  const now = Date.now()
  return { username, password: `pw-${username}`, kind: 'dynamic', leaseId: `database/creds/ro/${username}`, leaseDurationSec: durationSec, renewable, issuedAt: now, expiresAt: now + durationSec * 1000 }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('ConnectionLeases', () => {
  let statuses: VaultStatus[]
  let revoked: string[]
  let issued: number
  let renewImpl: (incrementSec: number) => Promise<RenewResult>
  let reissueImpl: () => Promise<{ creds: IssuedCredentials; token: VaultToken }>
  let ops: LeaseOps & { renew: ReturnType<typeof vi.fn>; reissue: ReturnType<typeof vi.fn>; rotated: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-05T10:00:00Z'))
    statuses = []
    revoked = []
    issued = 0
    renewImpl = async (inc) => ({ leaseDurationSec: inc, renewable: true })
    reissueImpl = async () => ({ creds: creds(`u${++issued}`), token })
    ops = {
      renew: vi.fn(async (_lease, inc: number) => renewImpl(inc)),
      reissue: vi.fn(async () => reissueImpl()),
      revoke: async (lease) => void revoked.push(lease.creds.username),
      rotated: vi.fn(async () => undefined),
      emit: (s) => statuses.push(s),
      now: () => Date.now(),
      needsUser: (e) => e instanceof DriverError && e.info.kind === 'needs-password',
      log: quiet,
    }
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const states = () => statuses.map((s) => s.state)

  it('renews at 2/3 of the remaining time and keeps the lease valid', async () => {
    const leases = new ConnectionLeases('c1', true, ops)
    const lease = leases.install(creds('u0', 60), token)
    expect(leases.status()).toMatchObject({ connectionId: 'c1', state: 'valid', info: { username: 'u0', kind: 'dynamic', tokenSource: 'oidc' } })
    await vi.advanceTimersByTimeAsync(39_900)
    expect(ops.renew).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(ops.renew).toHaveBeenCalledWith(lease, 60)
    expect(states()).toEqual(['valid', 'renewing', 'valid'])
    expect(lease.creds.expiresAt).toBe(Date.now() + 60_000)
    // Next renewal 2/3 of the new remaining time later.
    await vi.advanceTimersByTimeAsync(40_000)
    expect(ops.renew).toHaveBeenCalledTimes(2)
    await leases.close(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('switches to expiring at max TTL, re-issues before expiry and revokes the unused old lease', async () => {
    renewImpl = async () => ({ leaseDurationSec: 20, renewable: true }) // capped by max_ttl
    const leases = new ConnectionLeases('c1', true, ops)
    leases.install(creds('u0', 60), token)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(leases.status()).toMatchObject({ state: 'expiring' })
    expect(leases.status().message).toMatch(/maximum TTL/)
    // expires at 60 s; re-issued min(60 s, 10 % of 60 s) = 6 s before.
    await vi.advanceTimersByTimeAsync(13_900)
    expect(ops.reissue).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(ops.reissue).toHaveBeenCalledTimes(1)
    expect(ops.rotated).toHaveBeenCalledTimes(1)
    expect(leases.current?.creds.username).toBe('u1')
    expect(leases.status().state).toBe('valid')
    await flush()
    expect(revoked).toEqual(['u0'])
    expect(states()).toEqual(['valid', 'renewing', 'expiring', 'valid'])
    await leases.close(false)
  })

  it('keeps a superseded lease while a session uses it', async () => {
    const leases = new ConnectionLeases('c1', true, ops)
    const old = leases.install(creds('u0', 60, false), token)
    leases.retain(old.key, 'session-1')
    leases.retain(old.key, 'metadata')
    await leases.refresh(() => reissueImpl())
    leases.release(old.key, 'metadata')
    await flush()
    expect(revoked).toEqual([])
    expect(leases.lease(old.key)).toBeDefined()
    leases.release(old.key, 'session-1')
    await flush()
    expect(revoked).toEqual(['u0'])
    expect(leases.lease(old.key)).toBeUndefined()
    await leases.close(true)
    expect(revoked).toEqual(['u0', 'u1'])
  })

  it('does not renew a non-renewable lease: expiring at 2/3, re-issued before expiry', async () => {
    const leases = new ConnectionLeases('c1', true, ops)
    leases.install(creds('u0', 3600, false), token)
    await vi.advanceTimersByTimeAsync(2_400_000)
    expect(ops.renew).not.toHaveBeenCalled()
    expect(leases.status().state).toBe('expiring')
    expect(reissueMarginMs(3600)).toBe(60_000)
    await vi.advanceTimersByTimeAsync(3_600_000 - 2_400_000 - 60_000 - 1)
    expect(ops.reissue).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(ops.reissue).toHaveBeenCalledTimes(1)
    await leases.close(false)
  })

  it('treats a failed renewal as expiring', async () => {
    renewImpl = async () => {
      throw new Error('Vault: cannot reach https://vault.example.cloud (connection refused)')
    }
    const leases = new ConnectionLeases('c1', true, ops)
    leases.install(creds('u0', 30), token)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(leases.status()).toMatchObject({ state: 'expiring' })
    expect(leases.status().message).toMatch(/Lease renewal failed \(Vault: cannot reach/)
    await vi.advanceTimersByTimeAsync(7_000) // 30 s - 3 s margin
    expect(ops.reissue).toHaveBeenCalledTimes(1)
    await leases.close(false)
  })

  it('retries a failed re-issue, and reports expiry', async () => {
    let fail = true
    reissueImpl = async () => {
      if (fail) throw new Error('Vault: cannot reach https://vault.example.cloud (connection refused)')
      return { creds: creds(`u${++issued}`), token }
    }
    const leases = new ConnectionLeases('c1', true, ops)
    leases.install(creds('u0', 10, false), token)
    await vi.advanceTimersByTimeAsync(6_700) // 2/3: expiring
    await vi.advanceTimersByTimeAsync(2_300) // 10 s - 1 s margin: re-issue fails
    expect(leases.status()).toMatchObject({ state: 'error' })
    expect(leases.status().message).toMatch(/New credentials could not be issued/)
    await vi.advanceTimersByTimeAsync(REISSUE_RETRY_MS) // retry after expiry
    expect(ops.reissue).toHaveBeenCalledTimes(2)
    expect(leases.status().state).toBe('expired')
    expect(leases.needsRefresh()).toBe(true)
    fail = false
    await vi.advanceTimersByTimeAsync(REISSUE_RETRY_MS)
    expect(leases.status().state).toBe('valid')
    expect(leases.current?.creds.username).toBe('u1')
    await leases.close(false)
  })

  it('does not retry in the background when the user is needed', async () => {
    reissueImpl = async () => {
      throw DriverError.of('needs-password', 'Vault password required', { secretField: 'vaultPassword' })
    }
    const leases = new ConnectionLeases('c1', true, ops)
    leases.install(creds('u0', 10, false), token)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(leases.status().state).toBe('error')
    expect(vi.getTimerCount()).toBe(0)
    await leases.close(false)
  })

  it('handles a timer firing late (sleep): expired, then re-issued', async () => {
    const leases = new ConnectionLeases('c1', true, ops)
    leases.install(creds('u0', 60, false), token)
    vi.setSystemTime(Date.now() + 120_000) // the machine slept past expiry
    await vi.advanceTimersByTimeAsync(40_000) // 2/3 timer: expiring, re-issue due immediately
    await vi.advanceTimersByTimeAsync(0)
    expect(states()).toContain('expired')
    expect(leases.current?.creds.username).toBe('u1')
    await leases.close(false)
  })

  it('revokes every live dynamic lease on close (unless disabled) and clears timers', async () => {
    const leases = new ConnectionLeases('c1', true, ops)
    const a = leases.install(creds('u0'), token)
    leases.retain(a.key, 's')
    leases.install(creds('u1'), token)
    await leases.close(true)
    expect(revoked.sort()).toEqual(['u0', 'u1'])
    expect(vi.getTimerCount()).toBe(0)
    expect(leases.current).toBeNull()

    revoked = []
    const keep = new ConnectionLeases('c2', false, ops)
    keep.install(creds('u2'), token)
    keep.install(creds('u3'), token)
    await keep.close(true)
    expect(revoked).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('schedules nothing for static credentials', async () => {
    const leases = new ConnectionLeases('c1', true, ops)
    leases.install({ username: 'app', password: 'pw', kind: 'static', issuedAt: Date.now() }, token)
    expect(vi.getTimerCount()).toBe(0)
    expect(leases.needsRefresh()).toBe(false)
    await leases.close(true)
    expect(revoked).toEqual([])
  })

  it('refresh() issues, installs and rotates; refresh after close fails and revokes the orphan', async () => {
    const leases = new ConnectionLeases('c1', true, ops)
    leases.install(creds('u0'), token)
    const lease = await leases.refresh(() => reissueImpl())
    expect(lease.creds.username).toBe('u1')
    expect(ops.rotated).toHaveBeenCalledTimes(1)
    let release: () => void = () => undefined
    const pending = leases.refresh(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ creds: creds('late'), token })
        }),
    )
    await flush()
    const closing = leases.close(true)
    release()
    await expect(pending).rejects.toThrow(/closed/)
    await closing
    await flush()
    expect(revoked).toContain('late')
  })
  describe('the token that issued the lease', () => {
    const shortToken = (ttlSec: number, patch: Partial<VaultToken> = {}): VaultToken => ({
      token: 'tok-short',
      source: 'userpass',
      renewable: true,
      ttlSec,
      incrementSec: ttlSec,
      expiresAt: Date.now() + ttlSec * 1000,
      key: 'k',
      cached: false,
      obtainedAt: Date.now(),
      ...patch,
    })

    it('is renewed in the last third of its TTL, and caps the reported expiry', async () => {
      const renewToken = vi.fn(async (lease: { token: VaultToken }) => ({ ...lease.token, expiresAt: Date.now() + 60_000, ttlSec: 60 }))
      const leases = new ConnectionLeases('c1', true, { ...ops, renewToken })
      leases.install(creds('u0', 3600), shortToken(60))
      // The lease lasts 1 h but Vault revokes it with the token in 60 s.
      expect(leases.status().info?.expiresAt).toBe(Date.now() + 60_000)
      expect(leases.status().info?.leaseDurationSec).toBe(3600)
      await vi.advanceTimersByTimeAsync(39_900)
      expect(renewToken).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(100)
      expect(renewToken).toHaveBeenCalledTimes(1)
      expect(leases.status()).toMatchObject({ state: 'valid', info: { expiresAt: Date.now() + 60_000 } })
      expect(ops.renew).not.toHaveBeenCalled() // the lease itself is not due
      await vi.advanceTimersByTimeAsync(40_000)
      expect(renewToken).toHaveBeenCalledTimes(2)
      expect(states()).not.toContain('renewing') // token renewals are silent
      await leases.close(false)
    })

    it('at its max TTL: expiring, then new credentials (with a new token) before it ends', async () => {
      const renewToken = vi.fn(async (lease: { token: VaultToken }) => ({ ...lease.token, expiresAt: Date.now() + 10_000, ttlSec: 10, final: true }))
      const leases = new ConnectionLeases('c1', true, { ...ops, renewToken })
      const first = leases.install(creds('u0', 3600), shortToken(60))
      await vi.advanceTimersByTimeAsync(40_000)
      expect(leases.status()).toMatchObject({ state: 'expiring' })
      expect(leases.status().message).toMatch(/Vault token cannot be renewed past \d\d:\d\d/)
      // Ends at 50 s; re-issued min(60 s, 10 % of 10 s) → 1 s before.
      await vi.advanceTimersByTimeAsync(8_900)
      expect(ops.reissue).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(100)
      expect(ops.reissue).toHaveBeenCalledWith(first)
      expect(leases.current?.creds.username).toBe('u1')
      await leases.close(false)
    })

    it('OIDC: asks to sign in again before the token ends', async () => {
      const leases = new ConnectionLeases('c1', true, { ...ops, interactiveLogin: true })
      leases.install(creds('u0', 3600), shortToken(60, { renewable: false }))
      await vi.advanceTimersByTimeAsync(40_000)
      expect(leases.status().state).toBe('expiring')
      expect(leases.status().message).toMatch(/^The Vault sign-in cannot be extended: sign in to Vault again before \d\d:\d\d/)
      expect(leases.needsRefresh()).toBe(false)
      vi.setSystemTime(Date.now() + 19_000)
      expect(leases.needsRefresh()).toBe(true) // the token (not the 1 h lease) decides
      await leases.close(false)
    })

    it('a failed token renewal is handled like a failed lease renewal', async () => {
      const renewToken = vi.fn(async () => {
        throw new Error('Vault: cannot reach https://vault.example.cloud (connection refused)')
      })
      const leases = new ConnectionLeases('c1', true, { ...ops, renewToken })
      leases.install(creds('u0', 3600), shortToken(30))
      await vi.advanceTimersByTimeAsync(20_000)
      expect(leases.status().message).toMatch(/Vault token renewal failed \(Vault: cannot reach/)
      await vi.advanceTimersByTimeAsync(7_000)
      expect(ops.reissue).toHaveBeenCalledTimes(1)
      await leases.close(false)
    })
  })

  it('re-reads a database static role right after its password rotation', async () => {
    const issuedAt = Date.now()
    let rotated = false
    reissueImpl = async () => ({
      creds: { username: 'svc', password: rotated ? 'pw-2' : 'pw-1', kind: 'static', issuedAt: Date.now(), expiresAt: Date.now() + (rotated ? 600_000 : 0) },
      token,
    })
    const leases = new ConnectionLeases('c1', true, ops)
    const first = leases.install({ username: 'svc', password: 'pw-1', kind: 'static', issuedAt, expiresAt: issuedAt + 60_000 }, token)
    leases.retain(first.key, 'session-1')
    expect(leases.needsRefresh()).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000 + STATIC_REREAD_DELAY_MS - 1)
    expect(ops.reissue).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    // Not rotated yet (Vault rotates on a ~5 s tick): same record, read again shortly.
    expect(ops.reissue).toHaveBeenCalledTimes(1)
    expect(leases.current).toBe(first)
    rotated = true
    await vi.advanceTimersByTimeAsync(STATIC_REREAD_DELAY_MS)
    expect(ops.reissue).toHaveBeenCalledTimes(2)
    expect(leases.current?.creds.password).toBe('pw-2')
    expect(ops.rotated).toHaveBeenCalledTimes(1)
    await flush()
    expect(revoked).toEqual([]) // static: never revoked
    expect(leases.lease(first.key)).toBeDefined() // still held by its session
    await leases.close(true)
  })

  it('moves the holders of a superseded lease shortly before it ends, after trying to extend it', async () => {
    const retire = vi.fn(async () => undefined)
    renewImpl = async () => ({ leaseDurationSec: 30, renewable: true }) // capped
    const leases = new ConnectionLeases('c1', true, { ...ops, retire })
    const old = leases.install(creds('u0', 120), token)
    leases.retain(old.key, 'session-1')
    await leases.refresh(() => reissueImpl())
    // Ends at 120 s: checked max(5 s, 10 % of 120 s = 12 s) before; Vault grants no more than 30 s: moved.
    await vi.advanceTimersByTimeAsync(107_900)
    expect(retire).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    const renewalsOfOld = () => ops.renew.mock.calls.filter((call) => call[0] === old)
    expect(renewalsOfOld()).toEqual([[old, 120]])
    await flush()
    expect(retire).not.toHaveBeenCalled() // extended to 138 s: checked again at 126 s
    await vi.advanceTimersByTimeAsync(18_000)
    await flush()
    expect(renewalsOfOld()).toHaveLength(1) // capped: not renewed again
    expect(retire).toHaveBeenCalledWith(old)
    // Released before its end: no move, revoked.
    const other = leases.current!
    leases.retain(other.key, 'session-2')
    await leases.refresh(() => reissueImpl())
    leases.release(other.key, 'session-2')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(retire).toHaveBeenCalledTimes(1)
    await leases.close(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resync() runs overdue work right away (timers paused during sleep)', async () => {
    const leases = new ConnectionLeases('c1', true, ops)
    leases.install(creds('u0', 60), token)
    vi.setSystemTime(Date.now() + 45_000)
    leases.resync()
    await vi.advanceTimersByTimeAsync(0)
    expect(ops.renew).toHaveBeenCalledTimes(1)
    await leases.close(false)
  })

  it('adds the note to a valid status only', async () => {
    let note: string | undefined
    const leases = new ConnectionLeases('c1', true, { ...ops, note: () => note })
    leases.install(creds('u0', 60), token)
    expect(leases.status().message).toBeUndefined()
    note = 'Your Vault policy does not allow revoking leases'
    leases.publish()
    expect(statuses.at(-1)?.message).toBe(note)
    await leases.close(false)
  })
})
