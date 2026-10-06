import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { DriverError } from './db/errors'

const handle = vi.fn()
vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0', getPath: () => '/tmp/userdata' },
  ipcMain: { handle: (...args: unknown[]) => handle(...args), removeHandler: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  dialog: {},
}))

const { ARG_SPECS, createHandlers, isSafeExternalUrl, registerIpc, validateArgs, wrapHandler } = await import('./ipc')
type Deps = Parameters<typeof createHandlers>[0]

const fakeEvent = {} as IpcMainInvokeEvent
const log = { error: vi.fn() }

describe('ipc', () => {
  it('registers a handler for every channel', () => {
    const deps = { stores: {}, sessions: {}, getWindow: () => null } as unknown as Deps
    registerIpc(deps)
    const registered = handle.mock.calls.map((c) => c[0] as string).sort()
    expect(registered).toEqual(Object.keys(ARG_SPECS).sort())
    expect(registered).toContain('files:exportQuery')
    expect(registered.length).toBe(Object.keys(createHandlers(deps)).length)
  })

  it('validates argument shapes', () => {
    expect(() => validateArgs('meta:objects', ['c', 'db', 'public'])).not.toThrow()
    expect(() => validateArgs('meta:objects', ['c', 'db'])).toThrow(/argument 3/)
    expect(() => validateArgs('session:fetchMore', ['s', 'c', '10'])).toThrow(DriverError)
    expect(() => validateArgs('connections:connect', ['id'])).not.toThrow()
    expect(() => validateArgs('connections:connect', ['id', 'pw'])).toThrow()
    expect(() => validateArgs('data:applyChanges', [{}, {}])).toThrow(/array/)
    expect(() => validateArgs('history:clear', [])).not.toThrow()
  })

  it('wraps results and errors in envelopes', async () => {
    const ok = wrapHandler('connections:active', () => ['a'], { getWindow: () => null, log }, () => true)
    expect(await ok(fakeEvent)).toEqual({ ok: true, value: ['a'] })

    const known = wrapHandler(
      'connections:delete',
      () => {
        throw DriverError.of('not-found', 'gone')
      },
      { getWindow: () => null, log },
      () => true,
    )
    expect(await known(fakeEvent, 'x')).toEqual({ ok: false, error: { kind: 'not-found', message: 'gone' } })
    expect(log.error).not.toHaveBeenCalled()

    const unexpected = wrapHandler(
      'connections:delete',
      async () => {
        throw new Error('kaboom')
      },
      { getWindow: () => null, log },
      () => true,
    )
    expect(await unexpected(fakeEvent, 'x')).toMatchObject({ ok: false, error: { kind: 'internal', message: 'kaboom' } })
    expect(log.error).toHaveBeenCalled()

    const invalid = wrapHandler('connections:delete', () => undefined, { getWindow: () => null, log }, () => true)
    expect(await invalid(fakeEvent, 42)).toMatchObject({ ok: false, error: { kind: 'invalid-input' } })
  })

  it('rejects untrusted senders', async () => {
    const fn = vi.fn()
    const wrapped = wrapHandler('connections:active', fn, { getWindow: () => null, log })
    expect(await wrapped(fakeEvent)).toMatchObject({ ok: false, error: { message: 'Untrusted IPC sender.' } })
    expect(fn).not.toHaveBeenCalled()
  })

  it('only opens http(s) links', async () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true)
    expect(isSafeExternalUrl('http://example.com/a?b')).toBe(true)
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('not a url')).toBe(false)
    const handlers = createHandlers({ stores: {}, sessions: {}, getWindow: () => null } as unknown as Deps)
    await expect(Promise.resolve(handlers['app:openExternal']('file:///x'))).rejects.toMatchObject({ info: { kind: 'invalid-input' } })
  })

  it('routes the Vault channels to the session manager and validates the logout address', async () => {
    const sessions = {
      vaultTest: vi.fn(async () => ({ ok: true })),
      vaultStatus: vi.fn(() => null),
      vaultRefresh: vi.fn(async () => ({ connectionId: 'c', state: 'valid', info: null })),
      vaultCancelLogin: vi.fn(),
      vaultLogout: vi.fn(),
    }
    const handlers = createHandlers({ stores: {}, sessions, getWindow: () => null } as unknown as Deps)
    const input = { authMode: 'vault' } as never
    await handlers['vault:test'](input)
    expect(sessions.vaultTest).toHaveBeenCalledWith(input)
    expect(handlers['vault:status']('c')).toBeNull()
    await handlers['vault:refresh']('c')
    expect(sessions.vaultRefresh).toHaveBeenCalledWith('c')
    handlers['vault:cancelLogin']()
    expect(sessions.vaultCancelLogin).toHaveBeenCalled()
    handlers['vault:logout']('https://vault.example.cloud/', 'team')
    expect(sessions.vaultLogout).toHaveBeenCalledWith('https://vault.example.cloud/', 'team')
    expect(() => handlers['vault:logout']('vault.example.cloud')).toThrow(DriverError)
    expect(sessions.vaultLogout).toHaveBeenCalledTimes(1)
    expect(() => validateArgs('vault:logout', ['https://v', null])).not.toThrow()
    expect(() => validateArgs('vault:test', ['x'])).toThrow(/expected object/)
  })
})
