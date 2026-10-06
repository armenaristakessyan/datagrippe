// Data side of the command palette: collecting searchable entries from the stores, ranking them
// with the fuzzy matcher, and the in-memory most-recently-used list.
import type { CompletionCatalog, ConnectionConfig, DbObjectInfo, ObjectKind } from '@shared/types'
import { DIALECT_LABEL } from '@shared/types'
import type { Command } from '@/lib/commands'
import type { ConnectionRuntime } from '@/stores/connections'
import type { Loadable } from '@/stores/explorer'
import { FUZZY_TIER, matchFields, type SearchField } from './fuzzy'

export interface ObjectEntry {
  type: 'object'
  key: string
  connectionId: string
  connectionName: string
  database: string
  schema: string
  name: string
  kind: ObjectKind
  signature?: string
  identity?: string
}

export interface ConnectionEntry {
  type: 'connection'
  key: string
  connection: ConnectionConfig
  connected: boolean
}

export interface CommandEntry {
  type: 'command'
  key: string
  command: Command
}

export type PaletteEntry = ObjectEntry | ConnectionEntry | CommandEntry

export interface Ranked<T> {
  entry: T
  score: number
  /** Matched character positions inside the entry's label. */
  positions: number[]
}

export const ROUTINE_KINDS: ReadonlySet<ObjectKind> = new Set(['function', 'procedure'])
/** Kinds opened as a console with their DDL rather than a data tab. */
export const DDL_KINDS: ReadonlySet<ObjectKind> = new Set(['function', 'procedure', 'sequence', 'type'])

const KIND_ORDER: Record<ObjectKind, number> = {
  table: 0,
  view: 1,
  'materialized-view': 2,
  'foreign-table': 3,
  function: 4,
  procedure: 5,
  sequence: 6,
  type: 7,
}

export const KIND_LABEL: Record<ObjectKind, string> = {
  table: 'Table',
  view: 'View',
  'materialized-view': 'Materialized view',
  'foreign-table': 'Foreign table',
  function: 'Function',
  procedure: 'Procedure',
  sequence: 'Sequence',
  type: 'Type',
}

/** `${connectionId}|${database}|${schema}` (schemaKey) or `${connectionId}|${database}` (dbKey) → parts. */
export function splitKey(key: string): { connectionId: string; rest: string } {
  const bar = key.indexOf('|')
  return bar < 0 ? { connectionId: key, rest: '' } : { connectionId: key.slice(0, bar), rest: key.slice(bar + 1) }
}

const baseKey = (connectionId: string, database: string, schema: string, name: string, kind: ObjectKind) =>
  `obj|${connectionId}|${database}|${schema}|${name}|${kind}`

export interface CollectInput {
  connections: ConnectionConfig[]
  runtime: Record<string, ConnectionRuntime>
  /** useExplorer().objects — keyed by schemaKey. */
  objects: Record<string, Loadable<DbObjectInfo[]>>
  /** useCatalog().catalogs — keyed by dbKey. */
  catalogs: Record<string, Loadable<CompletionCatalog>>
}

/**
 * Every loaded object of connected connections: explorer listings first (they carry routine
 * identities for overloads), then the completion catalogs for anything the explorer has not loaded.
 */
export function collectObjects({ connections, runtime, objects, catalogs }: CollectInput): ObjectEntry[] {
  const byId = new Map(connections.filter((c) => runtime[c.id]?.status === 'connected').map((c) => [c.id, c]))
  const out: ObjectEntry[] = []
  const seenBase = new Set<string>()
  const seenKeys = new Set<string>()
  const push = (entry: ObjectEntry, base: string) => {
    if (seenKeys.has(entry.key)) return
    seenKeys.add(entry.key)
    seenBase.add(base)
    out.push(entry)
  }

  for (const [key, loadable] of Object.entries(objects)) {
    if (!loadable.data) continue
    const { connectionId, rest } = splitKey(key)
    const connection = byId.get(connectionId)
    if (!connection) continue
    const database = rest.slice(0, Math.max(0, rest.lastIndexOf('|')))
    for (const o of loadable.data) {
      const base = baseKey(connectionId, database, o.schema, o.name, o.kind)
      push(
        {
          type: 'object',
          key: o.identity ? `${base}|${o.identity}` : base,
          connectionId,
          connectionName: connection.name,
          database,
          schema: o.schema,
          name: o.name,
          kind: o.kind,
          signature: o.signature,
          identity: o.identity,
        },
        base,
      )
    }
  }

  for (const [key, loadable] of Object.entries(catalogs)) {
    const catalog = loadable.data
    if (!catalog) continue
    const { connectionId } = splitKey(key)
    const connection = byId.get(connectionId)
    if (!connection) continue
    const fromExplorer = new Set(seenBase)
    for (const schema of catalog.schemas) {
      for (const o of schema.objects) {
        const base = baseKey(connectionId, catalog.database, schema.name, o.name, o.kind)
        if (fromExplorer.has(base)) continue
        push(
          {
            type: 'object',
            key: o.signature ? `${base}|${o.signature}` : base,
            connectionId,
            connectionName: connection.name,
            database: catalog.database,
            schema: schema.name,
            name: o.name,
            kind: o.kind,
            signature: o.signature,
          },
          base,
        )
      }
    }
  }
  return out
}

export function connectionEntries(connections: ConnectionConfig[], runtime: Record<string, ConnectionRuntime>): ConnectionEntry[] {
  return connections.map((connection) => ({
    type: 'connection',
    key: `conn|${connection.id}`,
    connection,
    connected: runtime[connection.id]?.status === 'connected',
  }))
}

export function commandEntries(commands: Command[]): CommandEntry[] {
  return commands.map((command) => ({ type: 'command', key: `cmd|${command.id}`, command }))
}

/** Secondary fields only count for contiguous matches. */
const CONTEXT_MIN = FUZZY_TIER.fuzzyMax + 1

function objectFields(e: ObjectEntry): SearchField[] {
  const offset = e.schema.length + 1
  return [
    { text: e.name, weight: 1 },
    { text: `${e.schema}.${e.name}`, weight: 0.95, toLabel: (p) => (p >= offset ? p - offset : null) },
    { text: `${e.connectionName} ${e.database} ${e.schema}`, weight: 0.3, minScore: CONTEXT_MIN },
    { text: KIND_LABEL[e.kind], weight: 0.2, minScore: CONTEXT_MIN },
  ]
}

function connectionFields(e: ConnectionEntry): SearchField[] {
  const c = e.connection
  return [
    { text: c.name, weight: 1 },
    { text: `${c.host} ${c.database} ${c.group ?? ''}`, weight: 0.4, minScore: CONTEXT_MIN },
    { text: DIALECT_LABEL[c.dialect], weight: 0.3, minScore: CONTEXT_MIN },
  ]
}

function commandFields(e: CommandEntry): SearchField[] {
  const c = e.command
  return [
    { text: c.title, weight: 1 },
    ...(c.keywords ?? []).map((k) => ({ text: k, weight: 0.6, minScore: CONTEXT_MIN })),
    { text: c.group ?? '', weight: 0.4, minScore: CONTEXT_MIN },
  ]
}

export function entryFields(entry: PaletteEntry): SearchField[] {
  switch (entry.type) {
    case 'object':
      return objectFields(entry)
    case 'connection':
      return connectionFields(entry)
    case 'command':
      return commandFields(entry)
  }
}

export function entryLabel(entry: PaletteEntry): string {
  switch (entry.type) {
    case 'object':
      return entry.name
    case 'connection':
      return entry.connection.name
    case 'command':
      return entry.command.title
  }
}

function tieBreak(a: PaletteEntry, b: PaletteEntry, byLength: boolean): number {
  if (a.type === 'object' && b.type === 'object' && a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
  const la = entryLabel(a)
  const lb = entryLabel(b)
  if (byLength && la.length !== lb.length) return la.length - lb.length
  const byName = la.localeCompare(lb)
  if (byName !== 0 || a.type !== 'object' || b.type !== 'object') return byName
  return a.schema.localeCompare(b.schema) || a.connectionName.localeCompare(b.connectionName)
}

/**
 * Rank entries by fuzzy score (best first; ties: kind, shorter label, name). An empty query keeps
 * every entry, ordered by kind, then alphabetically.
 */
export function rankEntries<T extends PaletteEntry>(query: string, entries: T[], limit = Infinity): Ranked<T>[] {
  const ranked: Ranked<T>[] = []
  for (const entry of entries) {
    const match = matchFields(query, entryFields(entry))
    if (match) ranked.push({ entry, score: match.score, positions: match.labelPositions })
  }
  const byLength = query.trim() !== ''
  ranked.sort((a, b) => b.score - a.score || tieBreak(a.entry, b.entry, byLength))
  return Number.isFinite(limit) ? ranked.slice(0, limit) : ranked
}

// ---------------------------------------------------------------------------
// Most recently used (in memory, per palette mode)
// ---------------------------------------------------------------------------

export const RECENT_LIMIT = 6

const recent: Record<'commands' | 'objects', PaletteEntry[]> = { commands: [], objects: [] }

export function recordRecent(mode: 'commands' | 'objects', entry: PaletteEntry): void {
  recent[mode] = [entry, ...recent[mode].filter((e) => e.key !== entry.key)].slice(0, RECENT_LIMIT * 2)
}

/** Recent picks still valid now: commands/connections must be live, objects are kept as snapshots. */
export function recentEntries(mode: 'commands' | 'objects', live: Map<string, PaletteEntry>): PaletteEntry[] {
  const out: PaletteEntry[] = []
  for (const entry of recent[mode]) {
    const current = live.get(entry.key)
    if (current) out.push(current)
    else if (entry.type === 'object') out.push(entry)
    if (out.length >= RECENT_LIMIT) break
  }
  return out
}

export function clearRecent(): void {
  recent.commands = []
  recent.objects = []
}

/** Display order of command groups; unknown groups follow alphabetically, ungrouped last. */
const GROUP_ORDER = ['Query', 'Connection', 'Navigation', 'View', 'Editor', 'Results', 'Data', 'Help']

export function compareGroups(a: string, b: string): number {
  const ia = GROUP_ORDER.indexOf(a)
  const ib = GROUP_ORDER.indexOf(b)
  if (a === b) return 0
  if (a === 'Other') return 1
  if (b === 'Other') return -1
  if (ia >= 0 && ib >= 0) return ia - ib
  if (ia >= 0) return -1
  if (ib >= 0) return 1
  return a.localeCompare(b)
}

/**
 * Empty-query order of well-known commands inside their group: the everyday actions first, and never
 * an executing variant (Explain analyze) as the pre-selected default. `Command.priority` wins.
 */
const COMMAND_PRIORITY: Record<string, number> = {
  'run-statement': 0,
  'run-script': 1,
  'cancel-query': 2,
  'format-sql': 3,
  'new-console': 4,
  explain: 5,
  'explain-analyze': 6,
  commit: 7,
  rollback: 8,
  'toggle-autocommit': 9,
  'new-connection': 0,
  'show-sessions': 1,
  'command-palette': 0,
  'go-to-object': 1,
  'focus-editor': 2,
  'focus-results': 3,
  'focus-explorer': 4,
}

export function commandPriority(command: Command): number {
  return command.priority ?? COMMAND_PRIORITY[command.id] ?? 1000
}

export interface PaletteGroup {
  heading: string
  items: Ranked<PaletteEntry>[]
}

/**
 * Group ranked commands by `group`. With a query, groups are ordered by their best score;
 * without one, by the fixed group order.
 */
export function groupCommands(ranked: Ranked<CommandEntry>[], hasQuery: boolean): PaletteGroup[] {
  const map = new Map<string, Ranked<CommandEntry>[]>()
  for (const r of ranked) {
    const heading = r.entry.command.group ?? 'Other'
    const list = map.get(heading)
    if (list) list.push(r)
    else map.set(heading, [r])
  }
  const groups = [...map.entries()].map(([heading, items]) => ({ heading, items }))
  if (hasQuery) groups.sort((a, b) => (b.items[0]?.score ?? 0) - (a.items[0]?.score ?? 0))
  else {
    for (const g of groups) {
      g.items.sort(
        (a, b) =>
          commandPriority(a.entry.command) - commandPriority(b.entry.command) || a.entry.command.title.localeCompare(b.entry.command.title),
      )
    }
    groups.sort((a, b) => compareGroups(a.heading, b.heading))
  }
  return groups
}
