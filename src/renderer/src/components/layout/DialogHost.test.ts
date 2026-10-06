import { describe, expect, it } from 'vitest'
import type { VaultConfig } from '@shared/types'
import { secretPromptCopy } from './DialogHost'

const vault: VaultConfig = { address: 'https://vault.example.com', loginMethod: 'ldap', username: 'jane', secretPath: 'database/creds/ro' }

describe('secret prompt copy', () => {
  it('asks the database password by default', () => {
    expect(secretPromptCopy('password', {}, true)).toMatchObject({ title: 'Password required', label: 'Password' })
    expect(secretPromptCopy('password', {}, false).description).toContain('in memory')
  })

  it('names the Vault user and server for the Vault password', () => {
    expect(secretPromptCopy('vaultPassword', { vault })).toMatchObject({
      title: 'Vault password',
      description: 'For jane on https://vault.example.com.',
      label: 'Vault password',
    })
  })

  it('says whether a Vault secret is stored or kept in memory, like the database password', () => {
    expect(secretPromptCopy('vaultPassword', { vault }, true).description).toBe('For jane on https://vault.example.com. It will be stored encrypted for next time.')
    expect(secretPromptCopy('vaultPassword', { vault }, false).description).toContain('kept in memory until you quit')
    expect(secretPromptCopy('vaultToken', { vault }, false).description).toBe('Paste a token for https://vault.example.com. It is kept in memory until you quit DataGrippe.')
    expect(secretPromptCopy('password', {}).description).toContain('in memory')
  })

  it('asks for a token with a hint to run vault login', () => {
    const copy = secretPromptCopy('vaultToken', { vault })
    expect(copy.title).toBe('Vault token')
    expect(copy.description).toContain('https://vault.example.com')
    expect(copy.hint).toContain('vault login')
  })
})
