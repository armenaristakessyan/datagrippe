// Pure logic of the "Import from DBeaver" dialog: candidate keys and grouping, selection, the Vault
// settings shared by the imported connections (secret path template), validation and the final
// ConnectionInput of every selected candidate. No React, no IPC: unit tested in dbeaver-import.test.ts.
import {
  DEFAULT_VAULT_AUTH_MOUNT,
  type ConnectionConfig,
  type ConnectionInput,
  type DbeaverImportCandidate,
  type Dialect,
  type VaultConfig,
  type VaultDefaults,
  type VaultDiscoverTarget,
  type VaultLoginMethod,
  type VaultPathSuggestion,
} from '@shared/types'
import {
  DEFAULT_DISCOVERY_ROLE,
  environmentVaultSettings,
  isDiscoveryRole,
  normalizeVaultAddress,
  sameVaultAddress,
  VAULT_METHOD_OPTIONS,
  vaultAddressError,
  vaultSecretPathError,
} from '@/components/vault/config'

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** Stable key of a candidate: DBeaver ids are only unique inside one data-sources file. */
export function candidateKey(c: Pick<DbeaverImportCandidate, 'sourceFile' | 'sourceId'>): string {
  return `${c.sourceFile}\u0000${c.sourceId}`
}

/** The candidate maps to a supported DataGrippe connection. */
export function isImportable(c: DbeaverImportCandidate): c is DbeaverImportCandidate & { input: ConnectionInput } {
  return c.input !== null
}

/** Its user / password come from HashiCorp Vault (DBeaver "auth-model": "vault"). */
export function usesVault(c: DbeaverImportCandidate): boolean {
  return c.input?.authMode === 'vault'
}

/** Pre-selected when the dialog opens: everything importable that is not already in DataGrippe. */
export function initialSelection(candidates: readonly DbeaverImportCandidate[]): Set<string> {
  return new Set(candidates.filter((c) => isImportable(c) && !c.duplicateOf).map(candidateKey))
}

/** "host:port/database" of a candidate (the DBeaver provider for unsupported ones). */
export function candidateTarget(c: DbeaverImportCandidate): string {
  const input = c.input
  if (!input) return c.sourceProvider
  const server = input.host ? `${input.host}${input.port ? `:${input.port}` : ''}` : ''
  return input.database ? `${server}/${input.database}` : server
}

export interface CandidateGroup {
  /** DBeaver folder; '' for connections outside any folder. */
  folder: string
  label: string
  candidates: DbeaverImportCandidate[]
}

export const NO_FOLDER_LABEL = 'No folder'

/** Lower-cased text a filter query is matched against. */
function haystack(c: DbeaverImportCandidate): string {
  return [c.sourceName, c.sourceFolder, c.sourceProvider, candidateTarget(c), c.input?.user].filter(Boolean).join(' ').toLowerCase()
}

/**
 * Candidates grouped by DBeaver folder (A–Z, connections outside a folder last), in file order inside a
 * group. `query` keeps the candidates whose name, folder, provider or target contain every word.
 */
export function groupCandidates(candidates: readonly DbeaverImportCandidate[], query = ''): CandidateGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const groups = new Map<string, DbeaverImportCandidate[]>()
  for (const c of candidates) {
    if (words.length > 0) {
      const text = haystack(c)
      if (!words.every((w) => text.includes(w))) continue
    }
    const folder = c.sourceFolder?.trim() ?? ''
    const list = groups.get(folder)
    if (list) list.push(c)
    else groups.set(folder, [c])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })))
    .map(([folder, list]) => ({ folder, label: folder || NO_FOLDER_LABEL, candidates: list }))
}

/** Checkbox state of a group header (only importable rows count). */
export function groupSelectionState(group: CandidateGroup, selected: ReadonlySet<string>): boolean | 'indeterminate' {
  const keys = group.candidates.filter(isImportable).map(candidateKey)
  if (keys.length === 0) return false
  const on = keys.filter((k) => selected.has(k)).length
  if (on === 0) return false
  return on === keys.length ? true : 'indeterminate'
}

/** Select / deselect every importable row of `candidates` (e.g. one group). */
export function setSelected(selected: ReadonlySet<string>, candidates: readonly DbeaverImportCandidate[], on: boolean): Set<string> {
  const next = new Set(selected)
  for (const c of candidates) {
    if (!isImportable(c)) continue
    if (on) next.add(candidateKey(c))
    else next.delete(candidateKey(c))
  }
  return next
}

export function selectedCandidates(candidates: readonly DbeaverImportCandidate[], selected: ReadonlySet<string>): DbeaverImportCandidate[] {
  return candidates.filter((c) => isImportable(c) && selected.has(candidateKey(c)))
}

// ---------------------------------------------------------------------------
// Vault settings shared by the imported connections
// ---------------------------------------------------------------------------

export const SECRET_PATH_TOKENS = ['database', 'name', 'host'] as const
export type SecretPathToken = (typeof SECRET_PATH_TOKENS)[number]
export type SecretPathValues = Record<SecretPathToken, string>

export const SECRET_PATH_EXAMPLE = 'database/creds/{database}-readonly'

/** Sign-in methods, in the order the select lists them. */
/** Same labels as the connection dialog. */
export const VAULT_LOGIN_OPTIONS = VAULT_METHOD_OPTIONS

export interface VaultImportSettings {
  address: string
  namespace: string
  loginMethod: VaultLoginMethod
  /** Empty = the method's default mount. */
  authMount: string
  oidcRole: string
  /** ldap / userpass username. */
  username: string
  /** Secret path with {database} {name} {host} tokens (optional when paths are suggested from Vault). */
  template: string
  /** 'token' method: sign in with the browser (OIDC) when the CLI token is missing or expired. */
  oidcFallback: boolean
  /** Role appended to a suggested database mount: "<mount>/creds/<role>". */
  role: string
  /**
   * CA bundle of the most recent Vault connection; not editable here. Applied only while `address` is still
   * that connection's Vault (`caFrom`): a CA bundle replaces the default trust store, so it would break any
   * other server.
   */
  caPath?: string
  /** The Vault address `caPath` belongs to. */
  caFrom?: string
}

export const EMPTY_VAULT_SETTINGS: VaultImportSettings = {
  address: '',
  namespace: '',
  loginMethod: 'oidc',
  authMount: '',
  oidcRole: '',
  username: '',
  template: '',
  oidcFallback: true,
  role: DEFAULT_DISCOVERY_ROLE,
}

/**
 * The panel's starting point without any Vault connection yet: the vault CLI's environment (VAULT_ADDR of the
 * shell profile, ~/.vault-token) → the CLI token, with the browser as fallback. Unchanged when it names nothing.
 */
export function withEnvironment(settings: VaultImportSettings, environment: VaultDefaults | null): VaultImportSettings {
  if (settings.address.trim()) return settings
  const env = environmentVaultSettings(environment)
  if (!env) return settings
  return { ...settings, address: env.address, namespace: settings.namespace || env.namespace, loginMethod: env.loginMethod, oidcFallback: env.oidcFallback }
}

export function secretPathValues(c: DbeaverImportCandidate): SecretPathValues {
  return { database: c.input?.database ?? '', name: c.sourceName, host: c.input?.host ?? '' }
}

/** Replace {database} {name} {host} (case-insensitive) with the connection's values; other text is kept. */
export function expandSecretPath(template: string, values: SecretPathValues): string {
  return template.replace(/\{(\w+)\}/g, (match, token: string) => {
    const key = token.toLowerCase()
    return (SECRET_PATH_TOKENS as readonly string[]).includes(key) ? values[key as SecretPathToken] : match
  })
}

/** Supported {tokens} a template uses (lower-cased, without duplicates). */
export function usedTokens(template: string): SecretPathToken[] {
  const out = new Set<SecretPathToken>()
  for (const m of template.matchAll(/\{(\w*)\}/g)) {
    const key = (m[1] ?? '').toLowerCase()
    if ((SECRET_PATH_TOKENS as readonly string[]).includes(key)) out.add(key as SecretPathToken)
  }
  return [...out]
}

/** {tokens} of a template that are not supported, without duplicates. */
export function unknownTokens(template: string): string[] {
  const out = new Set<string>()
  for (const m of template.matchAll(/\{(\w*)\}/g)) {
    if (!(SECRET_PATH_TOKENS as readonly string[]).includes((m[1] ?? '').toLowerCase())) out.add(m[0])
  }
  return [...out]
}

/**
 * A template guessed from an existing connection's secret path: its database name (else host) becomes
 * the token. '' when the path names neither (a fixed path would be wrong for the other databases).
 * Only the last segment (the role / secret name) is looked at: the mount is shared by every connection
 * even when its name happens to contain the database name ("app-database/creds/app-ro").
 */
export function inferTemplate(secretPath: string, values: Pick<SecretPathValues, 'database' | 'host'>): string {
  const path = secretPath.trim()
  if (!path) return ''
  const cut = path.lastIndexOf('/') + 1
  const head = path.slice(0, cut)
  const tail = path.slice(cut)
  for (const token of ['database', 'host'] as const) {
    const value = values[token].trim()
    // One-letter values ("a") would replace random characters of the path.
    if (value.length < 2 || !tail.includes(value)) continue
    return head + tail.split(value).join(`{${token}}`)
  }
  return ''
}

/**
 * Template inferred from the most recent secret path that names its database or host, preferring the
 * connections of `dialect` (roles usually differ per engine: "…-pg-ro" vs "…-mssql-ro").
 */
export function defaultTemplate(connections: readonly ConnectionConfig[], dialect?: Dialect): string {
  const ordered = vaultConnectionsByRecency(connections)
  const preferred = dialect ? [...ordered.filter((c) => c.dialect === dialect), ...ordered.filter((c) => c.dialect !== dialect)] : ordered
  return preferred.map((c) => inferTemplate(c.vault?.secretPath ?? '', { database: c.database ?? '', host: c.host })).find(Boolean) ?? ''
}

/** Most common dialect among the Vault candidates (the first one on a tie), undefined when none uses Vault. */
export function majorityVaultDialect(candidates: readonly DbeaverImportCandidate[]): Dialect | undefined {
  const counts = new Map<Dialect, number>()
  for (const c of candidates) if (usesVault(c) && c.input) counts.set(c.input.dialect, (counts.get(c.input.dialect) ?? 0) + 1)
  let best: Dialect | undefined
  for (const [dialect, n] of counts) if (best === undefined || n > (counts.get(best) ?? 0)) best = dialect
  return best
}

function vaultConnectionsByRecency(connections: readonly ConnectionConfig[]): ConnectionConfig[] {
  return connections
    .filter((c) => c.authMode === 'vault' && c.vault && c.vault.address)
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
}

/** The most recently edited Vault connection, whose settings prefill the Vault panel. */
export function recentVaultConnection(connections: readonly ConnectionConfig[]): ConnectionConfig | undefined {
  return vaultConnectionsByRecency(connections)[0]
}

/**
 * Defaults of the Vault panel, taken from the most recently edited Vault connection (if any); the
 * template comes from the most recent secret path that names its database or host.
 */
export function vaultDefaultsFrom(connections: readonly ConnectionConfig[], dialect?: Dialect): VaultImportSettings {
  const recent = vaultConnectionsByRecency(connections)[0]
  const vault = recent?.vault
  if (!recent || !vault) return { ...EMPTY_VAULT_SETTINGS }
  return {
    address: vault.address,
    namespace: vault.namespace ?? '',
    loginMethod: vault.loginMethod,
    authMount: vault.authMount ?? '',
    oidcRole: vault.oidcRole ?? '',
    username: vault.username ?? '',
    template: defaultTemplate(connections, dialect),
    oidcFallback: vault.oidcFallback !== false,
    role: reusableRole(recent),
    ...(vault.caPath ? { caPath: vault.caPath, caFrom: vault.address } : {}),
  }
}

/** The role of a connection's secret path, unless it is specific to that connection (names its database / host). */
function reusableRole(c: ConnectionConfig): string {
  const role = roleOfPath(c.vault?.secretPath ?? '')
  const specific = [c.database, c.host].some((value) => value && value.length >= 2 && role.includes(value))
  return specific ? DEFAULT_DISCOVERY_ROLE : role
}

/** The role of "…/creds/<role>" (default read_only). */
export function roleOfPath(path: string): string {
  const match = /\/creds\/([^/]+)$/.exec(path.trim())
  return match && isDiscoveryRole(match[1]) ? match[1] : DEFAULT_DISCOVERY_ROLE
}

/** "database/creds/x" from "/v1/database/creds/x/". */
export function normalizeSecretPath(path: string): string {
  return path
    .trim()
    .replace(/^\/+/, '')
    .replace(/^v1\//, '')
    .replace(/\/+$/, '')
}

/** Address as main stores it: trimmed, no trailing slash, no /v1 suffix, nothing from /ui on. */
export function normalizeAddress(address: string): string {
  return normalizeVaultAddress(address)
}

export function isValidVaultAddress(address: string): boolean {
  const value = normalizeAddress(address)
  if (!/^https?:\/\//i.test(value)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
  } catch {
    return false
  }
}

export function needsUsername(method: VaultLoginMethod): boolean {
  return method === 'ldap' || method === 'userpass'
}

export function defaultAuthMount(method: VaultLoginMethod): string {
  return method === 'token' ? '' : DEFAULT_VAULT_AUTH_MOUNT[method]
}

/** The secret path a Vault row will use: its own edit, else the template expanded for it. */
export function rowSecretPath(c: DbeaverImportCandidate, template: string, overrides: ReadonlyMap<string, string>): string {
  const own = overrides.get(candidateKey(c))
  if (own !== undefined) return own
  return expandSecretPath(template, secretPathValues(c))
}

/** Secret paths the scan already filled in (kept as row edits so the template does not replace them). */
export function initialOverrides(candidates: readonly DbeaverImportCandidate[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const c of candidates) {
    const path = c.input?.vault?.secretPath?.trim()
    if (usesVault(c) && path) out.set(candidateKey(c), path)
  }
  return out
}

/**
 * Empty panel fields filled from Vault hints DBeaver kept in its (non-secret) authentication settings,
 * taken from the first Vault candidate that has an address. Fields already set win. The sign-in method is
 * only taken while the panel still shows the default one, and never 'token': a file must not steer the user's
 * CLI token (VAULT_TOKEN, ~/.vault-token) towards the address it names.
 */
export function fillFromCandidates(settings: VaultImportSettings, candidates: readonly DbeaverImportCandidate[]): VaultImportSettings {
  if (settings.address.trim()) return settings
  const hinted = candidates.find((c) => usesVault(c) && c.input?.vault?.address)?.input?.vault
  if (!hinted) return settings
  return {
    ...settings,
    address: hinted.address,
    namespace: settings.namespace || hinted.namespace || '',
    loginMethod: settings.loginMethod === EMPTY_VAULT_SETTINGS.loginMethod && hinted.loginMethod !== 'token' ? hinted.loginMethod : settings.loginMethod,
    authMount: settings.authMount || hinted.authMount || '',
    oidcRole: settings.oidcRole || hinted.oidcRole || '',
    username: settings.username || hinted.username || '',
  }
}

/**
 * Scan notes worth showing on a row: the ones about Vault settings the dialog's own panel collects
 * ("Set the Vault secret path"…, "Vault address … taken from the DBeaver authentication settings") and the
 * production marking (shown as a badge) are left out.
 */
export function visibleNotes(c: DbeaverImportCandidate): string[] {
  return c.notes.filter((note) => {
    if (note === 'Marked as production') return false
    if (!usesVault(c)) return true
    // The Vault values found in the file prefill the shared panel and the row's secret path, where they are shown.
    return (
      !/^Set the Vault (address|secret path)/.test(note) &&
      !/^Vault sign-in uses OIDC \(browser\) by default/.test(note) &&
      !/^Vault .+ taken from the DBeaver authentication settings$/.test(note)
    )
  })
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ImportValidation {
  ok: boolean
  /** No row selected. */
  empty: boolean
  /** Some selected row uses Vault: the Vault panel is shown and validated. */
  vault: boolean
  address?: string
  username?: string
  template?: string
  /** Role used by "Suggest paths from Vault". */
  role?: string
  /** Secret path error per candidate key. */
  rows: Record<string, string>
  /** One line for the footer explaining why Import is disabled. */
  summary?: string
}

export function validateImport(
  candidates: readonly DbeaverImportCandidate[],
  selected: ReadonlySet<string>,
  settings: VaultImportSettings,
  overrides: ReadonlyMap<string, string>,
): ImportValidation {
  const chosen = selectedCandidates(candidates, selected)
  const vaultRows = chosen.filter(usesVault)
  const result: ImportValidation = { ok: true, empty: chosen.length === 0, vault: vaultRows.length > 0, rows: {} }
  if (result.empty) return { ...result, ok: false, summary: 'Select the connections to import.' }
  if (!result.vault) return result

  if (!settings.address.trim()) result.address = 'Enter the Vault address.'
  else if (!isValidVaultAddress(settings.address)) result.address = 'Use a full URL, e.g. https://vault.example.com'
  else result.address = vaultAddressError(normalizeAddress(settings.address))
  if (needsUsername(settings.loginMethod) && !settings.username.trim()) result.username = 'Enter your Vault username.'
  if (settings.role.trim() && !isDiscoveryRole(settings.role.trim())) result.role = 'Use letters, digits, _ . @ -.'
  const unknown = unknownTokens(settings.template)
  if (unknown.length > 0) result.template = `Unknown ${unknown.length === 1 ? 'token' : 'tokens'} ${unknown.join(' ')}. Use {database}, {name} or {host}.`

  for (const c of vaultRows) {
    const path = normalizeSecretPath(rowSecretPath(c, settings.template, overrides))
    const key = candidateKey(c)
    // A {token} the connection has no value for would give "database/creds/-readonly", a role nobody named.
    const values = secretPathValues(c)
    const blank = overrides.has(key) ? undefined : usedTokens(settings.template).find((t) => !values[t].trim())
    if (blank) result.rows[key] = `This connection has no {${blank}}: type its secret path`
    else if (!path) result.rows[key] = 'Secret path required'
    else if (unknownTokens(path).length > 0) result.rows[key] = `Unknown token ${unknownTokens(path)[0]}`
    else {
      // Same rules as main (a row failing them would only fail at save time).
      const error = vaultSecretPathError(path)
      if (error) result.rows[key] = error
    }
  }
  const missing = Object.keys(result.rows).length
  result.ok = !result.address && !result.username && !result.template && !result.role && missing === 0
  if (!result.ok) {
    result.summary =
      result.address ??
      result.username ??
      result.template ??
      result.role ??
      (missing === 1 ? 'One connection needs a valid secret path.' : `${missing} connections need a valid secret path.`)
  }
  return result
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Definition saved for a selected candidate: its DBeaver folder as group, plus the Vault settings. */
export function buildInput(c: DbeaverImportCandidate, settings: VaultImportSettings, overrides: ReadonlyMap<string, string>): ConnectionInput {
  const base = c.input
  if (!base) throw new Error(`${c.sourceName} cannot be imported`)
  const group = base.group?.trim() || c.sourceFolder?.trim() || undefined
  if (!usesVault(c)) return { ...base, group }
  const method = settings.loginMethod
  const authMount = settings.authMount.trim()
  // The token method keeps the OIDC mount / role of its browser fallback.
  const fallback = method === 'token' && settings.oidcFallback
  const vault: VaultConfig = {
    ...base.vault,
    address: normalizeAddress(settings.address),
    namespace: settings.namespace.trim() || undefined,
    loginMethod: method,
    authMount: (method !== 'token' || fallback) && authMount ? authMount : undefined,
    oidcRole: method === 'oidc' || fallback ? settings.oidcRole.trim() || undefined : undefined,
    oidcFallback: method === 'token' && !settings.oidcFallback ? false : undefined,
    username: needsUsername(method) ? settings.username.trim() : undefined,
    secretPath: normalizeSecretPath(rowSecretPath(c, settings.template, overrides)),
    // The previous Vault's CA bundle only for that same Vault (it replaces the default trust store).
    caPath: settings.caPath && sameVaultAddress(settings.caFrom, settings.address) ? settings.caPath : base.vault?.caPath,
  }
  return { ...base, group, authMode: 'vault', vault }
}

// ---------------------------------------------------------------------------
// Secret path suggestions (vault:discover)
// ---------------------------------------------------------------------------

/** The Vault server settings of the panel (for vault:discover; the secret path is irrelevant there). */
export function panelVaultConfig(settings: VaultImportSettings): VaultConfig {
  const fallback = settings.loginMethod === 'token' && settings.oidcFallback
  const mount = settings.authMount.trim()
  return {
    address: normalizeAddress(settings.address),
    ...(settings.namespace.trim() ? { namespace: settings.namespace.trim() } : {}),
    loginMethod: settings.loginMethod,
    ...((settings.loginMethod !== 'token' || fallback) && mount ? { authMount: mount } : {}),
    ...((settings.loginMethod === 'oidc' || fallback) && settings.oidcRole.trim() ? { oidcRole: settings.oidcRole.trim() } : {}),
    ...(needsUsername(settings.loginMethod) ? { username: settings.username.trim() } : {}),
    ...(settings.loginMethod === 'token' && !settings.oidcFallback ? { oidcFallback: false } : {}),
    secretPath: '',
  }
}

/** One discovery target per selected Vault row, keyed by candidateKey. */
export function discoveryTargets(candidates: readonly DbeaverImportCandidate[]): VaultDiscoverTarget[] {
  return candidates.filter(usesVault).flatMap((c): VaultDiscoverTarget[] => {
    const input = c.input
    if (!input) return []
    const group = input.group?.trim() || c.sourceFolder?.trim()
    return [{ key: candidateKey(c), dialect: input.dialect, host: input.host, database: input.database, name: c.sourceName, ...(group ? { group } : {}) }]
  })
}

/**
 * Row paths after a discovery: every suggestion fills its row unless the user typed that row's path (a path
 * found in the DBeaver file counts as typed); rows filled by a previous suggestion are replaced.
 */
export function applySuggestions(
  overrides: ReadonlyMap<string, string>,
  previous: ReadonlyMap<string, VaultPathSuggestion>,
  suggestions: readonly VaultPathSuggestion[],
): { overrides: Map<string, string>; suggested: Map<string, VaultPathSuggestion> } {
  const nextOverrides = new Map(overrides)
  const suggested = new Map<string, VaultPathSuggestion>()
  for (const [key, old] of previous) {
    // A previous suggestion the user did not edit is up for replacement.
    if (nextOverrides.get(key) === old.path) nextOverrides.delete(key)
  }
  for (const suggestion of suggestions) {
    if (nextOverrides.has(suggestion.key)) continue
    nextOverrides.set(suggestion.key, suggestion.path)
    suggested.set(suggestion.key, suggestion)
  }
  return { overrides: nextOverrides, suggested }
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** Where DBeaver keeps its workspace by default on `platform` (what the default scan looks at). */
export function defaultWorkspaceLabel(platform: string): string {
  if (platform === 'darwin') return '~/Library/DBeaverData/workspace6'
  if (platform === 'win32') return '%APPDATA%\\DBeaverData\\workspace6'
  return '~/.local/share/DBeaverData/workspace6'
}

/** Last `keep` segments of a path ("…/.dbeaver/data-sources-prod.json"); the full path goes in a tooltip. */
export function shortenPath(path: string, keep = 2): string {
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  const parts = path.split(sep).filter(Boolean)
  if (parts.length <= keep) return path
  return `…${sep}${parts.slice(-keep).join(sep)}`
}
