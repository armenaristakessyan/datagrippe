// SSH tunnels must verify the server's host key: otherwise anyone able to intercept the SSH
// connection (DNS spoofing, rogue Wi-Fi, ARP) impersonates the bastion and receives the SSH
// password and every forwarded database byte (including the DB password).
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import ssh2 from 'ssh2'
import type { ConnectionConfig } from '@shared/types'
import { openTunnel, type Tunnel } from '../../../src/main/db/tunnel'

const { Server, utils } = ssh2

describe('SSH tunnel host key verification', () => {
  let server: InstanceType<typeof Server>
  let port = 0
  const received: string[] = []

  beforeAll(async () => {
    // A brand-new, never-seen host key: an impostor bastion.
    const key = utils.generateKeyPairSync('ed25519')
    server = new Server({ hostKeys: [key.private] }, (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password') {
          received.push(ctx.password)
          ctx.accept()
        } else ctx.reject(['password'])
      })
      client.on('error', () => undefined)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as AddressInfo).port
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('refuses an unknown / changed host key instead of sending the SSH password to it', async () => {
    const config = {
      host: 'db.internal',
      port: 5432,
      ssh: { enabled: true, host: '127.0.0.1', port, username: 'deploy', authMethod: 'password' },
      options: { connectTimeoutMs: 5000 },
    } as unknown as ConnectionConfig
    let tunnel: Tunnel | undefined
    try {
      tunnel = await openTunnel(config, { sshPassword: 'bastion-secret' }, { log: { warn: () => undefined, error: () => undefined } })
    } catch {
      // expected: host key not trusted
    } finally {
      await tunnel?.close()
    }
    expect(received).not.toContain('bastion-secret')
    expect(tunnel).toBeUndefined()
  })
})
