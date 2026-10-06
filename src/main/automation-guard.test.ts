import { describe, expect, it } from 'vitest'
import { assertHostAllowed, assertUrlAllowed, defaultDbeaverScanAllowed, isAutomatedRun, isLoopbackHost } from './automation-guard'

describe('automation guard', () => {
  it('recognises loopback hosts only', () => {
    for (const h of ['localhost', 'LOCALHOST', 'db.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) expect(isLoopbackHost(h)).toBe(true)
    for (const h of ['pg-prod.example.cloud', '10.0.0.5', '192.168.1.2', '0.0.0.0', '127.0.0.256', 'localhost.evil.com', '']) expect(isLoopbackHost(h)).toBe(false)
  })

  it('detects automation from the env flag or Playwright', () => {
    expect(isAutomatedRun({ DATAGRIPPE_AUTOMATION: '1' }, [])).toBe(true)
    expect(isAutomatedRun({}, ['/x/Electron', '-r', '/repo/node_modules/playwright-core/lib/server/electron/loader.js'])).toBe(true)
    expect(isAutomatedRun({}, ['/Applications/DataGrippe.app/Contents/MacOS/DataGrippe'])).toBe(false)
  })

  it('blocks non-local targets only during automated runs', () => {
    expect(() => assertHostAllowed('pg-prod.example.cloud', 'database host', true)).toThrow(/Blocked/)
    expect(() => assertHostAllowed('127.0.0.1', 'database host', true)).not.toThrow()
    expect(() => assertHostAllowed('pg-prod.example.cloud', 'database host', false)).not.toThrow()
    expect(() => assertUrlAllowed('https://vault.example.cloud', 'Vault', true)).toThrow(/Blocked/)
    expect(() => assertUrlAllowed('http://127.0.0.1:58200', 'Vault', true)).not.toThrow()
  })

  it('only lets automated runs scan DBeaver under a substitute HOME', () => {
    expect(defaultDbeaverScanAllowed(false)).toBe(true)
    // Under vitest HOME is the real home directory: an automated run would be refused.
    expect(defaultDbeaverScanAllowed(true)).toBe(false)
  })
})
