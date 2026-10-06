// How Vault credentials and lease states are described: explorer badge, status bar chip, dialog result.
// Pure (time is passed in) so it is unit-tested.
import type { VaultCredentialsInfo, VaultLoginMethod, VaultStatus, VaultTokenSource } from '@shared/types'

/** Below this, a lease is shown as about to expire (warning). */
export const EXPIRY_WARNING_MS = 5 * 60_000

export type VaultTone = 'neutral' | 'warning' | 'danger'

export const LOGIN_METHOD_LABEL: Record<VaultLoginMethod, string> = {
  oidc: 'OIDC',
  token: 'Token',
  ldap: 'LDAP',
  userpass: 'Userpass',
}

export const TOKEN_SOURCE_LABEL: Record<VaultTokenSource, string> = {
  env: 'VAULT_TOKEN',
  cli: 'the vault CLI token',
  stored: 'a saved token',
  oidc: 'OIDC',
  ldap: 'LDAP',
  userpass: 'userpass',
}

/** "45 s", "47 min", "1 h", "1 h 5 min", "3 days" — a duration rounded for humans. */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const min = Math.floor(s / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const restMin = min % 60
  if (h < 24) return restMin ? `${h} h ${restMin} min` : `${h} h`
  const d = Math.floor(h / 24)
  const restH = h % 24
  if (d < 7 && restH) return `${d} ${d === 1 ? 'day' : 'days'} ${restH} h`
  return `${d} ${d === 1 ? 'day' : 'days'}`
}

/** Remaining time of a dynamic lease (negative once expired); undefined when it has no expiry. */
export function remainingMs(info: VaultCredentialsInfo | null | undefined, now: number): number | undefined {
  return info?.expiresAt !== undefined ? info.expiresAt - now : undefined
}

/**
 * Static credentials with a deadline come from a database static role: Vault rotates the password then and
 * DataGrippe reads it again by itself, so the deadline is not something the user must act on.
 */
export function isRotatedStatic(info: VaultCredentialsInfo | null | undefined): boolean {
  return info?.kind === 'static' && info.expiresAt !== undefined
}

/** "expires in 47 min", "expires in < 1 min", "expired 3 min ago", "no expiry", "rotates in 12 h". */
export function describeExpiry(info: VaultCredentialsInfo, now: number): string {
  const left = remainingMs(info, now)
  if (left === undefined) return info.kind === 'static' ? 'static secret' : 'no expiry'
  if (isRotatedStatic(info)) return left <= 60_000 ? 'password rotating now' : `password rotates in ${formatSpan(left)}`
  if (left <= 0) return -left < 60_000 ? 'expired just now' : `expired ${formatSpan(-left)} ago`
  if (left < 60_000) return 'expires in < 1 min'
  return `expires in ${formatSpan(left)}`
}

/** One line for tooltips: "expires in 47 min · renewable". */
export function describeLease(info: VaultCredentialsInfo, now: number): string {
  const parts = [describeExpiry(info, now)]
  if (info.kind === 'dynamic' && info.renewable !== undefined) parts.push(info.renewable ? 'renewable' : 'not renewable')
  return parts.join(' · ')
}

export function vaultTone(status: VaultStatus | null | undefined, now: number): VaultTone {
  if (!status) return 'neutral'
  if (status.state === 'error' || status.state === 'expired') return 'danger'
  // A static role's rotation is followed automatically: its deadline never needs attention.
  if (isRotatedStatic(status.info)) return status.state === 'expiring' ? 'warning' : 'neutral'
  const left = remainingMs(status.info, now)
  if (left !== undefined && left <= 0) return 'danger'
  if (status.state === 'expiring') return 'warning'
  if (left !== undefined && left < EXPIRY_WARNING_MS) return 'warning'
  return 'neutral'
}

/** Short text after "Vault ·" in the status bar chip: "47 min", "renewing…", "expired", "error". */
export function chipText(status: VaultStatus, now: number): string {
  if (status.state === 'error') return 'error'
  if (status.state === 'renewing') return 'renewing…'
  if (status.info?.kind === 'static' && status.state !== 'expired') return 'static'
  const left = remainingMs(status.info, now)
  if (status.state === 'expired' || (left !== undefined && left <= 0)) return 'expired'
  if (left === undefined) return status.info?.kind === 'static' ? 'static' : 'signed in'
  if (left < 60_000) return '< 1 min'
  return formatSpan(left)
}

const STATE_LABEL: Record<VaultStatus['state'], string> = {
  valid: 'Credentials valid',
  renewing: 'Renewing the lease…',
  expiring: 'Lease about to expire',
  expired: 'Lease expired',
  error: 'Vault error',
}

export interface VaultStatusLine {
  label: string
  value: string
  mono?: boolean
}

/** Details listed in tooltips (explorer badge, status bar chip). */
export function statusDetails(status: VaultStatus, now: number): { title: string; lines: VaultStatusLine[]; message?: string } {
  const lines: VaultStatusLine[] = []
  const info = status.info
  if (info) {
    lines.push({ label: 'User', value: info.username, mono: true })
    lines.push({
      label: 'Kind',
      value: info.kind === 'dynamic' ? 'Dynamic (database secrets engine)' : isRotatedStatic(info) ? 'Static role (rotated password)' : 'Static (KV secret)',
    })
    if (info.kind === 'dynamic') lines.push({ label: 'Lease', value: describeLease(info, now) })
    else if (isRotatedStatic(info)) lines.push({ label: 'Rotation', value: describeExpiry(info, now) })
    lines.push({ label: 'Signed in via', value: TOKEN_SOURCE_LABEL[info.tokenSource] })
  }
  return { title: STATE_LABEL[status.state], lines, message: status.message }
}

/** "lease 1 h, renewable" / "static secret" — the fetched credentials, for the connection dialog. */
export function describeFetched(info: VaultCredentialsInfo): string {
  if (isRotatedStatic(info)) return 'static role, rotated password'
  if (info.kind === 'static') return 'static secret (KV)'
  const lease = info.leaseDurationSec !== undefined ? `lease ${formatSpan(info.leaseDurationSec * 1000)}` : 'lease'
  return info.renewable === undefined ? lease : `${lease}, ${info.renewable ? 'renewable' : 'not renewable'}`
}

/** "Signed in via OIDC" for the fetch result's title. */
export function signedInVia(info: VaultCredentialsInfo): string {
  return `Signed in via ${TOKEN_SOURCE_LABEL[info.tokenSource]}`
}

/** A Vault error message shown under a "Vault" title, without main's own "Vault:" prefix. */
export function vaultMessage(message: string | undefined): string {
  const text = (message ?? '').replace(/^vault:\s*/i, '').trim()
  if (!text) return 'Vault refused the request.'
  // A message starting with a path or an identifier (e.g. "database/creds/x rejected…") keeps its case.
  const first = text.split(/\s/, 1)[0]!
  if (/[/_.:-]/.test(first)) return text
  return text[0]!.toUpperCase() + text.slice(1)
}
