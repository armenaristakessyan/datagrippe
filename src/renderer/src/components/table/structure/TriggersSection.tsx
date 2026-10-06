import { Zap } from 'lucide-react'
import type { TriggerInfo } from '@shared/types'
import { Badge, StatusDot } from '@/components/ui'
import { ExpandableRow, SectionEmpty, SectionTable } from './SectionTable'

export function TriggersSection({ triggers }: { triggers: TriggerInfo[] }) {
  if (triggers.length === 0) {
    return <SectionEmpty icon={Zap} title="No triggers" description="No trigger fires on changes to this table." />
  }
  return (
    <SectionTable head={[{ label: 'Name' }, { label: 'Timing' }, { label: 'Events' }, { label: 'Status' }]}>
      {triggers.map((trigger) => (
        <ExpandableRow
          key={trigger.name}
          label={trigger.name}
          colSpan={4}
          detail={trigger.definition}
          cells={[
            <span key="n" className="block truncate font-mono text-xs font-medium text-fg">
              {trigger.name}
            </span>,
            <span key="t" className="whitespace-nowrap font-mono text-xs text-muted">
              {trigger.timing}
            </span>,
            <span key="e" className="flex flex-wrap gap-1">
              {trigger.events.map((event) => (
                <Badge key={event} mono>
                  {event}
                </Badge>
              ))}
            </span>,
            <span key="s" className="flex items-center gap-1.5 whitespace-nowrap text-xs">
              <StatusDot status={trigger.enabled ? 'success' : 'neutral'} />
              <span className={trigger.enabled ? 'text-muted' : 'text-subtle'}>{trigger.enabled ? 'Enabled' : 'Disabled'}</span>
            </span>,
          ]}
        />
      ))}
    </SectionTable>
  )
}
