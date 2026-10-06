import type { ReactNode } from 'react'
import type { ObjectKind, TableDetails } from '@shared/types'
import { Badge, Skeleton, renderIcon } from '@/components/ui'
import { formatBytes, formatCount } from '@/lib/format'
import { OBJECT_KIND_ICON, OBJECT_KIND_LABEL, isViewLike } from '../object-kind'

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-end gap-0.5">
      <dt className="text-2xs text-subtle">{label}</dt>
      <dd className="text-sm font-medium tabular text-fg">{children}</dd>
    </div>
  )
}

export function StructureHeader({ schema, name, kind, details }: { schema: string; name: string; kind: ObjectKind; details?: TableDetails }) {
  const showRows = !isViewLike(kind) || kind === 'materialized-view'
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-panel text-muted shadow-inset">
        {renderIcon(OBJECT_KIND_ICON[kind], 18)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="selectable truncate font-mono text-[14px] font-medium leading-5 text-fg">
            <span className="text-subtle">{schema}.</span>
            {name}
          </h1>
          <Badge tone="outline">{OBJECT_KIND_LABEL[kind]}</Badge>
        </div>
        {details ? (
          <p className="selectable mt-0.5 truncate text-xs text-muted" title={details.comment}>
            {details.comment || <span className="text-subtle">No comment</span>}
          </p>
        ) : (
          <Skeleton width={220} className="mt-1.5" />
        )}
      </div>
      <dl className="flex shrink-0 items-center gap-6">
        {details ? (
          <>
            {showRows && (
              <Stat label="Rows">
                {details.rowEstimate !== undefined && details.rowEstimate >= 0 ? `~${formatCount(Math.round(details.rowEstimate))}` : '—'}
              </Stat>
            )}
            {details.sizeBytes !== undefined && <Stat label="Size">{formatBytes(details.sizeBytes)}</Stat>}
            <Stat label="Columns">{formatCount(details.columns.length)}</Stat>
            {!isViewLike(kind) && <Stat label="Indexes">{formatCount(details.indexes.length)}</Stat>}
          </>
        ) : (
          [0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col items-end gap-1.5">
              <Skeleton width={32} height={8} />
              <Skeleton width={44} />
            </div>
          ))
        )}
      </dl>
    </div>
  )
}
