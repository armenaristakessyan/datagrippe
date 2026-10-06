import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DriverError } from '../db/errors'
import { describeHttpError, isPermissionDenied, normalizeVaultAddress, redactSecrets, VaultClient, VaultError } from './client'
import { FakeVault, freePort } from './testing/fake-vault'

async function failure(promise: Promise<unknown>): Promise<DriverError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(DriverError)
    return error as DriverError
  }
  throw new Error('expected a failure')
}

describe('normalizeVaultAddress', () => {
  it('keeps scheme + host + port + path prefix, drops trailing slashes and /v1', () => {
    expect(normalizeVaultAddress(' https://vault.example.cloud/ ')).toBe('https://vault.example.cloud')
    expect(normalizeVaultAddress('https://vault.example.cloud:8200///')).toBe('https://vault.example.cloud:8200')
    expect(normalizeVaultAddress('http://127.0.0.1:8200/v1/')).toBe('http://127.0.0.1:8200')
    expect(normalizeVaultAddress('https://gw.example.internal/vault/')).toBe('https://gw.example.internal/vault')
    expect(normalizeVaultAddress('HTTPS://Vault.Example.cloud')).toBe('https://vault.example.cloud')
  })

  it('rejects a missing scheme, other schemes, credentials and queries', () => {
    for (const bad of ['', 'vault.example.cloud', 'ftp://vault.example.cloud', 'https://user:pw@vault.example.cloud', 'https://vault.example.cloud/?x=1', 'https://']) {
      const error = (() => {
        try {
          normalizeVaultAddress(bad)
        } catch (e) {
          return e as DriverError
        }
        return null
      })()
      expect(error, bad).toBeInstanceOf(DriverError)
      expect(error?.info.kind).toBe('invalid-input')
    }
  })

  it('drops a web UI path copied from the browser (the API is never under /ui)', () => {
    expect(normalizeVaultAddress('https://vault.example.cloud/ui/')).toBe('https://vault.example.cloud')
    expect(normalizeVaultAddress('https://vault.example.cloud/ui/vault/secrets')).toBe('https://vault.example.cloud')
    expect(normalizeVaultAddress('https://gw.example.internal/vault/ui/vault/auth?')).toBe('https://gw.example.internal/vault')
    expect(normalizeVaultAddress('https://vault.example.cloud/build')).toBe('https://vault.example.cloud/build')
  })

  it('allows plain http only on this machine', () => {
    for (const ok of ['http://127.0.0.1:8200', 'http://localhost:8200', 'http://[::1]:8200', 'http://vault.localhost', 'http://127.1.2.3']) {
      expect(() => normalizeVaultAddress(ok), ok).not.toThrow()
    }
    for (const bad of ['http://vault.example.internal:8200', 'http://10.0.0.5:8200', 'http://localhost.example.cloud']) {
      expect(() => normalizeVaultAddress(bad), bad).toThrow(/Use https:\/\/ for a remote Vault server/)
    }
  })
})

describe('describeHttpError / redactSecrets', () => {
  it('maps statuses to short messages', () => {
    expect(describeHttpError(403, 'database/creds/ro', 'https://v', '')).toBe('Vault: permission denied on database/creds/ro (403)')
    expect(describeHttpError(503, 'x', 'https://v', 'Vault is sealed')).toBe('Vault at https://v is sealed (503)')
    expect(describeHttpError(404, 'kv/x', 'https://v', '')).toBe('Vault: nothing found at kv/x (404)')
    expect(describeHttpError(400, 'auth/x', 'https://v', 'missing role')).toBe('Vault: auth/x rejected the request (400): missing role')
  })

  it('redacts every secret value', () => {
    expect(redactSecrets('token s.abcdef leaked twice s.abcdef', ['s.abcdef'])).toBe('token *** leaked twice ***')
    expect(redactSecrets('short ab', ['ab'])).toBe('short ab')
  })
})

describe('VaultClient', () => {
  let vault: FakeVault

  beforeEach(async () => {
    vault = await FakeVault.start()
  })
  afterEach(async () => vault.close())

  it('sends JSON with the token and namespace headers on /v1/<path>', async () => {
    vault.on('POST', 'auth/userpass/login/alice', (req) => ({ body: { auth: { client_token: 't' }, echo: req.body } }))
    const client = new VaultClient({ address: `${vault.address}/`, namespace: '/team-a/' })
    const response = await client.request('POST', '/auth/userpass/login/alice', { token: 'tok-1234', body: { password: 'pw-secret' } })
    expect(response.status).toBe(200)
    const [req] = vault.requests
    expect(req.token).toBe('tok-1234')
    expect(req.namespace).toBe('team-a')
    expect(req.headers['content-type']).toBe('application/json')
    expect(req.body).toEqual({ password: 'pw-secret' })
  })

  it('accepts empty (204) answers', async () => {
    vault.on('PUT', 'sys/leases/revoke', { status: 204 })
    const response = await new VaultClient({ address: vault.address }).request('PUT', 'sys/leases/revoke', { token: 't', body: { lease_id: 'x' } })
    expect(response.body).toBeNull()
  })

  it('maps HTTP errors to kind vault with the status as code, never echoing secrets', async () => {
    vault.on('GET', 'database/creds/ro', { status: 403, body: { errors: ['permission denied'] } })
    vault.on('POST', 'auth/userpass/login/bob', { status: 400, body: { errors: ['invalid password "hunter2-pw" for token tok-secret-1'] } })
    vault.on('GET', 'sys/x', { status: 503, body: { errors: ['Vault is sealed'] } })
    const client = new VaultClient({ address: vault.address })

    const denied = await failure(client.request('GET', 'database/creds/ro', { token: 'tok-secret-1' }))
    expect(denied.info).toMatchObject({ kind: 'vault', code: '403', message: 'Vault: permission denied on database/creds/ro (403)' })
    expect(isPermissionDenied(denied)).toBe(true)

    const rejected = await failure(client.request('POST', 'auth/userpass/login/bob', { token: 'tok-secret-1', body: { password: 'hunter2-pw' } }))
    expect(rejected.message).not.toContain('hunter2-pw')
    expect(rejected.message).not.toContain('tok-secret-1')
    expect(rejected.message).toContain('***')

    const sealed = await failure(client.request('GET', 'sys/x'))
    expect(sealed.message).toBe(`Vault at ${vault.address} is sealed (503)`)
  })

  it('never puts query strings (OIDC codes) in messages', async () => {
    vault.on('GET', 'auth/oidc/oidc/callback', { status: 400, body: { errors: ['bad code'] } })
    const error = await failure(new VaultClient({ address: vault.address }).request('GET', 'auth/oidc/oidc/callback', { query: { code: 'secret-code-123', state: 'st' } }))
    expect(error.message).toBe('Vault: auth/oidc/oidc/callback rejected the request (400): bad code')
    expect(vault.requests[0].query.get('code')).toBe('secret-code-123')
  })

  it('reports invalid JSON', async () => {
    vault.on('GET', 'kv/app', { raw: '<html>proxy login</html>' })
    const error = await failure(new VaultClient({ address: vault.address }).request('GET', 'kv/app'))
    expect(error.info.kind).toBe('vault')
    expect(error.message).toMatch(/invalid JSON response from kv\/app/)
  })

  it('reports an unreachable address', async () => {
    const port = await freePort()
    const error = await failure(new VaultClient({ address: `http://127.0.0.1:${port}` }).request('GET', 'sys/health'))
    expect(error.info.kind).toBe('vault')
    expect(error.message).toBe(`Vault: cannot reach http://127.0.0.1:${port} (connection refused)`)
    expect((error as VaultError).failure).toBe('network')
  })

  it('times out', async () => {
    vault.on('GET', 'slow', { hang: true })
    const error = await failure(new VaultClient({ address: vault.address, timeoutMs: 150 }).request('GET', 'slow'))
    expect(error.message).toBe(`Vault: ${vault.address} did not answer within 150 ms`)
    expect((error as VaultError).failure).toBe('timeout')
  })

  it('honours abort signals', async () => {
    vault.on('GET', 'slow', { hang: true })
    const controller = new AbortController()
    const pending = new VaultClient({ address: vault.address }).request('GET', 'slow', { signal: controller.signal })
    setTimeout(() => controller.abort(), 30)
    const error = await failure(pending)
    expect(error.info.kind).toBe('cancelled')
    const already = await failure(new VaultClient({ address: vault.address }).request('GET', 'slow', { signal: controller.signal }))
    expect(already.info.kind).toBe('cancelled')
  })

  it('reports an unreadable CA bundle', async () => {
    const error = await failure(new VaultClient({ address: 'https://vault.example.internal', caPath: '/nonexistent/ca.pem' }).request('GET', 'sys/health'))
    expect(error.message).toBe('Vault: cannot read the CA certificate /nonexistent/ca.pem (ENOENT)')
  })

  it('reports TLS failures on an http server spoken to with https', async () => {
    const server = http.createServer((_req, res) => res.end('{}'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port
    try {
      const error = await failure(new VaultClient({ address: `https://127.0.0.1:${port}` }).request('GET', 'sys/health'))
      expect(error.info.kind).toBe('vault')
      expect(error.message).toMatch(/TLS|cannot reach|closed the connection/)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
