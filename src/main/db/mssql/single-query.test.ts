import { describe, expect, it } from 'vitest'
import { isSingleReadOnlyQuery } from './single-query'

describe('isSingleReadOnlyQuery', () => {
  it('accepts one query, with CTEs, set operators, subqueries, CASE and OFFSET / FETCH', () => {
    for (const sql of [
      'SELECT * FROM dbo.events',
      'select id from dbo.events order by id offset 10 rows fetch next 5 rows only;',
      'WITH c AS (SELECT 1 AS x UNION ALL SELECT 2) SELECT x, CASE WHEN x > 1 THEN 1 END FROM c',
      'SELECT a FROM t UNION SELECT b FROM u EXCEPT SELECT c FROM v INTERSECT SELECT d FROM w',
      'SELECT (SELECT MAX(id) FROM t) AS m, x FROM a INNER JOIN b ON a.id = b.id',
      "SELECT 'PRINT 1; SELECT 2' AS s -- SELECT 3\n/* DELETE FROM t */",
    ]) {
      expect(isSingleReadOnlyQuery(sql), sql).toBe(true)
    }
  })

  it('rejects several statements, even without ";" between them', () => {
    for (const sql of [
      "SELECT TOP 20 id FROM dbo.events ORDER BY id\nSELECT 'second' AS x",
      'SELECT 1; SELECT 2',
      'SELECT 1\nPRINT 2',
      'SELECT 1 FROM t\nIF 1 = 1 SELECT 2',
      'SELECT 1\nEXEC dbo.p',
      'SELECT * INTO #t FROM dbo.events',
      'WITH c AS (SELECT 1 AS x) SELECT x FROM c\nSELECT 2',
      'DELETE FROM t',
      'SELECT 1)',
      '(SELECT 1)',
    ]) {
      expect(isSingleReadOnlyQuery(sql), sql).toBe(false)
    }
  })
})
