import { useMemo, type ReactNode } from 'react'
import { ArrowRight, Import, Plus, SquareTerminal } from 'lucide-react'
import { DIALECT_LABEL, type ConnectionConfig, type Dialect } from '@shared/types'
import { openDbeaverImport } from '@/components/import/useDbeaverImportCommand'
import { Button, ColorTag, DialectIcon, Kbd, Skeleton, StatusDot } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatRelativeTime } from '@/lib/format'
import { MENU_ACCELERATORS } from '@/lib/shortcuts'
import { useConnections } from '@/stores/connections'
import { useUi } from '@/stores/ui'
import { AppMark } from './AppMark'
import { newConsole } from './useGlobalCommands'

const MAX_RECENT = 6

const SHORTCUTS: { label: string; shortcut: string }[] = [
  { label: 'Command palette', shortcut: MENU_ACCELERATORS['command-palette'] },
  { label: 'New console', shortcut: MENU_ACCELERATORS['new-console'] },
  { label: 'Go to object', shortcut: MENU_ACCELERATORS['go-to-object'] },
  { label: 'New connection', shortcut: MENU_ACCELERATORS['new-connection'] },
  { label: 'Toggle sidebar', shortcut: MENU_ACCELERATORS['toggle-sidebar'] },
  { label: 'Query history', shortcut: MENU_ACCELERATORS['open-history'] },
]

const DIALECT_BLURB: Record<Dialect, string> = {
  postgres: 'Local, cloud or via SSH tunnel',
  mssql: 'On-prem, Azure or via SSH',
}

export function WelcomeScreen() {
  const openConnectionDialog = useUi((s) => s.openConnectionDialog)
  return (
    <div className="relative h-full overflow-y-auto bg-surface">
      <Backdrop />
      <div className="relative mx-auto flex min-h-full w-full max-w-[640px] flex-col justify-center px-8 py-14">
        <header className="flex flex-col items-center text-center">
          <div className="relative">
            <div aria-hidden className="absolute inset-0 -z-10 scale-150 rounded-full bg-glow blur-2xl" />
            <AppMark size={52} className="drop-shadow-[0_8px_24px_var(--c-glow)]" />
          </div>
          <h1 className="mt-5 text-[26px] font-semibold leading-8 tracking-[-0.02em] text-fg">DataGrippe</h1>
          <p className="mt-1.5 text-sm text-muted">A calm, fast workspace for PostgreSQL and SQL Server.</p>
        </header>

        <section aria-label="Create a connection" className="mt-9 grid grid-cols-2 gap-3">
          {(['postgres', 'mssql'] as const).map((dialect) => (
            <button
              key={dialect}
              type="button"
              onClick={() => openConnectionDialog({ dialect })}
              className={cn(
                'group flex items-center gap-3 rounded-xl border border-line bg-panel p-3.5 text-left shadow-inset outline-none',
                'transition-[border-color,background-color,transform] duration-150 hover:-translate-y-px hover:border-line-strong hover:bg-elevated',
                'focus-visible:ring-2 focus-visible:ring-focus',
              )}
            >
              <DialectIcon dialect={dialect} size={34} title="" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">New {DIALECT_LABEL[dialect]} connection</span>
                <span className="mt-0.5 block truncate text-xs text-subtle">{DIALECT_BLURB[dialect]}</span>
              </span>
              <ArrowRight
                size={15}
                strokeWidth={1.75}
                className="shrink-0 -translate-x-1 text-subtle opacity-0 transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100"
              />
            </button>
          ))}
        </section>
        <div className="mt-2.5 flex items-center justify-center gap-1.5 text-xs text-subtle">
          <span>Coming from DBeaver?</span>
          <Button size="xs" variant="ghost" leadingIcon={Import} onClick={openDbeaverImport} className="text-muted hover:text-fg">
            Import from DBeaver
          </Button>
        </div>

        <SavedConnections />

        <section aria-label="Keyboard shortcuts" className="mt-8">
          <SectionTitle>Shortcuts</SectionTitle>
          <div className="mt-2 grid grid-cols-2 gap-x-8 gap-y-0.5 px-1">
            {SHORTCUTS.map((s) => (
              <div key={s.label} className="flex h-7 items-center justify-between gap-3 border-b border-line/60 text-xs text-muted">
                <span>{s.label}</span>
                <Kbd shortcut={s.shortcut} />
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: 'radial-gradient(var(--c-line-strong) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
          maskImage: 'radial-gradient(ellipse 60% 45% at 50% 18%, black 0%, transparent 100%)',
          WebkitMaskImage: 'radial-gradient(ellipse 60% 45% at 50% 18%, black 0%, transparent 100%)',
          opacity: 0.6,
        }}
      />
      <div
        className="absolute left-1/2 top-[-180px] h-[420px] w-[720px] -translate-x-1/2 rounded-full"
        style={{ background: 'radial-gradient(closest-side, var(--c-glow), transparent)' }}
      />
    </div>
  )
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex h-6 items-center justify-between px-1">
      <h2 className="text-2xs font-medium uppercase tracking-[0.08em] text-subtle">{children}</h2>
      {aside}
    </div>
  )
}

function SavedConnections() {
  const connections = useConnections((s) => s.connections)
  const loaded = useConnections((s) => s.loaded)
  const openConnectionDialog = useUi((s) => s.openConnectionDialog)
  const recent = useMemo(
    () => [...connections].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, MAX_RECENT),
    [connections],
  )

  return (
    <section aria-label="Saved connections" className="mt-8">
      <SectionTitle
        aside={
          connections.length > 0 && (
            <Button size="xs" variant="ghost" leadingIcon={Plus} onClick={() => openConnectionDialog()}>
              New
            </Button>
          )
        }
      >
        Connections{connections.length > 0 && <span className="ml-1.5 text-subtle tabular">{connections.length}</span>}
      </SectionTitle>
      <div className="mt-2">
        {!loaded ? (
          <div className="overflow-hidden rounded-xl border border-line bg-panel">
            {[0, 1, 2].map((i) => (
              <div key={i} className={cn('flex h-12 items-center gap-3 px-3.5', i > 0 && 'border-t border-line')}>
                <Skeleton className="size-5 rounded-md" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton width={`${40 - i * 6}%`} />
                  <Skeleton width={`${28 + i * 5}%`} height={8} />
                </div>
              </div>
            ))}
          </div>
        ) : recent.length === 0 ? (
          <div className="flex items-center gap-3 rounded-xl border border-dashed border-line-strong px-4 py-3.5 text-xs text-subtle">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-hover text-subtle">
              <Plus size={15} strokeWidth={1.75} />
            </span>
            <span className="flex-1">No saved connections yet. Create one to start exploring your data.</span>
            <Button size="xs" variant="secondary" onClick={() => openConnectionDialog()}>
              New connection
            </Button>
          </div>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-line bg-panel shadow-inset">
            {recent.map((c, i) => (
              <ConnectionRow key={c.id} connection={c} first={i === 0} />
            ))}
          </ul>
        )}
        {connections.length > MAX_RECENT && (
          <p className="mt-2 px-1 text-2xs text-subtle">
            {connections.length - MAX_RECENT} more in the sidebar
          </p>
        )}
      </div>
    </section>
  )
}

function ConnectionRow({ connection: c, first }: { connection: ConnectionConfig; first: boolean }) {
  const status = useConnections((s) => s.runtime[c.id]?.status ?? 'disconnected')
  const open = () => {
    newConsole(c.id)
    void useConnections.getState().ensureConnected(c.id)
  }
  const target = `${c.host}:${c.port}${c.database ? `/${c.database}` : ''}`
  return (
    <li className={cn('group relative flex h-12 items-center gap-3 px-3.5 transition-colors hover:bg-hover', !first && 'border-t border-line')}>
      <ColorTag color={c.color} variant="bar" className="absolute inset-y-2.5 left-0 rounded-l-none" />
      <DialectIcon dialect={c.dialect} size={20} />
      <button type="button" onClick={open} className="min-w-0 flex-1 text-left outline-none focus-visible:underline" tabIndex={-1}>
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">{c.name}</span>
          {status !== 'disconnected' && <StatusDot status={status} size={6} />}
        </span>
        <span className="flex items-center gap-1.5 text-2xs text-subtle">
          <span className="truncate font-mono">{target}</span>
          {c.updatedAt && (
            <>
              <span className="text-faint">·</span>
              <span className="shrink-0">edited {formatRelativeTime(c.updatedAt)}</span>
            </>
          )}
        </span>
      </button>
      <Button
        size="xs"
        variant="ghost"
        leadingIcon={SquareTerminal}
        onClick={open}
        className="opacity-70 group-hover:bg-active group-hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
      >
        Open console
      </Button>
    </li>
  )
}
