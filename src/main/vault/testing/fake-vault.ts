// In-process fake Vault HTTP server for unit tests (node:http on port 0). Not bundled: only tests import it.
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeRequest {
  method: string
  /** Path after /v1/ (no query string). */
  path: string
  query: URLSearchParams
  headers: http.IncomingHttpHeaders
  token: string | undefined
  namespace: string | undefined
  body: Record<string, unknown> | null
}

export interface FakeReply {
  status?: number
  body?: unknown
  /** Raw text instead of JSON. */
  raw?: string
  /** Never answer (timeouts). */
  hang?: boolean
}

export type FakeHandler = (req: FakeRequest) => FakeReply | Promise<FakeReply>

export class FakeVault {
  readonly requests: FakeRequest[] = []
  private readonly routes = new Map<string, FakeHandler>()
  private readonly server: http.Server
  address = ''

  private constructor() {
    this.server = http.createServer((req, res) => void this.handle(req, res))
  }

  static async start(): Promise<FakeVault> {
    const vault = new FakeVault()
    await new Promise<void>((resolve) => vault.server.listen(0, '127.0.0.1', () => resolve()))
    vault.address = `http://127.0.0.1:${(vault.server.address() as AddressInfo).port}`
    return vault
  }

  on(method: string, path: string, handler: FakeHandler | FakeReply): this {
    this.routes.set(`${method} ${path}`, typeof handler === 'function' ? handler : () => handler)
    return this
  }

  calls(method: string, path: string): FakeRequest[] {
    return this.requests.filter((r) => r.method === method && r.path === path)
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url ?? '/', 'http://fake')
    const path = url.pathname.replace(/^\/v1\//, '')
    let body: Record<string, unknown> | null = null
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : null
    } catch {
      body = null
    }
    const header = (name: string) => {
      const value = req.headers[name]
      return typeof value === 'string' ? value : undefined
    }
    const request: FakeRequest = {
      method: req.method ?? 'GET',
      path,
      query: url.searchParams,
      headers: req.headers,
      token: header('x-vault-token'),
      namespace: header('x-vault-namespace'),
      body,
    }
    this.requests.push(request)
    const handler = this.routes.get(`${request.method} ${path}`)
    const reply: FakeReply = handler ? await handler(request) : { status: 404, body: { errors: [] } }
    if (reply.hang) return
    const status = reply.status ?? 200
    if (reply.raw !== undefined) {
      res.writeHead(status, { 'Content-Type': 'text/plain' })
      res.end(reply.raw)
      return
    }
    if (reply.body === undefined) {
      res.writeHead(status === 200 ? 204 : status)
      res.end()
      return
    }
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(reply.body))
  }
}

/** A lookup-self answer. */
export function lookupSelf(ttl = 3600, renewable = true): FakeReply {
  return { body: { data: { ttl, renewable, policies: ['default'] } } }
}

/** A login answer (auth block). */
export function loginReply(token: string, leaseDuration = 3600, renewable = true): FakeReply {
  return { body: { auth: { client_token: token, lease_duration: leaseDuration, renewable, policies: ['default'] } } }
}

/** A database secrets engine answer. */
export function dynamicCreds(username: string, password: string, leaseId: string, leaseDuration = 3600, renewable = true): FakeReply {
  return { body: { lease_id: leaseId, lease_duration: leaseDuration, renewable, data: { username, password } } }
}

/** Accept only this token, 403 otherwise. */
export function requireToken(token: string, reply: FakeReply | (() => FakeReply)): FakeHandler {
  return (req) => (req.token === token ? (typeof reply === 'function' ? reply() : reply) : { status: 403, body: { errors: ['permission denied'] } })
}

/** A free TCP port on 127.0.0.1 (for the OIDC callback server). */
export async function freePort(): Promise<number> {
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
