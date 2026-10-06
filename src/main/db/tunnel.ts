// SSH local port forwarding: a 127.0.0.1:<random> listener whose sockets are forwarded through the
// SSH server to config.host:config.port. Drivers then dial the local end.
import { readFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { Client, type ConnectConfig, type ServerHostKeyAlgorithm } from 'ssh2'
import type { ConnectionConfig, ConnectionSecrets } from '@shared/types'
import { DriverError } from './errors'
import { knownKeyTypes, preferredHostKeyAlgorithms, verifyHostKey, type HostKeyVerdict, type HostKeyVerifierOptions } from './host-keys'
import { assertHostAllowed } from '../automation-guard'

export interface Tunnel {
  host: '127.0.0.1'
  port: number
  /** Stop listening, drop forwarded sockets and end the SSH connection. Idempotent. */
  close(): Promise<void>
  /** Called once when the SSH connection drops on its own (not after close()). */
  onClose(listener: (reason: string) => void): void
}

export interface TunnelDeps {
  createClient?: () => Client
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  readFile?: (path: string) => Buffer
  log?: Pick<Console, 'warn' | 'error'>
  /** Host key verification (known_hosts files, keys trusted by the user). Unknown keys are always refused. */
  hostKeys?: HostKeyVerifierOptions
}

const KEEPALIVE_INTERVAL_MS = 10_000
const KEEPALIVE_COUNT_MAX = 3
const CLOSE_TIMEOUT_MS = 2_000

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path
}

/** Validate the SSH settings and build the ssh2 config. Throws DriverError('invalid-input'). */
export function buildSshConnectConfig(config: ConnectionConfig, secrets: ConnectionSecrets, deps: TunnelDeps = {}): ConnectConfig {
  const ssh = config.ssh
  if (!ssh?.enabled) throw DriverError.of('invalid-input', 'SSH tunnel is not enabled for this connection.')
  if (!ssh.host?.trim()) throw DriverError.of('invalid-input', 'SSH host is required.')
  if (!Number.isInteger(ssh.port) || ssh.port < 1 || ssh.port > 65535) {
    throw DriverError.of('invalid-input', 'SSH port must be a number between 1 and 65535.')
  }
  if (!ssh.username?.trim()) throw DriverError.of('invalid-input', 'SSH user is required.')

  const base: ConnectConfig = {
    host: ssh.host.trim(),
    port: ssh.port,
    username: ssh.username.trim(),
    readyTimeout: config.options?.connectTimeoutMs ?? 15_000,
    keepaliveInterval: KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: KEEPALIVE_COUNT_MAX,
  }

  switch (ssh.authMethod) {
    case 'password': {
      if (!secrets.sshPassword) throw DriverError.of('invalid-input', 'SSH password is not set.')
      return { ...base, password: secrets.sshPassword, tryKeyboard: true }
    }
    case 'privateKey': {
      const keyPath = ssh.privateKeyPath?.trim()
      if (!keyPath) throw DriverError.of('invalid-input', 'SSH private key file is required.')
      const resolved = expandHome(keyPath)
      let privateKey: Buffer
      try {
        privateKey = (deps.readFile ?? readFileSync)(resolved)
      } catch (error) {
        throw DriverError.of('invalid-input', `Cannot read SSH private key ${resolved}: ${messageOf(error)}`)
      }
      const out: ConnectConfig = { ...base, privateKey }
      if (secrets.sshPassphrase) out.passphrase = secrets.sshPassphrase
      return out
    }
    case 'agent': {
      const env = deps.env ?? process.env
      const platform = deps.platform ?? process.platform
      const agent = env.SSH_AUTH_SOCK || (platform === 'win32' ? 'pageant' : '')
      if (!agent) throw DriverError.of('invalid-input', 'SSH agent is not available (SSH_AUTH_SOCK is not set).')
      return { ...base, agent }
    }
    default:
      throw DriverError.of('invalid-input', 'Unknown SSH authentication method.')
  }
}

/** Human-friendly DriverError for ssh2 / socket failures. */
export function sshError(error: unknown, config: ConnectionConfig): DriverError {
  const e = (error instanceof Error ? error : new Error(String(error))) as Error & { level?: string; code?: string }
  const target = `${config.ssh.username}@${config.ssh.host}:${config.ssh.port}`
  let message: string
  if (e.level === 'client-authentication') message = `SSH authentication failed for ${target}.`
  else if (e.level === 'client-timeout') message = `SSH connection to ${target} timed out.`
  else if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') message = `SSH host ${config.ssh.host} not found.`
  else if (e.code === 'ECONNREFUSED') message = `SSH server ${config.ssh.host}:${config.ssh.port} refused the connection.`
  else if (/passphrase/i.test(e.message)) message = `SSH private key: ${e.message}`
  else message = `SSH: ${e.message}`
  return DriverError.of('connection', message, e.code ? { code: e.code } : {})
}

/** The refusal for a host key that is not trusted (yet). */
export function hostKeyError(verdict: Extract<HostKeyVerdict, { status: 'untrusted' }>): DriverError {
  const { info } = verdict
  const target = `${info.host}:${info.port}`
  if (verdict.revoked) {
    return DriverError.of('connection', `The SSH host key of ${target} (${info.fingerprint}) is marked as revoked in known_hosts.`)
  }
  const message = info.changed
    ? `The SSH host key of ${target} changed: it is now ${info.keyType} ${info.fingerprint}, but ${info.previousFingerprint ?? 'another key'} is trusted. Someone could be intercepting the connection — continue only if the server's key was replaced on purpose.`
    : `The authenticity of SSH host ${target} can't be established. Check that its ${info.keyType} key fingerprint is ${info.fingerprint} before trusting it.`
  return DriverError.of('needs-host-key', message, { hostKey: info })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function openTunnel(config: ConnectionConfig, secrets: ConnectionSecrets, deps: TunnelDeps = {}): Promise<Tunnel> {
  assertHostAllowed(config.ssh.host, 'SSH host')
  const credentials = buildSshConnectConfig(config, secrets, deps)
  const log = deps.log ?? console
  const client = (deps.createClient ?? (() => new Client()))()
  const sshHost = config.ssh.host.trim()
  const sshPort = config.ssh.port
  // Refuse unknown / changed host keys during key exchange, before any credential is sent.
  let refusedKey: Extract<HostKeyVerdict, { status: 'untrusted' }> | null = null
  const connectConfig: ConnectConfig = {
    ...credentials,
    algorithms: { serverHostKey: preferredHostKeyAlgorithms(knownKeyTypes(sshHost, sshPort, deps.hostKeys)) as ServerHostKeyAlgorithm[] },
    hostVerifier: (key: Buffer) => {
      const verdict = verifyHostKey(sshHost, sshPort, key, deps.hostKeys)
      if (verdict.status === 'trusted') return true
      refusedKey = verdict
      return false
    },
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      client.removeListener('ready', onReady)
      client.removeListener('error', onError)
      client.removeListener('close', onEarlyClose)
    }
    const onReady = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      client.end()
      reject(refusedKey ? hostKeyError(refusedKey) : sshError(error, config))
    }
    const onEarlyClose = () => {
      cleanup()
      reject(refusedKey ? hostKeyError(refusedKey) : DriverError.of('connection', `SSH connection to ${config.ssh.host} closed before it was ready.`))
    }
    client.on('ready', onReady)
    client.on('error', onError)
    client.on('close', onEarlyClose)
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map(() => secrets.sshPassword ?? ''))
    })
    try {
      client.connect(connectConfig)
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)))
    }
  })

  const sockets = new Set<Socket>()
  const listeners: ((reason: string) => void)[] = []
  let closed = false
  let clientClosed = false

  const server: Server = createServer((socket) => {
    if (closed) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    client.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, config.host, config.port, (error, stream) => {
      if (error) {
        log.warn(`[tunnel] forward to ${config.host}:${config.port} failed: ${error.message}`)
        socket.destroy()
        return
      }
      if (closed) {
        stream.close()
        socket.destroy()
        return
      }
      stream.on('error', () => socket.destroy())
      stream.on('close', () => socket.destroy())
      socket.on('close', () => stream.close())
      socket.pipe(stream).pipe(socket)
    })
  })

  const shutdown = () => {
    server.close()
    for (const socket of sockets) socket.destroy()
    sockets.clear()
  }

  const onLost = (reason: string) => {
    if (closed) return
    closed = true
    shutdown()
    for (const listener of listeners.splice(0)) {
      try {
        listener(reason)
      } catch (error) {
        log.error('[tunnel] onClose listener failed', error)
      }
    }
  }

  client.on('error', (error: Error) => onLost(sshError(error, config).message))
  client.on('close', () => {
    clientClosed = true
    onLost(`SSH connection to ${config.ssh.host} was closed.`)
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (error) {
    closed = true
    client.end()
    throw DriverError.of('connection', `Cannot open the local tunnel port: ${messageOf(error)}`)
  }
  server.on('error', (error) => onLost(`Local tunnel listener failed: ${error.message}`))

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    host: '127.0.0.1',
    port,
    onClose(listener) {
      if (!closed) listeners.push(listener)
    },
    async close() {
      if (!closed) {
        closed = true
        listeners.length = 0
        shutdown()
      }
      if (clientClosed) return
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS)
        timer.unref?.()
        client.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
        client.end()
      })
    },
  }
}
