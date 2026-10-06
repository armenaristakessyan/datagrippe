// What happens when a palette entry is picked.
import { toast } from '@/components/ui'
import { newConsole } from '@/components/layout/useGlobalCommands'
import { api } from '@/lib/api'
import { runCommand } from '@/lib/commands'
import { useConnections } from '@/stores/connections'
import { useTabs } from '@/stores/tabs'
import { DDL_KINDS, type ConnectionEntry, type ObjectEntry, type PaletteEntry } from './items'

/** Show a loading toast only when the work takes longer than this. */
const SLOW_MS = 300

async function openDefinition(entry: ObjectEntry): Promise<void> {
  let toastId: string | number | undefined
  const timer = setTimeout(() => {
    toastId = toast.loading(`Loading ${entry.name}…`)
  }, SLOW_MS)
  try {
    const ok = await useConnections.getState().ensureConnected(entry.connectionId)
    if (!ok) return
    const ddl = await api.meta.ddl({
      connectionId: entry.connectionId,
      database: entry.database,
      schema: entry.schema,
      name: entry.name,
      kind: entry.kind,
      identity: entry.identity,
    })
    useTabs.getState().openConsole({
      connectionId: entry.connectionId,
      database: entry.database,
      schema: entry.schema,
      content: ddl,
      title: entry.name,
    })
  } catch (error) {
    toast.error(`Could not load the definition of ${entry.schema}.${entry.name}`, error)
  } finally {
    clearTimeout(timer)
    if (toastId !== undefined) toast.dismiss(toastId)
  }
}

/** Tables/views open their data (alt: structure); routines, sequences and types open their DDL in a console. */
export function openObject(entry: ObjectEntry, alt: boolean): void {
  if (DDL_KINDS.has(entry.kind)) {
    void openDefinition(entry)
    return
  }
  useTabs.getState().openTable(
    { connectionId: entry.connectionId, database: entry.database, schema: entry.schema, name: entry.name, kind: entry.kind },
    alt ? 'structure' : 'table',
  )
}

/** Enter opens a console (connecting on the way); alt only connects. */
export function openConnection(entry: ConnectionEntry, alt: boolean): void {
  if (!alt) {
    newConsole(entry.connection.id)
    return
  }
  if (entry.connected) return
  useConnections
    .getState()
    .connect(entry.connection.id)
    .then((info) => {
      if (info) toast.success(`Connected to ${entry.connection.name}`, { description: `${info.currentDatabase} · ${info.versionShort}` })
    })
    .catch((error: unknown) => toast.error(`Could not connect to ${entry.connection.name}`, error))
}

export function runEntry(entry: PaletteEntry, alt: boolean): void {
  switch (entry.type) {
    case 'command':
      runCommand(entry.command.id)
      return
    case 'connection':
      openConnection(entry, alt)
      return
    case 'object':
      openObject(entry, alt)
  }
}

/** Footer hint for the primary (↵) and alternate (⌥↵) actions of an entry. */
export function entryActions(entry: PaletteEntry | undefined, mode: 'commands' | 'objects' = 'objects'): { primary: string; alt?: string } {
  if (!entry) return { primary: mode === 'commands' ? 'Run' : 'Open' }
  switch (entry.type) {
    case 'command':
      return { primary: 'Run' }
    case 'connection':
      return { primary: 'Open console', alt: entry.connected ? undefined : 'Connect' }
    case 'object':
      return DDL_KINDS.has(entry.kind) ? { primary: 'Open definition' } : { primary: 'Open data', alt: 'Structure' }
  }
}
