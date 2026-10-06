import { describe, expect, it } from 'vitest'
import type { PlanNode } from '@shared/types'
import {
  actualRowsPerLoop,
  actualRowsTotal,
  analyzePlan,
  branchIds,
  detectMisestimate,
  flattenPlan,
  formatXml,
  heatTone,
  prettyRawPlan,
} from './plan'

const node = (operation: string, extra: Partial<PlanNode> = {}, children: PlanNode[] = []): PlanNode => ({
  operation,
  details: [],
  children,
  ...extra,
})

describe('detectMisestimate', () => {
  it('flags 10× in either direction', () => {
    expect(detectMisestimate(10, 100)).toEqual({ factor: 10, direction: 'under' })
    expect(detectMisestimate(1000, 50)).toEqual({ factor: 20, direction: 'over' })
    expect(detectMisestimate(10, 99)).toBeNull()
    expect(detectMisestimate(100, 11)).toBeNull()
  })

  it('floors rows at 1 and ignores missing values', () => {
    expect(detectMisestimate(1, 0)).toBeNull()
    expect(detectMisestimate(0, 5)).toBeNull()
    expect(detectMisestimate(200, 0)?.direction).toBe('over')
    expect(detectMisestimate(undefined, 50)).toBeNull()
    expect(detectMisestimate(50, undefined)).toBeNull()
  })

  it('honours a custom threshold', () => {
    expect(detectMisestimate(10, 30, 3)?.factor).toBe(3)
  })
})

describe('rows per loop', () => {
  it('postgres rows are per loop already', () => {
    const n = node('Index Scan', { actualRows: 3, loops: 4 })
    expect(actualRowsPerLoop(n, 'postgres-json')).toBe(3)
    expect(actualRowsTotal(n, 'postgres-json')).toBe(12)
  })
  it('sql server rows are totals over executions', () => {
    const n = node('Index Seek', { actualRows: 12, loops: 4 })
    expect(actualRowsPerLoop(n, 'mssql-xml')).toBe(3)
    expect(actualRowsTotal(n, 'mssql-xml')).toBe(12)
  })
})

describe('heatTone', () => {
  it('goes neutral → warning → danger', () => {
    expect(heatTone(0)).toBe('neutral')
    expect(heatTone(0.149)).toBe('neutral')
    expect(heatTone(0.15)).toBe('warning')
    expect(heatTone(0.39)).toBe('warning')
    expect(heatTone(0.4)).toBe('danger')
    expect(heatTone(1)).toBe('danger')
  })
})

describe('analyzePlan', () => {
  it('computes self time shares for analyzed postgres plans (time × loops)', () => {
    // Hash Join 10 ms total = Seq Scan 4 ms + Hash 5 ms (whose child Seq Scan takes 3 ms).
    const root = node('Hash Join', { actualTimeMs: 10, loops: 1, actualRows: 100, estimatedRows: 100, estimatedCost: 50 }, [
      node('Seq Scan', { actualTimeMs: 2, loops: 2, actualRows: 50, estimatedRows: 50, estimatedCost: 20 }),
      node('Hash', { actualTimeMs: 5, loops: 1, actualRows: 10, estimatedRows: 10, estimatedCost: 25 }, [
        node('Seq Scan', { actualTimeMs: 3, loops: 1, actualRows: 10, estimatedRows: 1000, estimatedCost: 24 }),
      ]),
    ])
    const a = analyzePlan(root, 'postgres-json')
    expect(a.analyzed).toBe(true)
    expect(a.basis).toBe('time')
    expect(a.total).toBe(10)
    expect(a.nodeCount).toBe(4)
    expect(a.metrics.get('0')?.selfTimeMs).toBeCloseTo(1)
    expect(a.metrics.get('0.0')?.inclusiveTimeMs).toBe(4)
    expect(a.metrics.get('0.0')?.share).toBeCloseTo(0.4)
    expect(a.metrics.get('0.1')?.selfTimeMs).toBeCloseTo(2)
    expect(a.metrics.get('0.1.0')?.share).toBeCloseTo(0.3)
    expect(a.metrics.get('0.1.0')?.misestimate).toEqual({ factor: 100, direction: 'over' })
    expect(a.metrics.get('0')?.misestimate).toBeNull()
    expect(a.maxShare).toBeCloseTo(0.4)
    const sum = [...a.metrics.values()].reduce((s, m) => s + m.share, 0)
    expect(sum).toBeCloseTo(1)
  })

  it('clamps self time at zero when children exceed the parent (parallel workers)', () => {
    const root = node('Gather', { actualTimeMs: 5, loops: 1 }, [node('Parallel Seq Scan', { actualTimeMs: 4, loops: 3 })])
    const a = analyzePlan(root, 'postgres-json')
    expect(a.metrics.get('0')?.selfTimeMs).toBe(0)
    expect(a.metrics.get('0.0')?.share).toBe(1)
  })

  it('uses inclusive elapsed time for sql server and sums statement nodes without timing', () => {
    const root = node('Batch', { estimatedCost: 3 }, [
      node('SELECT', { estimatedCost: 1 }, [node('Clustered Index Scan', { actualTimeMs: 6, loops: 2, actualRows: 40, estimatedRows: 20, estimatedCost: 1 })]),
      node('SELECT', { estimatedCost: 2 }, [
        node('Hash Match', { actualTimeMs: 4, loops: 1, actualRows: 5, estimatedRows: 5, estimatedCost: 2 }, [
          node('Index Seek', { actualTimeMs: 1, loops: 0, actualRows: 0, estimatedRows: 100, estimatedCost: 0.5 }),
        ]),
      ]),
    ])
    const a = analyzePlan(root, 'mssql-xml')
    expect(a.analyzed).toBe(true)
    expect(a.total).toBe(10)
    expect(a.metrics.get('0.0.0')?.share).toBeCloseTo(0.6)
    expect(a.metrics.get('0.0.0')?.actualRowsPerLoop).toBe(20)
    expect(a.metrics.get('0.1.0')?.selfTimeMs).toBe(3)
    expect(a.metrics.get('0.1.0.0')?.neverExecuted).toBe(true)
    expect(a.metrics.get('0.1.0.0')?.misestimate).toBeNull()
    expect(a.metrics.get('0')?.share).toBe(0)
  })

  it('falls back to self cost shares for estimated plans', () => {
    const root = node('Sort', { estimatedCost: 100 }, [node('Seq Scan', { estimatedCost: 60 })])
    const a = analyzePlan(root, 'postgres-json')
    expect(a.analyzed).toBe(false)
    expect(a.basis).toBe('cost')
    expect(a.totalCost).toBe(100)
    expect(a.metrics.get('0')?.selfCost).toBe(40)
    expect(a.metrics.get('0')?.share).toBeCloseTo(0.4)
    expect(a.metrics.get('0.0')?.share).toBeCloseTo(0.6)
  })

  it('falls back to cost when an analyzed plan ran below the timer resolution', () => {
    const root = node('Sort', { actualTimeMs: 0, loops: 1, estimatedCost: 10 }, [node('Index Seek', { actualTimeMs: 0, loops: 1, estimatedCost: 4 })])
    const a = analyzePlan(root, 'mssql-xml')
    expect(a.analyzed).toBe(true)
    expect(a.basis).toBe('cost')
    expect(a.metrics.get('0.0')?.share).toBeCloseTo(0.4)
  })

  it('reports no basis when the plan has neither timing nor cost', () => {
    const a = analyzePlan(node('Result'), 'postgres-json')
    expect(a.basis).toBe('none')
    expect(a.metrics.get('0')?.share).toBe(0)
  })
})

describe('flattenPlan', () => {
  const tree = node('A', {}, [node('B', {}, [node('D'), node('E')]), node('C', {}, [node('F')])])

  it('lists nodes depth-first with guides and last-child flags', () => {
    const rows = flattenPlan(tree, new Set())
    expect(rows.map((r) => `${r.id}:${r.node.operation}:${r.depth}`)).toEqual([
      '0:A:0',
      '0.0:B:1',
      '0.0.0:D:2',
      '0.0.1:E:2',
      '0.1:C:1',
      '0.1.0:F:2',
    ])
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get('0')?.guides).toEqual([])
    expect(byId.get('0.0')?.guides).toEqual([])
    expect(byId.get('0.0')?.isLast).toBe(false)
    // B has a later sibling (C): its children draw a continuing guide at level 1.
    expect(byId.get('0.0.0')?.guides).toEqual([true])
    expect(byId.get('0.0.1')?.isLast).toBe(true)
    // C is the last child: no guide below it.
    expect(byId.get('0.1.0')?.guides).toEqual([false])
    expect(byId.get('0.1.0')?.parentId).toBe('0.1')
  })

  it('skips the descendants of collapsed nodes and counts them', () => {
    const rows = flattenPlan(tree, new Set(['0.0']))
    expect(rows.map((r) => r.id)).toEqual(['0', '0.0', '0.1', '0.1.0'])
    const b = rows[1]
    expect(b?.collapsed).toBe(true)
    expect(b?.hiddenCount).toBe(2)
    // Collapsing a leaf is a no-op.
    expect(flattenPlan(tree, new Set(['0.0.0'])).find((r) => r.id === '0.0.0')?.collapsed).toBe(false)
  })

  it('lists branch ids for collapse all', () => {
    expect(branchIds(tree)).toEqual(['0', '0.0', '0.1'])
  })
})

describe('raw plan formatting', () => {
  it('pretty-prints postgres JSON and tolerates invalid input', () => {
    expect(prettyRawPlan({ format: 'postgres-json', raw: '[{"Plan":{"Node Type":"Result"}}]' })).toBe(
      '[\n  {\n    "Plan": {\n      "Node Type": "Result"\n    }\n  }\n]',
    )
    expect(prettyRawPlan({ format: 'postgres-json', raw: 'not json' })).toBe('not json')
  })

  it('indents XML, keeps text elements inline and respects quoted ">"', () => {
    const xml = '<?xml version="1.0"?><Plan a="x > 1"><Op Name="Scan"><Note>hot</Note><Leaf/></Op></Plan>'
    expect(formatXml(xml)).toBe(
      [
        '<?xml version="1.0"?>',
        '<Plan a="x > 1">',
        '  <Op Name="Scan">',
        '    <Note>hot</Note>',
        '    <Leaf/>',
        '  </Op>',
        '</Plan>',
      ].join('\n'),
    )
  })

  it('separates multiple showplan documents', () => {
    const out = formatXml('<?xml version="1.0"?><A></A>\n<?xml version="1.0"?><B/>')
    expect(out).toBe('<?xml version="1.0"?>\n<A></A>\n\n<?xml version="1.0"?>\n<B/>')
  })

  it('formats the sql server fixture without losing elements', () => {
    const raw = '<ShowPlanXML xmlns="x"><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT 1 WHERE a &lt;= 3"/></Statements></Batch></BatchSequence></ShowPlanXML>'
    const out = prettyRawPlan({ format: 'mssql-xml', raw })
    expect(out.split('\n')).toHaveLength(9)
    expect(out).toContain('      <Statements>')
    expect(out.replace(/\n\s*/g, '')).toBe(raw)
  })
})
