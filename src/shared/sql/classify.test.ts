import { describe, expect, it } from 'vitest'
import type { Dialect } from '../types'
import { classifyStatement } from './index'

type Expected = 'read' | 'write' | 'destructive'

function kind(sql: string, dialect: Dialect): Expected {
  const c = classifyStatement(sql, dialect)
  if (c.destructive) {
    expect(c.readOnly).toBe(false)
    return 'destructive'
  }
  return c.readOnly ? 'read' : 'write'
}

function matrix(dialect: Dialect, cases: [string, Expected][]): void {
  it.each(cases)('%s', (sql, expected) => {
    expect(kind(sql, dialect)).toBe(expected)
  })
}

describe('classifyStatement — postgres matrix', () => {
  matrix('postgres', [
    ['SELECT * FROM t', 'read'],
    ['select 1', 'read'],
    ['  -- comment\n/* block */ SELECT 1', 'read'],
    ['(SELECT 1) UNION (SELECT 2)', 'read'],
    ['VALUES (1), (2)', 'read'],
    ['TABLE users', 'read'],
    ['SHOW search_path', 'read'],
    ['SET search_path TO app', 'read'],
    ['RESET ALL', 'write'],
    ['RESET search_path', 'read'],
    ['BEGIN', 'read'],
    ['START TRANSACTION READ ONLY', 'read'],
    ['COMMIT', 'read'],
    ['ROLLBACK', 'read'],
    ['END', 'read'],
    ['SAVEPOINT s1', 'read'],
    ['RELEASE SAVEPOINT s1', 'read'],
    ['DECLARE c CURSOR FOR SELECT * FROM t', 'read'],
    ['FETCH 10 FROM c', 'read'],
    ['CLOSE c', 'read'],
    ['DEALLOCATE ALL', 'read'],
    ['DISCARD ALL', 'write'],
    ['DISCARD PLANS', 'read'],
    ['LISTEN channel', 'read'],
    ['EXPLAIN SELECT * FROM t', 'read'],
    ['EXPLAIN DELETE FROM t', 'read'],
    ['EXPLAIN (FORMAT JSON) UPDATE t SET a = 1', 'read'],
    ['EXPLAIN (ANALYZE false) DELETE FROM t', 'read'],
    ['EXPLAIN ANALYZE SELECT 1', 'read'],
    ['EXPLAIN ANALYZE INSERT INTO t VALUES (1)', 'write'],
    ['EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a = 1 WHERE id = 1', 'write'],
    ['EXPLAIN ANALYZE DELETE FROM t', 'destructive'],
    ['EXPLAIN (ANALYZE true) DELETE FROM t', 'destructive'],
    ['SELECT * INTO backup FROM t', 'write'],
    ['SELECT * FROM t FOR UPDATE', 'write'],
    ['SELECT * FROM t FOR NO KEY UPDATE', 'write'],
    ['SELECT * FROM t FOR SHARE', 'write'],
    ['SELECT * FROM t FOR KEY SHARE SKIP LOCKED', 'write'],
    ['INSERT INTO t VALUES (1)', 'write'],
    ["INSERT INTO t SELECT * FROM u WHERE a = 'x'", 'write'],
    ['UPDATE t SET a = 1 WHERE id = 2', 'write'],
    ['DELETE FROM t WHERE id = 2', 'write'],
    ['DELETE FROM t USING u WHERE t.id = u.id', 'write'],
    ['DELETE FROM t WHERE CURRENT OF c', 'write'],
    ['MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE', 'write'],
    ['CREATE TABLE t (id int)', 'write'],
    ['CREATE INDEX CONCURRENTLY ix ON t (a)', 'write'],
    ['ALTER TABLE t ADD COLUMN b int', 'write'],
    ['ALTER TABLE t ALTER COLUMN b DROP DEFAULT', 'write'],
    ['ALTER TABLE t ALTER COLUMN b DROP NOT NULL', 'write'],
    ['GRANT SELECT ON t TO bob', 'write'],
    ['REVOKE ALL ON t FROM bob', 'write'],
    ['COPY t TO STDOUT', 'write'],
    ['CALL proc()', 'write'],
    ['DO $$ BEGIN PERFORM 1; END $$', 'write'],
    ['VACUUM t', 'write'],
    ['ANALYZE t', 'write'],
    ['REINDEX TABLE t', 'write'],
    ['CLUSTER t', 'write'],
    ['REFRESH MATERIALIZED VIEW mv', 'write'],
    ["COMMENT ON TABLE t IS 'x'", 'write'],
    ['LOCK TABLE t', 'write'],
    ['PREPARE p AS SELECT 1', 'write'],
    ['EXECUTE p', 'write'],
    ['NOTIFY channel', 'write'],
    ['frobnicate everything', 'write'],
    ['DELETE FROM t', 'destructive'],
    ['UPDATE t SET a = 1', 'destructive'],
    ['DROP TABLE t', 'destructive'],
    ['DROP INDEX IF EXISTS ix', 'destructive'],
    ['TRUNCATE t', 'destructive'],
    ['TRUNCATE TABLE t CASCADE', 'destructive'],
    ['ALTER TABLE t DROP COLUMN a', 'destructive'],
    ['ALTER TABLE t DROP a', 'destructive'],
    ['ALTER TABLE t DROP CONSTRAINT fk', 'destructive'],
  ])
})

describe('classifyStatement — WITH', () => {
  matrix('postgres', [
    ['WITH a AS (SELECT 1) SELECT * FROM a', 'read'],
    ['WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 5) SELECT * FROM r', 'read'],
    ['WITH a AS MATERIALIZED (SELECT 1), b AS NOT MATERIALIZED (SELECT 2) SELECT * FROM a, b', 'read'],
    ['WITH a AS (SELECT id FROM t WHERE x = 1) DELETE FROM t WHERE id IN (SELECT id FROM a)', 'write'],
    ['WITH a AS (SELECT id FROM t WHERE x = 1) DELETE FROM t', 'destructive'],
    ['WITH a AS (SELECT 1) UPDATE t SET b = 1 WHERE id = 1', 'write'],
    ['WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a', 'write'],
    ['WITH moved AS (DELETE FROM t WHERE old RETURNING *) SELECT * FROM moved', 'write'],
    ['WITH moved AS (DELETE FROM t RETURNING *) INSERT INTO archive SELECT * FROM moved', 'destructive'],
    ['WITH u AS (UPDATE t SET a = 1 WHERE id = 1 RETURNING *) SELECT * FROM u', 'write'],
    ['WITH a AS (SELECT * FROM t FOR UPDATE) SELECT * FROM a', 'write'],
    ['WITH a AS (SELECT 1)', 'write'],
  ])

  it('reports WITH as the command', () => {
    expect(classifyStatement('WITH a AS (SELECT 1) DELETE FROM t', 'postgres')).toEqual({
      command: 'WITH',
      readOnly: false,
      destructive: true,
      reason: 'DELETE without WHERE clause',
    })
  })
})

describe('classifyStatement — WHERE detection', () => {
  matrix('postgres', [
    ['DELETE FROM t WHERE id IN (SELECT id FROM u)', 'write'],
    ['DELETE FROM t USING (SELECT id FROM u WHERE x = 1) s', 'destructive'],
    ['UPDATE t SET a = (SELECT max(b) FROM u WHERE u.id = 1)', 'destructive'],
    ['UPDATE t SET a = CASE WHEN b > 0 THEN 1 ELSE 0 END WHERE id = 1', 'write'],
    ['UPDATE t SET a = CASE WHEN b > 0 THEN 1 ELSE 0 END', 'destructive'],
    ["DELETE FROM t -- WHERE id = 1\n", 'destructive'],
    ["DELETE FROM t /* WHERE id = 1 */", 'destructive'],
    ["UPDATE t SET note = 'WHERE x'", 'destructive'],
    ['UPDATE "where" SET a = 1', 'destructive'],
  ])
})

describe('classifyStatement — mssql matrix', () => {
  matrix('mssql', [
    ['SELECT * FROM dbo.t', 'read'],
    ['SELECT TOP (10) * FROM [dbo].[t] WITH (NOLOCK)', 'read'],
    ['DECLARE @x int = 1', 'read'],
    ['SET NOCOUNT ON', 'read'],
    ['SET @x = (SELECT COUNT(*) FROM t)', 'read'],
    ['USE master', 'read'],
    ["PRINT 'hello'", 'read'],
    ['BEGIN TRAN', 'read'],
    ['BEGIN TRANSACTION; SELECT 1; COMMIT TRANSACTION', 'read'],
    ['SAVE TRAN s1', 'read'],
    ['ROLLBACK TRAN', 'read'],
    ['FETCH NEXT FROM c INTO @a, @b', 'read'],
    ['CLOSE c; DEALLOCATE c', 'read'],
    ["WAITFOR DELAY '00:00:01'", 'read'],
    ['IF @x = 1 SELECT 1 ELSE SELECT 2', 'read'],
    ['IF EXISTS (SELECT 1 FROM t) BEGIN SELECT 1 END', 'read'],
    ['WITH a AS (SELECT 1 AS x) SELECT * FROM a', 'read'],
    [';WITH a AS (SELECT 1 AS x) SELECT * FROM a', 'read'],
    ['SELECT * INTO #copy FROM t', 'write'],
    ['SELECT * INTO dbo.backup FROM t', 'write'],
    ['IF 1 = 1 SELECT * INTO x FROM t', 'write'],
    ['INSERT INTO t (a) VALUES (1)', 'write'],
    ['INSERT t VALUES (1)', 'write'],
    ['UPDATE t SET a = 1 WHERE id = 1', 'write'],
    ['UPDATE STATISTICS dbo.t', 'write'],
    ['DELETE FROM t WHERE id = 1', 'write'],
    ['MERGE t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = s.a WHEN NOT MATCHED THEN INSERT (a) VALUES (s.a);', 'write'],
    ['EXEC sp_who', 'write'],
    ['EXECUTE dbo.p @a = 1', 'write'],
    ['sp_who', 'write'],
    ['BULK INSERT t FROM \'c:\\data.csv\'', 'write'],
    ["BACKUP DATABASE d TO DISK = 'x.bak'", 'write'],
    ["RESTORE DATABASE d FROM DISK = 'x.bak'", 'write'],
    ['DBCC CHECKDB', 'write'],
    ['GRANT SELECT, INSERT, UPDATE, DELETE ON t TO bob', 'write'],
    ['DENY DELETE ON t TO bob', 'write'],
    ['KILL 52', 'write'],
    ['WITH a AS (SELECT id FROM t) DELETE FROM a WHERE id = 1', 'write'],
    ['WITH a AS (SELECT id FROM t) UPDATE a SET id = 2 WHERE id = 1', 'write'],
    ['ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES r (id) ON DELETE CASCADE ON UPDATE NO ACTION', 'write'],
    ['ALTER TABLE t ALTER COLUMN a bigint', 'write'],
    ['DROP TABLE t', 'destructive'],
    ['DROP TABLE IF EXISTS #tmp', 'destructive'],
    ['TRUNCATE TABLE t', 'destructive'],
    ['DELETE FROM t', 'destructive'],
    ['DELETE TOP (10) FROM t', 'destructive'],
    ['UPDATE t SET a = 1', 'destructive'],
    ['ALTER TABLE t DROP COLUMN a', 'destructive'],
    ['WITH a AS (SELECT id FROM t) DELETE FROM a', 'destructive'],
  ])
})

describe('classifyStatement — mssql batches without semicolons', () => {
  matrix('mssql', [
    ['SELECT 1 UPDATE t SET a = 1 WHERE id = 1', 'write'],
    ['SELECT 1 UPDATE t SET a = 1', 'destructive'],
    ['SELECT 1\nDELETE FROM t\nSELECT * FROM u WHERE x = 1', 'destructive'],
    ['DELETE FROM t\nSELECT * FROM u WHERE x = 1', 'destructive'],
    ['SET NOCOUNT ON\nUPDATE t SET a = 1 WHERE id = 1', 'write'],
    ['SET IDENTITY_INSERT t ON\nINSERT INTO t (id) VALUES (1)\nSET IDENTITY_INSERT t OFF', 'write'],
    ['DECLARE @x int\nSELECT @x = 1\nEXEC p @x', 'write'],
    ["IF OBJECT_ID('t') IS NOT NULL DROP TABLE t", 'destructive'],
    ['IF EXISTS (SELECT 1 FROM t) DROP TABLE t', 'destructive'],
    ['IF @x = 1\nBEGIN\n  DELETE FROM t\nEND', 'destructive'],
    ['IF @x = 1\nBEGIN\n  DELETE FROM t WHERE id = @x\nEND', 'write'],
    ['BEGIN TRY\n  UPDATE t SET a = 1 WHERE id = 1\nEND TRY\nBEGIN CATCH\n  SELECT ERROR_MESSAGE()\nEND CATCH', 'write'],
    ['SELECT 1\nGO\nTRUNCATE TABLE t\nGO\nSELECT 2', 'destructive'],
    ['SELECT 1\nGO\nINSERT INTO t VALUES (1)', 'write'],
    ['SELECT 1\nGO\nSELECT 2\nGO', 'read'],
    ['SELECT a FROM t WHERE b IN (SELECT b FROM u)', 'read'],
    ['DECLARE c CURSOR FOR SELECT a FROM t\nOPEN c\nFETCH NEXT FROM c INTO @a', 'read'],
    ['IF UPDATE(a) PRINT 1', 'read'],
    ["SELECT 'DELETE FROM t' AS q, [update] FROM t", 'read'],
    ["EXEC ('DROP TABLE t')", 'write'],
    ["SELECT 1 EXEC ('DROP TABLE t')", 'write'],
    ['CREATE TABLE t (a int)\nINSERT INTO t VALUES (1)', 'write'],
    ['DROP TABLE IF EXISTS t CREATE TABLE t (a int)', 'destructive'],
  ])

  it('keeps module bodies as part of CREATE / ALTER', () => {
    const proc = 'CREATE PROCEDURE p AS\nBEGIN\n  DELETE FROM t\n  DROP TABLE x\nEND'
    expect(classifyStatement(proc, 'mssql')).toEqual({ command: 'CREATE', readOnly: false, destructive: false })
    const trigger = 'CREATE OR ALTER TRIGGER trg ON t AFTER INSERT, UPDATE, DELETE AS\nUPDATE t SET a = 1'
    expect(classifyStatement(trigger, 'mssql').destructive).toBe(false)
    const view = 'ALTER VIEW v AS SELECT * FROM t'
    expect(classifyStatement(view, 'mssql')).toMatchObject({ command: 'ALTER', readOnly: false, destructive: false })
  })

  it('reports the most dangerous statement of a batch', () => {
    expect(classifyStatement('SELECT 1; INSERT INTO t VALUES (1); DROP TABLE x; SELECT 2', 'mssql')).toEqual({
      command: 'DROP',
      readOnly: false,
      destructive: true,
      reason: 'DROP TABLE',
    })
    expect(classifyStatement('SELECT 1 UPDATE t SET a = 1 WHERE id = 1', 'mssql').command).toBe('UPDATE')
  })
})

describe('classifyStatement — multi-statement postgres input', () => {
  it('uses the most dangerous statement', () => {
    expect(classifyStatement('SELECT 1; DELETE FROM t; SELECT 2;', 'postgres')).toMatchObject({
      command: 'DELETE',
      destructive: true,
    })
    expect(kind('SELECT 1; SELECT 2;', 'postgres')).toBe('read')
    expect(kind('SELECT 1; INSERT INTO t VALUES (1)', 'postgres')).toBe('write')
  })

  it('does not split inside dollar bodies or BEGIN ATOMIC', () => {
    expect(kind("SELECT $$; DELETE FROM t; $$", 'postgres')).toBe('read')
    expect(
      kind('CREATE FUNCTION f() RETURNS void LANGUAGE sql BEGIN ATOMIC DELETE FROM t; END', 'postgres'),
    ).toBe('write')
  })
})

describe('classifyStatement — details', () => {
  it('returns the upper-case command', () => {
    expect(classifyStatement('  select 1', 'postgres').command).toBe('SELECT')
    expect(classifyStatement('/* x */ (((select 1)))', 'postgres').command).toBe('SELECT')
    expect(classifyStatement('insert into t values (1)', 'mssql').command).toBe('INSERT')
    expect(classifyStatement('explain analyze delete from t', 'postgres').command).toBe('EXPLAIN')
  })

  it('treats empty and comment-only input as read-only', () => {
    expect(classifyStatement('', 'postgres')).toEqual({ command: '', readOnly: true, destructive: false })
    expect(classifyStatement('-- nothing', 'mssql')).toEqual({ command: '', readOnly: true, destructive: false })
  })

  it('is conservative for input that does not start with a keyword', () => {
    expect(classifyStatement("'abc'", 'postgres').readOnly).toBe(false)
    expect(classifyStatement('((', 'postgres').readOnly).toBe(false)
  })

  it('gives plain-English reasons', () => {
    const reason = (sql: string, d: Dialect = 'postgres'): string | undefined => classifyStatement(sql, d).reason
    expect(reason('DELETE FROM t')).toBe('DELETE without WHERE clause')
    expect(reason('UPDATE t SET a = 1')).toBe('UPDATE without WHERE clause')
    expect(reason('DROP TABLE t')).toBe('DROP TABLE')
    expect(reason('drop materialized view mv')).toBe('DROP MATERIALIZED VIEW')
    expect(reason('DROP SCHEMA s CASCADE')).toBe('DROP SCHEMA')
    expect(reason('DROP DATABASE d', 'mssql')).toBe('DROP DATABASE')
    expect(reason('TRUNCATE t')).toBe('TRUNCATE TABLE')
    expect(reason('ALTER TABLE t DROP COLUMN a')).toBe('ALTER TABLE … DROP COLUMN')
    expect(reason('ALTER TABLE t DROP CONSTRAINT c', 'mssql')).toBe('ALTER TABLE … DROP CONSTRAINT')
    expect(reason('SELECT 1')).toBeUndefined()
  })

  it('ignores keywords inside strings, comments and quoted identifiers', () => {
    expect(kind("SELECT 'DROP TABLE t'", 'postgres')).toBe('read')
    expect(kind('SELECT 1 -- ; DROP TABLE t', 'postgres')).toBe('read')
    expect(kind('SELECT "delete" FROM t', 'postgres')).toBe('read')
    expect(kind("SELECT E'\\'; DROP TABLE t; --'", 'postgres')).toBe('read')
    expect(kind('SELECT [drop table] FROM t', 'mssql')).toBe('read')
  })
})

describe('classifyStatement — postgres read-only guard settings', () => {
  // A read-only connection relies on default_transaction_read_only: anything that turns it off is a write.
  matrix('postgres', [
    ['SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE', 'write'],
    ['SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY', 'read'],
    ['SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'read'],
    ['SET default_transaction_read_only = off', 'write'],
    ['set default_transaction_read_only to default', 'write'],
    ['SET SESSION default_transaction_read_only = false', 'write'],
    ['SET LOCAL transaction_read_only = off', 'write'],
    ['SET "transaction_read_only" TO off', 'write'],
    ['SET TRANSACTION READ WRITE', 'write'],
    ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ WRITE', 'write'],
    ['SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'read'],
    ['SET TRANSACTION READ ONLY', 'read'],
    ['SET LOCAL search_path TO app', 'read'],
    ['SET SESSION statement_timeout = 0', 'read'],
    ['RESET default_transaction_read_only', 'write'],
    ['RESET transaction_read_only', 'write'],
    ['BEGIN READ WRITE', 'write'],
    ['begin isolation level serializable read write', 'write'],
    ['START TRANSACTION READ WRITE', 'write'],
    ['BEGIN READ ONLY', 'read'],
    ['START TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'read'],
    ["SELECT set_config('default_transaction_read_only', 'off', false)", 'write'],
    ["select pg_catalog.set_config('transaction_read_only', 'off', true)", 'write'],
    ["SELECT set_config(' Default_Transaction_Read_Only ', 'off', false)", 'write'],
    ["SELECT set_config('default_transaction_' || 'read_only', 'off', false)", 'write'],
    ['SELECT set_config($1, $2, false)', 'write'],
    ["WITH x AS (SELECT set_config('default_transaction_read_only', 'off', false)) SELECT * FROM x", 'write'],
    ["SELECT set_config('search_path', 'app', false)", 'read'],
    ["SELECT current_setting('default_transaction_read_only')", 'read'],
  ])

  it('blocks the guard bypass inside a multi-statement script', () => {
    expect(kind('RESET ALL; SELECT 1', 'postgres')).toBe('write')
    expect(kind('BEGIN READ WRITE; SELECT f(); COMMIT', 'postgres')).toBe('write')
  })

  it('leaves SQL Server SET / BEGIN statements alone', () => {
    expect(kind('SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'mssql')).toBe('read')
    expect(kind('BEGIN TRANSACTION', 'mssql')).toBe('read')
  })
})

describe('classifyStatement — mssql column aliases named like trigger timings', () => {
  matrix('mssql', [
    ['select 1 as after delete from dbo.t', 'destructive'],
    ['select 1 after delete from dbo.t', 'destructive'],
    ['select 1 as before delete from dbo.t where id = 1', 'write'],
    ['select 1 as instead insert into t values (1)', 'write'],
    ['select 1 as after', 'read'],
  ])

  it('still keeps trigger headers whole', () => {
    expect(kind('CREATE TRIGGER trg ON t INSTEAD OF DELETE AS SELECT 1', 'mssql')).toBe('write')
    expect(classifyStatement('CREATE TRIGGER trg ON t AFTER DELETE AS SELECT 1', 'mssql').command).toBe('CREATE')
  })
})

describe('classifyStatement — separators the server sees but a naive lexer would not', () => {
  it.each([
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029'],
    ['U+0085', '\u0085'],
    ['U+200B', '\u200b'],
    ['U+00A0', '\u00a0'],
    ['U+3000', '\u3000'],
    ['\\x01', '\x01'],
  ])('%s between statements', (_name, sep) => {
    expect(kind(`select 1${sep}delete from dbo.t`, 'mssql')).toBe('destructive')
    expect(kind(`select 1 as a${sep}delete from dbo.t`, 'mssql')).toBe('destructive')
  })

  it('a lone carriage return ends a line comment', () => {
    expect(kind('select 1 -- note\rdelete from dbo.t', 'mssql')).toBe('destructive')
    expect(kind('select 1 -- note\r; delete from t', 'postgres')).toBe('destructive')
  })
})
