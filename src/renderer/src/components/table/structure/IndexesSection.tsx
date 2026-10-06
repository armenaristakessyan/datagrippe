import { ListTree } from 'lucide-react'
import type { IndexInfo } from '@shared/types'
import { Badge, SqlText } from '@/components/ui'
import { ExpandableRow, IdentList, None, SectionEmpty, SectionTable } from './SectionTable'

export function IndexesSection({ indexes }: { indexes: IndexInfo[] }) {
  if (indexes.length === 0) {
    return <SectionEmpty icon={ListTree} title="No indexes" description="Lookups on this table scan every row." />
  }
  const sorted = [...indexes].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name))
  return (
    <SectionTable head={[{ label: 'Name' }, { label: 'Columns' }, { label: '', className: 'w-px' }, { label: 'Method' }, { label: 'Predicate' }]}>
      {sorted.map((index) => (
        <ExpandableRow
          key={index.name}
          label={index.name}
          colSpan={5}
          detail={index.definition}
          cells={[
            <span key="n" className="block truncate font-mono text-xs font-medium text-fg">
              {index.name}
            </span>,
            <IdentList key="c" names={index.columns} />,
            <span key="b" className="flex gap-1 whitespace-nowrap">
              {index.isPrimary && <Badge tone="warning">primary</Badge>}
              {index.isUnique && !index.isPrimary && <Badge tone="accent">unique</Badge>}
            </span>,
            index.method ? (
              <span key="m" className="whitespace-nowrap font-mono text-xs text-muted">
                {index.method}
              </span>
            ) : (
              <None key="m" />
            ),
            index.predicate ? <SqlText key="p" code={index.predicate} className="block max-w-[320px] truncate text-xs" /> : <None key="p" />,
          ]}
        />
      ))}
    </SectionTable>
  )
}
