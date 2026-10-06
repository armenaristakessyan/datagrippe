import { describe, expect, it } from 'vitest'
import { environmentVaultSettings } from './config'
import { roleOf, suggestionRows } from './SecretPathSuggest'

describe('SecretPathSuggest helpers', () => {
  it('takes the role from the current path', () => {
    expect(roleOf('gcp/prod/data/acme/server/creds/reporting')).toBe('reporting')
    expect(roleOf('')).toBe('read_only')
    expect(roleOf('database/creds/../x')).toBe('read_only')
  })

  it('lists the ranked mounts first, the suggestion marked, then every other mount', () => {
    const rows = suggestionRows(
      {
        mounts: [{ path: 'a', type: 'database' }, { path: 'b', type: 'database' }, { path: 'c', type: 'database' }],
        suggestions: [{ key: 'self', path: 'b/creds/read_only', mount: 'b', score: 0.9, reason: 'shares "b"' }],
        ranking: { self: [{ mount: 'b', path: 'b/creds/read_only', score: 0.9 }, { mount: 'a', path: 'a/creds/read_only', score: 0.2 }] },
        warnings: [],
      },
      'self',
    )
    expect(rows).toEqual([
      { mount: 'b', score: 0.9, suggested: true, reason: 'shares "b"' },
      { mount: 'a', score: 0.2, suggested: false, reason: undefined },
      { mount: 'c', suggested: false },
    ])
  })

  it('turns the vault CLI environment into the settings of a new Vault connection', () => {
    expect(environmentVaultSettings({ source: 'login-shell', address: 'https://vault.example.shared', namespace: 'team', cliTokenFile: false })).toEqual({
      address: 'https://vault.example.shared',
      namespace: 'team',
      loginMethod: 'token',
      oidcFallback: true,
    })
    expect(environmentVaultSettings({ source: 'none', cliTokenFile: false })).toBeNull()
    expect(environmentVaultSettings(null)).toBeNull()
  })
})
