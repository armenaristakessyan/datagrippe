// Content of the popover shown next to a column, key, index, foreign key or trigger row of the
// explorer (click / Enter / context menu › Properties).
import type { ReactNode } from 'react'
import { Columns3, KeyRound, Link2, ListTree, Zap, type LucideIcon } from 'lucide-react'
import type { ColumnInfo, DbObjectInfo } from '@shared/types'
import { Badge, CodeBlock } from '@/components/ui'
import { cn } from '@/lib/cn'
import { objectKey, useExplorer } from '@/stores/explorer'
import { columnProperties, detailProperties, type ColumnReference, type DetailProperties, type KeyColumn } from './properties'
import type { DetailFolder, ObjectPath, TreeNode } from './tree'

export type InspectableNode = Extract<TreeNode, { type: 'column' } | { type: 'detail' }>

export function isInspectable(node: TreeNode): node is InspectableNode {
  return node.type === 'column' || node.type === 'detail'
}

const DETAIL_LABEL: Record<DetailFolder, string> = {
  keys: 'key',
  indexes: 'index',
  'foreign-keys': 'foreign key',
  triggers: 'trigger',
}

function itemLabel(node: InspectableNode): string {
  if (node.type === 'column') return 'column'
  if (node.folder === 'keys') return node.flag === 'primary' ? 'primary key' : 'unique key'
  return DETAIL_LABEL[node.folder]
}

/** Accessible name of the popover, e.g. "Properties of foreign key FK_Order_Customer". */
export function propertiesLabel(node: InspectableNode): string {
  return `Properties of ${itemLabel(node)} ${node.type === 'column' ? node.column.name : node.name}`
}

function useDetails(path: ObjectPath, object: DbObjectInfo) {
  return useExplorer((s) => s.details[objectKey(path.connectionId, path.database, path.schema, object.name)]?.data)
}

export function PropertiesCard({ node }: { node: InspectableNode }) {
  return node.type === 'column' ? (
    <ColumnCard path={node.path} object={node.object} column={node.column} />
  ) : (
    <DetailCard path={node.path} object={node.object} folder={node.folder} name={node.name} />
  )
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const None = () => <span className="text-faint">—</span>

function Header({
  icon: Icon,
  iconClassName,
  name,
  path,
  object,
  meta,
}: {
  icon: LucideIcon
  iconClassName: string
  name: string
  path: ObjectPath
  object: DbObjectInfo
  meta: string
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon size={14} strokeWidth={1.75} aria-hidden className={cn('mt-[3px] shrink-0', iconClassName)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-mono text-sm font-medium text-fg [overflow-wrap:anywhere]">{name}</span>
        <span className="truncate font-mono text-2xs text-subtle">
          {path.schema}.{object.name}
        </span>
      </div>
      <span className="shrink-0 pt-0.5 text-2xs text-subtle tabular">{meta}</span>
    </div>
  )
}

function Badges({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-1">{children}</div>
}

function Properties({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">{children}</dl>
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-px text-subtle">{label}</dt>
      <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">{children}</dd>
    </>
  )
}

function Entries({ children }: { children: ReactNode }) {
  return <span className="flex flex-col gap-1.5">{children}</span>
}

function Entry({ main, meta }: { main: ReactNode; meta?: ReactNode }) {
  return (
    <span className="flex flex-col gap-px">
      <span className="font-mono">{main}</span>
      {meta && <span className="text-2xs text-subtle">{meta}</span>}
    </span>
  )
}

const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono">{children}</span>

const withOthers = (columns: string[]) => (columns.length > 0 ? `with ${columns.join(', ')}` : undefined)

function References({ items, arrow }: { items: ColumnReference[]; arrow: string }) {
  return (
    <Entries>
      {items.map((r) => (
        <Entry key={r.name} main={`${arrow} ${r.target}`} meta={[r.name, ...r.actions].join(' · ')} />
      ))}
    </Entries>
  )
}

function KeyColumns({ columns }: { columns: KeyColumn[] }) {
  return (
    <Entries>
      {columns.map((c, i) => (
        <Entry key={`${i}:${c.name}`} main={c.name} meta={c.dataType} />
      ))}
    </Entries>
  )
}

function Definition({ sql }: { sql?: string }) {
  if (!sql) return null
  return <CodeBlock code={sql} maxHeight={168} className="text-xs" />
}

const Card = ({ children }: { children: ReactNode }) => <div className="flex flex-col gap-3">{children}</div>

// ---------------------------------------------------------------------------
// Column
// ---------------------------------------------------------------------------

function ColumnCard({ path, object, column }: { path: ObjectPath; object: DbObjectInfo; column: ColumnInfo }) {
  const details = useDetails(path, object)
  // The cached details hold the latest version of the column (after a refresh).
  const current = details?.columns.find((c) => c.name === column.name) ?? column
  const p = columnProperties(current, details)
  const c = p.column

  return (
    <Card>
      <Header
        icon={p.primaryKey ? KeyRound : Columns3}
        iconClassName={p.primaryKey ? 'text-warning' : 'text-faint'}
        name={c.name}
        path={path}
        object={object}
        meta={`Column ${c.ordinal}`}
      />
      {(p.primaryKey || c.isIdentity || c.isGenerated || p.unique.length > 0) && (
        <Badges>
          {p.primaryKey && <Badge tone="warning">Primary key</Badge>}
          {p.unique.length > 0 && <Badge tone="neutral">Unique</Badge>}
          {c.isIdentity && <Badge tone="accent">Identity</Badge>}
          {c.isGenerated && <Badge tone="info">Generated</Badge>}
        </Badges>
      )}
      <Properties>
        <Property label="Type">
          <Mono>{c.dataType}</Mono>
        </Property>
        <Property label="Nullable">{c.nullable ? 'Yes' : 'No'}</Property>
        <Property label="Default">{c.defaultValue !== null && c.defaultValue !== '' ? <Mono>{c.defaultValue}</Mono> : <None />}</Property>
        {p.primaryKey && (p.primaryKey.name || p.primaryKey.with.length > 0) && (
          <Property label="Primary key">
            <Entry main={p.primaryKey.name || 'Primary key'} meta={withOthers(p.primaryKey.with)} />
          </Property>
        )}
        {p.unique.length > 0 && (
          <Property label="Unique">
            <Entries>
              {p.unique.map((u) => (
                <Entry key={u.name} main={u.name} meta={withOthers(u.with)} />
              ))}
            </Entries>
          </Property>
        )}
        {p.references.length > 0 && (
          <Property label="References">
            <References items={p.references} arrow="→" />
          </Property>
        )}
        {p.referencedBy.length > 0 && (
          <Property label="Referenced by">
            <References items={p.referencedBy} arrow="←" />
          </Property>
        )}
        {p.indexes.length > 0 && (
          <Property label="Indexes">
            <Entries>
              {p.indexes.map((i) => (
                <Entry
                  key={i.name}
                  main={i.name}
                  meta={[i.primary ? 'primary' : i.unique ? 'unique' : undefined, i.method, withOthers(i.with)].filter(Boolean).join(' · ') || undefined}
                />
              ))}
            </Entries>
          </Property>
        )}
        {p.checks.length > 0 && (
          <Property label="Checks">
            <Entries>
              {p.checks.map((k) => (
                <Entry key={k.name} main={k.definition ?? k.name} meta={k.definition ? k.name : undefined} />
              ))}
            </Entries>
          </Property>
        )}
        <Property label="Comment">{c.comment ? <span className="whitespace-pre-wrap">{c.comment}</span> : <None />}</Property>
      </Properties>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Keys, indexes, foreign keys, triggers
// ---------------------------------------------------------------------------

const DETAIL_ICON: Record<DetailFolder, LucideIcon> = {
  keys: KeyRound,
  indexes: ListTree,
  'foreign-keys': Link2,
  triggers: Zap,
}

function detailMeta(p: DetailProperties): string {
  switch (p.kind) {
    case 'key':
      return p.primary ? 'Primary key' : 'Unique key'
    case 'index':
      return 'Index'
    case 'foreign-key':
      return 'Foreign key'
    case 'trigger':
      return 'Trigger'
  }
}

function DetailCard({ path, object, folder, name }: { path: ObjectPath; object: DbObjectInfo; folder: DetailFolder; name: string }) {
  const p = detailProperties(folder, name, useDetails(path, object))
  const primary = (p?.kind === 'key' || p?.kind === 'index') && p.primary
  const header = (
    <Header
      icon={DETAIL_ICON[folder]}
      iconClassName={primary ? 'text-warning' : 'text-subtle'}
      name={name}
      path={path}
      object={object}
      meta={p ? detailMeta(p) : DETAIL_LABEL[folder]}
    />
  )
  if (!p) {
    return (
      <Card>
        {header}
        <p className="text-xs text-muted">Not in the loaded metadata any more. Refresh the table to update it.</p>
      </Card>
    )
  }
  switch (p.kind) {
    case 'key':
      return (
        <Card>
          {header}
          <Properties>
            <Property label="Columns">
              <KeyColumns columns={p.columns} />
            </Property>
            {p.method && (
              <Property label="Method">
                <Mono>{p.method}</Mono>
              </Property>
            )}
          </Properties>
          <Definition sql={p.definition} />
        </Card>
      )
    case 'index':
      return (
        <Card>
          {header}
          {(p.primary || p.unique) && (
            <Badges>
              {p.primary && <Badge tone="warning">Primary key</Badge>}
              {p.unique && <Badge tone="neutral">Unique</Badge>}
            </Badges>
          )}
          <Properties>
            <Property label="Columns">
              <KeyColumns columns={p.columns} />
            </Property>
            {p.method && (
              <Property label="Method">
                <Mono>{p.method}</Mono>
              </Property>
            )}
            {p.predicate && (
              <Property label="Filter">
                <Mono>{p.predicate}</Mono>
              </Property>
            )}
          </Properties>
          <Definition sql={p.definition} />
        </Card>
      )
    case 'foreign-key':
      return (
        <Card>
          {header}
          <Properties>
            <Property label="References">
              <Mono>{p.target}</Mono>
            </Property>
            <Property label="Columns">
              <Entries>
                {p.pairs.map((pair) => (
                  <Entry key={pair.column} main={`${pair.column} → ${pair.refColumn}`} meta={pair.dataType} />
                ))}
              </Entries>
            </Property>
            <Property label="On delete">
              <Mono>{p.onDelete}</Mono>
            </Property>
            <Property label="On update">
              <Mono>{p.onUpdate}</Mono>
            </Property>
          </Properties>
        </Card>
      )
    case 'trigger':
      return (
        <Card>
          {header}
          {!p.enabled && (
            <Badges>
              <Badge tone="neutral">Disabled</Badge>
            </Badges>
          )}
          <Properties>
            <Property label="Timing">{p.timing ? <Mono>{p.timing}</Mono> : <None />}</Property>
            <Property label="Events">{p.events.length > 0 ? <Mono>{p.events.join(' | ')}</Mono> : <None />}</Property>
            <Property label="Enabled">{p.enabled ? 'Yes' : 'No'}</Property>
          </Properties>
          <Definition sql={p.definition} />
        </Card>
      )
  }
}
