import { ArrowRight, GitFork, Link2, Table2 } from 'lucide-react'
import type { FkAction, ForeignKeyInfo } from '@shared/types'
import { IconButton, Tooltip } from '@/components/ui'
import { cn } from '@/lib/cn'
import { IdentList, Row, Cell, SectionEmpty, SectionTable } from './SectionTable'

export interface TableTarget {
  schema: string
  name: string
}

export interface KeysSectionProps {
  keys: ForeignKeyInfo[]
  /** Schema of the table being shown (other schemas are spelled out). */
  currentSchema: string
  onOpenStructure: (target: TableTarget) => void
  onOpenData: (target: TableTarget) => void
}

function TableLink({ target, currentSchema, onOpen }: { target: TableTarget; currentSchema: string; onOpen: () => void }) {
  return (
    <Tooltip content="Open structure">
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex min-w-0 items-center rounded-[4px] font-mono text-xs font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="truncate">
          {target.schema !== currentSchema && <span className="text-accent/70">{target.schema}.</span>}
          {target.name}
        </span>
      </button>
    </Tooltip>
  )
}

function Actions({ onUpdate, onDelete }: { onUpdate: FkAction; onDelete: FkAction }) {
  const tone = (a: FkAction) => (a === 'CASCADE' ? 'text-warning' : a === 'NO ACTION' ? 'text-faint' : 'text-muted')
  return (
    <span className="flex flex-col gap-0.5 whitespace-nowrap font-mono text-2xs leading-4">
      <span>
        <span className="text-subtle">ON UPDATE </span>
        <span className={tone(onUpdate)}>{onUpdate}</span>
      </span>
      <span>
        <span className="text-subtle">ON DELETE </span>
        <span className={tone(onDelete)}>{onDelete}</span>
      </span>
    </span>
  )
}

function OpenDataButton({ onClick }: { onClick: () => void }) {
  return (
    <IconButton
      icon={Table2}
      label="Open data"
      size="xs"
      onClick={onClick}
      className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
    />
  )
}

/** Foreign keys declared on this table: local columns → referenced table (columns). */
export function ForeignKeysSection({ keys, currentSchema, onOpenStructure, onOpenData }: KeysSectionProps) {
  if (keys.length === 0) {
    return <SectionEmpty icon={Link2} title="No foreign keys" description="This table does not reference other tables." />
  }
  return (
    <SectionTable head={[{ label: 'Name' }, { label: 'Columns' }, { label: 'References' }, { label: 'Actions' }, { label: '', className: 'w-px' }]}>
      {keys.map((fk) => {
        const target = { schema: fk.refSchema, name: fk.refTable }
        return (
          <Row key={fk.name}>
            <Cell className="font-mono text-xs text-muted">{fk.name}</Cell>
            <Cell>
              <IdentList names={fk.columns} />
            </Cell>
            <Cell>
              <span className="flex min-w-0 items-center gap-1.5">
                <ArrowRight size={12} strokeWidth={2} className="shrink-0 text-faint" aria-hidden />
                <TableLink target={target} currentSchema={currentSchema} onOpen={() => onOpenStructure(target)} />
                <span className="font-mono text-xs text-subtle">
                  (<IdentList names={fk.refColumns} className="text-muted" />)
                </span>
              </span>
            </Cell>
            <Cell className="py-1">
              <Actions onUpdate={fk.onUpdate} onDelete={fk.onDelete} />
            </Cell>
            <Cell className="w-px">
              <OpenDataButton onClick={() => onOpenData(target)} />
            </Cell>
          </Row>
        )
      })}
    </SectionTable>
  )
}

/** Foreign keys of other tables pointing at this one. */
export function ReferencedBySection({ keys, currentSchema, onOpenStructure, onOpenData }: KeysSectionProps) {
  if (keys.length === 0) {
    return <SectionEmpty icon={GitFork} title="Not referenced" description="No foreign key of another table points here." />
  }
  return (
    <SectionTable head={[{ label: 'Table' }, { label: 'Columns' }, { label: 'Referenced columns' }, { label: 'Constraint' }, { label: 'Actions' }, { label: '', className: 'w-px' }]}>
      {keys.map((fk) => {
        const source = { schema: fk.schema, name: fk.table }
        return (
          <Row key={`${fk.schema}.${fk.table}.${fk.name}`}>
            <Cell>
              <TableLink target={source} currentSchema={currentSchema} onOpen={() => onOpenStructure(source)} />
            </Cell>
            <Cell>
              <IdentList names={fk.columns} />
            </Cell>
            <Cell>
              <span className="flex items-center gap-1.5">
                <ArrowRight size={12} strokeWidth={2} className="shrink-0 text-faint" aria-hidden />
                <IdentList names={fk.refColumns} className={cn('text-muted')} />
              </span>
            </Cell>
            <Cell className="font-mono text-xs text-muted">{fk.name}</Cell>
            <Cell className="py-1">
              <Actions onUpdate={fk.onUpdate} onDelete={fk.onDelete} />
            </Cell>
            <Cell className="w-px">
              <OpenDataButton onClick={() => onOpenData(source)} />
            </Cell>
          </Row>
        )
      })}
    </SectionTable>
  )
}
