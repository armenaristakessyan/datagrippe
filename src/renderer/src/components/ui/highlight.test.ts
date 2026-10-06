import { describe, expect, it } from 'vitest'
import { highlightSql, type SqlToken } from './highlight'

const kinds = (tokens: SqlToken[]) => tokens.filter((t) => t.text.trim() !== '').map((t) => `${t.type}:${t.text.trim()}`)

describe('highlightSql', () => {
  it('round-trips the input text', () => {
    const sql = "SELECT a, 'x''y', \"Q\" FROM t -- hi\n/* block */ WHERE n = 1.5e3;"
    expect(highlightSql(sql).map((t) => t.text).join('')).toBe(sql)
  })

  it('classifies keywords, types, calls and literals', () => {
    expect(kinds(highlightSql('select count(*)::int from users where active = true'))).toEqual([
      'keyword:select',
      'function:count',
      'operator:(*)::',
      'type:int',
      'keyword:from',
      'plain:users',
      'keyword:where',
      'plain:active',
      'operator:=',
      'keyword:true',
    ])
  })

  it('handles strings, comments and quoted identifiers', () => {
    const tokens = highlightSql(`-- note\nINSERT INTO [dbo].[T] VALUES (N'it''s', E'a\\'b', $$x$$, 0x1F)`)
    expect(tokens[0]).toEqual({ type: 'comment', text: '-- note' })
    expect(tokens.filter((t) => t.type === 'string').map((t) => t.text)).toEqual(["N'it''s'", "E'a\\'b'", '$$x$$'])
    expect(tokens.filter((t) => t.type === 'identifier').map((t) => t.text)).toEqual(['[dbo]', '[T]'])
    expect(tokens.find((t) => t.type === 'number')?.text).toBe('0x1F')
  })

  it('does not treat qualified names or digits inside words as keywords/numbers', () => {
    const tokens = highlightSql('select t.order, col1 from s.table')
    expect(tokens.find((t) => t.text.trim() === 'order')?.type).toBe('plain')
    expect(tokens.find((t) => t.text.trim() === 'col1')?.type).toBe('plain')
    expect(tokens.find((t) => t.text.trim() === 'table')?.type).toBe('plain')
  })

  it('survives unterminated constructs', () => {
    expect(highlightSql("select 'abc").at(-1)).toEqual({ type: 'string', text: "'abc" })
    expect(highlightSql('/* open').at(-1)).toEqual({ type: 'comment', text: '/* open' })
  })

  it('does not colour object names followed by "(" as calls', () => {
    const typeOf = (sql: string, word: string) => highlightSql(sql).find((t) => t.text.trim() === word)?.type
    expect(typeOf('CREATE TABLE public.customers (\n  id integer\n)', 'customers')).toBe('plain')
    expect(typeOf('CREATE TABLE public.customers (id int)', 'public')).toBe('plain')
    expect(typeOf('CREATE TABLE IF NOT EXISTS orders (id int)', 'orders')).toBe('plain')
    expect(typeOf('INSERT INTO t (a) VALUES (now())', 't')).toBe('plain')
    expect(typeOf('INSERT INTO t (a) VALUES (now())', 'now')).toBe('function')
    expect(typeOf('ALTER TABLE a ADD FOREIGN KEY (c) REFERENCES public.customers (id)', 'customers')).toBe('plain')
    expect(typeOf('CREATE INDEX ix ON public.orders USING btree (customer_id)', 'btree')).toBe('plain')
    expect(typeOf('CREATE INDEX ix ON orders (lower(email))', 'orders')).toBe('plain')
    expect(typeOf('CREATE INDEX ix ON orders (lower(email))', 'lower')).toBe('function')
    // ON outside CREATE INDEX keeps calls: JOIN … ON coalesce(…)
    expect(typeOf('SELECT 1 FROM a JOIN b ON coalesce(a.x, 0) = b.x', 'coalesce')).toBe('function')
    expect(typeOf('CREATE INDEX ix ON t (c); SELECT 1 FROM a JOIN b ON coalesce(a.x, 0) = b.x', 'coalesce')).toBe('function')
    expect(typeOf('SELECT * FROM generate_series(1, 3)', 'generate_series')).toBe('function')
  })

  it('knows the DDL keywords of generated definitions', () => {
    const typeOf = (sql: string, word: string) => highlightSql(sql).find((t) => t.text.trim() === word)?.type
    expect(typeOf("COMMENT ON TABLE public.customers IS 'x'", 'COMMENT')).toBe('keyword')
    expect(typeOf('created_at timestamp with time zone', 'zone')).toBe('keyword')
    expect(typeOf('id integer GENERATED ALWAYS AS IDENTITY', 'GENERATED')).toBe('keyword')
    expect(typeOf('id integer GENERATED ALWAYS AS IDENTITY', 'IDENTITY')).toBe('keyword')
    expect(typeOf('ALTER TABLE t OWNER TO app', 'OWNER')).toBe('keyword')
  })
})

