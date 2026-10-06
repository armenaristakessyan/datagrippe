// Export dropdown of a rows result: copy all as…, save loaded rows as…, export all rows (re-run).
import { ClipboardCopy, Download, FileDown, FileOutput } from 'lucide-react'
import type { ExportFormat } from '@shared/types'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui'
import { EXPORT_FORMAT_META } from '@/lib/export-format'
import { copyAllAs, exportAllRows, saveLoadedRows, type ExportAllRequest, type ExportSource } from './export-actions'

const COPY_FORMATS: ExportFormat[] = ['tsv', 'csv', 'json', 'markdown', 'sql']
const SAVE_FORMATS: ExportFormat[] = ['csv', 'tsv', 'json', 'sql', 'markdown']
const FILE_FORMATS: ExportAllRequest['format'][] = ['csv', 'tsv', 'json', 'sql']

export interface ExportMenuProps {
  source: ExportSource
  /** Present when the statement is read-only and can be re-run to export every row. */
  exportAll?: Omit<ExportAllRequest, 'format'>
  /** More rows exist than are loaded (wording of the menu). */
  partial: boolean
  /** The grid is sorted client-side: copies follow it, a re-run export does not. */
  sorted?: boolean
}

export function ExportMenu({ source, exportAll, partial, sorted = false }: ExportMenuProps) {
  const empty = source.rows.length === 0
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="ghost" leadingIcon={Download} className="gap-1 px-1.5 text-muted">
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[230px]">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger icon={ClipboardCopy} disabled={empty}>
            Copy {partial ? 'loaded rows' : 'all'} as
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-[160px]">
            {COPY_FORMATS.map((f) => (
              <DropdownMenuItem key={f} onSelect={() => void copyAllAs(f, source)}>
                {EXPORT_FORMAT_META[f].label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger icon={FileDown} disabled={empty}>
            Save {partial ? 'loaded rows' : 'rows'} as
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-[160px]">
            {SAVE_FORMATS.map((f) => (
              <DropdownMenuItem key={f} onSelect={() => void saveLoadedRows(f, source)}>
                {EXPORT_FORMAT_META[f].label}…
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {exportAll && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{sorted ? 'Re-run and export every row (unsorted)' : 'Re-run and export every row'}</DropdownMenuLabel>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger icon={FileOutput}>Export all rows</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[160px]">
                {FILE_FORMATS.map((f) => (
                  <DropdownMenuItem key={f} onSelect={() => void exportAllRows({ ...exportAll, format: f })}>
                    {EXPORT_FORMAT_META[f].label}…
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
