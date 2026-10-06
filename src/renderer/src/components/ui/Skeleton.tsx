import type { CSSProperties } from 'react'
import { cn } from '@/lib/cn'

export interface SkeletonProps {
  className?: string
  width?: number | string
  height?: number | string
  style?: CSSProperties
}

/** Shimmering placeholder block; size it with className or width/height. */
export function Skeleton({ className, width, height, style }: SkeletonProps) {
  return <div aria-hidden className={cn('skeleton h-3 rounded', className)} style={{ width, height, ...style }} />
}

/** A few lines of varying width (lists, trees). */
export function SkeletonLines({ count = 4, className }: { count?: number; className?: string }) {
  const widths = ['72%', '54%', '86%', '62%', '44%', '78%']
  return (
    <div aria-busy className={cn('flex flex-col gap-2.5', className)}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} width={widths[i % widths.length]} />
      ))}
    </div>
  )
}
