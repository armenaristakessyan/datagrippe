import { describe, expect, it } from 'vitest'
import { columnDragText, generateDrop, objectQualifiedName } from './scripts'

describe('generateDrop', () => {
  it('uses the right keyword per kind and quotes names', () => {
    expect(generateDrop({ schema: 'public', name: 'orders', kind: 'table' }, 'postgres')).toContain('DROP TABLE public.orders;')
    expect(generateDrop({ schema: 'public', name: 'Mixed Case Table', kind: 'table' }, 'postgres')).toContain(
      'DROP TABLE public."Mixed Case Table";',
    )
    expect(generateDrop({ schema: 'sales', name: 'monthly_totals', kind: 'materialized-view' }, 'postgres')).toContain(
      'DROP MATERIALIZED VIEW sales.monthly_totals;',
    )
    expect(generateDrop({ schema: 'dbo', name: 'Mixed Case Table', kind: 'table' }, 'mssql')).toContain('DROP TABLE dbo.[Mixed Case Table];')
    expect(generateDrop({ schema: 'dbo', name: 'invoice_seq', kind: 'sequence' }, 'mssql')).toContain('DROP SEQUENCE dbo.invoice_seq;')
  })

  it('includes identity arguments for PostgreSQL routines only', () => {
    const fn = { schema: 'sales', name: 'customer_total', kind: 'function' as const, signature: '(p_customer_id integer)' }
    expect(generateDrop(fn, 'postgres')).toContain('DROP FUNCTION sales.customer_total(p_customer_id integer);')
    expect(generateDrop({ ...fn, kind: 'procedure' }, 'mssql')).toContain('DROP PROCEDURE sales.customer_total;')
  })

  it('starts with a review comment', () => {
    expect(generateDrop({ schema: 's', name: 'v', kind: 'view' }, 'postgres').split('\n')[0]).toMatch(/^-- Review before running/)
  })
})

describe('names', () => {
  it('qualifies objects and quotes columns', () => {
    expect(objectQualifiedName({ schema: 'public', name: 'order', kind: 'table' }, 'postgres')).toBe('public."order"')
    expect(objectQualifiedName({ schema: 's', name: 'f', kind: 'function', signature: '()' }, 'postgres')).toBe('s.f')
    expect(objectQualifiedName({ schema: 's', name: 'f', kind: 'function', signature: '()' }, 'postgres', true)).toBe('s.f()')
    expect(columnDragText('Email Address', 'mssql')).toBe('[Email Address]')
    expect(columnDragText('email', 'postgres')).toBe('email')
  })
})
