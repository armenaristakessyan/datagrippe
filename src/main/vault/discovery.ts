// Secret path discovery: list the database secrets engine mounts the user's token can see
// (sys/internal/ui/mounts, readable by any token) and suggest "<mount>/creds/<role>" for each connection.
//
// Mount paths are organised by the Vault administrators, e.g. "<cloud>/<env>/<team>/<instance-id>/<database>":
// the instance id is not derivable from the host name, but they share fragments (host labels, database name, a
// company token). Matching is token based: tokens shared by (almost) every mount carry no information, random ids
// are ignored, and the score is an F-measure between what explains the mount and what describes the connection.
import type { VaultDiscoverTarget, VaultMountInfo, VaultPathSuggestion } from '@shared/types'
import { isJsonObject } from './client'

export const DEFAULT_DISCOVERY_ROLE = 'read_only'
/** Below this, no suggestion (the user picks a mount). */
export const MIN_SUGGESTION_SCORE = 0.5
/** The best mount must beat the runner-up by this much, unless it is a near-certain match. */
const MIN_MARGIN = 0.12
const CERTAIN = 0.9
/** A token present in at least this share of the mounts (≥ 3 mounts) is a shared prefix: ignored. */
const COMMON_SHARE = 0.8

/** Words that describe the kind of thing, not which one. */
const GENERIC = new Set([
  'database', 'databases', 'db', 'dbs', 'data', 'sql', 'pgsql', 'psql', 'pg', 'postgres', 'postgresql', 'mssql',
  'sqlserver', 'sqlsrv', 'server', 'instance', 'cluster', 'primary', 'replica', 'master', 'main', 'cloud', 'all',
  'and', 'the', 'connection', 'creds', 'cred', 'read', 'only', 'ro', 'rw', 'readonly', 'legacy', 'default', 'v1',
])
const PG_HINTS = new Set(['pg', 'pgsql', 'psql', 'postgres', 'postgresql'])
const MSSQL_HINTS = new Set(['mssql', 'sqlserver', 'sqlsrv', 'server'])
/** Environment words: a mount of another environment than the connection's is never the right one. */
const ENVIRONMENTS: Record<string, string> = {
  prod: 'prod', production: 'prod', prd: 'prod', live: 'prod',
  staging: 'staging', stage: 'staging', stg: 'staging',
  preprod: 'preprod', preproduction: 'preprod', uat: 'preprod',
  dev: 'dev', development: 'dev',
  test: 'test', testing: 'test', qa: 'test',
  sandbox: 'sandbox', sbx: 'sandbox', demo: 'sandbox',
}

function environmentsOf(list: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const word of list) {
    const env = ENVIRONMENTS[word]
    if (env) out.add(env)
  }
  return out
}

/** Database names that say nothing about which database it is. */
const GENERIC_DATABASES = new Set(['postgres', 'master', 'template1', 'defaultdb', 'tempdb', 'model', 'msdb'])

/** Database secrets engines of a sys/internal/ui/mounts answer, sorted by path. */
export function databaseMounts(body: unknown): VaultMountInfo[] {
  const data = isJsonObject(body) && isJsonObject(body.data) ? body.data : null
  const secret = data && isJsonObject(data.secret) ? data.secret : null
  if (!secret) return []
  const mounts: VaultMountInfo[] = []
  for (const [rawPath, info] of Object.entries(secret)) {
    if (!isJsonObject(info) || info.type !== 'database') continue
    const path = rawPath.replace(/^\/+|\/+$/g, '')
    if (!path) continue
    const mount: VaultMountInfo = { path, type: 'database' }
    if (typeof info.description === 'string' && info.description.trim()) mount.description = info.description.trim()
    mounts.push(mount)
  }
  return mounts.sort((a, b) => a.path.localeCompare(b.path))
}

/** "<mount>/creds/<role>". */
export function credsPath(mount: string, role: string = DEFAULT_DISCOVERY_ROLE): string {
  return `${mount.replace(/\/+$/, '')}/creds/${role.trim() || DEFAULT_DISCOVERY_ROLE}`
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** Lower-case alphanumeric words. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0)
}

/** Random-looking ids (mix of letters and digits, e.g. "3jf23d71") and plain numbers carry no meaning. */
function isNoise(word: string): boolean {
  if (/^\d+$/.test(word)) return true
  return word.length >= 6 && /\d/.test(word) && /[a-z]/.test(word) && !/^[a-z]+\d{1,2}$/.test(word)
}

function meaningful(list: string[]): string[] {
  return list.filter((w) => w.length > 1 && !GENERIC.has(w) && !isNoise(w))
}

/** "pg-orders-database.example.cloud" → "pg-orders-database". */
function firstLabel(host: string): string {
  return host.trim().toLowerCase().split('.')[0] ?? ''
}

/** Replace host names inside a connection name by their first label ("… @db-1.example.cloud" → "… @db-1"). */
function withoutDomains(name: string): string {
  return name.replace(/([a-z0-9-]+)(\.[a-z0-9-]+)+\.[a-z]{2,}/gi, '$1')
}

/** Separators unified, for whole-name comparisons ("orders_db" ≈ "orders-db"). */
function unify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Host label without its trailing generic words: "pg-orders-database" → "pg-orders". */
function hostCore(host: string): string {
  const parts = unify(firstLabel(host)).split('-')
  while (parts.length > 1 && GENERIC.has(parts[parts.length - 1])) parts.pop()
  return parts.join('-')
}

function sameWord(a: string, b: string): boolean {
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= 4 && long.startsWith(short)
}

interface MountFeatures {
  mount: VaultMountInfo
  /** Meaningful words of the instance and database segments (the part that identifies the database). */
  words: Set<string>
  raw: Set<string>
  last: string
  instance: string
}

function mountFeatures(mount: VaultMountInfo): MountFeatures {
  const segments = mount.path.split('/')
  const last = segments[segments.length - 1] ?? ''
  const instance = segments.length >= 2 ? segments[segments.length - 2] : ''
  const all = words(mount.path)
  return { mount, words: new Set(meaningful(all)), raw: new Set(all), last, instance }
}

interface TargetFeatures {
  target: VaultDiscoverTarget
  words: Set<string>
  envs: Set<string>
  database: string
  hostCore: string
}

function targetFeatures(target: VaultDiscoverTarget): TargetFeatures {
  const list = [...words(firstLabel(target.host)), ...words(target.database), ...words(withoutDomains(target.name))]
  const envs = environmentsOf([...list, ...words(target.group ?? '')])
  return { target, words: new Set(meaningful(list)), envs, database: unify(target.database), hostCore: hostCore(target.host) }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ScoredMount {
  mount: string
  path: string
  /** 0..1, for display. */
  score: number
  /** Uncapped score used for ranking and margins. */
  raw: number
  reason: string
}

function round(score: number): number {
  return Math.round(Math.min(1, Math.max(0, score)) * 100) / 100
}

/** Every mount scored for one target, best first. */
export function scoreMounts(mounts: VaultMountInfo[], target: VaultDiscoverTarget, role: string = DEFAULT_DISCOVERY_ROLE): ScoredMount[] {
  const features = mounts.map(mountFeatures)
  // Document frequency of each word across mounts (fuzzy, so "aggreg" also counts for "aggregator").
  const vocabulary = new Set(features.flatMap((f) => [...f.words]))
  const df = new Map<string, number>()
  const frequency = (word: string): number => {
    let count = df.get(word)
    if (count === undefined) {
      count = features.filter((f) => [...f.words].some((w) => sameWord(w, word))).length
      df.set(word, count)
    }
    return count
  }
  const total = features.length
  const common = (word: string) => total >= 3 && frequency(word) / total >= COMMON_SHARE
  const weight = (word: string) => Math.log(1 + total / Math.max(1, frequency(word)))

  const t = targetFeatures(target)
  // Target words that some mount could explain (others would only lower every score alike).
  const targetWords = [...t.words].filter((w) => !common(w) && [...vocabulary].some((v) => sameWord(v, w)))

  const scored = features.map((f): ScoredMount => {
    const mountWords = [...f.words].filter((w) => !common(w))
    const explained = mountWords.filter((w) => [...t.words].some((tw) => sameWord(tw, w)))
    const covered = targetWords.filter((w) => mountWords.some((mw) => sameWord(mw, w)))
    const sum = (list: string[]) => list.reduce((acc, w) => acc + weight(w), 0)
    const precision = mountWords.length ? sum(explained) / sum(mountWords) : 0
    const recall = targetWords.length ? sum(covered) / sum(targetWords) : 0
    let score = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
    const reasons: string[] = []
    if (explained.length) reasons.push(`shares ${explained.map((w) => `"${w}"`).join(', ')}`)
    // A mount of the other engine is never the database, whatever its name says.
    const pgMount = [...f.raw].some((w) => PG_HINTS.has(w))
    const msMount = [...f.raw].some((w) => MSSQL_HINTS.has(w))
    const otherEngine = (target.dialect === 'postgres' && msMount && !pgMount) || (target.dialect === 'mssql' && pgMount && !msMount)

    if (!otherEngine && t.database && !GENERIC_DATABASES.has(t.database) && unify(f.last) === t.database) {
      // A mount named after the database is the strongest single sign (twins are settled by the environment).
      score += 0.4
      reasons.unshift(`database "${target.database}" is the mount name`)
    }
    if (!otherEngine && t.hostCore && t.hostCore.length >= 4 && f.instance && unify(f.instance).startsWith(t.hostCore)) {
      score += 0.15
      reasons.push(`host "${t.hostCore}" matches instance "${f.instance}"`)
    }
    // The engine named in the mount path (pgsql…, mssql / server) must agree with the connection's.
    if (target.dialect === 'postgres') {
      if (pgMount) {
        score += 0.1
        reasons.push('PostgreSQL mount')
      } else if (msMount) score -= 0.2
    } else if (target.dialect === 'mssql') {
      if (msMount) {
        score += 0.15
        reasons.push('SQL Server mount')
      } else if (pgMount) score -= 0.3
    }
    // Environment (prod, staging…): a conflict rules the mount out, agreement settles prod vs staging twins.
    const mountEnvs = environmentsOf(f.raw)
    if (t.envs.size > 0 && mountEnvs.size > 0) {
      if ([...mountEnvs].some((env) => t.envs.has(env))) {
        score += 0.1
        reasons.push(`same environment (${[...mountEnvs].filter((env) => t.envs.has(env)).join(', ')})`)
      } else {
        score -= 0.4
      }
    }
    return { mount: f.mount.path, path: credsPath(f.mount.path, role), score: round(score), raw: score, reason: reasons.join('; ') || 'weak match' }
  })
  return scored.sort((a, b) => b.raw - a.raw || a.mount.localeCompare(b.mount))
}

/** The suggestion for a target, or null when no mount is clearly the right one. */
export function bestSuggestion(scored: ScoredMount[], key: string): VaultPathSuggestion | null {
  const [best, second] = scored
  if (!best || best.raw < MIN_SUGGESTION_SCORE) return null
  if (second && best.raw - second.raw < MIN_MARGIN && !(best.raw >= CERTAIN && second.raw < CERTAIN)) return null
  return { key, path: best.path, mount: best.mount, score: best.score, reason: best.reason }
}

export interface DiscoveryOutcome {
  suggestions: VaultPathSuggestion[]
  /** Best mounts per target key (for pickers), at most `limit` each. */
  ranking: Record<string, { mount: string; path: string; score: number }[]>
}

export function suggestPaths(mounts: VaultMountInfo[], targets: VaultDiscoverTarget[], role: string = DEFAULT_DISCOVERY_ROLE, limit = 12): DiscoveryOutcome {
  const suggestions: VaultPathSuggestion[] = []
  const ranking: DiscoveryOutcome['ranking'] = {}
  for (const target of targets) {
    const scored = scoreMounts(mounts, target, role)
    ranking[target.key] = scored.slice(0, limit).map(({ mount, path, score }) => ({ mount, path, score }))
    const best = bestSuggestion(scored, target.key)
    if (best) suggestions.push(best)
  }
  return { suggestions, ranking }
}
