import { describe, expect, it } from 'vitest'
import { FUZZY_TIER, fuzzyMatch, highlightRuns, matchFields, wordStarts } from './fuzzy'

const score = (q: string, t: string) => fuzzyMatch(q, t)?.score ?? -1

describe('wordStarts', () => {
  it('detects separators, camelCase and digit transitions', () => {
    const starts = wordStarts('order_itemsByDay2024')
    const indices = starts.flatMap((s, i) => (s ? [i] : []))
    expect(indices).toEqual([0, 6, 11, 13, 16])
  })
})

describe('fuzzyMatch', () => {
  it('returns null when the query is not a subsequence', () => {
    expect(fuzzyMatch('xyz', 'orders')).toBeNull()
    expect(fuzzyMatch('orderss', 'orders')).toBeNull()
  })

  it('matches everything with an empty query', () => {
    expect(fuzzyMatch('  ', 'orders')).toEqual({ score: 0, positions: [] })
  })

  it('is case-insensitive', () => {
    expect(fuzzyMatch('ORD', 'orders')?.positions).toEqual([0, 1, 2])
    expect(fuzzyMatch('ord', 'ORDERS')?.score).toBeGreaterThan(FUZZY_TIER.substring)
  })

  it('ranks exact > prefix > word start > acronym > substring > fuzzy', () => {
    const exact = score('orders', 'orders')
    const prefix = score('orders', 'orders_archive')
    const wordStart = score('orders', 'customer_orders')
    const initials = score('oi', 'order_items')
    const substring = score('ders', 'orders')
    const scattered = score('odr', 'orders')
    expect(exact).toBe(FUZZY_TIER.exact)
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(wordStart)
    expect(wordStart).toBeGreaterThan(initials)
    expect(initials).toBeGreaterThan(substring)
    expect(substring).toBeGreaterThan(scattered)
    expect(scattered).toBeGreaterThan(0)
    expect(scattered).toBeLessThanOrEqual(FUZZY_TIER.fuzzyMax)
  })

  it('prefers shorter targets within a tier', () => {
    expect(score('ord', 'orders')).toBeGreaterThan(score('ord', 'orders_by_customer'))
    expect(score('user', 'app_users')).toBeGreaterThan(score('user', 'application_users'))
  })

  it('matches camelCase initials', () => {
    const match = fuzzyMatch('gbd', 'getByDay')
    expect(match?.positions).toEqual([0, 3, 5])
    expect(match?.score).toBeGreaterThanOrEqual(FUZZY_TIER.acronym - 60)
  })

  it('prefers word starts and consecutive runs for scattered matches', () => {
    // "cusord" should align with "cus…" + "ord…", not with scattered letters.
    const match = fuzzyMatch('cusord', 'customer_order_lines')
    expect(match?.positions).toEqual([0, 1, 2, 9, 10, 11])
    expect(score('cusord', 'customer_order_lines')).toBeGreaterThan(score('cusord', 'xcxuxsxoxrxdxxxxxxxx'))
  })

  it('returns ascending positions within the target', () => {
    const match = fuzzyMatch('pmt', 'payment_method')
    expect(match).not.toBeNull()
    const positions = match?.positions ?? []
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(positions.map((p) => 'payment_method'[p]).join('')).toBe('pmt')
  })
})

describe('matchFields', () => {
  it('requires every token to match some field and sums the scores', () => {
    const fields = [
      { text: 'orders', weight: 1 },
      { text: 'Local PG datagrippe_test', weight: 0.3 },
    ]
    expect(matchFields('ord local', fields)).not.toBeNull()
    expect(matchFields('ord nope', fields)).toBeNull()
    const single = matchFields('ord', fields)?.score ?? 0
    const both = matchFields('ord local', fields)?.score ?? 0
    expect(both).toBeGreaterThan(single)
  })

  it('maps positions of secondary fields back onto the label', () => {
    const name = 'orders'
    const qualified = `public.${name}`
    const match = matchFields('public.ord', [
      { text: name, weight: 1 },
      { text: qualified, weight: 0.95, toLabel: (p) => (p >= 7 ? p - 7 : null) },
    ])
    expect(match?.labelPositions).toEqual([0, 1, 2])
  })

  it('weights the label above context', () => {
    const asLabel = matchFields('sales', [{ text: 'sales', weight: 1 }])?.score ?? 0
    const asContext = matchFields('sales', [
      { text: 'orders', weight: 1 },
      { text: 'sales', weight: 0.3 },
    ])?.score ?? 0
    expect(asLabel).toBeGreaterThan(asContext)
  })
})

describe('highlightRuns', () => {
  it('splits text into matched and unmatched runs', () => {
    expect(highlightRuns('orders', [0, 1, 4])).toEqual([
      { text: 'or', match: true },
      { text: 'de', match: false },
      { text: 'r', match: true },
      { text: 's', match: false },
    ])
    expect(highlightRuns('abc', [])).toEqual([{ text: 'abc', match: false }])
  })
})
