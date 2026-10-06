import { beforeEach, describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '@shared/types'
import { markRegion, resetRegions } from '@/lib/recency'
import { useConnections } from '@/stores/connections'
import { useExplorer } from '@/stores/explorer'
import { useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { buildGlobalCommands, newConsole, pickConsoleConnection } from './useGlobalCommands'

function connection(id: string): ConnectionConfig {
  return {
    id,
    name: id,
    dialect: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'postgres',
    user: 'u',
    savePassword: false,
    hasPassword: false,
    ssl: { mode: 'disable' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'agent' },
    color: 'none',
    readOnly: false,
    productionGuard: false,
    options: {},
    createdAt: '',
    updatedAt: '',
  }
}

beforeEach(() => {
  resetRegions()
  useConnections.setState({ connections: [connection('a'), connection('b'), connection('c')], runtime: {}, loaded: true })
  useTabs.setState({ tabs: [], activeTabId: null, hydrated: false })
  useExplorer.setState({ selectedNode: null })
  useUi.setState({ connectionDialog: { open: false } })
})

describe('pickConsoleConnection', () => {
  it('prefers the active tab connection', () => {
    useTabs.getState().openConsole({ connectionId: 'b' })
    useConnections.setState({ runtime: { c: { status: 'connected' } } })
    expect(pickConsoleConnection()).toBe('b')
  })
  it('then the explorer selection', () => {
    useExplorer.setState({ selectedNode: 'c|postgres|public' })
    expect(pickConsoleConnection()).toBe('c')
  })
  it('then the first connected connection, then the first saved one', () => {
    useConnections.setState({ runtime: { b: { status: 'connected' } } })
    expect(pickConsoleConnection()).toBe('b')
    useConnections.setState({ runtime: {} })
    expect(pickConsoleConnection()).toBe('a')
  })
  it('prefers a connection picked in the explorer after the active tab was used', () => {
    useTabs.getState().openConsole({ connectionId: 'b' })
    // e.g. a connection created with Save & connect is selected in the explorer.
    useExplorer.getState().select('c')
    expect(pickConsoleConnection()).toBe('c')
    // Working in the tab again makes it the target.
    markRegion('workspace')
    expect(pickConsoleConnection()).toBe('b')
    useTabs.getState().setActive(useTabs.getState().tabs[0]!.id)
    expect(pickConsoleConnection()).toBe('b')
  })
  it('ignores tabs whose connection was deleted', () => {
    useTabs.getState().openConsole({ connectionId: 'gone' })
    expect(pickConsoleConnection()).toBe('a')
  })
})

describe('newConsole', () => {
  it('opens the connection dialog when there is no connection', () => {
    useConnections.setState({ connections: [] })
    newConsole()
    expect(useUi.getState().connectionDialog.open).toBe(true)
    expect(useTabs.getState().tabs).toHaveLength(0)
  })
  it('opens a console tab otherwise', () => {
    newConsole('c')
    const tab = useTabs.getState().tabs[0]
    expect(tab?.kind).toBe('console')
    expect(tab?.connectionId).toBe('c')
    expect(useTabs.getState().activeTabId).toBe(tab?.id)
  })
})

describe('global commands', () => {
  it('declare the native menu accelerators', () => {
    const byId = Object.fromEntries(buildGlobalCommands().map((c) => [c.id, c]))
    expect(byId['new-console']?.shortcut).toBe('CmdOrCtrl+T')
    expect(byId['new-connection']?.shortcut).toBe('CmdOrCtrl+Shift+N')
    expect(byId['close-tab']?.shortcut).toBe('CmdOrCtrl+W')
    expect(byId['command-palette']?.shortcut).toBe('CmdOrCtrl+K')
    expect(byId['go-to-object']?.shortcut).toBe('CmdOrCtrl+P')
    expect(byId['toggle-sidebar']?.shortcut).toBe('CmdOrCtrl+B')
    expect(byId['open-settings']?.shortcut).toBe('CmdOrCtrl+,')
    expect(byId['open-history']?.shortcut).toBe('CmdOrCtrl+Y')
    for (const c of buildGlobalCommands()) {
      expect(c.group).toBeTruthy()
      expect(c.icon).toBeTruthy()
    }
  })
  it('cycle tabs', () => {
    const first = useTabs.getState().openConsole({ connectionId: 'a' })
    const second = useTabs.getState().openConsole({ connectionId: 'a' })
    const byId = Object.fromEntries(buildGlobalCommands().map((c) => [c.id, c]))
    void byId['next-tab']?.run()
    expect(useTabs.getState().activeTabId).toBe(first)
    void byId['previous-tab']?.run()
    expect(useTabs.getState().activeTabId).toBe(second)
  })
  it('close-tab closes the active tab when no overlay is open', () => {
    useTabs.getState().openConsole({ connectionId: 'a' })
    const byId = Object.fromEntries(buildGlobalCommands().map((c) => [c.id, c]))
    void byId['close-tab']?.run()
    expect(useTabs.getState().tabs).toHaveLength(0)
  })
  it('show-sessions opens one sessions tab per connection', () => {
    useTabs.getState().openConsole({ connectionId: 'b' })
    const byId = Object.fromEntries(buildGlobalCommands().map((c) => [c.id, c]))
    void byId['show-sessions']?.run()
    void byId['show-sessions']?.run()
    const sessions = useTabs.getState().tabs.filter((t) => t.kind === 'sessions')
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.connectionId).toBe('b')
    expect(useTabs.getState().activeTabId).toBe(sessions[0]?.id)
  })
  it('offers focus commands for the editor, results and explorer', () => {
    const ids = buildGlobalCommands().map((c) => c.id)
    expect(ids).toEqual(expect.arrayContaining(['focus-editor', 'focus-results', 'focus-explorer']))
  })
})
