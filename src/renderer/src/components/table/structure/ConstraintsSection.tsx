import { ShieldCheck } from 'lucide-react'
import type { ConstraintInfo } from '@shared/types'
import { Badge, SqlText, type BadgeTone } from '@/components/ui'
import { Cell, IdentList, None, Row, SectionEmpty, SectionTable } from './SectionTable'

const TYPE: Record<ConstraintInfo['type'], { label: string; tone: BadgeTone }> = {
  'primary-key': { label: 'PRIMARY KEY', tone: 'warning' },
  unique: { label: 'UNIQUE', tone: 'accent' },
  check: { label: 'CHECK', tone: 'info' },
  exclusion: { label: 'EXCLUDE', tone: 'neutral' },
  default: { label: 'DEFAULT', tone: 'neutral' },
}

const ORDER: ConstraintInfo['type'][] = ['primary-key', 'unique', 'check', 'exclusion', 'default']

export function ConstraintsSection({ constraints }: { constraints: ConstraintInfo[] }) {
  if (constraints.length === 0) {
    return <SectionEmpty icon={ShieldCheck} title="No constraints" description="No primary key, unique or check constraint is defined." />
  }
  const sorted = [...constraints].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || a.name.localeCompare(b.name))
  return (
    <SectionTable head={[{ label: 'Type', className: 'w-px' }, { label: 'Name' }, { label: 'Columns' }, { label: 'Definition' }]}>
      {sorted.map((constraint) => {
        const type = TYPE[constraint.type]
        return (
          <Row key={`${constraint.type}:${constraint.name}`}>
            <Cell className="w-px whitespace-nowrap">
              <Badge tone={type.tone} mono>
                {type.label}
              </Badge>
            </Cell>
            <Cell className="font-mono text-xs font-medium text-fg">{constraint.name}</Cell>
            <Cell>
              <IdentList names={constraint.columns} />
            </Cell>
            <Cell className="py-1.5">
              {constraint.definition ? <SqlText code={constraint.definition} className="selectable block whitespace-pre-wrap text-xs [overflow-wrap:anywhere]" /> : <None />}
            </Cell>
          </Row>
        )
      })}
    </SectionTable>
  )
}
