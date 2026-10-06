import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig, ConnectionSecrets, DbErrorInfo, ServerInfo, VaultStatus } from '@shared/types'

const connectApi = vi.fn<(id: string, secrets?: ConnectionSecrets) => Promise<ServerInfo>>()
const vaultStatusApi = vi.fn<(id: string) => Promise<VaultStatus | null>>()
const disconnectApi = vi.fn<(id: string) => Promise<void>>()
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    info: DbErrorInfo
    constructor(info: DbErrorInfo) {
      super(info.message)
      this.info = info
    }
  }
  return {
    ApiError,
    api: { connections: { connect: connectApi, disconnect: disconnectApi }, vault: { status: vaultStatusApi } },
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    errorInfo: (e: unknown) => (e instanceof ApiError ? e.info : { message: e instanceof Error ? e.message : String(e), kind: 'internal' }),
    onEvent: () => () => undefined,
  }
})

const { ApiError } = (await import('@/lib/api')) as unknown as { ApiError: new (info: DbErrorInfo) => Error }
const { useConnections, neededSecret } = await import('./connections')
const { useUi } = await import('./ui')
const { useVault } = await import('./vault')

const config = { id: 'c1', name: 'Prod', dialect: 'postgres', host: 'db', port: 5432, savePassword: false } as ConnectionConfig
const info = { currentDatabase: 'app', versionShort: '16' } as ServerInfo

function prompt() {
  const dialog = useUi.getState().dialogs[0]
  if (!dialog || dialog.type !== 'password') throw new Error('no password prompt')
  return dialog
}

beforeEach(() => {
  connectApi.mockReset()
  vaultStatusApi.mockReset()
  disconnectApi.mockReset()
  useUi.setState({ dialogs: [] })
  useVault.setState({ prompts: [], statuses: {}, login: null })
  useConnections.setState({ connections: [config], runtime: {}, loaded: true })
})

describe('connect with a password prompt', () => {
  it('keeps the prompt open on a wrong password and connects with the corrected one', async () => {
    connectApi.mockImplementation(async (_id, secrets) => {
      if (!secrets) throw new ApiError({ message: 'Password required', kind: 'needs-password' })
      if (secrets.password !== 'right') throw new ApiError({ message: 'password authentication failed', kind: 'database' })
      return info
    })
    const connecting = useConnections.getState().connect('c1')
    await vi.waitFor(() => expect(useUi.getState().dialogs).toHaveLength(1))
    const dialog = prompt()
    // The dialog calls submit; a failure keeps it open (it shows the error) and nothing resolves yet.
    await expect(dialog.submit?.('wrong')).rejects.toThrow('password authentication failed')
    expect(useConnections.getState().runtime.c1?.status).toBe('connecting')
    await dialog.submit?.('right')
    dialog.resolve('right')
    await expect(connecting).resolves.toBe(info)
    expect(useConnections.getState().runtime.c1).toEqual({ status: 'connected', info })
    expect(connectApi).toHaveBeenLastCalledWith('c1', { password: 'right' })
  })

  it('cancelling the prompt leaves the connection disconnected, not in error', async () => {
    connectApi.mockRejectedValue(new ApiError({ message: 'Password required', kind: 'needs-password' }))
    const connecting = useConnections.getState().connect('c1')
    await vi.waitFor(() => expect(useUi.getState().dialogs).toHaveLength(1))
    prompt().resolve(null)
    await expect(connecting).resolves.toBeNull()
    expect(useConnections.getState().runtime.c1?.status).toBe('disconnected')
  })

  it('reports other failures as errors without prompting', async () => {
    connectApi.mockRejectedValue(new ApiError({ message: 'host not found', kind: 'connection' }))
    await expect(useConnections.getState().connect('c1')).rejects.toThrow('host not found')
    expect(useUi.getState().dialogs).toHaveLength(0)
    expect(useConnections.getState().runtime.c1).toMatchObject({ status: 'error', error: 'host not found' })
  })
})

const vaultConfig = {
  ...config,
  id: 'v1',
  name: 'Vault prod',
  user: '',
  authMode: 'vault',
  vault: { address: 'https://vault.example.com', loginMethod: 'ldap', username: 'jane', secretPath: 'database/creds/ro' },
} as ConnectionConfig

const needs = (secretField?: DbErrorInfo['secretField']) => new ApiError({ message: 'Secret required', kind: 'needs-password', secretField })

function vaultPrompt() {
  const prompt = useVault.getState().prompts[0]
  if (!prompt) throw new Error('no Vault prompt')
  return prompt
}

describe('secret prompts routed by secretField', () => {
  beforeEach(() => {
    useConnections.setState({ connections: [config, vaultConfig], runtime: {}, loaded: true })
  })

  it('reads the secret main asks for (password by default)', () => {
    expect(neededSecret(needs())).toBe('password')
    expect(neededSecret(needs('vaultToken'))).toBe('vaultToken')
    expect(neededSecret(new ApiError({ message: 'x', kind: 'vault' }))).toBeNull()
    expect(neededSecret(new Error('x'))).toBeNull()
  })

  it('asks the Vault password through the Vault prompt and connects with it', async () => {
    const status: VaultStatus = { connectionId: 'v1', state: 'valid', info: null }
    vaultStatusApi.mockResolvedValue(status)
    connectApi.mockImplementation(async (_id, secrets) => {
      if (!secrets?.vaultPassword) throw needs('vaultPassword')
      if (secrets.vaultPassword !== 'right') throw new ApiError({ message: 'invalid username or password', kind: 'vault' })
      return info
    })
    const connecting = useConnections.getState().connect('v1')
    await vi.waitFor(() => expect(useVault.getState().prompts).toHaveLength(1))
    expect(useUi.getState().dialogs).toHaveLength(0)
    const prompt = vaultPrompt()
    expect(prompt.field).toBe('vaultPassword')
    expect(prompt.target.vault?.username).toBe('jane')
    await expect(prompt.submit?.('wrong')).rejects.toThrow('invalid username or password')
    await prompt.submit?.('right')
    prompt.resolve('right')
    await expect(connecting).resolves.toBe(info)
    expect(connectApi).toHaveBeenLastCalledWith('v1', { vaultPassword: 'right' })
    // The lease status of a Vault connection is loaded once connected.
    await vi.waitFor(() => expect(useVault.getState().statuses.v1).toEqual(status))
  })

  it('chains prompts: a Vault token, then another secret, sending both on the last attempt', async () => {
    connectApi.mockImplementation(async (_id, secrets) => {
      if (!secrets?.vaultToken) throw needs('vaultToken')
      if (!secrets.password) throw needs('password')
      return info
    })
    const connecting = useConnections.getState().connect('v1')
    await vi.waitFor(() => expect(useVault.getState().prompts).toHaveLength(1))
    const tokenPrompt = vaultPrompt()
    expect(tokenPrompt.field).toBe('vaultToken')
    await tokenPrompt.submit?.('hvs.token')
    tokenPrompt.resolve('hvs.token')
    useVault.setState({ prompts: [] })
    await vi.waitFor(() => expect(useUi.getState().dialogs).toHaveLength(1))
    const passwordPrompt = prompt()
    await passwordPrompt.submit?.('db')
    passwordPrompt.resolve('db')
    await expect(connecting).resolves.toBe(info)
    expect(connectApi).toHaveBeenLastCalledWith('v1', { vaultToken: 'hvs.token', password: 'db' })
  })

  it('opens the Vault prompt with the reason when a saved secret was rejected', async () => {
    const rejected = new ApiError({ message: 'Vault rejected the password for jane on vault.example.com', kind: 'needs-password', secretField: 'vaultPassword', detail: 'invalid username or password (400)' })
    connectApi.mockRejectedValueOnce(rejected).mockRejectedValueOnce(needs('vaultPassword'))
    const first = useConnections.getState().connect('v1')
    await vi.waitFor(() => expect(useVault.getState().prompts).toHaveLength(1))
    expect(vaultPrompt().error?.message).toMatch(/rejected the password/)
    vaultPrompt().resolve(null)
    await first
    useVault.setState({ prompts: [] })
    // A merely missing secret opens a clean prompt.
    const second = useConnections.getState().connect('v1')
    await vi.waitFor(() => expect(useVault.getState().prompts).toHaveLength(1))
    expect(vaultPrompt().error).toBeUndefined()
    vaultPrompt().resolve(null)
    await second
  })

  it('cancelling a Vault prompt leaves the connection disconnected', async () => {
    connectApi.mockRejectedValue(needs('vaultToken'))
    const connecting = useConnections.getState().connect('v1')
    await vi.waitFor(() => expect(useVault.getState().prompts).toHaveLength(1))
    vaultPrompt().resolve(null)
    await expect(connecting).resolves.toBeNull()
    expect(useConnections.getState().runtime.v1?.status).toBe('disconnected')
  })

  it('keeps the kind of the error (Vault errors are presented as such)', async () => {
    connectApi.mockRejectedValue(new ApiError({ message: 'permission denied', kind: 'vault' }))
    await expect(useConnections.getState().connect('v1')).rejects.toThrow('permission denied')
    expect(useConnections.getState().runtime.v1).toMatchObject({ status: 'error', error: 'permission denied', errorKind: 'vault' })
  })

  it('forgets the lease status reported before the database refused the Vault user', async () => {
    // event:vaultStatus arrives while connections:connect is still running (lease installed once Vault
    // issued it); the database then refuses the login and main revokes the lease without a new status.
    connectApi.mockImplementation(async () => {
      useVault.getState().setStatus({
        connectionId: 'v1',
        state: 'valid',
        info: { username: 'v-oidc-ro-x1', kind: 'dynamic', expiresAt: Date.now() + 3_600_000, leaseDurationSec: 3600, renewable: true, tokenSource: 'oidc', issuedAt: Date.now() },
      })
      throw new ApiError({ message: "Login failed for user 'v-oidc-ro-x1'.", code: '18456', kind: 'database' })
    })
    await expect(useConnections.getState().connect('v1')).rejects.toThrow(/Login failed/)
    expect(useConnections.getState().runtime.v1?.status).toBe('error')
    expect(useVault.getState().statuses.v1).toBeUndefined()
  })

  it('forgets the lease status when a follow-up prompt is cancelled', async () => {
    connectApi.mockImplementation(async () => {
      useVault.getState().setStatus({ connectionId: 'v1', state: 'valid', info: null })
      throw needs('vaultToken')
    })
    const connecting = useConnections.getState().connect('v1')
    await vi.waitFor(() => expect(useVault.getState().prompts).toHaveLength(1))
    vaultPrompt().resolve(null)
    await expect(connecting).resolves.toBeNull()
    expect(useVault.getState().statuses.v1).toBeUndefined()
  })

  it('forgets the Vault status on disconnect', async () => {
    useVault.setState({ statuses: { v1: { connectionId: 'v1', state: 'valid', info: null } } })
    disconnectApi.mockResolvedValue(undefined)
    await useConnections.getState().disconnect('v1')
    expect(useVault.getState().statuses.v1).toBeUndefined()
  })
})
