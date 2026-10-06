import { useEffect, useState, type ReactNode } from 'react'
import { Database, Layers, Lock, Moon, Sun } from 'lucide-react'
import { Spinner, StatusDot, Tooltip } from '@/components/ui'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/format'
import { hasBridge } from '@/lib/platform'
import { toggleTheme } from '@/lib/theme'
import { connectionIdOf } from '@/components/explorer/tree'
import { vaultMessage } from '@/components/vault/format'
import { VaultStatusChip } from '@/components/vault/VaultIndicators'
import { useConnections } from '@/stores/connections'
import { useConsoles, type ConsoleRuntime } from '@/stores/consoles'
import { useExplorer } from '@/stores/explorer'
import { useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { summarizeExecution } from './status-summary'

let versionPromise: Promise<string | null> | null = null
function loadAppVersion(): Promise<string | null> {
  versionPromise ??= hasBridge()
    ? api.app
        .info()
        .then((info) => info.version)
        .catch(() => null)
    : Promise.resolve(null)
  return versionPromise
}

function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void loadAppVersion().then((v) => alive && setVersion(v))
    return () => {
      alive = false
    }
  }, [])
  return version
}

export function StatusBar() {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === s.activeTabId))
  // Without a tab, the connection selected in the explorer.
  const selectedConnectionId = useExplorer((s) => (s.selectedNode ? connectionIdOf(s.selectedNode) : undefined))
  const connectionId = tab?.connectionId ?? selectedConnectionId
  const connection = useConnections((s) => (connectionId ? s.connections.find((c) => c.id === connectionId) : undefined))
  const runtime = useConnections((s) => (connectionId ? s.runtime[connectionId] : undefined))
  const consoleRuntime = useConsoles((s) => (tab?.kind === 'console' ? s.runtimes[tab.id] : undefined))
  const theme = useUi((s) => s.resolvedTheme)
  const version = useAppVersion()

  const status = runtime?.status ?? 'disconnected'
  const database = !tab || tab.kind === 'sessions' ? undefined : tab.kind === 'console' ? (tab.database ?? connection?.database) : tab.database
  const schema = !tab || tab.kind === 'sessions' ? undefined : tab.kind === 'console' ? tab.schema : tab.table.schema

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-panel px-2.5 text-2xs text-subtle">
      {connection ? (
        <>
          <Tooltip content={runtime?.error ? (runtime.errorKind === 'vault' ? `Vault: ${vaultMessage(runtime.error)}` : runtime.error) : statusLabel(status)} side="top">
            <span className="flex min-w-0 items-center gap-1.5">
              <StatusDot status={status} size={6} />
              <span className="max-w-48 truncate text-muted">{connection.name}</span>
              {runtime?.info?.versionShort && <span className="tabular text-subtle">{runtime.info.versionShort}</span>}
              {connection.readOnly && <Lock size={10} strokeWidth={2} className="text-warning" aria-label="Read-only" />}
            </span>
          </Tooltip>
          {connection.authMode === 'vault' && status === 'connected' && <VaultStatusChip connection={connection} />}
          {database && (
            <Item icon={<Database size={11} strokeWidth={1.75} />}>
              {database}
              {schema && <span className="text-subtle">/{schema}</span>}
            </Item>
          )}
          {tab?.kind === 'console' && <TransactionIndicator runtime={consoleRuntime} />}
        </>
      ) : (
        <span className="text-subtle">No connection selected</span>
      )}

      <div className="ml-auto flex items-center gap-3">
        {tab?.kind === 'console' && consoleRuntime && <ExecutionSummary runtime={consoleRuntime} />}
        <Tooltip content={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} side="top">
          <button
            type="button"
            onClick={toggleTheme}
            aria-label="Toggle theme"
            className="flex size-[18px] items-center justify-center rounded text-subtle outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
          >
            {theme === 'dark' ? <Moon size={11} strokeWidth={2} /> : <Sun size={11} strokeWidth={2} />}
          </button>
        </Tooltip>
        {version && <span className="tabular text-subtle">v{version}</span>}
      </div>
    </footer>
  )
}

function statusLabel(status: string): string {
  return status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : status === 'error' ? 'Connection error' : 'Not connected'
}

function Item({ icon, children, className }: { icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-1', className)}>
      {icon && <span className="flex shrink-0 text-faint">{icon}</span>}
      <span className="truncate">{children}</span>
    </span>
  )
}

function TransactionIndicator({ runtime }: { runtime: ConsoleRuntime | undefined }) {
  const tx = runtime?.transaction ?? { autoCommit: true, inTransaction: false }
  if (tx.inTransaction) {
    return (
      <span className="flex items-center gap-1 rounded-[3px] bg-warning-soft px-1.5 font-medium text-warning">
        <Layers size={10} strokeWidth={2} />
        Transaction open
      </span>
    )
  }
  return <Item>{tx.autoCommit ? 'Auto-commit' : 'Manual commit'}</Item>
}

function ExecutionSummary({ runtime }: { runtime: ConsoleRuntime }) {
  const [now, setNow] = useState(() => Date.now())
  const running = runtime.status === 'running'
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [running])

  if (running) {
    return (
      <span className="flex items-center gap-1.5 text-muted">
        <Spinner size={10} />
        Running
        <span className="tabular text-subtle">{formatDuration(Math.max(0, now - (runtime.runningSince ?? now)))}</span>
      </span>
    )
  }
  if (runtime.status === 'connecting') {
    return (
      <span className="flex items-center gap-1.5">
        <Spinner size={10} />
        Connecting
      </span>
    )
  }
  const summary = summarizeExecution(runtime.execution, runtime.activeResult, runtime.resultView, runtime.explain)
  if (!summary) return null
  return (
    <span title={summary.title} className={cn('flex items-center gap-1.5 tabular', summary.danger && 'text-danger')}>
      {summary.text}
      {summary.durationMs !== undefined && (
        <>
          <span className="text-faint" aria-hidden>
            ·
          </span>
          <span>{formatDuration(summary.durationMs)}</span>
        </>
      )}
    </span>
  )
}
