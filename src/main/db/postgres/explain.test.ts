import { describe, expect, it } from 'vitest'
import { DriverError } from '../errors'
import { operationName, parseExplain } from './explain'

const PLAN = [
  {
    Plan: {
      'Node Type': 'Hash Join',
      'Join Type': 'Left',
      'Startup Cost': 1.1,
      'Total Cost': 25.5,
      'Plan Rows': 10,
      'Actual Total Time': 0.42,
      'Actual Rows': 4,
      'Actual Loops': 1,
      'Hash Cond': '(o.customer_id = c.id)',
      'Shared Hit Blocks': 3,
      'Shared Read Blocks': 1,
      Plans: [
        {
          'Node Type': 'Seq Scan',
          'Relation Name': 'orders',
          Schema: 'sales',
          Alias: 'o',
          'Total Cost': 12,
          'Plan Rows': 5,
          Filter: '(total > 10)',
          'Rows Removed by Filter': 2,
        },
        {
          'Node Type': 'Hash',
          'Total Cost': 1,
          'Plan Rows': 5,
          Plans: [
            {
              'Node Type': 'Index Scan',
              'Scan Direction': 'Backward',
              'Index Name': 'customers_pkey',
              'Relation Name': 'customers',
              Schema: 'public',
              Alias: 'customers',
              'Index Cond': '(id > 1)',
              'Total Cost': 1,
              'Plan Rows': 5,
            },
          ],
        },
      ],
    },
    'Planning Time': 0.12,
    'Execution Time': 0.55,
  },
]

describe('parseExplain', () => {
  it('builds the plan tree', () => {
    const result = parseExplain(JSON.stringify(PLAN))
    expect(result.format).toBe('postgres-json')
    expect(result.planningTimeMs).toBe(0.12)
    expect(result.totalTimeMs).toBe(0.55)
    expect(JSON.parse(result.raw)).toEqual(PLAN)
    expect(result.raw).toContain('\n  ')
    const root = result.root
    expect(root).toMatchObject({
      operation: 'Hash Join (Left)',
      estimatedRows: 10,
      estimatedCost: 25.5,
      actualRows: 4,
      actualTimeMs: 0.42,
      loops: 1,
      details: ['Hash Cond: (o.customer_id = c.id)', 'Buffers: shared hit=3 shared read=1'],
    })
    expect(root?.relation).toBeUndefined()
    const [scan, hash] = root?.children ?? []
    expect(scan).toMatchObject({
      operation: 'Seq Scan',
      relation: 'sales.orders o',
      details: ['Filter: (total > 10)', 'Rows Removed by Filter: 2'],
      children: [],
    })
    expect(hash?.children[0]).toMatchObject({
      operation: 'Index Scan Backward',
      relation: 'public.customers',
      details: ['Index Name: customers_pkey', 'Index Cond: (id > 1)'],
    })
  })

  it('returns a null root when there is no plan', () => {
    expect(parseExplain('[]').root).toBeNull()
  })

  it('rejects unreadable plans', () => {
    expect(() => parseExplain('not json')).toThrow(DriverError)
  })
})

describe('operationName', () => {
  it('mirrors text EXPLAIN labels', () => {
    expect(operationName({ 'Node Type': 'Aggregate', Strategy: 'Hashed' })).toBe('HashAggregate')
    expect(operationName({ 'Node Type': 'Aggregate', Strategy: 'Sorted', 'Partial Mode': 'Partial' })).toBe('Partial GroupAggregate')
    expect(operationName({ 'Node Type': 'Aggregate', Strategy: 'Plain', 'Partial Mode': 'Simple' })).toBe('Aggregate')
    expect(operationName({ 'Node Type': 'SetOp', Strategy: 'Hashed' })).toBe('HashSetOp')
    expect(operationName({ 'Node Type': 'Nested Loop', 'Join Type': 'Inner' })).toBe('Nested Loop')
    expect(operationName({ 'Node Type': 'Merge Join', 'Join Type': 'Anti' })).toBe('Merge Join (Anti)')
    expect(operationName({ 'Node Type': 'ModifyTable', Operation: 'Update' })).toBe('Update')
    expect(operationName({})).toBe('Unknown')
  })

  it('formats sort details', () => {
    const root = parseExplain(
      JSON.stringify([{ Plan: { 'Node Type': 'Sort', 'Sort Key': ['a', 'b DESC'], 'Sort Method': 'quicksort', 'Sort Space Used': 25, 'Sort Space Type': 'Memory' } }]),
    ).root
    expect(root?.details).toEqual(['Sort Key: a, b DESC', 'Sort Method: quicksort  Memory: 25kB'])
  })
})
