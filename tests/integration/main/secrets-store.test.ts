// secrets.json must not lose encrypted passwords it could not decrypt in this run (keychain access
// denied once, safeStorage key temporarily unavailable…): the next save rewrites the file without them.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SecretStore } from '../../../src/main/store/secrets'
import { createHarness, crypto, quiet } from './harness'

const h = createHarness()
afterAll(() => h.dispose())

describe('SecretStore', () => {
  it('keeps entries it cannot decrypt when another connection saves a secret', () => {
    const first = new SecretStore(h.dir, crypto, quiet)
    first.setStored('prod', { password: 'prod-password' })
    first.setStored('staging', { password: 'staging-password' })
    first.flush()

    // Next launch: decryption fails (e.g. the user clicked "Deny" on the keychain prompt).
    const failing = {
      isEncryptionAvailable: () => true,
      encryptString: crypto.encryptString,
      decryptString: () => {
        throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      },
    }
    const second = new SecretStore(h.dir, failing, quiet)
    second.setStored('new-connection', { password: 'x' })
    second.flush()

    const onDisk = JSON.parse(readFileSync(join(h.dir, 'secrets.json'), 'utf8')) as Record<string, string>
    expect(Object.keys(onDisk).sort()).toEqual(['new-connection', 'prod', 'staging'])
  })
})
