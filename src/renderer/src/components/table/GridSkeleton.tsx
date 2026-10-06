import { Skeleton } from '@/components/ui'

const WIDTHS = [36, 120, 180, 72, 96, 140, 88, 160]

/** Placeholder grid while the first page loads. */
export function GridSkeleton({ columns = 7, rows = 14 }: { columns?: number; rows?: number }) {
  const cols = Array.from({ length: columns }, (_, i) => WIDTHS[i % WIDTHS.length] ?? 96)
  return (
    <div aria-busy aria-label="Loading rows" className="h-full overflow-hidden bg-surface">
      <div className="flex h-7 items-center gap-6 border-b border-line bg-grid-header px-3">
        {cols.map((w, i) => (
          <Skeleton key={i} width={Math.max(40, w * 0.6)} height={8} className="shrink-0 opacity-80" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex h-6 items-center gap-6 border-b border-line/60 px-3" style={{ opacity: 1 - r / (rows + 4) }}>
          {cols.map((w, i) => (
            <Skeleton key={i} width={w * (0.55 + (((r + 1) * (i + 3)) % 5) / 10)} height={7} className="shrink-0" />
          ))}
        </div>
      ))}
    </div>
  )
}
