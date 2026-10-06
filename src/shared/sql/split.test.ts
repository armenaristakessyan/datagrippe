import { describe, expect, it } from 'vitest'
import type { Dialect } from '../types'
import { splitStatements, splitStatementsFine, statementAtOffset, type SqlStatement } from './index'

function texts(sql: string, dialect: Dialect): string[] {
  return splitStatements(sql, dialect).map((s) => s.text)
}

function fine(sql: string): string[] {
  return splitStatementsFine(sql, 'mssql').map((s) => s.text)
}

function expectConsistentOffsets(sql: string, statements: SqlStatement[]): void {
  for (const s of statements) expect(sql.slice(s.start, s.end)).toBe(s.text)
}

/** Caret position marked with '|' in the source. */
function at(marked: string, dialect: Dialect): string | null {
  const offset = marked.indexOf('|')
  const sql = marked.slice(0, offset) + marked.slice(offset + 1)
  return statementAtOffset(sql, offset, dialect)?.text ?? null
}

describe('splitStatements — postgres', () => {
  it('splits on semicolons and trims', () => {
    expect(texts('  SELECT 1;\n\nSELECT 2 ;  ', 'postgres')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('keeps a final statement without semicolon', () => {
    expect(texts('SELECT 1; SELECT 2', 'postgres')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('reports offsets into the source', () => {
    const sql = '-- intro\nSELECT 1;\n  UPDATE t SET a = 1 ;'
    const statements = splitStatements(sql, 'postgres')
    expect(statements).toEqual([
      { text: 'SELECT 1', start: 9, end: 17 },
      { text: 'UPDATE t SET a = 1', start: 21, end: 39 },
    ])
    expectConsistentOffsets(sql, statements)
  })

  it('drops empty and comment-only statements', () => {
    expect(texts(';;  ; -- only a comment\n; /* block */ ;', 'postgres')).toEqual([])
    expect(texts('', 'postgres')).toEqual([])
    expect(texts('   \n\t ', 'postgres')).toEqual([])
  })

  it('excludes leading and trailing comments from the text', () => {
    expect(texts('/* head */ SELECT 1 -- tail\n; SELECT /* mid */ 2', 'postgres')).toEqual([
      'SELECT 1',
      'SELECT /* mid */ 2',
    ])
  })

  it('ignores semicolons in strings', () => {
    expect(texts("SELECT 'a;b'; SELECT 'it''s; fine'", 'postgres')).toEqual(["SELECT 'a;b'", "SELECT 'it''s; fine'"])
  })

  it('ignores semicolons in E strings with escaped quotes', () => {
    expect(texts("SELECT E'a\\';b'; SELECT 2", 'postgres')).toEqual(["SELECT E'a\\';b'", 'SELECT 2'])
  })

  it('ignores semicolons in quoted identifiers', () => {
    expect(texts('SELECT "a;""b"; SELECT 2', 'postgres')).toEqual(['SELECT "a;""b"', 'SELECT 2'])
  })

  it('ignores semicolons in comments', () => {
    expect(texts('SELECT 1 -- a; b\n; SELECT /* x; /* nested; */ y; */ 2', 'postgres')).toEqual([
      'SELECT 1',
      'SELECT /* x; /* nested; */ y; */ 2',
    ])
  })

  it('keeps $$ function bodies whole', () => {
    const sql = `CREATE FUNCTION f() RETURNS int AS $$
BEGIN
  RETURN 1;
END;
$$ LANGUAGE plpgsql;
SELECT f();`
    expect(texts(sql, 'postgres')).toEqual([sql.slice(0, sql.indexOf(';\nSELECT')), 'SELECT f()'])
  })

  it('keeps tagged dollar bodies whole, even with $$ inside', () => {
    const sql = "DO $body$ BEGIN EXECUTE $$SELECT 1; SELECT 2$$; RAISE NOTICE 'x;'; END $body$; SELECT 3"
    expect(texts(sql, 'postgres')).toEqual([
      "DO $body$ BEGIN EXECUTE $$SELECT 1; SELECT 2$$; RAISE NOTICE 'x;'; END $body$",
      'SELECT 3',
    ])
  })

  it('does not mistake $1 parameters for dollar quotes', () => {
    expect(texts('SELECT $1; SELECT $2', 'postgres')).toEqual(['SELECT $1', 'SELECT $2'])
  })

  it('keeps BEGIN ATOMIC bodies whole', () => {
    const fn = `CREATE FUNCTION add(a int, b int) RETURNS int LANGUAGE sql
BEGIN ATOMIC
  SELECT CASE WHEN a > 0 THEN a + b ELSE b END;
  SELECT a + b;
END`
    expect(texts(`${fn};\nSELECT add(1, 2);`, 'postgres')).toEqual([fn, 'SELECT add(1, 2)'])
  })

  it('still splits transaction BEGIN', () => {
    expect(texts('BEGIN; UPDATE t SET a = 1 WHERE id = 1; COMMIT;', 'postgres')).toEqual([
      'BEGIN',
      'UPDATE t SET a = 1 WHERE id = 1',
      'COMMIT',
    ])
  })

  it('treats [ ] as array syntax, not identifiers', () => {
    expect(texts("SELECT a[1]; SELECT '{1}'::int[]", 'postgres')).toEqual(['SELECT a[1]', "SELECT '{1}'::int[]"])
  })

  it('handles unterminated strings without throwing', () => {
    expect(texts("SELECT 'abc; SELECT 2", 'postgres')).toEqual(["SELECT 'abc; SELECT 2"])
  })

  it('handles CRLF line endings', () => {
    expect(texts('SELECT 1;\r\nSELECT 2;\r\n', 'postgres')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('splitStatementsFine equals splitStatements on postgres', () => {
    const sql = 'SELECT 1;\n\nSELECT\n\n2;'
    expect(splitStatementsFine(sql, 'postgres')).toEqual(splitStatements(sql, 'postgres'))
    expect(texts(sql, 'postgres')).toEqual(['SELECT 1', 'SELECT\n\n2'])
  })
})

describe('splitStatements — mssql batches', () => {
  it('splits on GO lines', () => {
    expect(texts('SELECT 1\nGO\nSELECT 2\nGO', 'mssql')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('keeps semicolons inside a batch', () => {
    expect(texts('SELECT 1; SELECT 2;\nGO\nSELECT 3', 'mssql')).toEqual(['SELECT 1; SELECT 2;', 'SELECT 3'])
  })

  it('is case-insensitive and allows surrounding spaces', () => {
    expect(texts('SELECT 1\n  go  \nSELECT 2\n\tGo\t\nSELECT 3', 'mssql')).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3'])
  })

  it('reads GO counts', () => {
    const batches = splitStatements('INSERT INTO t DEFAULT VALUES\nGO 5\nSELECT 1\nGO', 'mssql')
    expect(batches.map((b) => [b.text, b.repeat])).toEqual([
      ['INSERT INTO t DEFAULT VALUES', 5],
      ['SELECT 1', undefined],
    ])
  })

  it('accepts a trailing comment on the GO line', () => {
    expect(texts('SELECT 1\nGO -- end of batch\nSELECT 2\nGO 3 -- thrice', 'mssql')).toEqual(['SELECT 1', 'SELECT 2'])
    expect(splitStatements('SELECT 1\nGO 3 -- thrice\n', 'mssql')[0].repeat).toBe(3)
  })

  it('ignores GO inside strings', () => {
    expect(texts("SELECT 'a\nGO\nb'\nGO\nSELECT 2", 'mssql')).toEqual(["SELECT 'a\nGO\nb'", 'SELECT 2'])
  })

  it('ignores GO inside block comments', () => {
    expect(texts('SELECT 1 /*\nGO\n*/\nGO\nSELECT 2', 'mssql')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('ignores GO inside brackets and quoted identifiers', () => {
    expect(texts('SELECT [a\nGO\nb], "c\nGO\nd" FROM t', 'mssql')).toEqual(['SELECT [a\nGO\nb], "c\nGO\nd" FROM t'])
  })

  it('ignores GO in a line comment', () => {
    expect(texts('SELECT 1 -- GO\nSELECT 2', 'mssql')).toEqual(['SELECT 1 -- GO\nSELECT 2'])
  })

  it('requires GO to be alone on its line', () => {
    expect(texts('SELECT 1 GO\nSELECT 2', 'mssql')).toEqual(['SELECT 1 GO\nSELECT 2'])
    expect(texts('SELECT 1\nGO SELECT 2', 'mssql')).toEqual(['SELECT 1\nGO SELECT 2'])
    expect(texts('SELECT 1\nGO;\nSELECT 2', 'mssql')).toEqual(['SELECT 1\nGO;\nSELECT 2'])
    expect(texts('SELECT 1\n/* c */ GO\nSELECT 2', 'mssql')).toEqual(['SELECT 1\n/* c */ GO\nSELECT 2'])
  })

  it('does not treat GOTO or labels as GO', () => {
    const sql = 'IF 1 = 1\nGOTO done\nSELECT 1\ndone:\nPRINT 1'
    expect(texts(sql, 'mssql')).toEqual([sql])
    expect(texts('SELECT 1\nGO5\nSELECT 2', 'mssql')).toHaveLength(1)
    expect(texts('SELECT 1\nGO 5x\nSELECT 2', 'mssql')).toHaveLength(1)
  })

  it('handles GO at start and end of the script and consecutive GOs', () => {
    expect(texts('GO\nSELECT 1\nGO\nGO\n\nGO\nSELECT 2', 'mssql')).toEqual(['SELECT 1', 'SELECT 2'])
    expect(texts('GO', 'mssql')).toEqual([])
  })

  it('handles CRLF around GO', () => {
    const sql = 'SELECT 1\r\nGO\r\nSELECT 2\r\n'
    const batches = splitStatements(sql, 'mssql')
    expect(batches.map((b) => b.text)).toEqual(['SELECT 1', 'SELECT 2'])
    expectConsistentOffsets(sql, batches)
  })

  it('reports offsets into the source', () => {
    const sql = '-- header\nCREATE TABLE t (a int)\nGO\n\n  SELECT * FROM t\n'
    const batches = splitStatements(sql, 'mssql')
    expect(batches).toEqual([
      { text: 'CREATE TABLE t (a int)', start: 10, end: 32 },
      { text: 'SELECT * FROM t', start: 39, end: 54 },
    ])
    expectConsistentOffsets(sql, batches)
  })

  it('drops comment-only batches', () => {
    expect(texts('-- nothing\nGO\n/* still nothing */\nGO\nSELECT 1', 'mssql')).toEqual(['SELECT 1'])
  })

  it('treats N strings with GO inside as strings', () => {
    expect(texts("PRINT N'x\nGO\n'\nGO", 'mssql')).toEqual(["PRINT N'x\nGO\n'"])
  })
})

describe('splitStatementsFine — mssql', () => {
  it('splits on semicolons and blank lines', () => {
    expect(fine('SELECT 1; SELECT 2\n\nSELECT 3\nFROM t')).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3\nFROM t'])
  })

  it('splits on GO lines', () => {
    expect(fine('SELECT 1\nGO\nSELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('does not split inside BEGIN … END blocks', () => {
    const block = 'IF 1 = 1\nBEGIN\n  SELECT 1;\n\n  SELECT 2;\nEND'
    expect(fine(`${block}\n\nSELECT 3`)).toEqual([block, 'SELECT 3'])
  })

  it('tracks BEGIN TRY / BEGIN CATCH', () => {
    const block = 'BEGIN TRY\n  SELECT 1;\nEND TRY\nBEGIN CATCH\n  SELECT 2;\nEND CATCH'
    expect(fine(`${block};\nSELECT 3`)).toEqual([block, 'SELECT 3'])
  })

  it('does not treat BEGIN TRAN as a block', () => {
    expect(fine('BEGIN TRAN; UPDATE t SET a = 1 WHERE id = 1; COMMIT')).toEqual([
      'BEGIN TRAN',
      'UPDATE t SET a = 1 WHERE id = 1',
      'COMMIT',
    ])
    expect(fine('BEGIN TRANSACTION;\n\nSELECT 1')).toEqual(['BEGIN TRANSACTION', 'SELECT 1'])
    expect(fine('BEGIN DISTRIBUTED TRANSACTION; SELECT 1')).toEqual(['BEGIN DISTRIBUTED TRANSACTION', 'SELECT 1'])
  })

  it('tracks CASE … END', () => {
    const stmt = 'SELECT CASE\n  WHEN a = 1 THEN 1\n\n  ELSE 2 END\nFROM t'
    expect(fine(`${stmt}\n\nSELECT 2`)).toEqual([stmt, 'SELECT 2'])
  })

  it('tracks parentheses', () => {
    const stmt = 'SELECT *\nFROM (\n  SELECT 1 AS a;\n\n) x'
    expect(fine(stmt)).toEqual([stmt])
  })

  it('ignores semicolons and blank lines in strings and comments', () => {
    const stmt = "SELECT 'a;\n\nb' /* x;\n\ny */, [c;\n\nd]"
    expect(fine(`${stmt}; SELECT 2`)).toEqual([stmt, 'SELECT 2'])
  })

  it('handles nested blocks', () => {
    const block = 'WHILE @i < 10\nBEGIN\n  IF @i = 5\n  BEGIN\n    BREAK;\n  END;\n\n  SET @i += 1;\nEND'
    expect(fine(`${block}\nGO\nSELECT 1`)).toEqual([block, 'SELECT 1'])
  })

  it('reports offsets into the source', () => {
    const sql = 'SELECT 1;\n\n  SELECT 2\nGO\nSELECT 3'
    const units = splitStatementsFine(sql, 'mssql')
    expect(units.map((u) => u.text)).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3'])
    expectConsistentOffsets(sql, units)
  })
})

describe('statementAtOffset', () => {
  it('returns null for empty text', () => {
    expect(statementAtOffset('', 0, 'postgres')).toBeNull()
    expect(statementAtOffset('   -- only comment', 3, 'mssql')).toBeNull()
  })

  it('returns the statement containing the caret', () => {
    expect(at('SELECT 1; SEL|ECT 2; SELECT 3', 'postgres')).toBe('SELECT 2')
    expect(at('|SELECT 1; SELECT 2', 'postgres')).toBe('SELECT 1')
    expect(at('SELECT 1; SELECT 2|', 'postgres')).toBe('SELECT 2')
  })

  it('returns the statement just before the caret after a semicolon (DataGrip)', () => {
    expect(at('SELECT 1;|\nSELECT 2;', 'postgres')).toBe('SELECT 1')
    expect(at('SELECT 1;   |\nSELECT 2;', 'postgres')).toBe('SELECT 1')
    expect(at('SELECT 1; -- note |\nSELECT 2;', 'postgres')).toBe('SELECT 1')
  })

  it('prefers the previous statement on the same line over the next one', () => {
    expect(at('SELECT 1; | SELECT 2;', 'postgres')).toBe('SELECT 1')
  })

  it('returns the next statement on the same line when nothing precedes on that line', () => {
    expect(at('SELECT 1;\n\n  |  SELECT 2;', 'postgres')).toBe('SELECT 2')
    expect(at('|   SELECT 1', 'postgres')).toBe('SELECT 1')
  })

  it('returns the adjacent statement when no blank line separates it', () => {
    expect(at('SELECT 1;\n|\nSELECT 2;', 'postgres')).toBe('SELECT 1')
    expect(at('SELECT 1;\n\n-- next one|\nSELECT 2;', 'postgres')).toBe('SELECT 2')
  })

  it('returns null when blank lines separate the caret from every statement', () => {
    expect(at('SELECT 1;\n\n|\n\nSELECT 2;', 'postgres')).toBeNull()
  })

  it('handles carets inside multi-line statements and dollar bodies', () => {
    const sql = "SELECT 1;\nDO $$\nBEGIN\n  RAISE NOTICE '|x';\nEND $$;\nSELECT 2;"
    expect(at(sql, 'postgres')).toBe("DO $$\nBEGIN\n  RAISE NOTICE 'x';\nEND $$")
  })

  it('clamps out-of-range offsets', () => {
    expect(statementAtOffset('SELECT 1; SELECT 2', 999, 'postgres')?.text).toBe('SELECT 2')
    expect(statementAtOffset('SELECT 1; SELECT 2', -5, 'postgres')?.text).toBe('SELECT 1')
  })

  it('uses fine statements on mssql', () => {
    expect(at('SELECT 1\n\nSELECT| 2\nGO\nSELECT 3', 'mssql')).toBe('SELECT 2')
    expect(at('SELECT 1; SELECT 2;|', 'mssql')).toBe('SELECT 2')
    expect(at('IF 1 = 1\nBEGIN\n  SELECT 1;\n\n  SEL|ECT 2;\nEND', 'mssql')).toBe(
      'IF 1 = 1\nBEGIN\n  SELECT 1;\n\n  SELECT 2;\nEND',
    )
  })

  it('does not reach across a GO line', () => {
    expect(at('SELECT 1\nGO\n|', 'mssql')).toBeNull()
    expect(at('SELECT 1\n|\nGO', 'mssql')).toBe('SELECT 1')
  })

  it('returns offsets usable for highlighting', () => {
    const sql = 'SELECT 1;\n  SELECT 2;'
    const s = statementAtOffset(sql, sql.length, 'postgres')
    expect(s).not.toBeNull()
    expect(sql.slice(s?.start, s?.end)).toBe('SELECT 2')
  })
})

describe('splitStatements — postgres parentheses', () => {
  it('does not split CREATE RULE … DO ALSO (action; action)', () => {
    const rule = 'CREATE RULE fan_out AS ON INSERT TO src DO ALSO (INSERT INTO a VALUES (new.id); INSERT INTO b VALUES (new.id))'
    expect(texts(`${rule};\nSELECT 1;`, 'postgres')).toEqual([rule, 'SELECT 1'])
  })

  it('still splits after the parentheses close', () => {
    expect(texts('SELECT (1); SELECT ((2))', 'postgres')).toEqual(['SELECT (1)', 'SELECT ((2))'])
  })
})

describe('splitStatementsFine — mssql blank lines inside a statement', () => {
  it.each([
    ['DELETE FROM dbo.customers\n\nWHERE id = 42'],
    ['SELECT *\nFROM t\n\nWHERE x = 1'],
    ['SELECT a\n\nFROM t\n\nINNER JOIN u ON u.id = t.id\n\nORDER BY a'],
    ['UPDATE t\n\nSET a = 1\n\nWHERE id = 1'],
    ['INSERT INTO t (a, b)\n\nVALUES (1, 2)'],
    ['INSERT INTO t (a)\n\nSELECT a FROM u'],
    ['WITH c AS (SELECT 1 AS a)\n\nSELECT * FROM c'],
    ["IF 1 = 1\n  PRINT 'a'\n\nELSE\n  PRINT 'b'"],
    ["IF EXISTS (SELECT 1 FROM t)\n\n  PRINT 'a'"],
    ['SELECT a,\n\n  b\nFROM t'],
    ['SELECT a\nFROM t\n\nUNION ALL\n\nSELECT b FROM u'],
    ['SELECT a FROM t ORDER BY a OFFSET 0 ROWS\n\nFETCH NEXT 5 ROWS ONLY'],
    ['BEGIN TRY\n  SELECT 1\nEND TRY\n\nBEGIN CATCH\n  SELECT 2\nEND CATCH'],
  ])('%j stays one statement', (sql) => {
    expect(fine(sql)).toEqual([sql])
  })

  it('runs a module definition to the end of its batch', () => {
    const proc = 'CREATE PROCEDURE dbo.p AS\nSET NOCOUNT ON;\n\nSELECT 1;\n\nSELECT 2'
    expect(fine(`${proc}\nGO\nSELECT 3`)).toEqual([proc, 'SELECT 3'])
    const fn = 'CREATE OR ALTER FUNCTION dbo.f() RETURNS int AS\nBEGIN\n  RETURN 1\nEND'
    expect(fine(`${fn}\n\nGO\nSELECT 3`)).toEqual([fn, 'SELECT 3'])
  })

  it('keeps IF … ; ELSE together', () => {
    expect(fine("IF 1 = 1 PRINT 'a'; ELSE PRINT 'b'; SELECT 2")).toEqual(["IF 1 = 1 PRINT 'a'; ELSE PRINT 'b'", 'SELECT 2'])
  })

  it('still splits complete statements at blank lines', () => {
    expect(fine('SELECT 1\n\nSELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
    expect(fine('SET NOCOUNT ON\n\nSELECT 1')).toEqual(['SET NOCOUNT ON', 'SELECT 1'])
    expect(fine('UPDATE t SET a = 1 WHERE id = 1\n\nSET NOCOUNT ON')).toEqual(['UPDATE t SET a = 1 WHERE id = 1', 'SET NOCOUNT ON'])
    expect(fine('INSERT INTO t VALUES (1)\n\nSELECT 1')).toEqual(['INSERT INTO t VALUES (1)', 'SELECT 1'])
    expect(fine("IF 1 = 1\n  PRINT 'a'\n\nSELECT 2")).toEqual(["IF 1 = 1\n  PRINT 'a'", 'SELECT 2'])
    expect(fine('EXEC dbo.p @x OUTPUT\n\nSELECT @x')).toEqual(['EXEC dbo.p @x OUTPUT', 'SELECT @x'])
    expect(fine('WITH c AS (SELECT 1 AS a) SELECT * FROM c\n\nSELECT 2')).toEqual(['WITH c AS (SELECT 1 AS a) SELECT * FROM c', 'SELECT 2'])
    expect(fine('IF UPDATE(a) PRINT 1\n\nSELECT 2')).toEqual(['IF UPDATE(a) PRINT 1', 'SELECT 2'])
  })

  it('Run statement picks the whole DELETE … WHERE when the caret is on the first line', () => {
    expect(at('DELETE FROM dbo.customers|\n\nWHERE id = 42', 'mssql')).toBe('DELETE FROM dbo.customers\n\nWHERE id = 42')
    expect(at('CREATE PROCEDURE dbo.p AS|\nSET NOCOUNT ON\n\nSELECT 1\nGO', 'mssql')).toBe('CREATE PROCEDURE dbo.p AS\nSET NOCOUNT ON\n\nSELECT 1')
    expect(at("IF 1 = 1|\n  PRINT 'a'\n\nELSE\n  PRINT 'b'", 'mssql')).toBe("IF 1 = 1\n  PRINT 'a'\n\nELSE\n  PRINT 'b'")
  })
})
