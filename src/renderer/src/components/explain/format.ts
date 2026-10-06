// Number formatting for plan metrics (more precision than the general-purpose formatters).
import { formatCount, formatDuration } from '@/lib/format'

/** 0.042 → "0.042 ms", 3.456 → "3.46 ms", 45.67 → "45.7 ms", 1234 → "1.2 s". */
export function formatPlanTime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms === 0) return '0 ms'
  if (ms < 1) return `${ms.toFixed(3)} ms`
  if (ms < 10) return `${ms.toFixed(2)} ms`
  if (ms < 1000) return `${ms.toFixed(1)} ms`
  return formatDuration(ms)
}

/** Planner costs: 0.0197 → "0.0197", 12.5 → "12.50", 123456.7 → "123 457". */
export function formatCost(cost: number | undefined): string {
  if (cost === undefined || !Number.isFinite(cost)) return '—'
  if (cost === 0) return '0'
  const abs = Math.abs(cost)
  if (abs >= 1000) return formatCount(Math.round(cost))
  if (abs >= 1) return cost.toFixed(2)
  return String(Number(cost.toPrecision(3)))
}

/** Row counts are integers in PostgreSQL; SQL Server per-execution averages can be fractional. */
export function formatRows(rows: number | undefined): string {
  if (rows === undefined || !Number.isFinite(rows)) return '—'
  if (rows > 0 && rows < 10 && !Number.isInteger(rows)) return rows.toFixed(1)
  return formatCount(Math.round(rows))
}

export function formatShare(share: number): string {
  if (share <= 0) return '0%'
  if (share < 0.01) return '<1%'
  return `${Math.round(share * 100)}%`
}

export function formatFactor(factor: number): string {
  if (factor >= 100) return `${formatCount(Math.round(factor))}×`
  return `${Number(factor.toFixed(factor < 10 ? 1 : 0))}×`
}
