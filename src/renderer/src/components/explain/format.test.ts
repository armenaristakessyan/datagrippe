import { describe, expect, it } from 'vitest'
import { NNBSP } from '@/lib/format'
import { formatCost, formatFactor, formatPlanTime, formatRows, formatShare } from './format'

describe('plan number formatting', () => {
  it('formats times with precision for small values', () => {
    expect(formatPlanTime(undefined)).toBe('—')
    expect(formatPlanTime(0)).toBe('0 ms')
    expect(formatPlanTime(0.0421)).toBe('0.042 ms')
    expect(formatPlanTime(3.456)).toBe('3.46 ms')
    expect(formatPlanTime(45.67)).toBe('45.7 ms')
    expect(formatPlanTime(1430)).toBe('1.4 s')
  })

  it('formats costs', () => {
    expect(formatCost(undefined)).toBe('—')
    expect(formatCost(0)).toBe('0')
    expect(formatCost(0.0197466)).toBe('0.0197')
    expect(formatCost(12.5)).toBe('12.50')
    expect(formatCost(123456.7)).toBe(`123${NNBSP}457`)
  })

  it('formats rows', () => {
    expect(formatRows(2.5)).toBe('2.5')
    expect(formatRows(12.4)).toBe('12')
    expect(formatRows(0)).toBe('0')
    expect(formatRows(12345)).toBe(`12${NNBSP}345`)
  })

  it('formats shares and factors', () => {
    expect(formatShare(0)).toBe('0%')
    expect(formatShare(0.004)).toBe('<1%')
    expect(formatShare(0.426)).toBe('43%')
    expect(formatFactor(12.34)).toBe('12×')
    expect(formatFactor(10)).toBe('10×')
    expect(formatFactor(1234.5)).toBe(`1${NNBSP}235×`)
  })
})
