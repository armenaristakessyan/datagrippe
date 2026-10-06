import { EventEmitter } from 'node:events'
import { connect } from 'node:net'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { Client } from 'ssh2'
import type { ConnectionConfig } from '@shared/types'
import { buildSshConnectConfig, openTunnel, sshError } from './tunnel'

function config(ssh: Partial<ConnectionConfig['ssh']> = {}): ConnectionConfig {
  return {
    id: 'c',
    name: 'C',
    dialect: 'postgres',
    host: 'db.internal',
    port: 5432,
    database: 'app',
    user: 'me',
    savePassword: true,
    hasPassword: false,
    ssl: { mode: 'disable' },
    ssh: { enabled: true, host: 'bastion', port: 22, username: 'deploy', authMethod: 'password', ...ssh },
    color: 'none',
    readOnly: false,
    productionGuard: false,
    options: { connectTimeoutMs: 5000 },
    createdAt: '',
    updatedAt: '',
  }
}

/** ssh2 Client stand-in: `ready` (or an error) on connect, echo channels on forwardOut. */
class FakeClient extends EventEmitter {
  connectConfig: unknown
  forwards: [string, number, string, number][] = []
  ended = false
  constructor(private readonly mode: 'ready' | 'auth-fail' | 'throw') {
    super()
  }
  connect(cfg: unknown) {
    this.connectConfig = cfg
    if (this.mode === 'throw') throw new Error('Encrypted private OpenSSH key detected, but no passphrase given')
    setImmediate(() => {
      if (this.mode === 'ready') this.emit('ready')
      else this.emit('error', Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }))
    })
    return this
  }
  forwardOut(srcIP: string, srcPort: number, dstIP: string, dstPort: number, cb: (err: Error | undefined, stream: PassThrough & { close(): void }) => void) {
    this.forwards.push([srcIP, srcPort, dstIP, dstPort])
    const echo = Object.assign(new PassThrough(), { close: () => echo.destroy() })
    cb(undefined, echo)
    return this
  }
  end() {
    if (this.ended) return this
    this.ended = true
    setImmediate(() => this.emit('close'))
    return this
  }
}

const asClient = (c: FakeClient) => c as unknown as Client
const silent = { warn: vi.fn(), error: vi.fn() }

describe('buildSshConnectConfig', () => {
  it('validates required fields', () => {
    expect(() => buildSshConnectConfig(config({ enabled: false }), {})).toThrow(/not enabled/)
    expect(() => buildSshConnectConfig(config({ host: ' ' }), { sshPassword: 'x' })).toThrow(/SSH host/)
    expect(() => buildSshConnectConfig(config({ port: 0 }), { sshPassword: 'x' })).toThrow(/port/)
    expect(() => buildSshConnectConfig(config({ username: '' }), { sshPassword: 'x' })).toThrow(/SSH user/)
    expect(() => buildSshConnectConfig(config(), {})).toThrow(/SSH password is not set/)
  })

  it('builds password auth with keepalive and timeout', () => {
    expect(buildSshConnectConfig(config(), { sshPassword: 'pw' })).toEqual({
      host: 'bastion',
      port: 22,
      username: 'deploy',
      password: 'pw',
      tryKeyboard: true,
      readyTimeout: 5000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
    })
  })

  it('reads private keys (with ~ expansion) and passes the passphrase', () => {
    const readFile = vi.fn((_path: string) => Buffer.from('KEY'))
    const cfg = buildSshConnectConfig(config({ authMethod: 'privateKey', privateKeyPath: '~/.ssh/id_ed25519' }), { sshPassphrase: 'pp' }, { readFile })
    expect(readFile.mock.calls[0][0]).not.toContain('~')
    expect(cfg).toMatchObject({ privateKey: Buffer.from('KEY'), passphrase: 'pp' })
    expect(() => buildSshConnectConfig(config({ authMethod: 'privateKey' }), {})).toThrow(/key file is required/)
    const failing = () => {
      throw new Error('ENOENT: no such file')
    }
    expect(() => buildSshConnectConfig(config({ authMethod: 'privateKey', privateKeyPath: '/nope' }), {}, { readFile: failing })).toThrow(
      /Cannot read SSH private key \/nope: ENOENT/,
    )
  })

  it('uses SSH_AUTH_SOCK for agent auth', () => {
    expect(buildSshConnectConfig(config({ authMethod: 'agent' }), {}, { env: { SSH_AUTH_SOCK: '/tmp/agent' } })).toMatchObject({ agent: '/tmp/agent' })
    expect(() => buildSshConnectConfig(config({ authMethod: 'agent' }), {}, { env: {}, platform: 'darwin' })).toThrow(/SSH_AUTH_SOCK/)
    expect(buildSshConnectConfig(config({ authMethod: 'agent' }), {}, { env: {}, platform: 'win32' })).toMatchObject({ agent: 'pageant' })
  })
})

describe('sshError', () => {
  it('maps common failures to readable messages', () => {
    const c = config()
    expect(sshError(Object.assign(new Error('x'), { level: 'client-authentication' }), c).message).toBe(
      'SSH authentication failed for deploy@bastion:22.',
    )
    expect(sshError(Object.assign(new Error('x'), { level: 'client-timeout' }), c).message).toMatch(/timed out/)
    expect(sshError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), c).info).toMatchObject({ kind: 'connection', code: 'ECONNREFUSED' })
    expect(sshError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }), c).message).toBe('SSH host bastion not found.')
  })
})

describe('openTunnel', () => {
  it('surfaces authentication errors', async () => {
    const client = new FakeClient('auth-fail')
    await expect(openTunnel(config(), { sshPassword: 'pw' }, { createClient: () => asClient(client), log: silent })).rejects.toMatchObject({
      info: { kind: 'connection', message: 'SSH authentication failed for deploy@bastion:22.' },
    })
  })

  it('surfaces synchronous connect errors', async () => {
    const client = new FakeClient('throw')
    await expect(
      openTunnel(config({ authMethod: 'privateKey', privateKeyPath: '/k' }), {}, { createClient: () => asClient(client), readFile: () => Buffer.from('k'), log: silent }),
    ).rejects.toThrow(/SSH private key/)
  })

  it('forwards local sockets to the target and closes cleanly', async () => {
    const client = new FakeClient('ready')
    const tunnel = await openTunnel(config(), { sshPassword: 'pw' }, { createClient: () => asClient(client), log: silent })
    expect(tunnel.host).toBe('127.0.0.1')
    expect(tunnel.port).toBeGreaterThan(0)
    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = connect(tunnel.port, '127.0.0.1', () => socket.write('ping'))
      socket.on('data', (d) => {
        resolve(d.toString())
        socket.destroy()
      })
      socket.on('error', reject)
    })
    expect(echoed).toBe('ping')
    expect(client.forwards[0].slice(2)).toEqual(['db.internal', 5432])
    const lost = vi.fn()
    tunnel.onClose(lost)
    await tunnel.close()
    expect(client.ended).toBe(true)
    expect(lost).not.toHaveBeenCalled()
    await tunnel.close()
  })

  it('reports an unexpected SSH disconnect', async () => {
    const client = new FakeClient('ready')
    const tunnel = await openTunnel(config(), { sshPassword: 'pw' }, { createClient: () => asClient(client), log: silent })
    const lost = vi.fn()
    tunnel.onClose(lost)
    client.emit('close')
    expect(lost).toHaveBeenCalledWith('SSH connection to bastion was closed.')
    await tunnel.close()
  })
})
