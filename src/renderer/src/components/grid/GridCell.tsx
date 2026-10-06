// What one grid cell renders for a value: NULL, booleans, binary, JSON/XML badges, line markers.
import { Fragment } from 'react'
import type { CellValue } from '@shared/types'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/cn'
import { cellDisplay } from './cell-format'
import type { ColumnKind } from './column-types'

export interface CellContentProps {
  value: CellValue
  kind: ColumnKind
  nullDisplay: string
}

export function CellContent({ value, kind, nullDisplay }: CellContentProps) {
  const d = cellDisplay(value, kind)
  switch (d.type) {
    case 'null':
      return <span className="truncate italic text-grid-null">{nullDisplay}</span>
    case 'empty':
      return (
        <span className="text-faint" title="Empty string">
          ''
        </span>
      )
    case 'blank':
      return (
        <span className="truncate text-faint" title={`${d.length} whitespace character${d.length === 1 ? '' : 's'}`}>
          {'·'.repeat(Math.min(d.length, 64))}
        </span>
      )
    case 'boolean':
      return (
        <span
          className={cn(
            'inline-flex h-4 items-center rounded-[3px] px-1 text-2xs leading-4',
            d.value ? 'bg-accent-soft text-accent' : 'bg-active text-muted',
          )}
        >
          {d.value ? 'true' : 'false'}
        </span>
      )
    case 'binary':
      return (
        <>
          <span className="min-w-0 truncate text-muted">
            {d.hex}
            {d.truncated && '…'}
          </span>
          <span className="ml-1.5 shrink-0 font-sans text-2xs text-faint">{formatBytes(d.bytes)}</span>
        </>
      )
    case 'text':
      return (
        <>
          {d.badge && (
            <span className="mr-1.5 shrink-0 rounded-[3px] bg-active px-1 font-mono text-2xs leading-4 text-subtle">
              {d.badge === 'json' ? '{}' : '<>'}
            </span>
          )}
          <span className="min-w-0 truncate whitespace-pre">
            {d.segments.length === 1
              ? d.segments[0]
              : d.segments.map((s, i) => (
                  <Fragment key={i}>
                    {i > 0 && <span className="mx-px text-subtle">↵</span>}
                    {s}
                  </Fragment>
                ))}
            {d.truncated && '…'}
          </span>
        </>
      )
  }
}
