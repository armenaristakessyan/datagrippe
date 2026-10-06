import { describe, expect, it } from 'vitest'
import { createIndexStatement, fkAction, foreignKeyStatement, formatType, keyConstraintBody, kindOfType, type CatalogIndex } from './catalog'

const spec = (typeName: string, maxLength = 0, precision = 0, scale = 0) => ({ typeName, maxLength, precision, scale })

describe('formatType', () => {
  it('formats lengths, precision and scale like SQL Server', () => {
    expect(formatType(spec('nvarchar', 510))).toBe('nvarchar(255)')
    expect(formatType(spec('nvarchar', -1))).toBe('nvarchar(max)')
    expect(formatType(spec('nchar', 20))).toBe('nchar(10)')
    expect(formatType(spec('varchar', 100))).toBe('varchar(100)')
    expect(formatType(spec('varbinary', -1))).toBe('varbinary(max)')
    expect(formatType(spec('binary', 4))).toBe('binary(4)')
    expect(formatType(spec('decimal', 9, 12, 2))).toBe('decimal(12,2)')
    expect(formatType(spec('numeric', 17, 38, 10))).toBe('numeric(38,10)')
    expect(formatType(spec('datetime2', 8, 27, 7))).toBe('datetime2(7)')
    expect(formatType(spec('time', 5, 16, 3))).toBe('time(3)')
    expect(formatType(spec('datetimeoffset', 10, 34, 7))).toBe('datetimeoffset(7)')
    expect(formatType(spec('float', 8, 53))).toBe('float')
    expect(formatType(spec('float', 4, 24))).toBe('float(24)')
    expect(formatType(spec('int', 4, 10))).toBe('int')
    expect(formatType(spec('xml', -1))).toBe('xml')
  })

  it('names user-defined types, qualified on request', () => {
    const udt = { ...spec('email address', 640), isUserDefined: true, typeSchema: 'dbo' }
    expect(formatType(udt)).toBe('email address')
    expect(formatType(udt, true)).toBe('dbo.[email address]')
  })
})

describe('catalog helpers', () => {
  it('maps object types to kinds', () => {
    expect(kindOfType('U ')).toBe('table')
    expect(kindOfType('V')).toBe('view')
    expect(kindOfType('IF')).toBe('function')
    expect(kindOfType('P')).toBe('procedure')
    expect(kindOfType('SO')).toBe('sequence')
    expect(kindOfType('TR')).toBeUndefined()
  })

  it('maps referential actions', () => {
    expect(fkAction('NO_ACTION')).toBe('NO ACTION')
    expect(fkAction('CASCADE')).toBe('CASCADE')
    expect(fkAction('SET_NULL')).toBe('SET NULL')
    expect(fkAction('SET_DEFAULT')).toBe('SET DEFAULT')
  })

  const index = (overrides: Partial<CatalogIndex>): CatalogIndex => ({
    name: 'IX',
    indexId: 2,
    typeDesc: 'NONCLUSTERED',
    isUnique: false,
    isPrimaryKey: false,
    isUniqueConstraint: false,
    keys: [{ name: 'a', descending: false }],
    included: [],
    ...overrides,
  })

  it('renders index and key constraint definitions', () => {
    expect(
      createIndexStatement(
        index({ isUnique: true, keys: [{ name: 'a', descending: false }, { name: 'order', descending: true }], included: ['My Col'], filter: '([a]>(0))' }),
        'dbo',
        'T',
      ),
    ).toBe('CREATE UNIQUE NONCLUSTERED INDEX IX ON dbo.T (a ASC, [order] DESC) INCLUDE ([My Col]) WHERE ([a]>(0))')
    expect(createIndexStatement(index({ typeDesc: 'CLUSTERED COLUMNSTORE', keys: [], included: ['a', 'b'] }), 'dbo', 'T')).toBe(
      'CREATE CLUSTERED COLUMNSTORE INDEX IX ON dbo.T',
    )
    expect(createIndexStatement(index({ typeDesc: 'NONCLUSTERED COLUMNSTORE', keys: [], included: ['a', 'b'] }), 'dbo', 'T')).toBe(
      'CREATE NONCLUSTERED COLUMNSTORE INDEX IX ON dbo.T (a, b)',
    )
    expect(keyConstraintBody(index({ typeDesc: 'CLUSTERED', isPrimaryKey: true }))).toBe('PRIMARY KEY CLUSTERED (a ASC)')
    expect(keyConstraintBody(index({ isUniqueConstraint: true }))).toBe('UNIQUE NONCLUSTERED (a ASC)')
  })

  it('renders foreign keys with non-default actions only', () => {
    expect(
      foreignKeyStatement({
        name: 'FK_x',
        schema: 'sales',
        table: 'orders',
        columns: ['customer_id'],
        refSchema: 'dbo',
        refTable: 'customers',
        refColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'SET NULL',
      }),
    ).toBe('ALTER TABLE sales.orders ADD CONSTRAINT FK_x FOREIGN KEY (customer_id) REFERENCES dbo.customers (id) ON DELETE SET NULL')
  })
})
