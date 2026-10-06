import { describe, expect, it } from 'vitest'
import type { Dialect } from '../types'
import { tokenize, type TokenKind } from './lexer'

function lex(sql: string, dialect: Dialect = 'postgres'): [TokenKind, string][] {
  return tokenize(sql, dialect)
    .filter((t) => t.kind !== 'whitespace')
    .map((t) => [t.kind, sql.slice(t.start, t.end)])
}

describe('tokenize', () => {
  it('covers the input contiguously', () => {
    const sql = "SELECT 'a''b', \"x\"\"y\" -- c\n/* d */ FROM t;"
    const tokens = tokenize(sql, 'postgres')
    let pos = 0
    for (const t of tokens) {
      expect(t.start).toBe(pos)
      expect(t.end).toBeGreaterThan(t.start)
      pos = t.end
    }
    expect(pos).toBe(sql.length)
  })

  it('reads strings with doubled quotes', () => {
    expect(lex("'it''s'; x")).toEqual([
      ['string', "'it''s'"],
      ['punct', ';'],
      ['word', 'x'],
    ])
  })

  it('reads PostgreSQL E strings with backslash escapes', () => {
    expect(lex("E'a\\'b;c' x")).toEqual([
      ['string', "E'a\\'b;c'"],
      ['word', 'x'],
    ])
    expect(lex("e'\\\\' y")).toEqual([
      ['string', "e'\\\\'"],
      ['word', 'y'],
    ])
  })

  it('does not treat backslashes as escapes in standard strings', () => {
    expect(lex("'a\\' x")).toEqual([
      ['string', "'a\\'"],
      ['word', 'x'],
    ])
  })

  it('does not read E strings on SQL Server', () => {
    expect(lex("E'a\\' x'", 'mssql')[0]).toEqual(['word', 'E'])
  })

  it('reads N strings on both dialects', () => {
    expect(lex("N'é''x' y", 'mssql')).toEqual([
      ['string', "N'é''x'"],
      ['word', 'y'],
    ])
    expect(lex("n'a'", 'postgres')).toEqual([['string', "n'a'"]])
  })

  it('reads dollar-quoted bodies', () => {
    expect(lex("$$ it's; $$ x")).toEqual([
      ['string', "$$ it's; $$"],
      ['word', 'x'],
    ])
    expect(lex('$fn$ a $$ b $fn$ y')).toEqual([
      ['string', '$fn$ a $$ b $fn$'],
      ['word', 'y'],
    ])
  })

  it('treats $1 as a parameter, not a dollar quote', () => {
    expect(lex('SELECT $1, $2')).toEqual([
      ['word', 'SELECT'],
      ['param', '$1'],
      ['punct', ','],
      ['param', '$2'],
    ])
  })

  it('does not start a dollar tag with a digit', () => {
    expect(lex('$1abc$')[0]).toEqual(['param', '$1'])
  })

  it('keeps $ inside identifiers', () => {
    expect(lex('a$b $$x$$')).toEqual([
      ['word', 'a$b'],
      ['string', '$$x$$'],
    ])
  })

  it('reads quoted identifiers with doubled quotes', () => {
    expect(lex('"a""b;" x')).toEqual([
      ['quoted-ident', '"a""b;"'],
      ['word', 'x'],
    ])
  })

  it('reads SQL Server bracketed identifiers with ]] escapes', () => {
    expect(lex('[a]]b;] x', 'mssql')).toEqual([
      ['quoted-ident', '[a]]b;]'],
      ['word', 'x'],
    ])
  })

  it('treats [ as punctuation on PostgreSQL', () => {
    expect(lex('a[1]')).toEqual([
      ['word', 'a'],
      ['punct', '['],
      ['number', '1'],
      ['punct', ']'],
    ])
  })

  it('reads line comments up to the newline', () => {
    const tokens = tokenize('-- a;b\nx', 'postgres')
    expect(tokens[0]).toMatchObject({ kind: 'line-comment', start: 0, end: 6 })
  })

  it('reads nested block comments', () => {
    expect(lex('/* a /* b */ c; */ x')).toEqual([
      ['block-comment', '/* a /* b */ c; */'],
      ['word', 'x'],
    ])
    expect(lex('/* a /* b */ c; */ x', 'mssql')[0][0]).toBe('block-comment')
  })

  it('runs unterminated tokens to the end of input', () => {
    expect(lex("'abc")).toEqual([['string', "'abc"]])
    expect(lex('/* abc')).toEqual([['block-comment', '/* abc']])
    expect(lex('$$ abc')).toEqual([['string', '$$ abc']])
    expect(lex('[abc', 'mssql')).toEqual([['quoted-ident', '[abc']])
    expect(lex('"abc')).toEqual([['quoted-ident', '"abc']])
  })

  it('reads SQL Server variables and temp tables as words', () => {
    expect(lex('@x @@ROWCOUNT #tmp ##g', 'mssql').map((t) => t[0])).toEqual(['word', 'word', 'word', 'word'])
  })

  it('reads numbers', () => {
    expect(lex('1 1.5 .5 1e10 2.5E-3 0x1F')).toEqual([
      ['number', '1'],
      ['number', '1.5'],
      ['number', '.5'],
      ['number', '1e10'],
      ['number', '2.5E-3'],
      ['number', '0x1F'],
    ])
  })

  it('upper-cases words', () => {
    expect(tokenize('select', 'postgres')[0].upper).toBe('SELECT')
  })
})
