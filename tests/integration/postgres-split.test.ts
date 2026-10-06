// Statement splitting interplay with the PostgreSQL session.
import { describe, expect, it } from 'vitest'
import { withSession } from './helpers/pg'

describe('pg review: statement splitting', () => {
  it('runs a CREATE RULE with several parenthesized actions as one statement', async () => {
    await withSession(async (s) => {
      const { results } = await s.execute(
        `CREATE TEMP TABLE src (v int); CREATE TEMP TABLE a (v int); CREATE TEMP TABLE b (v int);
         CREATE RULE fan_out AS ON INSERT TO src DO ALSO (INSERT INTO a VALUES (NEW.v); INSERT INTO b VALUES (NEW.v));
         INSERT INTO src VALUES (1);
         SELECT (SELECT count(*) FROM a)::int, (SELECT count(*) FROM b)::int`,
        { maxRows: 10 },
      )
      // Before the fix, the splitter cuts at the ';' inside the parentheses: "syntax error at end of input".
      expect(results.filter((r) => r.kind === 'error').map((r) => r.error?.message)).toEqual([])
      expect(results[results.length - 1]?.rows).toEqual([[1, 1]])
    })
  })
})
