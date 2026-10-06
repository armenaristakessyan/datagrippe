import { describe, expect, it } from 'vitest'
import { isLoopbackHost, normalizeVaultAddress, vaultAddressError, vaultSecretKeysError, vaultSecretPathError } from './config'

describe('vault config rules (same as main)', () => {
  it('refuses http:// for a remote Vault server', () => {
    expect(vaultAddressError('http://vault.example.internal:8200')).toMatch(/Use https:\/\/ for a remote Vault server/)
    expect(vaultAddressError('https://vault.example.internal:8200')).toBeUndefined()
    for (const local of ['http://127.0.0.1:58200', 'http://localhost:8200', 'http://vault.localhost', 'http://[::1]:8200']) {
      expect(vaultAddressError(local)).toBeUndefined()
    }
  })

  it('recognizes loopback hosts', () => {
    expect(isLoopbackHost('127.10.0.1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('localhost.example.cloud')).toBe(false)
    expect(isLoopbackHost('10.0.0.1')).toBe(false)
  })

  it('normalizes an address copied from the Vault web UI', () => {
    expect(normalizeVaultAddress(' https://vault.example.cloud/ui/vault/secrets ')).toBe('https://vault.example.cloud')
    expect(normalizeVaultAddress('https://gw.example.cloud/vault/ui/')).toBe('https://gw.example.cloud/vault')
    expect(normalizeVaultAddress('https://vault.example.cloud:8200/v1/')).toBe('https://vault.example.cloud:8200')
    expect(normalizeVaultAddress('https://vault.example.cloud/uidata')).toBe('https://vault.example.cloud/uidata')
    expect(normalizeVaultAddress('vault.example.cloud/')).toBe('vault.example.cloud')
  })

  it("refuses Vault's own APIs as secret paths", () => {
    for (const path of ['auth/token/lookup-self', 'sys/policies/acl', 'identity/entity', 'Cubbyhole/x', 'token']) {
      expect(vaultSecretPathError(path)).toMatch(/is not a secret path/)
    }
    expect(vaultSecretPathError('database/creds/readonly')).toBeUndefined()
    expect(vaultSecretPathError('authz/creds/readonly')).toBeUndefined()
  })

  it('needs different user name and password keys', () => {
    expect(vaultSecretKeysError('', '')).toBeUndefined()
    expect(vaultSecretKeysError('password', '')).toMatch(/must differ/)
    expect(vaultSecretKeysError('', 'username')).toMatch(/must differ/)
    expect(vaultSecretKeysError('user', 'user ')).toMatch(/must differ/)
    expect(vaultSecretKeysError('user', 'pass')).toBeUndefined()
  })
})
