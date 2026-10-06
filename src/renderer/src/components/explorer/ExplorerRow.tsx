// One row of the virtualized explorer tree. Purely presentational: events go up through `handlers`.
import { memo, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import {
  ChevronRight,
  ShieldAlert,
  CircleAlert,
  Columns3,
  Database,
  Eye,
  FolderClosed,
  FolderOpen,
  Globe,
  KeyRound,
  Layers,
  Link2,
  ListOrdered,
  ListTree,
  Lock,
  Shapes,
  SquareFunction,
  Table2,
  TableProperties,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { ObjectKind } from '@shared/types'
import { ColorTag, DialectIcon, Spinner, StatusDot, Tooltip } from '@/components/ui'
import { cn } from '@/lib/cn'
import type { ConnectionRuntime } from '@/stores/connections'
import { vaultMessage } from '@/components/vault/format'
import { VaultBadge } from '@/components/vault/VaultIndicators'
import { nodeLabel, type TreeRow } from './tree'

export const ROW_HEIGHT = 24
const INDENT = 12
const BASE_PAD = 6

export const KIND_ICON: Record<ObjectKind, { icon: LucideIcon; className: string }> = {
  table: { icon: Table2, className: 'text-syn-function' },
  view: { icon: Eye, className: 'text-syn-string' },
  'materialized-view': { icon: TableProperties, className: 'text-syn-type' },
  'foreign-table': { icon: Globe, className: 'text-syn-number' },
  function: { icon: SquareFunction, className: 'text-syn-keyword' },
  procedure: { icon: Workflow, className: 'text-syn-keyword' },
  sequence: { icon: ListOrdered, className: 'text-muted' },
  type: { icon: Shapes, className: 'text-muted' },
}

export interface RowHandlers {
  onSelect: (row: TreeRow) => void
  onToggle: (row: TreeRow) => void
  onActivate: (row: TreeRow) => void
  onContextMenu: (row: TreeRow) => void
  onRetry: (row: TreeRow) => void
  onDragStart: (row: TreeRow, event: DragEvent<HTMLDivElement>) => void
}

export interface ExplorerRowProps {
  row: TreeRow
  domId: string
  selected: boolean
  /** Runtime of the row's connection (connection rows only). */
  runtime?: ConnectionRuntime
  handlers: RowHandlers
  top: number
}

function Highlighted({ text, match }: { text: string; match?: [number, number] }) {
  if (!match) return <>{text}</>
  const [start, end] = match
  return (
    <>
      {text.slice(0, start)}
      <mark className="rounded-[2px] bg-accent-soft text-accent shadow-[0_0_0_1px_var(--c-accent-soft)]">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  )
}

function Icon({ icon: I, className }: { icon: LucideIcon; className?: string }) {
  return <I size={14} strokeWidth={1.75} aria-hidden className={cn('shrink-0', className)} />
}

/** Name + muted detail: the detail truncates first, the name only once it alone exceeds the row. */
function NameMeta({ name, meta, nameClassName }: { name: ReactNode; meta?: ReactNode; nameClassName?: string }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className={cn('max-w-full shrink-0 truncate text-fg', nameClassName)}>{name}</span>
      {meta !== undefined && meta !== null && meta !== '' && (
        <span className="min-w-0 truncate font-mono text-[10.5px] text-subtle">{meta}</span>
      )}
    </span>
  )
}

const Count = ({ n }: { n: number }) => <span className="shrink-0 text-2xs text-subtle tabular">{n}</span>

function ConnectionStatus({ runtime }: { runtime?: ConnectionRuntime }) {
  if (runtime?.status === 'connecting') return <Spinner size={12} className="text-subtle" label="Connecting" />
  if (runtime?.status === 'connected') return <StatusDot status="connected" size={6} />
  if (runtime?.status === 'error') {
    const content =
      runtime.errorKind === 'vault' ? (
        <span className="flex max-w-64 flex-col gap-0.5 py-0.5">
          <span className="font-medium text-danger">Vault</span>
          <span className="text-muted [overflow-wrap:anywhere]">{vaultMessage(runtime.error)}</span>
        </span>
      ) : (
        (runtime.error ?? 'Connection error')
      )
    return (
      <Tooltip content={content} side="right">
        <span className="flex size-3.5 items-center justify-center">
          <StatusDot status="error" size={6} />
        </span>
      </Tooltip>
    )
  }
  return null
}

function RowBody({ row, runtime, onRetry }: { row: TreeRow; runtime?: ConnectionRuntime; onRetry: () => void }) {
  const node = row.node
  const label = <Highlighted text={nodeLabel(node)} match={row.match} />
  switch (node.type) {
    case 'group':
      return (
        <>
          <Icon icon={row.expanded ? FolderOpen : FolderClosed} className="text-subtle" />
          <span className="min-w-0 truncate text-xs font-medium text-muted">{label}</span>
          <Count n={node.count} />
        </>
      )
    case 'connection': {
      const c = node.connection
      return (
        <>
          <ColorTag color={c.color} variant="bar" className="absolute inset-y-[5px] left-0.5" />
          <DialectIcon dialect={c.dialect} size={14} title="" />
          {/* Items that do not fit wrap onto a clipped second line: the host disappears before the name truncates. */}
          <span className="flex h-6 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 overflow-hidden">
            <span className="flex h-6 min-w-0 max-w-full items-center gap-1.5">
              <span className="min-w-0 truncate font-medium text-fg">{label}</span>
              {c.readOnly && (
                <Tooltip content="Read-only" side="right">
                  <Lock size={11} strokeWidth={2} className="shrink-0 text-subtle" aria-label="Read-only" />
                </Tooltip>
              )}
              {c.productionGuard && (
                <Tooltip content="Production connection" side="right">
                  <ShieldAlert size={11} strokeWidth={2} className="shrink-0 text-warning" aria-label="Production connection" />
                </Tooltip>
              )}
              {c.authMode === 'vault' && <VaultBadge connection={c} />}
            </span>
            <span className="flex h-6 shrink-0 items-center font-mono text-[10.5px] text-subtle">{c.host}</span>
          </span>
          <span className="flex w-3.5 shrink-0 items-center justify-center">
            <ConnectionStatus runtime={runtime} />
          </span>
        </>
      )
    }
    case 'database':
      return (
        <>
          <Icon icon={Database} className="text-subtle" />
          <span className="min-w-0 truncate text-fg">{label}</span>
        </>
      )
    case 'schema':
      return (
        <>
          <Icon icon={Layers} className="text-subtle" />
          <span className="min-w-0 truncate text-fg">{label}</span>
        </>
      )
    case 'folder':
    case 'detail-folder':
      return (
        <>
          <Icon icon={row.expanded ? FolderOpen : FolderClosed} className="text-faint" />
          <span className="min-w-0 truncate text-muted">{label}</span>
          <Count n={node.count} />
        </>
      )
    case 'object': {
      const kind = KIND_ICON[node.object.kind]
      return (
        <>
          <Icon icon={kind.icon} className={kind.className} />
          <NameMeta name={label} meta={node.object.signature} />
        </>
      )
    }
    case 'column': {
      const c = node.column
      return (
        <>
          {c.isPrimaryKey ? <Icon icon={KeyRound} className="text-warning" /> : <Icon icon={Columns3} className="text-faint" />}
          <NameMeta
            name={label}
            meta={
              <>
                {c.dataType}
                {c.nullable && (
                  <span title="Nullable">
                    ?
                  </span>
                )}
              </>
            }
          />
        </>
      )
    }
    case 'detail': {
      const icon =
        node.folder === 'keys' ? KeyRound : node.folder === 'indexes' ? ListTree : node.folder === 'foreign-keys' ? Link2 : Zap
      const tone = node.flag === 'primary' ? 'text-warning' : 'text-subtle'
      return (
        <>
          <Icon icon={icon} className={tone} />
          <NameMeta name={label} meta={node.info} nameClassName={node.flag === 'disabled' ? 'text-subtle line-through' : undefined} />
        </>
      )
    }
    case 'message':
      if (node.tone === 'empty') return <span className="truncate text-xs text-subtle">{node.text}</span>
      return (
        <>
          <Icon icon={CircleAlert} className="text-danger" />
          <Tooltip content={node.text} side="right">
            <span className="min-w-0 truncate text-xs text-danger">{node.text}</span>
          </Tooltip>
          {node.retry && (
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation()
                onRetry()
              }}
              className="ml-auto shrink-0 rounded px-1 text-2xs font-medium text-accent outline-none hover:bg-accent-soft"
            >
              Retry
            </button>
          )}
        </>
      )
  }
}

const isDraggable = (row: TreeRow) => row.node.type === 'object' || row.node.type === 'column'

export const ExplorerRow = memo(function ExplorerRow({ row, domId, selected, runtime, handlers, top }: ExplorerRowProps) {
  const pad = BASE_PAD + row.depth * INDENT
  const guides = Array.from({ length: row.depth }, (_, d) => BASE_PAD + d * INDENT + 7.5)
  const isMessage = row.node.type === 'message'

  const onClick = (e: MouseEvent) => {
    if (e.detail > 1) return
    handlers.onSelect(row)
  }
  return (
    <div
      id={domId}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.expandable ? row.expanded : undefined}
      aria-selected={selected}
      aria-busy={row.loading || undefined}
      data-row-id={row.id}
      draggable={isDraggable(row) || undefined}
      onDragStart={isDraggable(row) ? (e) => handlers.onDragStart(row, e) : undefined}
      onClick={onClick}
      onDoubleClick={() => handlers.onActivate(row)}
      onContextMenu={() => handlers.onContextMenu(row)}
      className={cn(
        'absolute inset-x-0 flex cursor-default select-none items-center gap-1.5 pr-2 text-sm',
        'hover:bg-hover',
        selected && 'bg-active group-focus-within/tree:bg-selection hover:bg-active',
      )}
      style={{ top, height: ROW_HEIGHT, paddingLeft: pad }}
    >
      {guides.map((x) => (
        <span key={x} aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-line" style={{ left: x }} />
      ))}
      <span
        aria-hidden
        className={cn('flex size-4 shrink-0 items-center justify-center text-subtle', row.expandable && 'hover:text-fg')}
        onClick={
          row.expandable
            ? (e) => {
                e.stopPropagation()
                handlers.onSelect(row)
                handlers.onToggle(row)
              }
            : undefined
        }
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {row.loading ? (
          <Spinner size={11} />
        ) : row.expandable ? (
          <ChevronRight
            size={13}
            strokeWidth={2}
            className={cn('transition-transform duration-100', row.expanded && 'rotate-90')}
          />
        ) : null}
      </span>
      {isMessage ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <RowBody row={row} runtime={runtime} onRetry={() => handlers.onRetry(row)} />
        </span>
      ) : (
        <RowBody row={row} runtime={runtime} onRetry={() => handlers.onRetry(row)} />
      )}
    </div>
  )
})
