import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseShowplan } from './showplan'

const fixture = (name: string): string => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')

const NS = 'xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"'

describe('parseShowplan', () => {
  it('builds the operator tree of an estimated plan', () => {
    const xml = fixture('showplan-estimated.xml')
    const plan = parseShowplan([xml])
    expect(plan.format).toBe('mssql-xml')
    expect(plan.raw).toBe(xml)
    expect(plan.planningTimeMs).toBeTypeOf('number')
    expect(plan.totalTimeMs).toBeUndefined()
    const root = plan.root
    expect(root?.operation).toBe('Nested Loops (Inner Join)')
    expect(root?.estimatedRows).toBeCloseTo(1.73205)
    expect(root?.estimatedCost).toBeCloseTo(0.00658026)
    expect(root?.actualRows).toBeUndefined()
    expect(root?.children.map((c) => c.operation)).toEqual(['Clustered Index Seek', 'Clustered Index Scan'])
    expect(root?.children[0]).toMatchObject({ relation: 'dbo.customers [PK_customers]', details: ['Seek: c.id = (1)'] })
    expect(root?.children[1]?.relation).toBe('sales.orders [PK_orders]')
    expect(root?.children[1]?.details[0]).toMatch(/^Predicate: .*\[customer_id\]=\(1\)/)
  })

  it('sums runtime counters of an actual plan', () => {
    const plan = parseShowplan([fixture('showplan-actual.xml')])
    expect(plan.totalTimeMs).toBeTypeOf('number')
    const aggregate = plan.root?.children[0]
    expect(aggregate?.operation).toBe('Stream Aggregate (Aggregate)')
    expect(aggregate).toMatchObject({ actualRows: 3, loops: 1 })
    const seek = aggregate?.children[0]?.children[0]
    expect(seek).toMatchObject({
      operation: 'Clustered Index Seek',
      relation: 'dbo.events [PK_events]',
      details: ['Seek: events.id <= (300)'],
      actualRows: 300,
      loops: 1,
    })
  })

  it('sums rows and executions over threads and keeps the slowest thread time', () => {
    const xml = `<ShowPlanXML ${NS}><BatchSequence><Batch><Statements>
      <StmtSimple StatementText="SELECT 1" StatementType="SELECT" StatementSubTreeCost="2" StatementEstRows="10">
        <QueryPlan CompileTime="3"><QueryTimeStats ElapsedTime="40" CpuTime="70"/>
          <RelOp NodeId="0" PhysicalOp="Parallelism" LogicalOp="Gather Streams" EstimateRows="10" EstimatedTotalSubtreeCost="2">
            <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="10" ActualExecutions="1" ActualElapsedms="40"/></RunTimeInformation>
            <Parallelism><RelOp NodeId="1" PhysicalOp="Table Scan" LogicalOp="Table Scan" EstimateRows="10" EstimatedTotalSubtreeCost="1">
              <RunTimeInformation>
                <RunTimeCountersPerThread Thread="1" ActualRows="6" ActualExecutions="1" ActualElapsedms="30"/>
                <RunTimeCountersPerThread Thread="2" ActualRows="4" ActualExecutions="1" ActualElapsedms="35"/>
              </RunTimeInformation>
              <TableScan><Object Database="[d]" Schema="[dbo]" Table="[heap]" Alias="[h]"/>
                <Predicate><ScalarOperator ScalarString="[h].[x]&gt;(1)"/></Predicate></TableScan>
            </RelOp></Parallelism>
          </RelOp>
        </QueryPlan>
      </StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`
    const plan = parseShowplan([xml])
    expect(plan.root?.operation).toBe('Parallelism (Gather Streams)')
    expect(plan.totalTimeMs).toBe(40)
    expect(plan.planningTimeMs).toBe(3)
    expect(plan.root?.children[0]).toMatchObject({
      operation: 'Table Scan',
      relation: 'dbo.heap',
      details: ['Predicate: [h].[x]>(1)'],
      actualRows: 10,
      loops: 2,
      actualTimeMs: 35,
    })
  })

  it('wraps several statements (and IF branches) in a batch node', () => {
    const relOp = (op: string, rows: number) =>
      `<QueryPlan><RelOp NodeId="0" PhysicalOp="${op}" LogicalOp="${op}" EstimateRows="${rows}" EstimatedTotalSubtreeCost="1"/></QueryPlan>`
    const xml = `<ShowPlanXML ${NS}><BatchSequence><Batch><Statements>
      <StmtSimple StatementText="DECLARE @x int" StatementType="DECLARE"/>
      <StmtSimple StatementText="SELECT a FROM t" StatementType="SELECT" StatementSubTreeCost="1" StatementEstRows="5">${relOp('Table Scan', 5)}</StmtSimple>
      <StmtCond StatementText="IF @x = 1" StatementType="COND">
        <Condition>${relOp('Constant Scan', 1)}</Condition>
        <Then><Statements><StmtSimple StatementText="UPDATE t SET a = 1" StatementType="UPDATE" StatementSubTreeCost="0.5">${relOp('Table Update', 1)}</StmtSimple></Statements></Then>
      </StmtCond>
    </Statements></Batch></BatchSequence></ShowPlanXML>`
    const plan = parseShowplan([xml])
    expect(plan.root?.operation).toBe('Batch')
    expect(plan.root?.children.map((c) => [c.operation, c.details[0]])).toEqual([
      ['SELECT', 'SELECT a FROM t'],
      ['COND', 'IF @x = 1'],
    ])
    expect(plan.root?.children[1]?.children.map((c) => c.operation)).toEqual(['Constant Scan', 'UPDATE'])
    expect(plan.root?.children[1]?.children[1]?.children[0]?.operation).toBe('Table Update')
  })

  it('combines one document per statement (STATISTICS XML)', () => {
    const doc = (text: string) =>
      `<ShowPlanXML ${NS}><BatchSequence><Batch><Statements><StmtSimple StatementText="${text}" StatementType="SELECT">` +
      `<QueryPlan><RelOp NodeId="0" PhysicalOp="Constant Scan" LogicalOp="Constant Scan" EstimateRows="1" EstimatedTotalSubtreeCost="0.1"/></QueryPlan>` +
      `</StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`
    const plan = parseShowplan([doc('SELECT 1'), doc('SELECT 2')])
    expect(plan.root?.operation).toBe('Batch')
    expect(plan.root?.children).toHaveLength(2)
    expect(plan.root?.estimatedCost).toBeCloseTo(0.2)
  })

  it('returns a null root when no statement has a plan', () => {
    const xml = `<ShowPlanXML ${NS}><BatchSequence><Batch><Statements><StmtSimple StatementText="SET NOCOUNT ON" StatementType="SET ON/OFF"/></Statements></Batch></BatchSequence></ShowPlanXML>`
    expect(parseShowplan([xml]).root).toBeNull()
  })
})
