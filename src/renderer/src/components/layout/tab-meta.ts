import { Activity, Columns3, SquareTerminal, Table2 } from 'lucide-react'
import type { ConnectionConfig, DatabaseInfo } from '@shared/types'
import type { IconLike } from '@/components/ui'
import type { Tab } from '@/stores/tabs'

export const TAB_KIND_ICON: Record<Tab['kind'], IconLike> = {
  console: SquareTerminal,
  table: Table2,
  structure: Columns3,
  sessions: Activity,
}

export const TAB_KIND_LABEL: Record<Tab['kind'], string> = {
  console: 'Console',
  table: 'Data',
  structure: 'Structure',
  sessions: 'Server sessions',
}

/**
 * The database a tab works in: a console's own, else its connection's default, else `firstDatabase` (for a
 * connection that names none). Undefined for the server sessions view.
 */
export function tabDatabase(tab: Tab, connection: ConnectionConfig | undefined, firstDatabase?: string): string | undefined {
  if (tab.kind === 'console') return tab.database ?? (connection?.database || firstDatabase)
  if (tab.kind === 'sessions') return undefined
  return tab.database
}

/** The first user database the explorer lists (a console's database when the connection names none). */
export function firstUserDatabase(databases: readonly DatabaseInfo[] | undefined): string | undefined {
  return databases?.find((d) => !d.isSystem)?.name ?? databases?.[0]?.name
}

/** Text used by "Copy name": qualified object for table tabs, the title for consoles. */
export function tabCopyName(tab: Tab): string {
  return tab.kind === 'console' || tab.kind === 'sessions' ? tab.title : `${tab.table.schema}.${tab.table.name}`
}

/**
 * Suffix that tells apart tabs sharing a title (e.g. two "customers" tables): the connection when it
 * differs, else the schema, else the database; plus "Structure" on the structure tab of an object
 * whose data tab is open too. Undefined when the title is unique.
 */
export function tabHint(tab: Tab, tabs: readonly Tab[], connections: readonly ConnectionConfig[]): string | undefined {
  const twins = tabs.filter((t) => t.id !== tab.id && t.title === tab.title)
  if (twins.length === 0) return undefined
  const schemaOf = (t: Tab) => (t.kind === 'console' ? t.schema : t.kind === 'sessions' ? undefined : t.table.schema)
  let where: string | undefined
  if (twins.some((t) => t.connectionId !== tab.connectionId)) where = connections.find((c) => c.id === tab.connectionId)?.name
  else if (twins.some((t) => schemaOf(t) !== schemaOf(tab))) where = schemaOf(tab)
  else if (twins.some((t) => t.database !== tab.database)) where = tab.database
  const view = tab.kind === 'structure' && twins.some((t) => t.kind !== 'structure') ? TAB_KIND_LABEL.structure : undefined
  return [where, view].filter(Boolean).join(' · ') || undefined
}
