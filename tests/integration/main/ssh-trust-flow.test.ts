// SSH host keys end to end with a real ssh2 server: unknown key refused before authentication, trusted
// after confirmation (ssh:trustHostKey), a changed key refused again, known_hosts honoured.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import ssh2 from 'ssh2'
import type { ConnectionConfig, DbErrorInfo } from '@shared/types'
import { DriverError } from '../../../src/main/db/errors'
import { openTunnel } from '../../../src/main/db/tunnel'
import { HostKeyStore } from '../../../src/main/store/host-keys'

const { Server, utils } = ssh2
const quiet = { warn: () => undefined, error: () => undefined }

interface Bastion {
  port: number
  publicKey: Buffer
  passwords: string[]
  close(): Promise<void>
}

async function bastion(port = 0): Promise<Bastion> {
  const key = utils.generateKeyPairSync('ed25519')
  const passwords: string[] = []
  const server = new Server({ hostKeys: [key.private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') {
        passwords.push(ctx.password)
        ctx.accept()
      } else ctx.reject(['password'])
    })
    client.on('error', () => undefined)
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()))
  const parsed = utils.parseKey(key.public)
  if (parsed instanceof Error) throw parsed
  const publicKey = (Array.isArray(parsed) ? parsed[0] : parsed).getPublicSSH()
  return {
    port: (server.address() as AddressInfo).port,
    publicKey,
    passwords,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function config(port: number): ConnectionConfig {
  return {
    host: 'db.internal',
    port: 5432,
    ssh: { enabled: true, host: '127.0.0.1', port, username: 'deploy', authMethod: 'password' },
    options: { connectTimeoutMs: 5000 },
  } as unknown as ConnectionConfig
}

async function refusal(promise: Promise<unknown>): Promise<DbErrorInfo> {
  try {
    const tunnel = (await promise) as { close(): Promise<void> }
    await tunnel.close()
  } catch (error) {
    if (error instanceof DriverError) return error.info
    throw error
  }
  throw new Error('expected the tunnel to be refused')
}

describe('SSH host key trust flow', () => {
  let dir: string
  let store: HostKeyStore
  const noKnownHosts = { knownHostsFiles: [] as string[] }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dg-ssh-'))
    store = new HostKeyStore(dir, { log: quiet })
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('asks to confirm an unknown key, then connects once it is trusted, and refuses a changed key', async () => {
    const first = await bastion()
    const hostKeys = { ...noKnownHosts, trusted: store }
    const unknown = await refusal(openTunnel(config(first.port), { sshPassword: 'bastion-secret' }, { log: quiet, hostKeys }))
    expect(unknown).toMatchObject({ kind: 'needs-host-key', hostKey: { host: '127.0.0.1', port: first.port, keyType: 'ssh-ed25519', changed: false } })
    expect(unknown.hostKey?.fingerprint).toMatch(/^SHA256:/)
    expect(first.passwords).toEqual([])

    store.trust(unknown.hostKey!)
    const tunnel = await openTunnel(config(first.port), { sshPassword: 'bastion-secret' }, { log: quiet, hostKeys })
    expect(first.passwords).toEqual(['bastion-secret'])
    await tunnel.close()
    await first.close()

    // Same endpoint, another key: an impostor (or a rebuilt server) must be confirmed again.
    const impostor = await bastion(first.port)
    const changed = await refusal(openTunnel(config(first.port), { sshPassword: 'bastion-secret' }, { log: quiet, hostKeys }))
    expect(changed).toMatchObject({ kind: 'needs-host-key', hostKey: { changed: true, previousFingerprint: unknown.hostKey!.fingerprint } })
    expect(changed.message).toMatch(/changed/)
    expect(impostor.passwords).toEqual([])
    await impostor.close()
  })

  it('trusts keys listed in known_hosts', async () => {
    const server = await bastion()
    const knownHosts = join(dir, 'known_hosts')
    writeFileSync(knownHosts, `[127.0.0.1]:${server.port} ssh-ed25519 ${server.publicKey.toString('base64')}\n`)
    const tunnel = await openTunnel(config(server.port), { sshPassword: 'pw' }, { log: quiet, hostKeys: { knownHostsFiles: [knownHosts] } })
    expect(server.passwords).toEqual(['pw'])
    await tunnel.close()
    await server.close()
  })
})
