import { describe, expect, it } from 'vitest'
import { DriverError } from '../db/errors'
import { authMountOf, sameVaultIdentity, validateVaultConfig, vaultIdentityKey, vaultServerKey } from './config'

function error(fn: () => unknown): DriverError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(DriverError)
    return e as DriverError
  }
  throw new Error('expected a failure')
}

describe('validateVaultConfig', () => {
  it('normalizes a valid configuration', () => {
    expect(
      validateVaultConfig({
        address: 'https://vault.example.cloud/',
        namespace: '/team/',
        loginMethod: 'oidc',
        authMount: '/sso/',
        oidcRole: ' reader ',
        username: 'ignored-for-oidc',
        secretPath: '/database/creds/ro/',
        usernameKey: ' ',
        revokeOnDisconnect: true,
        caPath: ' /etc/ca.pem ',
      }),
    ).toEqual({
      address: 'https://vault.example.cloud',
      namespace: 'team',
      loginMethod: 'oidc',
      authMount: 'sso',
      oidcRole: 'reader',
      secretPath: 'database/creds/ro',
      caPath: '/etc/ca.pem',
    })
    expect(validateVaultConfig({ address: 'http://127.0.0.1:8200', loginMethod: 'userpass', username: 'alice', secretPath: 'kv/app', revokeOnDisconnect: false })).toEqual({
      address: 'http://127.0.0.1:8200',
      loginMethod: 'userpass',
      username: 'alice',
      secretPath: 'kv/app',
      revokeOnDisconnect: false,
    })
  })

  it('rejects invalid settings with invalid-input', () => {
    const cases: [Record<string, unknown> | undefined, RegExp][] = [
      [undefined, /required/],
      [{ address: 'vault.example.cloud', loginMethod: 'token', secretPath: 'a/b' }, /https:\/\//],
      [{ address: 'https://v', loginMethod: 'kerberos', secretPath: 'a/b' }, /login method/],
      [{ address: 'https://v', loginMethod: 'token', secretPath: '' }, /secret path is required/],
      [{ address: 'https://v', loginMethod: 'token', secretPath: '/v1/database/creds/ro' }, /must not start with \/v1\//],
      [{ address: 'https://v', loginMethod: 'token', secretPath: 'database/../sys/raw' }, /invalid characters/],
      [{ address: 'https://v', loginMethod: 'token', secretPath: 'kv/app?version=1' }, /invalid characters/],
      [{ address: 'https://v', loginMethod: 'ldap', secretPath: 'a/b' }, /user name is required/],
      // Vault's own APIs would hand the token (or other secrets) back as a "user name".
      [{ address: 'https://v', loginMethod: 'token', secretPath: 'auth/token/lookup-self' }, /"auth\/…" is not a secret path/],
      [{ address: 'https://v', loginMethod: 'token', secretPath: 'SYS/policies/acl/default' }, /not a secret path/],
      [{ address: 'https://v', loginMethod: 'token', secretPath: 'identity/entity/id/x' }, /not a secret path/],
      [{ address: 'https://v', loginMethod: 'token', secretPath: 'cubbyhole/app' }, /not a secret path/],
      [{ address: 'https://v', loginMethod: 'token', secretPath: 'token' }, /not a secret path/],
      [{ address: 'https://v', loginMethod: 'token', secretPath: 'kv/app', usernameKey: 'secret', passwordKey: 'secret' }, /must differ/],
      [{ address: 'https://v', loginMethod: 'token', secretPath: 'kv/app', usernameKey: 'password' }, /must differ/],
      [{ address: 'http://vault.example.internal:8200', loginMethod: 'ldap', username: 'alice', secretPath: 'database/creds/ro' }, /Use https:\/\//],
    ]
    for (const [raw, message] of cases) {
      const e = error(() => validateVaultConfig(raw))
      expect(e.info.kind).toBe('invalid-input')
      expect(e.message).toMatch(message)
    }
  })

  it('keeps incomplete settings in lenient mode', () => {
    expect(validateVaultConfig({ address: 'vault.example.cloud', loginMethod: 'ldap', secretPath: '' }, { lenient: true })).toEqual({
      address: 'vault.example.cloud',
      loginMethod: 'ldap',
      secretPath: '',
    })
    expect(validateVaultConfig(null, { lenient: true })).toEqual({ address: '', loginMethod: 'token', secretPath: '' })
  })
})

describe('identity keys', () => {
  it('groups by server, namespace, method, mount and role / user', () => {
    const a = { address: 'https://Vault.example.cloud/', loginMethod: 'oidc' as const, secretPath: 'x/y' }
    expect(authMountOf(a)).toBe('oidc')
    expect(authMountOf({ ...a, loginMethod: 'token' })).toBe('')
    expect(vaultServerKey('https://vault.example.cloud', '/ns/')).toBe('https://vault.example.cloud|ns')
    expect(vaultIdentityKey(a)).toBe(vaultIdentityKey({ ...a, address: 'https://vault.example.cloud', secretPath: 'other/path' }))
    expect(sameVaultIdentity(a, { ...a, oidcRole: 'admin' })).toBe(false)
    expect(sameVaultIdentity(a, { ...a, address: 'https://evil.example.cloud' })).toBe(false)
    expect(sameVaultIdentity(a, undefined)).toBe(false)
  })
})
