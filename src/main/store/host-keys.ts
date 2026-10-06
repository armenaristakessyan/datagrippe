// ssh-host-keys.json — SSH host keys the user trusted after checking their fingerprint (trust on first
// use). ~/.ssh/known_hosts is consulted first and never written.
import { join } from 'node:path'
import type { SshHostKeyInfo } from '@shared/types'
import type { TrustedHostKey, TrustedHostKeySource } from '../db/host-keys'
import { isRecord, JsonFile } from './json-file'

interface StoredHostKey extends TrustedHostKey {
  addedAt: string
}

type HostKeysFile = Record<string, StoredHostKey[]>

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/

function endpointKey(host: string, port: number): string {
  return `${host.trim().toLowerCase()}:${port}`
}

export class HostKeyStore implements TrustedHostKeySource {
  private readonly file: JsonFile<HostKeysFile>
  private readonly now: () => Date

  constructor(baseDir: string, options: { now?: () => Date; log?: Pick<Console, 'warn' | 'error'> } = {}) {
    this.now = options.now ?? (() => new Date())
    this.file = new JsonFile<HostKeysFile>(join(baseDir, 'ssh-host-keys.json'), {
      fallback: () => ({}),
      parse: (raw) => {
        if (!isRecord(raw)) throw new Error('expected an object')
        const out: HostKeysFile = {}
        for (const [endpoint, keys] of Object.entries(raw)) {
          if (!Array.isArray(keys)) continue
          const valid = keys.filter(
            (k): k is StoredHostKey =>
              isRecord(k) && typeof k.keyType === 'string' && typeof k.fingerprint === 'string' && FINGERPRINT.test(k.fingerprint),
          )
          if (valid.length > 0) out[endpoint] = valid.map((k) => ({ keyType: k.keyType, fingerprint: k.fingerprint, addedAt: String(k.addedAt ?? '') }))
        }
        return out
      },
      log: options.log,
    })
  }

  trusted(host: string, port: number): TrustedHostKey[] {
    return (this.file.get()[endpointKey(host, port)] ?? []).map(({ keyType, fingerprint }) => ({ keyType, fingerprint }))
  }

  /** Trust a key for host:port. It replaces any key trusted before for that endpoint (the user confirmed a change). */
  trust(key: SshHostKeyInfo): void {
    if (!key.host?.trim() || !Number.isInteger(key.port) || key.port < 1 || key.port > 65535) {
      throw new Error('Invalid SSH host.')
    }
    if (!FINGERPRINT.test(key.fingerprint) || !key.keyType?.trim()) throw new Error('Invalid SSH host key fingerprint.')
    const next = { ...this.file.get() }
    next[endpointKey(key.host, key.port)] = [{ keyType: key.keyType.trim(), fingerprint: key.fingerprint, addedAt: this.now().toISOString() }]
    this.file.set(next)
  }

  forget(host: string, port: number): void {
    const next = { ...this.file.get() }
    if (!(endpointKey(host, port) in next)) return
    delete next[endpointKey(host, port)]
    this.file.set(next)
  }

  flush(): void {
    this.file.flush()
  }
}
