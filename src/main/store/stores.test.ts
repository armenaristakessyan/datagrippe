import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type HistoryEntry } from '@shared/types'
import { HISTORY_MAX_SQL_CHARS, HISTORY_MAX_TOTAL_CHARS, HistoryStore, historySql, redactSecrets } from './history'
import { HostKeyStore } from './host-keys'
import { SecretStore } from './secrets'
import { SettingsStore, sanitizeSettings } from './settings'
import { fitBounds, WindowStateStore } from './window-state'
import { WorkspaceStore } from './workspace'

const silent = { warn: vi.fn(), error: vi.fn() }

function entry(i: number, overrides: Partial<HistoryEntry> = {}): Omit<HistoryEntry, 'id'> {
  return {
    connectionId: i % 2 ? 'a' : 'b',
    sql: `SELECT ${i}`,
    executedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    durationMs: i,
    success: true,
    ...overrides,
  }
}

describe('stores', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dg-stores-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  describe('settings', () => {
    it('merges with defaults and clamps values', () => {
      expect(sanitizeSettings({})).toEqual(DEFAULT_SETTINGS)
      const s = sanitizeSettings({ maxRows: 0, editorFontSize: 100, theme: 'neon', editorTabSize: 3.6, bogus: 1 })
      expect(s.maxRows).toBe(1)
      expect(s.editorFontSize).toBe(32)
      expect(s.theme).toBe(DEFAULT_SETTINGS.theme)
      expect(s.editorTabSize).toBe(4)
      expect('bogus' in s).toBe(false)
      expect(sanitizeSettings({ maxRows: 1e9, editorFontSize: 2 })).toMatchObject({ maxRows: 100_000, editorFontSize: 9 })
    })

    it('keeps an app icon id only', () => {
      expect(sanitizeSettings({ appIcon: 'datagrip-halo' }).appIcon).toBe('datagrip-halo')
      expect(sanitizeSettings({ appIcon: 'Not An Id' }).appIcon).toBe(DEFAULT_SETTINGS.appIcon)
      expect(sanitizeSettings({ appIcon: 42 }).appIcon).toBe(DEFAULT_SETTINGS.appIcon)
    })

    it('persists updates and reloads partial files', () => {
      const store = new SettingsStore(dir, silent)
      expect(store.get()).toEqual(DEFAULT_SETTINGS)
      const next = store.update({ theme: 'light', maxRows: 1000 })
      expect(next).toMatchObject({ theme: 'light', maxRows: 1000, editorFontSize: DEFAULT_SETTINGS.editorFontSize })
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ editorFontSize: 15 }))
      expect(new SettingsStore(dir, silent).get()).toEqual({ ...DEFAULT_SETTINGS, editorFontSize: 15 })
    })
  })

  describe('history', () => {
    it('keeps newest first and caps entries', () => {
      const store = new HistoryStore(dir, { max: 5, debounceMs: 0, log: silent })
      for (let i = 0; i < 8; i++) store.add(entry(i))
      const all = store.list()
      expect(all).toHaveLength(5)
      expect(all[0].sql).toBe('SELECT 7')
      expect(all[4].sql).toBe('SELECT 3')
      expect(all.every((e) => typeof e.id === 'string' && e.id.length > 0)).toBe(true)
    })

    it('default cap is 2000', () => {
      const store = new HistoryStore(dir, { debounceMs: 60_000, log: silent })
      for (let i = 0; i < 2005; i++) store.add(entry(i))
      expect(store.list()).toHaveLength(2000)
    })

    it('filters by connection and case-insensitive substring, with limit', () => {
      const store = new HistoryStore(dir, { debounceMs: 0, log: silent })
      store.add(entry(1, { sql: 'select * from Users' }))
      store.add(entry(2, { sql: 'UPDATE users SET x = 1' }))
      store.add(entry(3, { sql: 'select 1' }))
      expect(store.list({ search: 'USERS' }).map((e) => e.sql)).toEqual(['UPDATE users SET x = 1', 'select * from Users'])
      expect(store.list({ connectionId: 'a' }).map((e) => e.sql)).toEqual(['select 1', 'select * from Users'])
      expect(store.list({ limit: 1 })).toHaveLength(1)
    })

    it('clears one connection or everything, and flushes debounced writes', () => {
      const store = new HistoryStore(dir, { debounceMs: 10_000, log: silent })
      store.add(entry(1))
      store.add(entry(2))
      store.clear('a')
      expect(store.list().map((e) => e.connectionId)).toEqual(['b'])
      store.flush()
      expect(JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8'))).toHaveLength(1)
      store.clear()
      expect(store.list()).toEqual([])
    })
  })

  describe('history size and secrets', () => {
    it('cuts long scripts and flags them', () => {
      const store = new HistoryStore(dir, { debounceMs: 0, log: silent })
      const big = 'select 1;\n'.repeat(20_000)
      const added = store.add(entry(1, { sql: big }))
      expect(added.sql).toHaveLength(HISTORY_MAX_SQL_CHARS)
      expect(added.truncated).toBe(true)
      expect(store.add(entry(2)).truncated).toBeUndefined()
    })

    it('replaces the newest entry when the same statement runs again', () => {
      const store = new HistoryStore(dir, { debounceMs: 0, log: silent })
      store.add(entry(1, { sql: 'select 1', connectionId: 'a' }))
      store.add(entry(2, { sql: 'select 1', connectionId: 'a', durationMs: 99 }))
      expect(store.list()).toHaveLength(1)
      expect(store.list()[0].durationMs).toBe(99)
      store.add(entry(3, { sql: 'select 1', connectionId: 'b' }))
      store.add(entry(4, { sql: 'select 1', connectionId: 'b', schema: 'sales' }))
      expect(store.list().map((e) => e.connectionId)).toEqual(['b', 'b', 'a'])
    })

    it('drops the oldest entries past the total size cap', () => {
      const store = new HistoryStore(dir, { debounceMs: 0, log: silent })
      const chunk = 'x'.repeat(HISTORY_MAX_SQL_CHARS)
      const count = HISTORY_MAX_TOTAL_CHARS / HISTORY_MAX_SQL_CHARS + 10
      for (let i = 0; i < count; i++) store.add(entry(i, { sql: `${i}${chunk}`.slice(0, HISTORY_MAX_SQL_CHARS) }))
      const total = store.list().reduce((n, e) => n + e.sql.length, 0)
      expect(total).toBeLessThanOrEqual(HISTORY_MAX_TOTAL_CHARS)
      expect(store.list()[0].sql.startsWith(String(count - 1))).toBe(true)
    })

    it('redacts PASSWORD / SECRET literals, leaving everything else', () => {
      expect(redactSecrets("ALTER ROLE app WITH LOGIN PASSWORD 'hunter2'", 'postgres')).toBe("ALTER ROLE app WITH LOGIN PASSWORD '********'")
      expect(redactSecrets("CREATE LOGIN bob WITH PASSWORD = N'S3cr''et!', CHECK_POLICY = OFF", 'mssql')).toBe(
        "CREATE LOGIN bob WITH PASSWORD = '********', CHECK_POLICY = OFF",
      )
      expect(redactSecrets("CREATE CREDENTIAL c WITH IDENTITY = 'id', SECRET = 'k3y'", 'mssql')).toBe(
        "CREATE CREDENTIAL c WITH IDENTITY = 'id', SECRET = '********'",
      )
      expect(redactSecrets("SELECT 'password' AS label, password FROM users", 'postgres')).toBe("SELECT 'password' AS label, password FROM users")
      expect(historySql("alter user x password 'p'", 'postgres')).toEqual({ sql: "alter user x password '********'" })
    })
  })

  describe('secrets', () => {
    const crypto = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s, 'utf8'),
      decryptString: (b: Buffer) => b.toString('utf8'),
    }
    const failing = { ...crypto, decryptString: (): string => { throw new Error('denied') } }

    it('keeps entries it cannot decrypt until they are replaced or deleted', () => {
      const first = new SecretStore(dir, crypto, silent)
      first.setStored('prod', { password: 'p' })
      first.setStored('staging', { password: 's' })
      const second = new SecretStore(dir, failing, silent)
      expect(second.unreadableIds().sort()).toEqual(['prod', 'staging'])
      expect(second.hasStoredPassword('prod')).toBe(false)
      second.setStored('new', { password: 'n' })
      second.setStored('staging', {})
      let onDisk = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')) as Record<string, string>
      expect(Object.keys(onDisk).sort()).toEqual(['new', 'prod', 'staging'])
      second.setStored('staging', { password: 'typed again' })
      second.delete('prod')
      onDisk = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')) as Record<string, string>
      expect(Object.keys(onDisk).sort()).toEqual(['new', 'staging'])
      expect(new SecretStore(dir, crypto, silent).getStored('staging')).toEqual({ password: 'typed again' })
    })
  })

  describe('ssh host keys', () => {
    const key = { host: 'Bastion.example', port: 22, keyType: 'ssh-ed25519', fingerprint: `SHA256:${'A'.repeat(43)}`, changed: false }

    it('trusts per endpoint, replaces on re-trust and survives a reload', () => {
      const store = new HostKeyStore(dir, { log: silent })
      expect(store.trusted('bastion.example', 22)).toEqual([])
      store.trust(key)
      expect(store.trusted('bastion.example', 22)).toEqual([{ keyType: 'ssh-ed25519', fingerprint: key.fingerprint }])
      expect(store.trusted('bastion.example', 2222)).toEqual([])
      store.trust({ ...key, fingerprint: `SHA256:${'B'.repeat(43)}` })
      expect(new HostKeyStore(dir, { log: silent }).trusted('BASTION.example', 22)).toEqual([{ keyType: 'ssh-ed25519', fingerprint: `SHA256:${'B'.repeat(43)}` }])
      store.forget('bastion.example', 22)
      expect(store.trusted('bastion.example', 22)).toEqual([])
    })

    it('rejects malformed keys', () => {
      const store = new HostKeyStore(dir, { log: silent })
      expect(() => store.trust({ ...key, fingerprint: 'MD5:aa' })).toThrow(/fingerprint/)
      expect(() => store.trust({ ...key, port: 0 })).toThrow(/host/)
    })
  })

  describe('workspace', () => {
    it('round-trips and is null when missing', () => {
      const store = new WorkspaceStore(dir, { debounceMs: 0, log: silent })
      expect(store.load()).toBeNull()
      store.save({ version: 1, tabs: [{ id: 't', kind: 'console', title: 'Console', connectionId: 'c', content: 'select 1' }], activeTabId: 't' })
      const reloaded = new WorkspaceStore(dir, { log: silent }).load()
      expect(reloaded?.tabs[0].content).toBe('select 1')
      expect(reloaded?.activeTabId).toBe('t')
    })

    it('recovers from a corrupt file', () => {
      writeFileSync(join(dir, 'workspace.json'), '[1,2')
      expect(new WorkspaceStore(dir, { log: silent }).load()).toBeNull()
    })
  })

  describe('window state', () => {
    it('persists bounds', () => {
      const store = new WindowStateStore(dir, { debounceMs: 0, log: silent })
      store.save({ bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: true })
      expect(new WindowStateStore(dir, { log: silent }).get()).toEqual({ bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: true })
    })

    it('fitBounds rejects off-screen bounds and clamps sizes', () => {
      const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }]
      expect(fitBounds({ x: 100, y: 100, width: 1200, height: 800 }, displays)).toEqual({ x: 100, y: 100, width: 1200, height: 800 })
      expect(fitBounds({ x: 5000, y: 100, width: 1200, height: 800 }, displays)).toBeUndefined()
      expect(fitBounds({ x: 100, y: 2000, width: 1200, height: 800 }, displays)).toBeUndefined()
      expect(fitBounds({ x: 0, y: 0, width: 4000, height: 3000 }, displays)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
      expect(fitBounds({ x: 0, y: 0, width: 100, height: 100 }, displays)).toEqual({ x: 0, y: 0, width: 960, height: 600 })
      expect(fitBounds(undefined, displays)).toBeUndefined()
    })
  })
})
