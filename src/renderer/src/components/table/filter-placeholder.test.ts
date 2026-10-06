import { describe, expect, it } from 'vitest'
import { filterPlaceholder } from './filter-placeholder'

describe('filterPlaceholder', () => {
  it('uses a numeric and a text column of the table', () => {
    const columns = [
      { name: 'id', dataType: 'int4' },
      { name: 'created_at', dataType: 'timestamptz' },
      { name: 'Full Name', dataType: 'varchar' },
    ]
    expect(filterPlaceholder(columns, 'postgres')).toBe(`id > 100 AND "Full Name" LIKE 'A%'`)
    expect(filterPlaceholder(columns, 'mssql')).toBe(`id > 100 AND [Full Name] LIKE N'A%'`)
  })

  it('falls back when nothing fits', () => {
    expect(filterPlaceholder(undefined, 'postgres')).toBe(`name LIKE 'A%'`)
    expect(filterPlaceholder([{ name: 'at', dataType: 'date' }], 'mssql')).toBe(`name LIKE N'A%'`)
  })
})
