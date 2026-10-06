import { Check, Columns3, KeyRound, Link2 } from 'lucide-react'
import type { ColumnInfo, ForeignKeyInfo } from '@shared/types'
import { Badge, Tooltip } from '@/components/ui'
import { Cell, None, Row, SectionEmpty, SectionTable } from './SectionTable'

export function ColumnsSection({ columns, foreignKeys }: { columns: ColumnInfo[]; foreignKeys: ForeignKeyInfo[] }) {
  if (columns.length === 0) {
    return <SectionEmpty icon={Columns3} title="No columns" description="This object does not expose any column." />
  }
  const fkByColumn = new Map<string, ForeignKeyInfo>()
  for (const fk of foreignKeys) for (const c of fk.columns) if (!fkByColumn.has(c)) fkByColumn.set(c, fk)

  return (
    <SectionTable
      head={[
        { label: '#', className: 'w-12 text-right' },
        { label: 'Name' },
        { label: 'Type' },
        { label: 'Null', className: 'w-14 text-center' },
        { label: 'Default' },
        { label: '', className: 'w-px' },
        { label: 'Comment' },
      ]}
    >
      {[...columns]
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((column) => {
          const fk = fkByColumn.get(column.name)
          return (
            <Row key={column.name}>
              <Cell className="w-12 text-right text-2xs tabular text-subtle">{column.ordinal}</Cell>
              <Cell>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-mono text-xs font-medium text-fg">{column.name}</span>
                  {column.isPrimaryKey && (
                    <Tooltip content="Primary key">
                      <span className="flex shrink-0 text-warning" aria-label="Primary key">
                        <KeyRound size={12} strokeWidth={2} />
                      </span>
                    </Tooltip>
                  )}
                  {fk && (
                    <Tooltip content={`References ${fk.refSchema}.${fk.refTable} (${fk.refColumns.join(', ')})`}>
                      <span className="flex shrink-0 text-info" aria-label="Foreign key">
                        <Link2 size={12} strokeWidth={2} />
                      </span>
                    </Tooltip>
                  )}
                </span>
              </Cell>
              <Cell className="whitespace-nowrap font-mono text-xs text-muted">{column.dataType}</Cell>
              <Cell className="w-14 text-center">
                {column.nullable ? (
                  <Check size={13} strokeWidth={2} className="inline text-muted" aria-label="Nullable" />
                ) : (
                  <span className="sr-only">Not null</span>
                )}
              </Cell>
              <Cell className="max-w-[260px]" title={column.defaultValue ?? undefined}>
                {column.defaultValue !== null && column.defaultValue !== '' ? (
                  <span className="block truncate font-mono text-xs text-muted">{column.defaultValue}</span>
                ) : (
                  <None />
                )}
              </Cell>
              <Cell className="w-px whitespace-nowrap">
                <span className="flex gap-1">
                  {column.isIdentity && <Badge tone="accent">identity</Badge>}
                  {column.isGenerated && <Badge tone="info">generated</Badge>}
                </span>
              </Cell>
              <Cell className="max-w-[360px] text-xs text-muted" title={column.comment}>
                {column.comment ? <span className="block truncate">{column.comment}</span> : <None />}
              </Cell>
            </Row>
          )
        })}
    </SectionTable>
  )
}
