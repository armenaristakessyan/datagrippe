// The vault CLI's environment (VAULT_ADDR, VAULT_NAMESPACE, VAULT_CACERT). An app started from Finder does not
// inherit the variables exported in ~/.zshrc, so they are read once from the user's login shell, the way the
// terminal sees them. Values are never logged; VAULT_TOKEN is never read from the shell (the token stays in
// ~/.vault-token or the process environment).
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { VaultDefaults } from '@shared/types'

export const VAULT_ENV_NAMES = ['VAULT_ADDR', 'VAULT_NAMESPACE', 'VAULT_CACERT'] as const
export type VaultEnvName = (typeof VAULT_ENV_NAMES)[number]

export interface VaultEnvironment {
  address?: string
  namespace?: string
  /** Absolute path of a PEM CA bundle (VAULT_CACERT). */
  caCert?: string
  source: VaultDefaults['source']
}

const START = '__DATAGRIPPE_VAULT_ENV_START__'
const END = '__DATAGRIPPE_VAULT_ENV_END__'
export const LOGIN_SHELL_TIMEOUT_MS = 3_000
/** Longest value kept from the shell (an address or a path). */
const MAX_VALUE_LENGTH = 2048

/** The script run by the login shell: the three variables, NUL separated, between markers (profile output is ignored). */
export function loginShellScript(): string {
  const fields = VAULT_ENV_NAMES.map((name) => `${name}=%s\\0`).join('')
  const args = VAULT_ENV_NAMES.map((name) => `"$${name}"`).join(' ')
  return `printf '\\n${START}\\n'; printf '${fields}' ${args}; printf '${END}\\n'`
}

/** Values printed by loginShellScript(), from a stdout that may also contain whatever the shell profile printed. */
export function parseLoginShellOutput(output: string): Partial<Record<VaultEnvName, string>> {
  const start = output.lastIndexOf(START)
  if (start < 0) return {}
  const end = output.indexOf(END, start)
  if (end < 0) return {}
  const body = output.slice(start + START.length, end).replace(/^\r?\n/, '')
  const values: Partial<Record<VaultEnvName, string>> = {}
  for (const entry of body.split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const name = entry.slice(0, eq) as VaultEnvName
    if (!VAULT_ENV_NAMES.includes(name)) continue
    const value = entry.slice(eq + 1).trim()
    if (value && value.length <= MAX_VALUE_LENGTH && !/[\r\n\0]/.test(value)) values[name] = value
  }
  return values
}

export type SpawnShell = (shell: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<string | null>

/** Run the shell, collect stdout (capped), kill it on timeout. Resolves null on any failure. */
const defaultSpawn: SpawnShell = (shell, args, { env, timeoutMs }) =>
  new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (value: string | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, args, { env, stdio: ['ignore', 'pipe', 'ignore'], detached: false, windowsHide: true })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (out.length < 256 * 1024) out += chunk
    })
    child.on('error', () => finish(null))
    child.on('close', () => finish(out))
  })

export interface VaultEnvironmentDeps {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Skip the login shell (automated runs: tests must never see the developer's real Vault settings). */
  automated?: boolean
  homeDir?: () => string
  /** The user's login shell; defaults to $SHELL, then the account's shell. */
  shell?: () => string | undefined
  spawnShell?: SpawnShell
  timeoutMs?: number
}

function userShell(env: NodeJS.ProcessEnv): string | undefined {
  const candidates = [env.SHELL]
  try {
    candidates.push(userInfo().shell ?? undefined)
  } catch {
    // no passwd entry
  }
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // not there
    }
  }
  return undefined
}

function fromValues(values: Partial<Record<VaultEnvName, string>>, source: VaultEnvironment['source']): VaultEnvironment {
  const env: VaultEnvironment = { source }
  if (values.VAULT_ADDR) env.address = values.VAULT_ADDR
  if (values.VAULT_NAMESPACE) env.namespace = values.VAULT_NAMESPACE
  if (values.VAULT_CACERT && isAbsolute(values.VAULT_CACERT)) env.caCert = values.VAULT_CACERT
  return env
}

/**
 * Resolves the vault CLI's environment once: the process environment when it names a Vault server (app started
 * from a terminal, or a test), else the login shell (macOS / Linux). Windows: the process environment only (setx
 * variables are inherited by every app).
 */
export class VaultEnvironmentResolver {
  private readonly deps: VaultEnvironmentDeps
  private pending: Promise<VaultEnvironment> | null = null
  private resolved: VaultEnvironment | null = null

  constructor(deps: VaultEnvironmentDeps = {}) {
    this.deps = deps
  }

  /** Start resolving in the background (app startup), so the first connection does not wait for the shell. */
  start(): void {
    void this.get()
  }

  /** The environment, resolved once. */
  get(): Promise<VaultEnvironment> {
    if (!this.pending) {
      this.pending = this.resolve().then((value) => {
        this.resolved = value
        return value
      })
    }
    return this.pending
  }

  /** The environment if already resolved (synchronous callers), else null. */
  peek(): VaultEnvironment | null {
    return this.resolved
  }

  /** What the renderer may show to prefill a Vault connection (never a token). */
  async defaults(): Promise<VaultDefaults> {
    const env = await this.get()
    const defaults: VaultDefaults = { source: env.source, cliTokenFile: this.cliTokenFileExists() }
    if (env.address) defaults.address = env.address
    if (env.namespace) defaults.namespace = env.namespace
    if (env.caCert) defaults.caPath = env.caCert
    return defaults
  }

  private cliTokenFileExists(): boolean {
    try {
      const home = this.deps.homeDir ? this.deps.homeDir() : homedir()
      return existsSync(join(home, '.vault-token'))
    } catch {
      return false
    }
  }

  private async resolve(): Promise<VaultEnvironment> {
    const env = this.deps.env ?? process.env
    const own: Partial<Record<VaultEnvName, string>> = {}
    for (const name of VAULT_ENV_NAMES) {
      const value = env[name]?.trim()
      if (value) own[name] = value
    }
    if (own.VAULT_ADDR) return fromValues(own, 'env')
    const platform = this.deps.platform ?? process.platform
    if (this.deps.automated || platform === 'win32') return fromValues(own, own.VAULT_NAMESPACE || own.VAULT_CACERT ? 'env' : 'none')

    const shell = this.deps.shell ? this.deps.shell() : userShell(env)
    if (!shell) return fromValues(own, 'none')
    const output = await (this.deps.spawnShell ?? defaultSpawn)(shell, ['-ilc', loginShellScript()], {
      // Keep the shell quiet and non-blocking: no oh-my-zsh update prompt, no tmux auto-start.
      env: { ...env, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTARTED: 'true', TERM: env.TERM ?? 'dumb' },
      timeoutMs: this.deps.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS,
    })
    const shellValues = output ? parseLoginShellOutput(output) : {}
    if (!shellValues.VAULT_ADDR) return fromValues(own, 'none')
    // The process environment wins variable by variable; the shell fills the rest.
    return fromValues({ ...shellValues, ...own }, 'login-shell')
  }
}
