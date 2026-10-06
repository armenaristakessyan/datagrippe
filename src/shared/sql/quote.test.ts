import { describe, expect, it } from 'vitest'
import { qualifiedName, quoteIdent, sqlLiteral } from './index'

describe('quoteIdent — postgres', () => {
  it.each([
    ['users', 'users'],
    ['_private', '_private'],
    ['col_1', 'col_1'],
    ['a$b', 'a$b'],
    ['name', 'name'],
    ['type', 'type'],
    ['user_id', 'user_id'],
  ])('leaves %s bare', (name, expected) => {
    expect(quoteIdent(name, 'postgres')).toBe(expected)
  })

  it.each([
    ['Users', '"Users"'],
    ['order', '"order"'],
    ['select', '"select"'],
    ['user', '"user"'],
    ['table', '"table"'],
    ['join', '"join"'],
    ['current_user', '"current_user"'],
    ['my table', '"my table"'],
    ['1abc', '"1abc"'],
    ['$x', '"$x"'],
    ['été', '"été"'],
    ['', '""'],
    ['a"b', '"a""b"'],
    ['a-b', '"a-b"'],
  ])('quotes %s', (name, expected) => {
    expect(quoteIdent(name, 'postgres')).toBe(expected)
  })
})

describe('quoteIdent — mssql', () => {
  it.each([
    ['Users', 'Users'],
    ['OrderLines', 'OrderLines'],
    ['_x', '_x'],
    ['a@b#c$', 'a@b#c$'],
    ['Name', 'Name'],
  ])('leaves %s bare', (name, expected) => {
    expect(quoteIdent(name, 'mssql')).toBe(expected)
  })

  it.each([
    ['Order', '[Order]'],
    ['select', '[select]'],
    ['User', '[User]'],
    ['Key', '[Key]'],
    ['go', '[go]'],
    ['My Table', '[My Table]'],
    ['1st', '[1st]'],
    ['#tmp', '[#tmp]'],
    ['a]b', '[a]]b]'],
    ['', '[]'],
  ])('quotes %s', (name, expected) => {
    expect(quoteIdent(name, 'mssql')).toBe(expected)
  })
})

describe('qualifiedName', () => {
  it('joins quoted parts with a dot', () => {
    expect(qualifiedName('public', 'users', 'postgres')).toBe('public.users')
    expect(qualifiedName('Sales', 'order', 'postgres')).toBe('"Sales"."order"')
    expect(qualifiedName('dbo', 'Order Lines', 'mssql')).toBe('dbo.[Order Lines]')
    expect(qualifiedName('my.schema', 't', 'mssql')).toBe('[my.schema].t')
  })
})

describe('sqlLiteral', () => {
  it('renders NULL', () => {
    expect(sqlLiteral(null, 'postgres')).toBe('NULL')
    expect(sqlLiteral(null, 'mssql')).toBe('NULL')
  })

  it('renders finite numbers as-is', () => {
    expect(sqlLiteral(42, 'postgres')).toBe('42')
    expect(sqlLiteral(-1.5, 'mssql')).toBe('-1.5')
    expect(sqlLiteral(0, 'postgres')).toBe('0')
    expect(sqlLiteral(-0, 'postgres')).toBe('0')
  })

  it('quotes non-finite numbers', () => {
    expect(sqlLiteral(Number.NaN, 'postgres')).toBe("'NaN'")
    expect(sqlLiteral(Number.POSITIVE_INFINITY, 'postgres')).toBe("'Infinity'")
    expect(sqlLiteral(Number.NEGATIVE_INFINITY, 'postgres')).toBe("'-Infinity'")
  })

  it('renders booleans per dialect', () => {
    expect(sqlLiteral(true, 'postgres')).toBe('TRUE')
    expect(sqlLiteral(false, 'postgres')).toBe('FALSE')
    expect(sqlLiteral(true, 'mssql')).toBe('1')
    expect(sqlLiteral(false, 'mssql')).toBe('0')
  })

  it('quotes strings with escaped quotes', () => {
    expect(sqlLiteral("it's", 'postgres')).toBe("'it''s'")
    expect(sqlLiteral("it's", 'mssql')).toBe("N'it''s'")
    expect(sqlLiteral('', 'postgres')).toBe("''")
    expect(sqlLiteral('a\\b', 'postgres')).toBe("'a\\b'")
    expect(sqlLiteral('line\nbreak', 'mssql')).toBe("N'line\nbreak'")
  })

  it('keeps numeric-looking strings as strings', () => {
    expect(sqlLiteral('42', 'postgres')).toBe("'42'")
    expect(sqlLiteral('12345678901234567890', 'mssql')).toBe("N'12345678901234567890'")
  })
})
