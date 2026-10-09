// Entry points of the "Import from DBeaver" / "Import from DataGrip" dialogs: the palette commands (registered
// while the dialog component is mounted, i.e. by the app shell) and the helpers the welcome screen / explorer call.
import { useEffect } from 'react'
import { Import } from 'lucide-react'
import { registerCommands } from '@/lib/commands'
import { useUi } from '@/stores/ui'

export const IMPORT_DBEAVER_COMMAND = 'import-dbeaver'
export const IMPORT_DATAGRIP_COMMAND = 'import-datagrip'

export function openDbeaverImport(): void {
  useUi.getState().setDbeaverImportOpen(true)
}

export function openDatagripImport(): void {
  useUi.getState().setDatagripImportOpen(true)
}

export function useDbeaverImportCommand(): void {
  useEffect(
    () =>
      registerCommands([
        {
          id: IMPORT_DBEAVER_COMMAND,
          title: 'Import connections from DBeaver',
          group: 'Connection',
          icon: Import,
          keywords: ['dbeaver', 'import', 'migrate', 'data sources', 'vault', 'add', 'connections'],
          run: openDbeaverImport,
        },
        {
          id: IMPORT_DATAGRIP_COMMAND,
          title: 'Import connections from DataGrip',
          group: 'Connection',
          icon: Import,
          keywords: ['datagrip', 'jetbrains', 'import', 'paste', 'data sources', 'add', 'connections'],
          run: openDatagripImport,
        },
      ]),
    [],
  )
}
