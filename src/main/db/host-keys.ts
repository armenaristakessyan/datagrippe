// SSH host key verification: ~/.ssh/known_hosts first (plain, wildcard and hashed entries), then the keys
// the user trusted in DataGrippe (trust on first use, stored by the main process). Unknown keys are refused
// before any authentication, so the SSH password never reaches a server the user has not checked.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SshHostKeyInfo } from '@shared/types'

export interface TrustedHostKey {
  keyType: string
  fingerprint: string
}

/** Keys trusted by the user (persisted by src/main/store/host-keys.ts). */
export interface TrustedHostKeySource {
  trusted(host: string, port: number): TrustedHostKey[]
}

export type HostKeyVerdict =
  | { status: 'trusted' }
  /** Not trusted: `info.changed` tells an unknown host from a key that differs from the trusted one. */
  | { status: 'untrusted'; info: SshHostKeyInfo; revoked?: boolean }

export interface HostKeyVerifierOptions {
  trusted?: TrustedHostKeySource
  /** OpenSSH known_hosts files (default ~/.ssh/known_hosts and ~/.ssh/known_hosts2). */
  knownHostsFiles?: string[]
  readFile?: (path: string) => string
}

/** Key algorithm name stored at the start of an SSH public key blob ("ssh-ed25519", "ssh-rsa"…). */
export function keyTypeOf(blob: Buffer): string {
  if (blob.length < 4) return 'unknown'
  const length = blob.readUInt32BE(0)
  if (length <= 0 || length > 64 || blob.length < 4 + length) return 'unknown'
  return blob.subarray(4, 4 + length).toString('latin1')
}

/** OpenSSH fingerprint: "SHA256:" + unpadded base64 of the SHA-256 of the key blob. */
export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

/** Name used in known_hosts for an endpoint: "host" on port 22, "[host]:port" otherwise. */
export function knownHostsName(host: string, port: number): string {
  const h = host.trim().toLowerCase()
  return port === 22 ? h : `[${h}]:${port}`
}

function wildcardMatch(pattern: string, name: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
  return re.test(name)
}

function hashedMatch(entry: string, name: string): boolean {
  // |1|base64(salt)|base64(HMAC-SHA1(salt, name))
  const parts = entry.split('|')
  if (parts.length !== 4 || parts[1] !== '1') return false
  try {
    const salt = Buffer.from(parts[2], 'base64')
    const expected = Buffer.from(parts[3], 'base64')
    const actual = createHmac('sha1', salt).update(name).digest()
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

/** True when a known_hosts host field ("a,b,[c]:2222,!d,|1|…") covers one of `names`. */
export function hostFieldMatches(field: string, names: string[]): boolean {
  let matched = false
  for (const raw of field.split(',')) {
    if (!raw) continue
    const negated = raw.startsWith('!')
    const pattern = negated ? raw.slice(1) : raw
    const hit = names.some((name) => (pattern.startsWith('|') ? hashedMatch(pattern, name) : wildcardMatch(pattern, name)))
    if (hit && negated) return false
    if (hit) matched = true
  }
  return matched
}

export interface KnownHostsLookup {
  /** The presented key is listed for this host. */
  match: boolean
  /** A @revoked line lists the presented key. */
  revoked: boolean
  /** Other keys listed for this host (the presented one is not among them). */
  others: TrustedHostKey[]
}

/** Look the presented key up in known_hosts content. @cert-authority lines are ignored (no host certificates). */
export function lookupKnownHosts(content: string, host: string, port: number, blob: Buffer): KnownHostsLookup {
  const names = [knownHostsName(host, port)]
  const out: KnownHostsLookup = { match: false, revoked: false, others: [] }
  const presented = blob.toString('base64')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const fields = line.split(/\s+/)
    let marker = ''
    if (fields[0].startsWith('@')) marker = fields.shift() ?? ''
    if (marker === '@cert-authority' || fields.length < 3) continue
    const [hostField, keyType, keyData] = fields
    if (!hostFieldMatches(hostField, names)) continue
    const same = keyData === presented
    if (marker === '@revoked') {
      if (same) out.revoked = true
      continue
    }
    if (same) out.match = true
    else {
      try {
        out.others.push({ keyType, fingerprint: fingerprintOf(Buffer.from(keyData, 'base64')) })
      } catch {
        // malformed line
      }
    }
  }
  return out
}

function defaultKnownHostsFiles(): string[] {
  const ssh = join(homedir(), '.ssh')
  return [join(ssh, 'known_hosts'), join(ssh, 'known_hosts2')]
}

/** Decide whether the key presented by host:port may be trusted. */
export function verifyHostKey(host: string, port: number, blob: Buffer, options: HostKeyVerifierOptions = {}): HostKeyVerdict {
  const keyType = keyTypeOf(blob)
  const fingerprint = fingerprintOf(blob)
  const read = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const others: TrustedHostKey[] = []
  let revoked = false
  let knownHostsMatch = false
  for (const file of options.knownHostsFiles ?? defaultKnownHostsFiles()) {
    let content: string
    try {
      content = read(file)
    } catch {
      continue
    }
    const result = lookupKnownHosts(content, host, port, blob)
    if (result.revoked) revoked = true
    if (result.match) knownHostsMatch = true
    others.push(...result.others)
  }
  const info = (changed: boolean, previous?: TrustedHostKey): SshHostKeyInfo => ({
    host: host.trim(),
    port,
    keyType,
    fingerprint,
    changed,
    ...(previous ? { previousFingerprint: previous.fingerprint } : {}),
  })
  if (revoked) return { status: 'untrusted', info: info(true), revoked: true }
  if (knownHostsMatch) return { status: 'trusted' }

  const trusted = options.trusted?.trusted(host, port) ?? []
  if (trusted.some((k) => k.fingerprint === fingerprint)) return { status: 'trusted' }
  const previous = trusted[0] ?? others[0]
  return { status: 'untrusted', info: info(previous !== undefined, previous) }
}

const DEFAULT_HOST_KEY_ALGORITHMS = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
]

/**
 * Host key algorithms with the types already trusted for this host first (as OpenSSH does), so a server
 * with several keys presents the one the user knows instead of triggering a "key changed" warning.
 */
export function preferredHostKeyAlgorithms(knownTypes: string[]): string[] {
  const first: string[] = []
  for (const type of knownTypes) {
    const algorithms = type === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : [type]
    for (const a of algorithms) if (DEFAULT_HOST_KEY_ALGORITHMS.includes(a) && !first.includes(a)) first.push(a)
  }
  return [...first, ...DEFAULT_HOST_KEY_ALGORITHMS.filter((a) => !first.includes(a))]
}

/** Key types known for host:port (known_hosts + trusted store), for preferredHostKeyAlgorithms. */
export function knownKeyTypes(host: string, port: number, options: HostKeyVerifierOptions = {}): string[] {
  const read = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const types: string[] = []
  const names = [knownHostsName(host, port)]
  for (const file of options.knownHostsFiles ?? defaultKnownHostsFiles()) {
    let content: string
    try {
      content = read(file)
    } catch {
      continue
    }
    for (const rawLine of content.split(/\r?\n/)) {
      const fields = rawLine.trim().split(/\s+/)
      if (fields.length < 3 || fields[0].startsWith('#') || fields[0].startsWith('@')) continue
      if (hostFieldMatches(fields[0], names) && !types.includes(fields[1])) types.push(fields[1])
    }
  }
  for (const k of options.trusted?.trusted(host, port) ?? []) if (!types.includes(k.keyType)) types.push(k.keyType)
  return types
}
