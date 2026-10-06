// Pure explorer tree model: node ids, children resolution from the metadata caches, flattening into
// the rows rendered by the virtualized list, and the type-to-filter logic. No React, no IPC.
import type {
  ColumnInfo,
  ConnectionConfig,
  DatabaseInfo,
  DbObjectInfo,
  ObjectKind,
  SchemaInfo,
  TableDetails,
} from '@shared/types'
import type { ConnectionRuntime } from '@/stores/connections'
import { dbKey, objectKey, schemaKey, type Loadable } from '@/stores/explorer'

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export const KIND_ORDER: ObjectKind[] = [
  'table',
  'view',
  'materialized-view',
  'foreign-table',
  'function',
  'procedure',
  'sequence',
  'type',
]

export const KIND_FOLDER_LABEL: Record<ObjectKind, string> = {
  table: 'Tables',
  view: 'Views',
  'materialized-view': 'Materialized views',
  'foreign-table': 'Foreign tables',
  function: 'Functions',
  procedure: 'Procedures',
  sequence: 'Sequences',
  type: 'Types',
}

/** Kinds whose node expands into columns (from tableDetails). */
export const RELATION_KINDS: ReadonlySet<ObjectKind> = new Set(['table', 'view', 'materialized-view', 'foreign-table'])
/** Kinds that additionally get Keys / Indexes / Foreign keys / Triggers folders. */
const TABLE_LIKE: ReadonlySet<ObjectKind> = new Set(['table', 'foreign-table', 'materialized-view'])

export type DetailFolder = 'keys' | 'indexes' | 'foreign-keys' | 'triggers'

export const DETAIL_FOLDER_LABEL: Record<DetailFolder, string> = {
  keys: 'Keys',
  indexes: 'Indexes',
  'foreign-keys': 'Foreign keys',
  triggers: 'Triggers',
}

export interface ObjectPath {
  connectionId: string
  database: string
  schema: string
}

export type LoadRequest =
  | { type: 'databases'; connectionId: string }
  | { type: 'schemas'; connectionId: string; database: string }
  | { type: 'objects'; connectionId: string; database: string; schema: string }
  | { type: 'details'; connectionId: string; database: string; schema: string; name: string }

export type TreeNode =
  | { type: 'group'; name: string; count: number }
  | { type: 'connection'; connection: ConnectionConfig }
  | { type: 'database'; connectionId: string; database: DatabaseInfo }
  | { type: 'schema'; connectionId: string; database: string; schema: SchemaInfo }
  | { type: 'folder'; path: ObjectPath; kind: ObjectKind; count: number }
  | { type: 'object'; path: ObjectPath; object: DbObjectInfo }
  | { type: 'column'; path: ObjectPath; object: DbObjectInfo; column: ColumnInfo }
  | { type: 'detail-folder'; path: ObjectPath; object: DbObjectInfo; folder: DetailFolder; count: number }
  | { type: 'detail'; path: ObjectPath; object: DbObjectInfo; folder: DetailFolder; name: string; info: string; flag?: 'primary' | 'unique' | 'disabled' }
  | { type: 'message'; tone: 'error' | 'empty'; text: string; retry?: LoadRequest }

export type TreeNodeType = TreeNode['type']

export interface TreeRow {
  id: string
  node: TreeNode
  depth: number
  parentId: string | null
  /** Connection the row belongs to (undefined for group folders). */
  connectionId?: string
  expandable: boolean
  /** Children are visible. */
  expanded: boolean
  /** Children are being fetched. */
  loading: boolean
  /** Character range of the filter match inside the row label. */
  match?: [number, number]
  /** Expanded but the children were never requested: the view triggers this load. */
  pendingLoad?: LoadRequest
}

// ---------------------------------------------------------------------------
// Ids — segments joined with "|", each escaped so names containing "|" stay unambiguous.
// A connection node's id is its connection id, and every descendant id starts with "<connectionId>|".
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replaceAll('%', '%25').replaceAll('|', '%7C')

export const nodeIds = {
  group: (name: string) => `group:${esc(name)}`,
  connection: (connectionId: string) => esc(connectionId),
  database: (connectionId: string, database: string) => `${esc(connectionId)}|${esc(database)}`,
  schema: (connectionId: string, database: string, schema: string) => `${nodeIds.database(connectionId, database)}|${esc(schema)}`,
  folder: (path: ObjectPath, kind: ObjectKind) => `${nodeIds.schema(path.connectionId, path.database, path.schema)}|#${kind}`,
  object: (path: ObjectPath, object: DbObjectInfo) =>
    `${nodeIds.folder(path, object.kind)}|${esc(object.name)}${object.identity ? `~${esc(object.identity)}` : ''}`,
  column: (objectId: string, column: string) => `${objectId}|c:${esc(column)}`,
  detailFolder: (objectId: string, folder: DetailFolder) => `${objectId}|#${folder}`,
  detail: (folderId: string, name: string) => `${folderId}|${esc(name)}`,
  message: (parentId: string) => `${parentId}|!`,
}

/** Connection id embedded in a node id (undefined for group folders). */
export function connectionIdOf(nodeId: string): string | undefined {
  if (nodeId.startsWith('group:')) return undefined
  const first = nodeId.split('|')[0] ?? ''
  return first.replaceAll('%7C', '|').replaceAll('%25', '%')
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Text the filter matches against and the row displays as its main label. */
export function nodeLabel(node: TreeNode): string {
  switch (node.type) {
    case 'group':
      return node.name
    case 'connection':
      return node.connection.name
    case 'database':
      return node.database.name
    case 'schema':
      return node.schema.name
    case 'folder':
      return KIND_FOLDER_LABEL[node.kind]
    case 'object':
      return node.object.name
    case 'column':
      return node.column.name
    case 'detail-folder':
      return DETAIL_FOLDER_LABEL[node.folder]
    case 'detail':
      return node.name
    case 'message':
      return node.text
  }
}

/**
 * The filter targets connections, databases, schemas, objects and columns. Folders and messages are
 * structure, and key / index / trigger names mostly repeat their table's name, so they never match.
 */
function isMatchable(node: TreeNode): boolean {
  return node.type !== 'folder' && node.type !== 'detail-folder' && node.type !== 'detail' && node.type !== 'message'
}

export function matchRange(label: string, needle: string): [number, number] | undefined {
  if (!needle) return undefined
  const index = label.toLowerCase().indexOf(needle)
  return index >= 0 ? [index, index + needle.length] : undefined
}

// ---------------------------------------------------------------------------
// Children
// ---------------------------------------------------------------------------

export interface TreeData {
  connections: ConnectionConfig[]
  runtime: Record<string, ConnectionRuntime>
  databases: Record<string, Loadable<DatabaseInfo[]>>
  schemas: Record<string, Loadable<SchemaInfo[]>>
  objects: Record<string, Loadable<DbObjectInfo[]>>
  details: Record<string, Loadable<TableDetails>>
}

export interface TreeInput extends TreeData {
  /** Persisted expansion (used when no filter is active). */
  expanded: Record<string, boolean>
  filter: string
  /** Expansion toggled by the user while the filter is active (reset when the filter changes). */
  filterExpanded?: Record<string, boolean>
}

interface Child {
  id: string
  node: TreeNode
}

type Children =
  | { state: 'none' }
  | { state: 'unloaded'; request: LoadRequest }
  | { state: 'loading'; children: Child[] }
  | { state: 'error'; error: string; request: LoadRequest; children: Child[] }
  | { state: 'ready'; children: Child[] }

function fromLoadable<T>(
  loadable: Loadable<T> | undefined,
  request: LoadRequest,
  parentId: string,
  build: (data: T) => Child[],
  emptyText: string,
): Children {
  if (!loadable) return { state: 'unloaded', request }
  // Stale data stays on screen while a refresh is running.
  const children = loadable.data !== undefined ? build(loadable.data) : []
  if (loadable.status === 'loading') return { state: 'loading', children }
  if (loadable.status === 'error') {
    return {
      state: 'error',
      error: loadable.error ?? 'Failed to load',
      request,
      children: [{ id: nodeIds.message(parentId), node: { type: 'message', tone: 'error', text: loadable.error ?? 'Failed to load', retry: request } }],
    }
  }
  if (children.length === 0) {
    return { state: 'ready', children: [{ id: nodeIds.message(parentId), node: { type: 'message', tone: 'empty', text: emptyText } }] }
  }
  return { state: 'ready', children }
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

type DetailFlag = 'primary' | 'unique' | 'disabled'
const DETAIL_FOLDERS: DetailFolder[] = ['keys', 'indexes', 'foreign-keys', 'triggers']

function detailItems(folder: DetailFolder, schema: string, details: TableDetails): { name: string; info: string; flag?: DetailFlag }[] {
  switch (folder) {
    case 'keys':
      return details.constraints
        .filter((c) => c.type === 'primary-key' || c.type === 'unique')
        .map((c) => ({ name: c.name, info: c.columns.join(', '), flag: c.type === 'primary-key' ? 'primary' : 'unique' }))
    case 'indexes':
      return details.indexes.map((i) => ({
        name: i.name,
        info: i.columns.join(', '),
        flag: i.isPrimary ? 'primary' : i.isUnique ? 'unique' : undefined,
      }))
    case 'foreign-keys':
      return details.foreignKeys.map((fk) => ({
        name: fk.name,
        info: `${fk.columns.join(', ')} → ${fk.refSchema === schema ? '' : `${fk.refSchema}.`}${fk.refTable}`,
      }))
    case 'triggers':
      return details.triggers.map((t) => ({
        name: t.name,
        info: `${t.timing} ${t.events.join(' | ')}`.trim(),
        flag: t.enabled ? undefined : 'disabled',
      }))
  }
}

/** Columns (ordinal order), then the non-empty Keys / Indexes / Foreign keys / Triggers folders for tables. */
function detailChildren(objectId: string, path: ObjectPath, object: DbObjectInfo, details: TableDetails): Child[] {
  const columns: Child[] = [...details.columns]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((column) => ({ id: nodeIds.column(objectId, column.name), node: { type: 'column', path, object, column } }))
  if (!TABLE_LIKE.has(object.kind)) return columns
  const folders: Child[] = []
  for (const folder of DETAIL_FOLDERS) {
    const count = detailItems(folder, path.schema, details).length
    if (count === 0) continue
    folders.push({ id: nodeIds.detailFolder(objectId, folder), node: { type: 'detail-folder', path, object, folder, count } })
  }
  return [...columns, ...folders]
}

function detailLeaves(folderId: string, node: Extract<TreeNode, { type: 'detail-folder' }>, details: TableDetails | undefined): Child[] {
  if (!details) return []
  return detailItems(node.folder, node.path.schema, details).map((item) => ({
    id: nodeIds.detail(folderId, item.name),
    node: { type: 'detail', path: node.path, object: node.object, folder: node.folder, ...item },
  }))
}

/** Effective children of a node given the caches. */
function childrenOf(id: string, node: TreeNode, data: TreeData, groups: Map<string, ConnectionConfig[]>): Children {
  switch (node.type) {
    case 'group':
      return {
        state: 'ready',
        children: (groups.get(node.name) ?? []).map((c) => ({ id: nodeIds.connection(c.id), node: { type: 'connection', connection: c } })),
      }
    case 'connection': {
      const cid = node.connection.id
      return fromLoadable(
        data.databases[cid],
        { type: 'databases', connectionId: cid },
        id,
        (dbs) => dbs.map((database) => ({ id: nodeIds.database(cid, database.name), node: { type: 'database', connectionId: cid, database } })),
        'No databases',
      )
    }
    case 'database': {
      const { connectionId } = node
      const database = node.database.name
      return fromLoadable(
        data.schemas[dbKey(connectionId, database)],
        { type: 'schemas', connectionId, database },
        id,
        (schemas) =>
          schemas.map((schema) => ({
            id: nodeIds.schema(connectionId, database, schema.name),
            node: { type: 'schema', connectionId, database, schema },
          })),
        'No schemas',
      )
    }
    case 'schema': {
      const path: ObjectPath = { connectionId: node.connectionId, database: node.database, schema: node.schema.name }
      return fromLoadable(
        data.objects[schemaKey(path.connectionId, path.database, path.schema)],
        { type: 'objects', ...path },
        id,
        (objects) => {
          const counts = new Map<ObjectKind, number>()
          for (const o of objects) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1)
          return KIND_ORDER.filter((k) => (counts.get(k) ?? 0) > 0).map((kind) => ({
            id: nodeIds.folder(path, kind),
            node: { type: 'folder', path, kind, count: counts.get(kind) ?? 0 },
          }))
        },
        'Empty schema',
      )
    }
    case 'folder': {
      const objects = data.objects[schemaKey(node.path.connectionId, node.path.database, node.path.schema)]?.data ?? []
      const children = objects
        .filter((o) => o.kind === node.kind)
        .sort((a, b) => byName(a.name, b.name) || byName(a.signature ?? '', b.signature ?? ''))
        .map((object) => ({ id: nodeIds.object(node.path, object), node: { type: 'object' as const, path: node.path, object } }))
      return { state: 'ready', children }
    }
    case 'object': {
      if (!RELATION_KINDS.has(node.object.kind)) return { state: 'none' }
      const { path, object } = node
      return fromLoadable(
        data.details[objectKey(path.connectionId, path.database, path.schema, object.name)],
        { type: 'details', ...path, name: object.name },
        id,
        (details) => detailChildren(id, path, object, details),
        'No columns',
      )
    }
    case 'detail-folder': {
      const details = data.details[objectKey(node.path.connectionId, node.path.database, node.path.schema, node.object.name)]?.data
      return { state: 'ready', children: detailLeaves(id, node, details) }
    }
    default:
      return { state: 'none' }
  }
}

/** A connection only shows children once a connection attempt / load was made for it. */
function connectionOpenable(node: TreeNode, data: TreeData): boolean {
  if (node.type !== 'connection') return true
  const status = data.runtime[node.connection.id]?.status
  return status === 'connected' || status === 'connecting' || data.databases[node.connection.id] !== undefined
}

function isExpandable(node: TreeNode): boolean {
  switch (node.type) {
    case 'group':
    case 'connection':
    case 'database':
    case 'schema':
    case 'folder':
    case 'detail-folder':
      return true
    case 'object':
      return RELATION_KINDS.has(node.object.kind)
    default:
      return false
  }
}

function connectionOf(node: TreeNode): string | undefined {
  switch (node.type) {
    case 'group':
    case 'message':
      return undefined
    case 'connection':
      return node.connection.id
    case 'database':
    case 'schema':
      return node.connectionId
    default:
      return node.path.connectionId
  }
}

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

/** Group folders first (alphabetical), then ungrouped connections; connections sorted by name. */
export function rootChildren(connections: ConnectionConfig[]): { roots: Child[]; groups: Map<string, ConnectionConfig[]> } {
  const sorted = [...connections].sort((a, b) => byName(a.name, b.name) || byName(a.host, b.host))
  const groups = new Map<string, ConnectionConfig[]>()
  const loose: ConnectionConfig[] = []
  for (const c of sorted) {
    const group = c.group?.trim()
    if (!group) {
      loose.push(c)
      continue
    }
    const list = groups.get(group)
    if (list) list.push(c)
    else groups.set(group, [c])
  }
  const groupNames = [...groups.keys()].sort(byName)
  const roots: Child[] = [
    ...groupNames.map((name) => ({ id: nodeIds.group(name), node: { type: 'group' as const, name, count: groups.get(name)?.length ?? 0 } })),
    ...loose.map((c) => ({ id: nodeIds.connection(c.id), node: { type: 'connection' as const, connection: c } })),
  ]
  return { roots, groups }
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

/** Group folders are expanded unless explicitly collapsed; everything else is collapsed by default. */
export function isStoredExpanded(id: string, node: TreeNode, expanded: Record<string, boolean>): boolean {
  if (node.type === 'group') return expanded[id] !== false
  return expanded[id] === true
}

function makeRow(child: Child, depth: number, parentId: string | null): TreeRow {
  return {
    id: child.id,
    node: child.node,
    depth,
    parentId,
    connectionId: connectionOf(child.node),
    expandable: isExpandable(child.node),
    expanded: false,
    loading: false,
  }
}

/** Visible rows for the current expansion, without a filter. */
function flattenPlain(roots: Child[], input: TreeInput, groups: Map<string, ConnectionConfig[]>): TreeRow[] {
  const out: TreeRow[] = []
  const visit = (child: Child, depth: number, parentId: string | null) => {
    const row = makeRow(child, depth, parentId)
    out.push(row)
    if (!row.expandable || !isStoredExpanded(child.id, child.node, input.expanded) || !connectionOpenable(child.node, input)) return
    const children = childrenOf(child.id, child.node, input, groups)
    row.expanded = true
    if (children.state === 'unloaded') {
      row.pendingLoad = children.request
      row.loading = true
      return
    }
    if (children.state === 'none') return
    row.loading = children.state === 'loading'
    for (const c of children.children) visit(c, depth + 1, child.id)
  }
  for (const r of roots) visit(r, 0, null)
  return out
}

/**
 * Filtered rows: a node is visible when its label or a loaded descendant's matches. Ancestors of matches
 * are expanded automatically; the user can still collapse them, or expand a match to browse its
 * (unfiltered) children, through `filterExpanded`.
 */
function flattenFiltered(roots: Child[], input: TreeInput, groups: Map<string, ConnectionConfig[]>, needle: string): TreeRow[] {
  const overrides = input.filterExpanded ?? {}

  // Unfiltered subtree under an expanded match: only user-toggled expansion applies.
  const browse = (child: Child, depth: number, parentId: string | null, out: TreeRow[]) => {
    const row = makeRow(child, depth, parentId)
    row.match = isMatchable(child.node) ? matchRange(nodeLabel(child.node), needle) : undefined
    out.push(row)
    if (!row.expandable || overrides[child.id] !== true) return
    const children = childrenOf(child.id, child.node, input, groups)
    row.expanded = true
    if (children.state === 'unloaded') {
      row.pendingLoad = children.request
      row.loading = true
      return
    }
    if (children.state === 'none') return
    row.loading = children.state === 'loading'
    for (const c of children.children) browse(c, depth + 1, child.id, out)
  }

  /** Rows of the subtree when it contains a match, else null. */
  const visit = (child: Child, depth: number, parentId: string | null): TreeRow[] | null => {
    const match = isMatchable(child.node) ? matchRange(nodeLabel(child.node), needle) : undefined
    const row = makeRow(child, depth, parentId)
    row.match = match
    const children = row.expandable ? childrenOf(child.id, child.node, input, groups) : ({ state: 'none' } as Children)
    const loaded = children.state === 'ready' || children.state === 'loading' ? children.children : []

    const descendantRows: TreeRow[] = []
    for (const c of loaded) {
      if (c.node.type === 'message') continue
      const rows = visit(c, depth + 1, child.id)
      if (rows) descendantRows.push(...rows)
    }
    const hasMatchBelow = descendantRows.length > 0
    if (!match && !hasMatchBelow) return null

    const override = overrides[child.id]
    const open = override ?? hasMatchBelow
    const out: TreeRow[] = [row]
    if (!open || !row.expandable) return out
    row.expanded = true
    if (hasMatchBelow) {
      row.loading = children.state === 'loading'
      out.push(...descendantRows)
      return out
    }
    // A match without matching descendants, expanded by the user: browse everything below it.
    if (children.state === 'unloaded') {
      row.pendingLoad = children.request
      row.loading = true
      return out
    }
    if (children.state === 'none') return out
    row.loading = children.state === 'loading'
    for (const c of children.children) browse(c, depth + 1, child.id, out)
    return out
  }

  const out: TreeRow[] = []
  for (const r of roots) {
    const rows = visit(r, 0, null)
    if (rows) out.push(...rows)
  }
  return out
}

export function flattenTree(input: TreeInput): TreeRow[] {
  const { roots, groups } = rootChildren(input.connections)
  const needle = input.filter.trim().toLowerCase()
  return needle ? flattenFiltered(roots, input, groups, needle) : flattenPlain(roots, input, groups)
}

/** Ids of every ancestor of a row (closest first), using the rows' parent links. */
export function ancestorIds(rows: TreeRow[], id: string): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out: string[] = []
  let current = byId.get(id)?.parentId ?? null
  while (current) {
    out.push(current)
    current = byId.get(current)?.parentId ?? null
  }
  return out
}

/** Persisted expansion pruned to existing connections, capped in size. */
export function pruneExpanded(expanded: Record<string, boolean>, connectionIds: Set<string>, max = 2000): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  let n = 0
  for (const [id, value] of Object.entries(expanded)) {
    if (n >= max) break
    if (id.startsWith('group:')) {
      if (value === false) {
        out[id] = false
        n++
      }
      continue
    }
    if (value !== true) continue
    const cid = connectionIdOf(id)
    if (cid === undefined || !connectionIds.has(cid)) continue
    out[id] = true
    n++
  }
  return out
}
