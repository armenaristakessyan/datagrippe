// Minimal HashiCorp Vault HTTP API client (node:http / node:https, no dependency).
//
// - JSON requests on <address>/v1/<path>, X-Vault-Token / X-Vault-Namespace headers.
// - TLS trust: Node's bundled CAs + the OS trust store (macOS Keychain, Windows store: corporate CAs work without
//   setup) + an optional PEM bundle (VaultConfig.caPath, else VAULT_CACERT). Verification is never disabled.
// - 10 s timeout per request, abort signals.
// - Every failure becomes a DriverError of kind 'vault' with a short, clear message. Messages never contain
//   the token, request bodies (passwords) or query strings (OIDC codes): only the path and Vault's own error
//   text, with every known secret value redacted.
import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import type { DbErrorInfo } from '@shared/types'
import { DriverError } from '../db/errors'
import { assertUrlAllowed } from '../automation-guard'

export const VAULT_REQUEST_TIMEOUT_MS = 10_000
/** Vault answers are small JSON documents; anything bigger is not a Vault answer. */
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_VAULT_ERROR_CHARS = 300

/** Raw JSON body of a Vault answer (only the fields DataGrippe reads). */
export interface VaultBody {
  request_id?: string
  lease_id?: string
  lease_duration?: number
  renewable?: boolean
  data?: unknown
  auth?: VaultAuthBlock | null
  warnings?: string[] | null
  errors?: unknown
}

export interface VaultAuthBlock {
  client_token?: string
  lease_duration?: number
  renewable?: boolean
  policies?: string[]
}

export interface VaultRequestOptions {
  token?: string
  body?: Record<string, unknown>
  /** Query parameters (never shown in error messages). */
  query?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  /** More values that must never appear in an error message. */
  redact?: string[]
}

export interface VaultResponse {
  status: number
  body: VaultBody | null
}

export type VaultFailure = 'http' | 'network' | 'timeout' | 'tls' | 'json' | 'config'

/** A Vault failure: kind 'vault', `code` = HTTP status for HTTP errors. */
export class VaultError extends DriverError {
  readonly status: number | undefined
  readonly failure: VaultFailure

  constructor(message: string, failure: VaultFailure, status?: number, extra: Partial<DbErrorInfo> = {}) {
    super({ ...extra, message, kind: 'vault', ...(status !== undefined ? { code: String(status) } : {}) })
    this.name = 'VaultError'
    this.status = status
    this.failure = failure
  }
}

/** Vault refused the token or the path (403), as opposed to an unreachable or sealed server. */
export function isPermissionDenied(error: unknown): boolean {
  return error instanceof VaultError && error.failure === 'http' && error.status === 403
}

/** The token itself is unusable (expired, revoked, unknown): Vault answers 400/401/403 to a token lookup. */
export function isTokenRejected(error: unknown): boolean {
  return error instanceof VaultError && error.failure === 'http' && (error.status === 400 || error.status === 401 || error.status === 403)
}

function invalidInput(message: string): DriverError {
  return DriverError.of('invalid-input', message)
}

/**
 * Canonical Vault address: scheme + host[:port] + optional path prefix, without trailing slash or "/v1".
 * Throws DriverError('invalid-input') when it is not an http(s) URL.
 */
export function normalizeVaultAddress(raw: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) throw invalidInput('Vault address is required.')
  if (!/^https?:\/\//i.test(trimmed)) throw invalidInput('Vault address must start with https:// (or http://), e.g. https://vault.example.com.')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw invalidInput('Vault address is not a valid URL.')
  }
  if (!url.hostname) throw invalidInput('Vault address must include a host name.')
  if (url.username || url.password) throw invalidInput('Vault address must not contain a user name or password.')
  if (url.search || url.hash) throw invalidInput('Vault address must not contain a query string or fragment.')
  // Tokens, LDAP passwords and the issued database passwords would cross the network in clear.
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw invalidInput('Use https:// for a remote Vault server (http:// is only allowed on this machine).')
  }
  // An address copied from the Vault web UI ("…/ui/vault/secrets"): the API is never served under /ui.
  const path = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/ui(\/.*)?$/i, '')
    .replace(/\/v1$/i, '')
  return `${url.protocol}//${url.host}${path}`
}

/** localhost, *.localhost, 127.0.0.0/8 and ::1 (URL.hostname keeps IPv6 brackets). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
}

/** Namespace without surrounding slashes ("" when none). */
export function normalizeVaultNamespace(raw: string | undefined): string {
  return typeof raw === 'string' ? raw.trim().replace(/^\/+|\/+$/g, '') : ''
}

/** Replace every secret value (≥ 4 chars) found in `text`. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue
    out = out.split(secret).join('***')
  }
  return out
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 4) return
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out, depth + 1)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out, depth + 1)
}

function vaultErrorText(body: VaultBody | null, secrets: string[]): string {
  const errors = Array.isArray(body?.errors) ? body.errors.filter((e): e is string => typeof e === 'string' && e.trim() !== '') : []
  if (errors.length === 0) return ''
  const text = redactSecrets(errors.join('; ').replace(/\s+/g, ' ').trim(), secrets)
  return text.length > MAX_VAULT_ERROR_CHARS ? `${text.slice(0, MAX_VAULT_ERROR_CHARS)}…` : text
}

/** Short message for an HTTP error status. */
export function describeHttpError(status: number, path: string, address: string, vaultText: string): string {
  const suffix = vaultText ? `: ${vaultText}` : ''
  switch (status) {
    case 400:
      return `Vault: ${path} rejected the request (400)${suffix}`
    case 401:
      return `Vault: not authenticated for ${path} (401)${suffix}`
    case 403:
      return `Vault: permission denied on ${path} (403)`
    case 404:
      return `Vault: nothing found at ${path} (404)${suffix}`
    case 405:
      return `Vault: ${path} does not support this operation (405)${suffix}`
    case 429:
      return `Vault: too many requests to ${address} (429)`
    case 501:
      return `Vault at ${address} is not initialized (501)`
    case 503:
      return /sealed/i.test(vaultText) ? `Vault at ${address} is sealed (503)` : `Vault at ${address} is unavailable or sealed (503)${suffix}`
    default:
      return status >= 500 ? `Vault: server error on ${path} (${status})${suffix}` : `Vault: ${path} failed (${status})${suffix}`
  }
}

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
])

function networkError(error: unknown, address: string, host: string): VaultError {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : ''
  if (TLS_CODES.has(code) || /certificate/i.test(code)) {
    return new VaultError(
      `Vault: the TLS certificate of ${address} is not trusted (${code}). Trust its CA in the macOS Keychain, or set the Vault CA certificate in the connection settings (or VAULT_CACERT).`,
      'tls',
    )
  }
  if (code === 'EPROTO' || /wrong version number|ssl/i.test(String((error as Error)?.message ?? ''))) {
    return new VaultError(`Vault: TLS handshake with ${address} failed. Check the address scheme (https:// or http://).`, 'tls')
  }
  switch (code) {
    case 'ECONNREFUSED':
      return new VaultError(`Vault: cannot reach ${address} (connection refused)`, 'network')
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new VaultError(`Vault: cannot resolve ${host}. Check the address (VPN connected?).`, 'network')
    case 'ECONNRESET':
      return new VaultError(`Vault: ${address} closed the connection`, 'network')
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'ETIMEDOUT':
      return new VaultError(`Vault: cannot reach ${address} (${code}). Check the address (VPN connected?).`, 'network')
    default:
      return new VaultError(`Vault: cannot reach ${address}${code ? ` (${code})` : ''}`, 'network')
  }
}

function cancelledError(signal: AbortSignal): DriverError {
  const reason: unknown = signal.reason
  if (reason instanceof DriverError) return reason
  return DriverError.of('cancelled', 'The Vault request was cancelled.')
}

export interface VaultClientOptions {
  address: string
  namespace?: string
  caPath?: string
  /** CA bundle used when caPath is empty (VAULT_CACERT of the vault CLI's environment). */
  fallbackCaPath?: string
  timeoutMs?: number
}

let defaultCas: string[] | null = null

/**
 * Node's bundled root CAs plus the OS trust store, computed once. A private CA the machine trusts (installed in
 * the macOS Keychain by IT, like a corporate Vault's) is accepted the way the browser and the vault CLI accept it.
 */
export function defaultTrustedCas(): string[] {
  if (!defaultCas) {
    const all = new Set<string>(tls.rootCertificates)
    const read = (type: 'default' | 'system') => {
      try {
        for (const cert of tls.getCACertificates(type)) all.add(cert)
      } catch {
        // Older runtime or unreadable OS store: the bundled CAs remain.
      }
    }
    read('default')
    read('system')
    defaultCas = [...all]
  }
  return defaultCas
}

/** One https.Agent per extra CA bundle (TLS contexts are costly to rebuild for every request). */
const agents = new Map<string, https.Agent>()

function agentFor(extraCa: Buffer | undefined): https.Agent {
  // Keyed by the bundle's content: a replaced CA file gets a new TLS context.
  const pem = extraCa ? extraCa.toString('utf8') : ''
  let agent = agents.get(pem)
  if (!agent) {
    agent = new https.Agent({ ca: pem ? [...defaultTrustedCas(), pem] : defaultTrustedCas(), keepAlive: false })
    agents.set(pem, agent)
  }
  return agent
}

export class VaultClient {
  /** Normalized address (no trailing slash). */
  readonly address: string
  readonly namespace: string
  private readonly caPath: string | undefined
  /** Where caPath came from, for messages. */
  private readonly caSource: 'connection' | 'VAULT_CACERT'
  private readonly timeoutMs: number
  private ca: Buffer | undefined

  constructor(options: VaultClientOptions) {
    this.address = normalizeVaultAddress(options.address)
    this.namespace = normalizeVaultNamespace(options.namespace)
    const own = options.caPath?.trim() || undefined
    this.caPath = own ?? (options.fallbackCaPath?.trim() || undefined)
    this.caSource = own ? 'connection' : 'VAULT_CACERT'
    this.timeoutMs = options.timeoutMs ?? VAULT_REQUEST_TIMEOUT_MS
  }

  private loadCa(): Buffer | undefined {
    if (!this.caPath) return undefined
    if (!this.ca) {
      try {
        this.ca = readFileSync(this.caPath)
      } catch (error) {
        const code = (error as { code?: unknown })?.code
        const from = this.caSource === 'VAULT_CACERT' ? ' (VAULT_CACERT)' : ''
        throw new VaultError(`Vault: cannot read the CA certificate ${this.caPath}${from}${typeof code === 'string' ? ` (${code})` : ''}`, 'config')
      }
    }
    return this.ca
  }

  /** Path for messages: no query string, no leading slash. */
  private static displayPath(path: string): string {
    return path.split('?')[0].replace(/^\/+/, '')
  }

  url(path: string, query?: Record<string, string>): URL {
    const clean = path.replace(/^\/+/, '')
    const url = new URL(`${this.address}/v1/${clean}`)
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
    return url
  }

  /** Send a request; resolves for 2xx answers, rejects with VaultError otherwise. */
  async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'LIST', path: string, options: VaultRequestOptions = {}): Promise<VaultResponse> {
    const display = VaultClient.displayPath(path)
    const secrets: string[] = []
    if (options.token) secrets.push(options.token)
    collectStrings(options.body, secrets)
    collectStrings(options.query, secrets)
    secrets.push(...(options.redact ?? []))
    const signal = options.signal
    if (signal?.aborted) throw cancelledError(signal)
    // Automated runs (tests, agents) may only reach a local Vault — see automation-guard.ts.
    assertUrlAllowed(this.address, 'Vault server')

    const url = this.url(path, options.query)
    const ca = url.protocol === 'https:' ? this.loadCa() : undefined
    const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), 'utf8')
    const headers: Record<string, string> = { Accept: 'application/json', 'X-Vault-Request': 'true' }
    if (options.token) headers['X-Vault-Token'] = options.token
    if (this.namespace) headers['X-Vault-Namespace'] = this.namespace
    if (payload) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(payload.length)
    }
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const address = this.address

    const raw = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      let settled = false
      const transport = url.protocol === 'https:' ? https : http
      const requestOptions: https.RequestOptions = { method: method === 'LIST' ? 'GET' : method, headers }
      if (method === 'LIST') url.searchParams.set('list', 'true')
      if (url.protocol === 'https:') requestOptions.agent = agentFor(ca)
      const req = transport.request(url, requestOptions, (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_RESPONSE_BYTES) {
            finish(new VaultError(`Vault: the answer of ${display} is too large`, 'json', res.statusCode))
            req.destroy()
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => finish(null, { status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', (error) => finish(networkError(error, address, url.hostname)))
      })
      const timer = setTimeout(() => {
        finish(new VaultError(`Vault: ${address} did not answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`, 'timeout'))
        req.destroy()
      }, timeoutMs)
      timer.unref?.()
      const onAbort = () => {
        if (signal) finish(cancelledError(signal))
        req.destroy()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      function finish(error: Error | null, value?: { status: number; text: string }) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(value as { status: number; text: string })
      }
      req.on('error', (error) => finish(networkError(error, address, url.hostname)))
      if (payload) req.write(payload)
      req.end()
    })

    let body: VaultBody | null = null
    if (raw.text.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(raw.text)
        body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as VaultBody) : null
        if (!body) throw new Error('not an object')
      } catch {
        if (raw.status >= 200 && raw.status < 300) {
          throw new VaultError(`Vault: invalid JSON response from ${display} (${raw.status}). Is ${address} a Vault server?`, 'json', raw.status)
        }
        body = null
      }
    }
    if (raw.status < 200 || raw.status >= 300) {
      throw new VaultError(describeHttpError(raw.status, display, address, vaultErrorText(body, secrets)), 'http', raw.status)
    }
    return { status: raw.status, body }
  }
}

/** Shallow type guard for JSON objects. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
