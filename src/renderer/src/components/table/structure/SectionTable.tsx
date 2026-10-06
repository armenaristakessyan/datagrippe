// Dense, hairline tables used by the structure sections.
import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { CodeBlock, EmptyState, type IconLike } from '@/components/ui'
import { cn } from '@/lib/cn'

export interface HeadCell {
  label: ReactNode
  className?: string
}

export function SectionTable({ head, children, className }: { head: HeadCell[]; children: ReactNode; className?: string }) {
  return (
    <table className={cn('w-full border-separate border-spacing-0 text-sm', className)}>
      <thead>
        <tr>
          {head.map((h, i) => (
            <th
              key={i}
              scope="col"
              className={cn(
                'sticky top-0 z-[1] h-8 whitespace-nowrap border-b border-line bg-surface px-3 text-left text-2xs font-medium text-subtle first:pl-4 last:pr-4',
                h.className,
              )}
            >
              {h.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  )
}

export const cellClass = 'h-8 border-b border-line px-3 align-middle first:pl-4 last:pr-4'

export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <tr className={cn('group transition-colors duration-75 hover:bg-hover', className)}>{children}</tr>
}

export function Cell({ children, className, title }: { children?: ReactNode; className?: string; title?: string }) {
  return (
    <td className={cn(cellClass, className)} title={title}>
      {children}
    </td>
  )
}

/** Muted em dash for empty cells. */
export function None() {
  return <span className="text-faint">—</span>
}

/**
 * A row whose first cell carries a disclosure toggle; `detail` (SQL) renders full-width below when
 * expanded. Rows without detail keep the chevron gutter for alignment.
 */
export function ExpandableRow({
  cells,
  detail,
  colSpan,
  label,
}: {
  /** Cells after the toggle cell; the first one receives the chevron. */
  cells: ReactNode[]
  detail?: string
  colSpan: number
  label: string
}) {
  const [open, setOpen] = useState(false)
  const [first, ...rest] = cells
  return (
    <>
      <tr
        className={cn('group transition-colors duration-75 hover:bg-hover', detail && 'cursor-default')}
        onClick={detail ? () => setOpen((o) => !o) : undefined}
      >
        <td className={cn(cellClass, open && 'border-b-transparent')}>
          <div className="flex min-w-0 items-center gap-1">
            {detail ? (
              <button
                type="button"
                aria-expanded={open}
                aria-label={`${open ? 'Hide' : 'Show'} definition of ${label}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen((o) => !o)
                }}
                className="-ml-1.5 flex size-5 shrink-0 items-center justify-center rounded-[4px] text-subtle outline-none hover:bg-active hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
              >
                <ChevronRight size={13} strokeWidth={2} className={cn('transition-transform duration-100', open && 'rotate-90')} />
              </button>
            ) : (
              <span className="-ml-1.5 w-5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">{first}</div>
          </div>
        </td>
        {rest.map((cell, i) => (
          <td key={i} className={cn(cellClass, open && 'border-b-transparent')}>
            {cell}
          </td>
        ))}
      </tr>
      {open && detail && (
        <tr>
          <td colSpan={colSpan} className="border-b border-line px-4 pb-3 pt-0">
            <CodeBlock code={detail} maxHeight={320} className="ml-5 bg-panel" />
          </td>
        </tr>
      )}
    </>
  )
}

export function SectionEmpty({ icon, title, description }: { icon: IconLike; title: string; description: string }) {
  return <EmptyState icon={icon} title={title} description={description} className="h-auto py-16" />
}

/** Comma-separated identifiers in mono. */
export function IdentList({ names, className }: { names: readonly string[]; className?: string }) {
  if (names.length === 0) return <None />
  return (
    <span className={cn('font-mono text-xs text-fg', className)}>
      {names.map((n, i) => (
        <span key={`${n}-${i}`}>
          {i > 0 && <span className="text-faint">, </span>}
          {n}
        </span>
      ))}
    </span>
  )
}
