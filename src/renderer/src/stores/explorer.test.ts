import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcEnvelope } from '@shared/ipc'
import type { ConnectionConfig } from '@shared/types'
import { useConnections } from './connections'
import { dbKey, defaultDatabase, defaultSchema, objectKey, schemaKey, useExplorer } from './explorer'

type Handler = (...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const invoke = vi.fn(async (channel: string, ...args: unknown[]): Promise<IpcEnvelope<unknown>> => {
  const handler = handlers[channel]
  if (!handler) return { ok: false, error: { message: `no handler for ${channel}` } }
  try {
    return { ok: true, value: await handler(...args) }
  } catch (error) {
    return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
  }
})
Object.defineProperty(globalThis, 'window', {
  value: { datagrippe: { invoke, on: () => () => undefined, platform: 'darwin' } },
  configurable: true,
})

function connection(id: string, extra: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id,
    name: id,
    dialect: 'postgres',
    host: 'h',
    port: 5432,
    database: '',
    user: 'u',
    savePassword: true,
    hasPassword: true,
    ssl: { mode: 'disable' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
    color: 'none',
    readOnly: false,
    productionGuard: false,
    options: {},
    createdAt: '',
    updatedAt: '',
    ...extra,
  }
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

beforeEach(() => {
  for (const key of Object.keys(handlers)) delete handlers[key]
  invoke.mockClear()
  useConnections.setState({ connections: [connection('c')], runtime: { c: { status: 'connected' } }, loaded: true })
  useExplorer.setState({ databases: {}, schemas: {}, objects: {}, details: {}, expanded: {}, selectedNode: null, filter: '' })
})

describe('explorer store loading', () => {
  it('shares one request between concurrent callers and caches the result', async () => {
    const gate = deferred<{ name: string; isSystem: boolean }[]>()
    handlers['meta:databases'] = () => gate.promise
    const a = useExplorer.getState().loadDatabases('c')
    const b = useExplorer.getState().loadDatabases('c')
    expect(useExplorer.getState().databases.c?.status).toBe('loading')
    gate.resolve([{ name: 'app', isSystem: false }])
    expect(await a).toEqual([{ name: 'app', isSystem: false }])
    expect(await b).toEqual([{ name: 'app', isSystem: false }])
    await useExplorer.getState().loadDatabases('c')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('records errors and retries on the next load', async () => {
    let fail = true
    handlers['meta:schemas'] = () => {
      if (fail) throw new Error('permission denied')
      return [{ name: 'public', isSystem: false }]
    }
    expect(await useExplorer.getState().loadSchemas('c', 'app')).toBeUndefined()
    expect(useExplorer.getState().schemas[dbKey('c', 'app')]).toEqual({ status: 'error', error: 'permission denied' })
    fail = false
    expect(await useExplorer.getState().loadSchemas('c', 'app')).toEqual([{ name: 'public', isSystem: false }])
  })

  it('reports the connection error when the connection cannot be opened', async () => {
    useConnections.setState({ runtime: {} })
    handlers['connections:connect'] = () => {
      throw new Error('Connection refused')
    }
    await useExplorer.getState().loadDatabases('c')
    expect(useExplorer.getState().databases.c).toEqual({ status: 'error', error: 'Connection refused' })
  })

  it('drops responses that arrive after an invalidation', async () => {
    const gate = deferred<never[]>()
    handlers['meta:objects'] = () => gate.promise
    const pending = useExplorer.getState().loadObjects('c', 'app', 'public')
    useExplorer.getState().invalidate('c')
    gate.resolve([])
    await pending
    expect(useExplorer.getState().objects[schemaKey('c', 'app', 'public')]).toBeUndefined()
  })
})

describe('refresh', () => {
  it('reloads every cached entry under the prefix and keeps stale data meanwhile', async () => {
    let version = 1
    handlers['meta:schemas'] = () => [{ name: `s${version}`, isSystem: false }]
    handlers['meta:objects'] = (_c, _d, schema) => [{ schema: String(schema), name: `t${version}`, kind: 'table' }]
    handlers['meta:databases'] = () => [{ name: `d${version}`, isSystem: false }]
    const ex = useExplorer.getState()
    await ex.loadDatabases('c')
    await ex.loadSchemas('c', 'app')
    await ex.loadObjects('c', 'app', 'public')
    await ex.loadObjects('c', 'other', 'public')
    version = 2

    const refreshing = useExplorer.getState().refresh('c', 'app')
    expect(useExplorer.getState().schemas[dbKey('c', 'app')]).toMatchObject({ status: 'loading', data: [{ name: 's1' }] })
    await refreshing
    const state = useExplorer.getState()
    expect(state.schemas[dbKey('c', 'app')]?.data).toEqual([{ name: 's2', isSystem: false }])
    expect(state.objects[schemaKey('c', 'app', 'public')]?.data?.[0]?.name).toBe('t2')
    // Outside the prefix: untouched.
    expect(state.objects[schemaKey('c', 'other', 'public')]?.data?.[0]?.name).toBe('t1')
    expect(state.databases.c?.data?.[0]?.name).toBe('d1')

    await useExplorer.getState().refresh('c')
    expect(useExplorer.getState().databases.c?.data?.[0]?.name).toBe('d2')
  })

  it('refreshes one table’s details', async () => {
    let n = 0
    handlers['meta:tableDetails'] = () => ({ schema: 'public', name: 't', kind: 'table', columns: [], primaryKey: [], indexes: [], foreignKeys: [], referencedBy: [], constraints: [], triggers: [], rowEstimate: ++n })
    await useExplorer.getState().loadDetails('c', 'app', 'public', 't')
    await useExplorer.getState().refresh('c', 'app', 'public', 't')
    expect(useExplorer.getState().details[objectKey('c', 'app', 'public', 't')]?.data?.rowEstimate).toBe(2)
  })
})

describe('lifecycle', () => {
  it('clears the caches of a connection that disconnects or is deleted', async () => {
    handlers['meta:databases'] = () => [{ name: 'app', isSystem: false }]
    await useExplorer.getState().loadDatabases('c')
    useConnections.setState({ runtime: { c: { status: 'disconnected' } } })
    expect(useExplorer.getState().databases.c).toBeUndefined()

    useConnections.setState({ runtime: { c: { status: 'connected' } } })
    await useExplorer.getState().loadDatabases('c')
    useConnections.setState({ connections: [] })
    expect(useExplorer.getState().databases.c).toBeUndefined()
  })

  it('keeps the error of a failed first connection attempt visible', async () => {
    useConnections.setState({ runtime: { c: { status: 'connecting' } } })
    useExplorer.setState({ databases: { c: { status: 'error', error: 'boom' } } })
    useConnections.setState({ runtime: { c: { status: 'error', error: 'boom' } } })
    expect(useExplorer.getState().databases.c?.error).toBe('boom')
  })
})

describe('defaults', () => {
  it('pick the configured database, else the server one, else the first user database', () => {
    useConnections.setState({ connections: [connection('c', { database: 'shop' })] })
    expect(defaultDatabase('c')).toBe('shop')
    useConnections.setState({
      connections: [connection('c')],
      runtime: { c: { status: 'connected', info: { dialect: 'postgres', version: '', versionShort: '', currentDatabase: 'postgres', currentUser: 'u' } } },
    })
    expect(defaultDatabase('c')).toBe('postgres')
  })

  it('pick the configured schema, then public / dbo, then the first user schema', () => {
    useExplorer.setState({
      schemas: {
        [dbKey('c', 'app')]: {
          status: 'ready',
          data: [
            { name: 'information_schema', isSystem: true },
            { name: 'public', isSystem: false },
            { name: 'sales', isSystem: false },
          ],
        },
      },
    })
    expect(defaultSchema('c', 'app')).toBe('public')
    useConnections.setState({ connections: [connection('c', { options: { defaultSchema: 'sales' } })] })
    expect(defaultSchema('c', 'app')).toBe('sales')
    useConnections.setState({ connections: [connection('c', { dialect: 'mssql' })] })
    useExplorer.setState({ schemas: { [dbKey('c', 'app')]: { status: 'ready', data: [{ name: 'sys', isSystem: true }, { name: 'hr', isSystem: false }] } } })
    expect(defaultSchema('c', 'app')).toBe('hr')
  })
})
