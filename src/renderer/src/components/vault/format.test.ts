import { describe, expect, it } from 'vitest'
import type { VaultCredentialsInfo, VaultStatus } from '@shared/types'
import {
  chipText,
  describeExpiry,
  describeFetched,
  describeLease,
  formatSpan,
  signedInVia,
  statusDetails,
  vaultMessage,
  vaultTone,
} from './format'

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0)
const MIN = 60_000

const dynamic = (patch: Partial<VaultCredentialsInfo> = {}): VaultCredentialsInfo => ({
  username: 'v-oidc-readonly-AbC123',
  kind: 'dynamic',
  expiresAt: NOW + 47 * MIN,
  leaseDurationSec: 3600,
  renewable: true,
  tokenSource: 'oidc',
  issuedAt: NOW - 13 * MIN,
  ...patch,
})

const status = (state: VaultStatus['state'], info: VaultCredentialsInfo | null = dynamic(), message?: string): VaultStatus => ({
  connectionId: 'c1',
  state,
  info,
  message,
})

describe('formatSpan', () => {
  it('rounds durations for humans', () => {
    expect(formatSpan(45_000)).toBe('45 s')
    expect(formatSpan(47 * MIN)).toBe('47 min')
    expect(formatSpan(60 * MIN)).toBe('1 h')
    expect(formatSpan(65 * MIN)).toBe('1 h 5 min')
    expect(formatSpan(26 * 60 * MIN)).toBe('1 day 2 h')
    expect(formatSpan(32 * 24 * 60 * MIN)).toBe('32 days')
    expect(formatSpan(-5)).toBe('0 s')
  })
})

describe('expiry', () => {
  it('describes the remaining time, relative to now', () => {
    expect(describeExpiry(dynamic(), NOW)).toBe('expires in 47 min')
    expect(describeExpiry(dynamic({ expiresAt: NOW + 30_000 }), NOW)).toBe('expires in < 1 min')
    expect(describeExpiry(dynamic({ expiresAt: NOW - 10_000 }), NOW)).toBe('expired just now')
    expect(describeExpiry(dynamic({ expiresAt: NOW - 3 * MIN }), NOW)).toBe('expired 3 min ago')
    expect(describeExpiry(dynamic({ kind: 'static', expiresAt: undefined }), NOW)).toBe('static secret')
  })

  it('adds renewability for dynamic leases', () => {
    expect(describeLease(dynamic(), NOW)).toBe('expires in 47 min · renewable')
    expect(describeLease(dynamic({ renewable: false }), NOW)).toBe('expires in 47 min · not renewable')
    expect(describeLease(dynamic({ kind: 'static', expiresAt: undefined, renewable: undefined }), NOW)).toBe('static secret')
  })
})

describe('tone', () => {
  it('warns when the lease is about to expire', () => {
    expect(vaultTone(status('valid'), NOW)).toBe('neutral')
    expect(vaultTone(status('valid', dynamic({ expiresAt: NOW + 4 * MIN })), NOW)).toBe('warning')
    expect(vaultTone(status('expiring', dynamic({ expiresAt: NOW + 20 * MIN })), NOW)).toBe('warning')
  })

  it('is danger when expired or failed', () => {
    expect(vaultTone(status('expired'), NOW)).toBe('danger')
    expect(vaultTone(status('error', null), NOW)).toBe('danger')
    // The clock passed the expiry before main reported it.
    expect(vaultTone(status('valid', dynamic({ expiresAt: NOW - 1 })), NOW)).toBe('danger')
  })

  it('is neutral without status or for static secrets', () => {
    expect(vaultTone(undefined, NOW)).toBe('neutral')
    expect(vaultTone(status('valid', dynamic({ kind: 'static', expiresAt: undefined })), NOW)).toBe('neutral')
  })
})

describe('status bar chip', () => {
  it('shows the time left or the state', () => {
    expect(chipText(status('valid'), NOW)).toBe('47 min')
    expect(chipText(status('valid', dynamic({ expiresAt: NOW + 20_000 })), NOW)).toBe('< 1 min')
    expect(chipText(status('renewing'), NOW)).toBe('renewing…')
    expect(chipText(status('expired'), NOW)).toBe('expired')
    expect(chipText(status('valid', dynamic({ expiresAt: NOW - MIN })), NOW)).toBe('expired')
    expect(chipText(status('error', null), NOW)).toBe('error')
    expect(chipText(status('valid', dynamic({ kind: 'static', expiresAt: undefined })), NOW)).toBe('static')
  })
})

describe('details', () => {
  it('lists user, kind, lease and token source', () => {
    const details = statusDetails(status('valid'), NOW)
    expect(details.title).toBe('Credentials valid')
    expect(details.lines).toEqual([
      { label: 'User', value: 'v-oidc-readonly-AbC123', mono: true },
      { label: 'Kind', value: 'Dynamic (database secrets engine)' },
      { label: 'Lease', value: 'expires in 47 min · renewable' },
      { label: 'Signed in via', value: 'OIDC' },
    ])
  })

  it('keeps the error message', () => {
    const details = statusDetails(status('error', null, 'permission denied'), NOW)
    expect(details).toEqual({ title: 'Vault error', lines: [], message: 'permission denied' })
  })

  it('describes fetched credentials for the connection dialog', () => {
    expect(signedInVia(dynamic())).toBe('Signed in via OIDC')
    expect(signedInVia(dynamic({ tokenSource: 'cli' }))).toBe('Signed in via the vault CLI token')
    expect(describeFetched(dynamic())).toBe('lease 1 h, renewable')
    expect(describeFetched(dynamic({ leaseDurationSec: 2_764_800, renewable: false }))).toBe('lease 32 days, not renewable')
    expect(describeFetched(dynamic({ kind: 'static', expiresAt: undefined }))).toBe('static secret (KV)')
    expect(describeFetched(dynamic({ kind: 'static' }))).toBe('static role, rotated password')
  })
})

describe('static database roles (password rotated by Vault)', () => {
  const rotated = dynamic({ kind: 'static', expiresAt: NOW + 2 * MIN, renewable: undefined, leaseDurationSec: undefined })

  it('shows the next rotation, never an expiry to act on', () => {
    expect(describeExpiry(rotated, NOW)).toBe('password rotates in 2 min')
    expect(vaultTone(status('valid', rotated), NOW)).toBe('neutral')
    expect(vaultTone(status('valid', rotated), NOW + 10 * MIN)).toBe('neutral')
    expect(chipText(status('valid', rotated), NOW)).toBe('static')
    expect(statusDetails(status('valid', rotated), NOW).lines).toEqual([
      { label: 'User', value: rotated.username, mono: true },
      { label: 'Kind', value: 'Static role (rotated password)' },
      { label: 'Rotation', value: 'password rotates in 2 min' },
      { label: 'Signed in via', value: 'OIDC' },
    ])
  })

  it('keeps a note on valid credentials informative', () => {
    const note = 'The Vault policy does not allow revoking leases.'
    expect(vaultTone(status('valid', dynamic(), note), NOW)).toBe('neutral')
    expect(statusDetails(status('valid', dynamic(), note), NOW)).toMatchObject({ title: 'Credentials valid', message: note })
  })
})

describe('vault messages', () => {
  it('drops the "Vault:" prefix under a Vault title', () => {
    expect(vaultMessage('Vault: permission denied on db/creds/x (403)')).toBe('Permission denied on db/creds/x (403)')
    expect(vaultMessage('Vault is sealed')).toBe('Vault is sealed')
    expect(vaultMessage('Vault: team-db/creds/x rejected the request (400)')).toBe('team-db/creds/x rejected the request (400)')
    expect(vaultMessage(undefined)).toBe('Vault refused the request.')
  })
})
