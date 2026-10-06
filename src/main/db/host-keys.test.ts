import { createHash, createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fingerprintOf, hostFieldMatches, keyTypeOf, knownHostsName, knownKeyTypes, lookupKnownHosts, preferredHostKeyAlgorithms, verifyHostKey } from './host-keys'

/** SSH wire-format public key blob: string(type) + payload. */
function blob(type: string, payload = randomBytes(32)): Buffer {
  const t = Buffer.from(type, 'latin1')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(t.length)
  return Buffer.concat([len, t, payload])
}

function hashed(name: string): string {
  const salt = randomBytes(20)
  return `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(name).digest('base64')}`
}

const ED = blob('ssh-ed25519')
const OTHER_ED = blob('ssh-ed25519')
const RSA = blob('ssh-rsa')
const files = (content: string) => ({ knownHostsFiles: ['/known_hosts'], readFile: () => content })

describe('host key helpers', () => {
  it('reads the key type and the OpenSSH SHA256 fingerprint', () => {
    expect(keyTypeOf(ED)).toBe('ssh-ed25519')
    expect(keyTypeOf(Buffer.from([0, 0]))).toBe('unknown')
    expect(fingerprintOf(ED)).toBe(`SHA256:${createHash('sha256').update(ED).digest('base64').replace(/=+$/, '')}`)
    expect(fingerprintOf(ED)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
  })

  it('names endpoints like OpenSSH', () => {
    expect(knownHostsName('Bastion', 22)).toBe('bastion')
    expect(knownHostsName('bastion', 2222)).toBe('[bastion]:2222')
  })

  it('matches plain, wildcard, negated and hashed host fields', () => {
    expect(hostFieldMatches('a.example,bastion', ['bastion'])).toBe(true)
    expect(hostFieldMatches('*.example', ['db.example'])).toBe(true)
    expect(hostFieldMatches('*.example,!db.example', ['db.example'])).toBe(false)
    expect(hostFieldMatches('[bastion]:2222', ['[bastion]:2222'])).toBe(true)
    expect(hostFieldMatches('bastion', ['[bastion]:2222'])).toBe(false)
    expect(hostFieldMatches(hashed('bastion'), ['bastion'])).toBe(true)
    expect(hostFieldMatches(hashed('other'), ['bastion'])).toBe(false)
  })

  it('looks keys up in known_hosts content', () => {
    const content = [
      '# comment',
      `bastion ssh-ed25519 ${ED.toString('base64')} me@laptop`,
      `@cert-authority * ssh-rsa ${RSA.toString('base64')}`,
      `@revoked bastion ssh-rsa ${RSA.toString('base64')}`,
    ].join('\n')
    expect(lookupKnownHosts(content, 'bastion', 22, ED)).toMatchObject({ match: true, revoked: false })
    expect(lookupKnownHosts(content, 'bastion', 22, RSA)).toMatchObject({ match: false, revoked: true })
    expect(lookupKnownHosts(content, 'bastion', 22, OTHER_ED)).toMatchObject({ match: false, others: [{ keyType: 'ssh-ed25519', fingerprint: fingerprintOf(ED) }] })
  })
})

describe('verifyHostKey', () => {
  it('trusts keys listed in known_hosts (plain or hashed)', () => {
    expect(verifyHostKey('bastion', 22, ED, files(`bastion ssh-ed25519 ${ED.toString('base64')}`))).toEqual({ status: 'trusted' })
    expect(verifyHostKey('bastion', 2222, ED, files(`${hashed('[bastion]:2222')} ssh-ed25519 ${ED.toString('base64')}`))).toEqual({ status: 'trusted' })
  })

  it('refuses unknown hosts with the fingerprint to confirm', () => {
    const verdict = verifyHostKey('bastion', 22, ED, files(''))
    expect(verdict).toEqual({
      status: 'untrusted',
      info: { host: 'bastion', port: 22, keyType: 'ssh-ed25519', fingerprint: fingerprintOf(ED), changed: false },
    })
  })

  it('reports a changed key (known_hosts or trusted store)', () => {
    const fromKnownHosts = verifyHostKey('bastion', 22, OTHER_ED, files(`bastion ssh-ed25519 ${ED.toString('base64')}`))
    expect(fromKnownHosts).toMatchObject({ status: 'untrusted', info: { changed: true, previousFingerprint: fingerprintOf(ED) } })
    const trusted = { trusted: { trusted: () => [{ keyType: 'ssh-ed25519', fingerprint: fingerprintOf(ED) }] } }
    expect(verifyHostKey('bastion', 22, ED, { ...files(''), ...trusted })).toEqual({ status: 'trusted' })
    expect(verifyHostKey('bastion', 22, OTHER_ED, { ...files(''), ...trusted })).toMatchObject({ status: 'untrusted', info: { changed: true } })
  })

  it('refuses revoked keys even when trusted', () => {
    const trusted = { trusted: { trusted: () => [{ keyType: 'ssh-rsa', fingerprint: fingerprintOf(RSA) }] } }
    expect(verifyHostKey('bastion', 22, RSA, { ...files(`@revoked * ssh-rsa ${RSA.toString('base64')}`), ...trusted })).toMatchObject({
      status: 'untrusted',
      revoked: true,
    })
  })

  it('ignores unreadable known_hosts files', () => {
    const verdict = verifyHostKey('bastion', 22, ED, {
      knownHostsFiles: ['/missing'],
      readFile: () => {
        throw new Error('ENOENT')
      },
    })
    expect(verdict.status).toBe('untrusted')
  })
})

describe('preferredHostKeyAlgorithms', () => {
  it('puts the known key types first', () => {
    expect(preferredHostKeyAlgorithms([])[0]).toBe('ssh-ed25519')
    expect(preferredHostKeyAlgorithms(['ssh-rsa']).slice(0, 3)).toEqual(['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'])
    expect(preferredHostKeyAlgorithms(['ecdsa-sha2-nistp256'])[0]).toBe('ecdsa-sha2-nistp256')
    expect(new Set(preferredHostKeyAlgorithms(['ssh-rsa'])).size).toBe(7)
    expect(knownKeyTypes('bastion', 22, { ...files(`bastion ssh-rsa ${RSA.toString('base64')}`), trusted: { trusted: () => [{ keyType: 'ssh-ed25519', fingerprint: 'x' }] } })).toEqual([
      'ssh-rsa',
      'ssh-ed25519',
    ])
  })
})
