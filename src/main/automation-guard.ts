// Safety net for automated runs (Playwright e2e suite, screenshot scripts, agents driving the app): the app
// may then only reach loopback hosts, so an automated run can never touch a real server — e.g. production
// connections imported from DBeaver — even by mistake.
import { homedir, userInfo } from 'node:os'
import { DriverError } from './db/errors'

function electronSwitch(name: string): boolean {
  try {
    // Not a static import: this module is also loaded by unit tests, where 'electron' is just a path string.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { commandLine?: { hasSwitch(name: string): boolean } } }
    return electron.app?.commandLine?.hasSwitch(name) ?? false
  } catch {
    return false
  }
}

/** True when the app is driven by automation (explicit env flag or Playwright). */
export function isAutomatedRun(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = [...process.execArgv, ...process.argv]): boolean {
  if (env.DATAGRIPPE_AUTOMATION === '1') return true
  if (argv.some((arg) => arg.includes('playwright') || arg.startsWith('--remote-debugging-port'))) return true
  return electronSwitch('remote-debugging-port')
}

/** localhost, *.localhost, 127.0.0.0/8 and ::1 (with or without brackets). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  return m !== null && m.slice(1).every((part) => Number(part) <= 255)
}

/** Throws when an automated run tries to reach a non-loopback host. `what` names the target for the message. */
export function assertHostAllowed(host: string, what: string, automated: boolean = isAutomatedRun()): void {
  if (!automated || isLoopbackHost(host)) return
  throw DriverError.of(
    'connection',
    `Blocked: automated runs may only connect to local hosts (${what} "${host}"). Real servers are never contacted during tests.`,
  )
}

/** Same check for a URL (Vault address…). Invalid URLs are left to the caller's own validation. */
export function assertUrlAllowed(url: string, what: string, automated: boolean = isAutomatedRun()): void {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return
  }
  assertHostAllowed(host, what, automated)
}

/**
 * Automated runs must not read the developer's real DBeaver workspace (real host names would end up in
 * screenshots or fixtures). The e2e suite gives each app its own HOME, which stays allowed.
 */
export function defaultDbeaverScanAllowed(automated: boolean = isAutomatedRun()): boolean {
  if (!automated) return true
  try {
    return homedir() !== userInfo().homedir
  } catch {
    return false
  }
}
