// Context menu content for explorer rows (one ContextMenu wraps the whole tree; see Explorer.tsx).
import {
  Activity,
  ChevronsDownUp,
  ClipboardCopy,
  Copy,
  FileCode2,
  FileUp,
  KeyRound,
  LogOut,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  SquareTerminal,
  Table2,
  TableProperties,
  Trash2,
  Unplug,
} from 'lucide-react'
import type { DbObjectInfo } from '@shared/types'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui'
import { importCsvInto } from '@/components/table/ImportCsvDialog'
import { isVaultConnection, refreshVaultCredentials, signOutOfVault } from '@/components/vault/actions'
import { MENU_ACCELERATORS } from '@/lib/shortcuts'
import { connectionById, useConnections } from '@/stores/connections'
import { useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import {
  activateObject,
  connect,
  copyText,
  deleteConnection,
  disconnect,
  dropObject,
  duplicateConnection,
  editConnection,
  generateScript,
  newConsoleFor,
  newConsoleHere,
  openTable,
  refreshRow,
} from './actions'
import { objectQualifiedName } from './scripts'
import { RELATION_KINDS, type ObjectPath, type TreeRow } from './tree'

export interface ExplorerMenuProps {
  /** Row under the pointer; null = empty area of the tree. */
  row: TreeRow | null
  onCollapseAll: () => void
  onRefreshAll: () => void
}

export function ExplorerMenuContent({ row, onCollapseAll, onRefreshAll }: ExplorerMenuProps) {
  return (
    <ContextMenuContent className="min-w-[224px]" onCloseAutoFocus={(e) => e.preventDefault()}>
      {row ? <RowItems row={row} /> : <BackgroundItems onCollapseAll={onCollapseAll} onRefreshAll={onRefreshAll} />}
    </ContextMenuContent>
  )
}

function BackgroundItems({ onCollapseAll, onRefreshAll }: Omit<ExplorerMenuProps, 'row'>) {
  return (
    <>
      <ContextMenuItem icon={Plus} shortcut={MENU_ACCELERATORS['new-connection']} onSelect={() => useUi.getState().openConnectionDialog()}>
        New connection…
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem icon={RefreshCw} onSelect={onRefreshAll}>
        Refresh all
      </ContextMenuItem>
      <ContextMenuItem icon={ChevronsDownUp} onSelect={onCollapseAll}>
        Collapse all
      </ContextMenuItem>
    </>
  )
}

function RowItems({ row }: { row: TreeRow }) {
  const node = row.node
  const refresh = () => void refreshRow(row)
  switch (node.type) {
    case 'group':
      return (
        <>
          <ContextMenuLabel>{node.name}</ContextMenuLabel>
          <ContextMenuItem icon={Plus} onSelect={() => useUi.getState().openConnectionDialog({ group: node.name })}>
            New connection in this group…
          </ContextMenuItem>
          <ContextMenuItem icon={RefreshCw} onSelect={refresh}>
            Refresh connected
          </ContextMenuItem>
        </>
      )
    case 'connection':
      return <ConnectionItems connectionId={node.connection.id} onRefresh={refresh} />
    case 'database':
      return (
        <>
          <ContextMenuItem icon={SquareTerminal} onSelect={() => newConsoleHere(node.connectionId, node.database.name)}>
            New console here
          </ContextMenuItem>
          <ContextMenuItem icon={RefreshCw} onSelect={refresh}>
            Refresh
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem icon={Copy} onSelect={() => void copyText(node.database.name)}>
            Copy name
          </ContextMenuItem>
        </>
      )
    case 'schema':
      return (
        <>
          <ContextMenuItem icon={SquareTerminal} onSelect={() => newConsoleHere(node.connectionId, node.database, node.schema.name)}>
            New console here
          </ContextMenuItem>
          <ContextMenuItem icon={RefreshCw} onSelect={refresh}>
            Refresh
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem icon={Copy} onSelect={() => void copyText(node.schema.name)}>
            Copy name
          </ContextMenuItem>
        </>
      )
    case 'folder':
      return (
        <>
          <ContextMenuItem icon={SquareTerminal} onSelect={() => newConsoleHere(node.path.connectionId, node.path.database, node.path.schema)}>
            New console here
          </ContextMenuItem>
          <ContextMenuItem icon={RefreshCw} onSelect={refresh}>
            Refresh
          </ContextMenuItem>
        </>
      )
    case 'object':
      return RELATION_KINDS.has(node.object.kind) ? (
        <RelationItems path={node.path} object={node.object} onRefresh={refresh} />
      ) : (
        <RoutineItems path={node.path} object={node.object} onRefresh={refresh} />
      )
    case 'column':
      return (
        <ContextMenuItem icon={Copy} onSelect={() => void copyText(node.column.name)}>
          Copy name
        </ContextMenuItem>
      )
    case 'detail-folder':
      return (
        <ContextMenuItem icon={RefreshCw} onSelect={refresh}>
          Refresh
        </ContextMenuItem>
      )
    case 'detail':
      return (
        <ContextMenuItem icon={Copy} onSelect={() => void copyText(node.name)}>
          Copy name
        </ContextMenuItem>
      )
    case 'message':
      return node.retry ? (
        <ContextMenuItem icon={RefreshCw} onSelect={refresh}>
          Retry
        </ContextMenuItem>
      ) : (
        <ContextMenuItem disabled>Nothing to do here</ContextMenuItem>
      )
  }
}

function ConnectionItems({ connectionId, onRefresh }: { connectionId: string; onRefresh: () => void }) {
  const status = useConnections((s) => s.runtime[connectionId]?.status ?? 'disconnected')
  const connection = connectionById(connectionId)
  const live = status === 'connected' || status === 'connecting'
  return (
    <>
      {live ? (
        <ContextMenuItem icon={Unplug} onSelect={() => void disconnect(connectionId)}>
          Disconnect
        </ContextMenuItem>
      ) : (
        <ContextMenuItem icon={PlugZap} onSelect={() => void connect(connectionId)}>
          Connect
        </ContextMenuItem>
      )}
      <ContextMenuItem icon={SquareTerminal} shortcut={MENU_ACCELERATORS['new-console']} onSelect={() => newConsoleFor(connectionId)}>
        New console
      </ContextMenuItem>
      <ContextMenuItem icon={Activity} onSelect={() => useTabs.getState().openSessions(connectionId)}>
        Show sessions…
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem icon={Pencil} onSelect={() => editConnection(connectionId)}>
        Edit…
      </ContextMenuItem>
      <ContextMenuItem icon={Copy} onSelect={() => void duplicateConnection(connectionId)}>
        Duplicate
      </ContextMenuItem>
      <ContextMenuItem icon={RefreshCw} disabled={status !== 'connected'} onSelect={onRefresh}>
        Refresh
      </ContextMenuItem>
      <ContextMenuItem icon={ClipboardCopy} disabled={!connection} onSelect={() => connection && void copyText(connection.host, 'host')}>
        Copy host
      </ContextMenuItem>
      {isVaultConnection(connection) && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem icon={KeyRound} disabled={status !== 'connected'} onSelect={() => void refreshVaultCredentials(connectionId)}>
            Refresh Vault credentials
          </ContextMenuItem>
          <ContextMenuItem icon={LogOut} onSelect={() => void signOutOfVault(connectionId)}>
            Sign out of Vault
          </ContextMenuItem>
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem icon={Trash2} danger onSelect={() => void deleteConnection(connectionId)}>
        Delete…
      </ContextMenuItem>
    </>
  )
}

function CopyItems({ path, object }: { path: ObjectPath; object: DbObjectInfo }) {
  const dialect = connectionById(path.connectionId)?.dialect ?? 'postgres'
  return (
    <>
      <ContextMenuItem icon={Copy} onSelect={() => void copyText(object.name)}>
        Copy name
      </ContextMenuItem>
      <ContextMenuItem icon={ClipboardCopy} onSelect={() => void copyText(objectQualifiedName(object, dialect), 'qualified name')}>
        Copy qualified name
      </ContextMenuItem>
    </>
  )
}

function RelationItems({ path, object, onRefresh }: { path: ObjectPath; object: DbObjectInfo; onRefresh: () => void }) {
  return (
    <>
      <ContextMenuItem icon={Table2} onSelect={() => openTable(path, object, 'table')}>
        Open data
      </ContextMenuItem>
      <ContextMenuItem icon={TableProperties} onSelect={() => openTable(path, object, 'structure')}>
        Open structure
      </ContextMenuItem>
      <ContextMenuItem icon={SquareTerminal} onSelect={() => void generateScript(path, object, 'select')}>
        New console with SELECT
      </ContextMenuItem>
      {object.kind === 'table' && (
        <ContextMenuItem
          icon={FileUp}
          disabled={connectionById(path.connectionId)?.readOnly}
          onSelect={() => void importCsvInto({ connectionId: path.connectionId, database: path.database, schema: object.schema, name: object.name })}
        >
          Import data from CSV…
        </ContextMenuItem>
      )}
      <ContextMenuSub>
        <ContextMenuSubTrigger icon={FileCode2}>Generate SQL</ContextMenuSubTrigger>
        <ContextMenuSubContent className="min-w-[160px]">
          <ContextMenuItem onSelect={() => void generateScript(path, object, 'select')}>SELECT</ContextMenuItem>
          <ContextMenuItem onSelect={() => void generateScript(path, object, 'insert')}>INSERT</ContextMenuItem>
          <ContextMenuItem onSelect={() => void generateScript(path, object, 'update')}>UPDATE</ContextMenuItem>
          <ContextMenuItem onSelect={() => void generateScript(path, object, 'delete')}>DELETE</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void generateScript(path, object, 'ddl')}>DDL</ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <CopyItems path={path} object={object} />
      <ContextMenuItem icon={RefreshCw} onSelect={onRefresh}>
        Refresh
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem icon={Trash2} danger onSelect={() => dropObject(path, object)}>
        Drop…
      </ContextMenuItem>
    </>
  )
}

function RoutineItems({ path, object, onRefresh }: { path: ObjectPath; object: DbObjectInfo; onRefresh: () => void }) {
  return (
    <>
      <ContextMenuItem icon={FileCode2} onSelect={() => activateObject(path, object)}>
        Open DDL
      </ContextMenuItem>
      <ContextMenuSeparator />
      <CopyItems path={path} object={object} />
      <ContextMenuItem icon={RefreshCw} onSelect={onRefresh}>
        Refresh
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem icon={Trash2} danger onSelect={() => dropObject(path, object)}>
        Drop…
      </ContextMenuItem>
    </>
  )
}
