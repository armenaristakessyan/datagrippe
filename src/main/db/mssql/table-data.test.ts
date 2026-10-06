import { describe, expect, it } from 'vitest'
import { DriverError } from '../errors'
import type { CatalogColumn } from './catalog'
import { buildEditStatements, orderByClause, readOnlyReason, selectList, whereClause, type TableShape } from './table-data'

function column(name: string, baseType: string, extra: Partial<CatalogColumn> = {}): CatalogColumn {
  return {
    columnId: 1,
    name,
    type: { typeName: baseType, maxLength: 0, precision: 0, scale: 0 },
    baseType,
    dataType: baseType,
    nullable: true,
    isIdentity: false,
    isComputed: false,
    isPersisted: false,
    ...extra,
  }
}

const shape: TableShape = {
  objectId: 1,
  kind: 'table',
  schema: 'dbo',
  name: 'Things',
  primaryKey: ['id'],
  columns: [
    column('id', 'int', { isIdentity: true, nullable: false }),
    column('name', 'nvarchar'),
    column('active', 'bit'),
    column('blob', 'varbinary'),
    column('total', 'computed', { isComputed: true }),
    column('rv', 'timestamp'),
    column('order', 'int'),
    column('valid_from', 'datetime2', { generatedAlwaysType: 1, isHidden: true }),
  ],
}

function rejects(fn: () => unknown): DriverError {
  try {
    fn()
  } catch (error) {
    if (error instanceof DriverError) return error
    throw error
  }
  throw new Error('expected a DriverError')
}

describe('buildEditStatements', () => {
  it('parameterizes inserts and skips identity, computed, rowversion and default columns', () => {
    const [insert] = buildEditStatements('db', shape, [
      { type: 'insert', values: { id: 5, name: "O'Brien", active: true, blob: 'CAFE', total: 1, rv: '0x01', order: { $default: true } } },
    ])
    expect(insert).toEqual({
      type: 'insert',
      text: 'INSERT INTO db.dbo.Things (name, active, blob) VALUES (@p0, @p1, CONVERT(varbinary(max), @p2, 1))',
      preview: "INSERT INTO db.dbo.Things (name, active, blob) VALUES (N'O''Brien', 1, CONVERT(varbinary(max), N'0xCAFE', 1))",
      params: [
        { name: 'p0', kind: 'text', value: "O'Brien" },
        { name: 'p1', kind: 'bit', value: true },
        { name: 'p2', kind: 'text', value: '0xCAFE' },
      ],
      expectOne: false,
    })
  })

  it('uses DEFAULT VALUES when nothing is left to insert', () => {
    const [insert] = buildEditStatements('db', shape, [{ type: 'insert', values: { id: 1, order: { $default: true } } }])
    expect(insert?.text).toBe('INSERT INTO db.dbo.Things DEFAULT VALUES')
    expect(insert?.params).toEqual([])
  })

  it('keys updates and deletes on the primary key', () => {
    const [update, remove] = buildEditStatements('db', shape, [
      { type: 'update', key: { id: 7 }, values: { order: 3, blob: null, active: 'false' } },
      { type: 'delete', key: { id: '8' } },
    ])
    expect(update?.text).toBe('UPDATE db.dbo.Things SET [order] = @p0, blob = CONVERT(varbinary(max), @p1, 1), active = @p2 WHERE id = @p3')
    expect(update?.preview).toBe('UPDATE db.dbo.Things SET [order] = 3, blob = NULL, active = 0 WHERE id = 7')
    expect(update?.params.map((p) => [p.kind, p.value])).toEqual([
      ['text', '3'],
      ['text', null],
      ['bit', false],
      ['text', '7'],
    ])
    expect(update?.expectOne).toBe(true)
    expect(remove).toMatchObject({ text: 'DELETE FROM db.dbo.Things WHERE id = @p0', preview: "DELETE FROM db.dbo.Things WHERE id = N'8'", expectOne: true })
  })

  it('matches NULL key parts with IS NULL and skips empty updates', () => {
    const composite: TableShape = { ...shape, primaryKey: ['id', 'name'] }
    const statements = buildEditStatements('db', composite, [
      { type: 'update', key: { id: 1, name: 'x' }, values: {} },
      { type: 'delete', key: { id: 1, name: null } },
    ])
    expect(statements).toHaveLength(1)
    expect(statements[0]?.text).toBe('DELETE FROM db.dbo.Things WHERE id = @p0 AND name IS NULL')
  })

  it('rejects invalid edits', () => {
    expect(rejects(() => buildEditStatements('db', shape, [{ type: 'update', key: { id: 1 }, values: { nope: 1 } }])).info.kind).toBe('invalid-input')
    expect(rejects(() => buildEditStatements('db', shape, [{ type: 'update', key: { id: 1 }, values: { total: 1 } }])).info.message).toMatch(/generated/)
    expect(rejects(() => buildEditStatements('db', shape, [{ type: 'update', key: { id: 1 }, values: { id: 2 } }])).info.message).toMatch(/Identity/)
    expect(rejects(() => buildEditStatements('db', shape, [{ type: 'delete', key: { name: 'x' } }])).info.message).toMatch(/Missing primary key/)
    expect(rejects(() => buildEditStatements('db', shape, [{ type: 'update', key: { id: 1 }, values: { active: 'maybe' } }])).info.message).toMatch(/bit/)
    expect(rejects(() => buildEditStatements('db', shape, [{ type: 'update', key: { id: 1 }, values: { blob: 'xyz' } }])).info.message).toMatch(/hexadecimal/)
    expect(rejects(() => buildEditStatements('db', { ...shape, primaryKey: [] }, [{ type: 'delete', key: { id: 1 } }])).info.message).toMatch(/no primary key/)
  })
})

describe('query clauses', () => {
  it('orders by requested columns, then the primary key, then nothing', () => {
    expect(orderByClause(shape, [{ column: 'order', direction: 'desc' }, { column: 'name', direction: 'asc' }])).toBe('ORDER BY [order] DESC, name ASC')
    expect(orderByClause(shape, undefined)).toBe('ORDER BY id')
    expect(orderByClause({ ...shape, primaryKey: [] }, [])).toBe('ORDER BY (SELECT NULL)')
    expect(rejects(() => orderByClause(shape, [{ column: 'x; DROP TABLE t', direction: 'asc' }])).info.kind).toBe('invalid-input')
  })

  it('wraps user predicates in parentheses', () => {
    expect(whereClause("name = 'a' OR 1 = 1")).toBe("WHERE (name = 'a' OR 1 = 1)")
    expect(whereClause("(a = 1) AND (b IN (SELECT x FROM t WHERE y = ';'))")).toBe("WHERE ((a = 1) AND (b IN (SELECT x FROM t WHERE y = ';')))")
    expect(whereClause('a = 1 -- note')).toBe('WHERE (a = 1 -- note\n)')
    expect(whereClause('   ')).toBe('')
    expect(whereClause(undefined)).toBe('')
  })

  it('rejects filters that would add statements to the batch', () => {
    for (const where of [
      '1=1); DELETE FROM dbo.t; SELECT * FROM dbo.t WHERE (1=1',
      '1=1); DELETE FROM dbo.t; --',
      '1=1) DELETE FROM dbo.t WHERE (1=1',
      'a = 1; DROP TABLE t',
      "a = 'x",
      'a = 1 /* open',
      '(a = 1',
      'a = 1)) OR ((1=1',
      'a = 1\nGO\nDELETE FROM t',
    ]) {
      expect(rejects(() => whereClause(where)).info.kind, where).toBe('invalid-input')
    }
  })

  it('binds sql_variant values without nvarchar(max) and CLR types through their binary form', () => {
    const variant: TableShape = {
      ...shape,
      columns: [
        column('id', 'int', { nullable: false }),
        column('sv', 'sql_variant'),
        column('geo', 'geography', { isAssemblyType: true }),
        column('node', 'hierarchyid', { isAssemblyType: true }),
      ],
    }
    const [update] = buildEditStatements('db', variant, [
      { type: 'update', key: { id: 1 }, values: { sv: '42', geo: '0xE6100000', node: '/1/2/' } },
      ])
    expect(update?.text).toBe('UPDATE db.dbo.Things SET sv = @p0, geo = CAST(CONVERT(varbinary(max), @p1, 1) AS geography), node = @p2 WHERE id = @p3')
    expect(update?.params.map((p) => p.kind)).toEqual(['int', 'text', 'text', 'text'])
    const [text] = buildEditStatements('db', variant, [{ type: 'update', key: { id: 1 }, values: { sv: 'hello' } }])
    expect(text?.params[0]).toEqual({ name: 'p0', kind: 'text4000', value: 'hello' })
    const [nul] = buildEditStatements('db', variant, [{ type: 'update', key: { id: 1 }, values: { sv: null } }])
    expect(nul?.params[0]).toEqual({ name: 'p0', kind: 'text4000', value: null })
  })

  it('selects every column by name and hierarchyid as text', () => {
    const tree: TableShape = { ...shape, columns: [column('id', 'int'), column('node', 'hierarchyid', { isAssemblyType: true }), column('valid_from', 'datetime2', { isHidden: true, generatedAlwaysType: 1 })] }
    expect(selectList(tree)).toBe('id, node.ToString() AS node, valid_from')
  })

  it('explains why a table is not editable', () => {
    expect(readOnlyReason(shape, false)).toBeUndefined()
    expect(readOnlyReason(shape, true)).toBe('The connection is read-only')
    expect(readOnlyReason({ ...shape, kind: 'view' }, false)).toBe('Views are not editable')
    expect(readOnlyReason({ ...shape, primaryKey: [] }, false)).toBe('The table has no primary key')
  })
})

describe('languageNeutralDateTime', () => {
  it('rewrites datetime text to formats that ignore DATEFORMAT', async () => {
    const { languageNeutralDateTime } = await import('./table-data')
    expect(languageNeutralDateTime('2024-01-15 10:11:12.997')).toBe('2024-01-15T10:11:12.997')
    expect(languageNeutralDateTime('2024-01-15 10:11')).toBe('2024-01-15T10:11:00')
    expect(languageNeutralDateTime('2024-01-15 10:11:12.9971234')).toBe('2024-01-15T10:11:12.997')
    expect(languageNeutralDateTime('2024-01-15')).toBe('20240115')
    expect(languageNeutralDateTime('15/01/2024')).toBe('15/01/2024')
  })
})
