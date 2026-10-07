// Host keys for the test SSH servers.
import ssh2 from 'ssh2'

const { utils } = ssh2

/**
 * A fresh ed25519 key pair. ssh2's generateKeyPairSync emits a private key that neither ssh2 nor ssh-keygen can
 * parse about once in 200 calls ("Malformed OpenSSH private key"): generate again until it parses.
 */
export function generateHostKey(): { private: string; public: string } {
  for (let attempt = 0; attempt < 20; attempt++) {
    const key = utils.generateKeyPairSync('ed25519')
    if (!(utils.parseKey(key.private) instanceof Error)) return key
  }
  throw new Error('ssh2 could not generate a parseable ed25519 key')
}
