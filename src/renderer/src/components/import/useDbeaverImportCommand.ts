// Entry points of the "Import from DBeaver" dialog: the palette command (registered while the dialog
// component is mounted, i.e. by the app shell) and the helper the welcome screen / explorer call.
import { useEffect } from 'react'
import { Import } from 'lucide-react'
import { registerCommands } from '@/lib/commands'
import { useUi } from '@/stores/ui'

export const IMPORT_DBEAVER_COMMAND = 'import-dbeaver'

export function openDbeaverImport(): void {
  useUi.getState().setDbeaverImportOpen(true)
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
      ]),
    [],
  )
}
