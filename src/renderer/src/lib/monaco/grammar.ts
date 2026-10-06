// SQL highlighting. Monaco's pgsql grammar only knows reserved keywords (no UPDATE, SET, VALUES,
// INSERT…) and no data types: extend it with statement keywords and a `type` token for data types.
// Both grammars colour word operators (AND, JOIN, LEFT…) as keywords instead of operators.
import type { languages } from 'monaco-editor/editor/editor.api.js'

const words = (text: string): string[] => text.trim().split(/\s+/)

/** Keywords highlighted on top of the grammar's reserved ones. Identifier-like words (name, type, key, data…) stay plain. */
export const PG_EXTRA_KEYWORDS = words(`
  INSERT UPDATE DELETE SET VALUES BY ALTER DROP TRUNCATE BEGIN COMMIT ROLLBACK SAVEPOINT RELEASE START TRANSACTION
  EXPLAIN VACUUM COPY SHOW RESET DECLARE EXECUTE PREPARE DEALLOCATE CALL MERGE MATCHED RETURNS RETURN LANGUAGE
  FUNCTION PROCEDURE TRIGGER VIEW INDEX SCHEMA DATABASE SEQUENCE EXTENSION MATERIALIZED REFRESH TEMP TEMPORARY
  UNLOGGED IF EXISTS REPLACE ADD RENAME CASCADE RESTRICT CONFLICT NOTHING OVER PARTITION ROWS RANGE GROUPS PRECEDING
  FOLLOWING UNBOUNDED CURRENT ROW NULLS FIRST LAST RECURSIVE INTERVAL BETWEEN EXCLUDE TIES FILTER WITHIN ORDINALITY
  OWNED OWNER TABLESPACE GRANTED PRIVILEGES REVOKE ROLE USAGE EXECUTE CONSTRAINTS DEFERRED IMMEDIATE NO ACTION
  MATCH PARTIAL SIMPLE GENERATED ALWAYS STORED IDENTITY INHERITS LIKE INCLUDING EXCLUDING COMMENT LOCK SHARE NOWAIT
  SKIP LOCKED LISTEN NOTIFY UNLISTEN DISCARD CLUSTER REINDEX CONCURRENTLY ANALYZE VERBOSE ZONE AT TIME
`)

export const PG_TYPES = words(`
  BIGINT BIGSERIAL BIT BOOLEAN BOOL BOX BYTEA CHAR CHARACTER VARYING CIDR CIRCLE DATE DATERANGE DECIMAL DOUBLE PRECISION
  FLOAT4 FLOAT8 INET INT INT2 INT4 INT8 INT4RANGE INT8RANGE INTEGER JSON JSONB LINE LSEG MACADDR MONEY NUMERIC NUMRANGE
  OID PATH POINT POLYGON REAL REGCLASS SERIAL SERIAL2 SERIAL4 SERIAL8 SMALLINT SMALLSERIAL TEXT TIMETZ TIMESTAMP
  TIMESTAMPTZ TSQUERY TSRANGE TSTZRANGE TSVECTOR UUID VARCHAR XML VOID RECORD ANYELEMENT ANYARRAY
`)

type Cases = Record<string, string>

function isCasesRule(rule: unknown): rule is [RegExp, { cases: Cases }] {
  if (!Array.isArray(rule) || rule.length !== 2) return false
  const action: unknown = rule[1]
  if (!action || typeof action !== 'object' || !('cases' in action)) return false
  const cases: unknown = action.cases
  return !!cases && typeof cases === 'object' && '@keywords' in cases
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Monaco's SQL grammars list word operators (AND, OR, NOT, IN, LIKE, IS, NULL, JOIN, LEFT, INNER…) as
 * `operators`, which get the near-plain operator colour: `JOIN … ON` would read as an identifier
 * followed by a keyword. Words are keywords here; symbolic operators keep the operator token.
 */
function wordOperators(base: languages.IMonarchLanguage): string[] {
  return stringList(base.operators).filter((w) => /^[A-Z_]+$/i.test(w))
}

/** Root rule cases with `extra` inserted before `before` (Monarch evaluates cases in order). */
function patchRootCases(base: languages.IMonarchLanguage, before: string, extra: Cases): languages.IMonarchLanguageRule[] {
  const root = base.tokenizer.root ?? []
  return root.map((rule) => {
    if (!isCasesRule(rule)) return rule
    const [regex, { cases }] = rule
    const next: Cases = {}
    for (const [key, value] of Object.entries(cases)) {
      if (key === before) Object.assign(next, extra)
      next[key] = value
    }
    return [regex, { cases: next }]
  }) as languages.IMonarchLanguageRule[]
}

/** A copy of Monaco's pgsql Monarch grammar with extra keywords and a `@pgTypes` → `type` case. */
export function extendPgsqlLanguage(base: languages.IMonarchLanguage): languages.IMonarchLanguage {
  const taken = new Set([...stringList(base.builtinFunctions), ...stringList(base.operators)].map((w) => w.toUpperCase()))
  const keywords = [...new Set([...stringList(base.keywords), ...PG_EXTRA_KEYWORDS])].filter((k) => !taken.has(k) || stringList(base.keywords).includes(k))
  const types = PG_TYPES.filter((t) => !keywords.includes(t))
  const withTypes: languages.IMonarchLanguage = { ...base, tokenizer: { ...base.tokenizer, root: patchRootCases(base, '@keywords', { '@pgTypes': 'type' }) } }
  return {
    ...base,
    keywords,
    pgTypes: types,
    wordOperators: wordOperators(base),
    tokenizer: { ...base.tokenizer, root: patchRootCases(withTypes, '@operators', { '@wordOperators': 'keyword' }) },
  }
}

/** A copy of Monaco's T-SQL ('sql') grammar where word operators are keywords. */
export function extendMssqlLanguage(base: languages.IMonarchLanguage): languages.IMonarchLanguage {
  return {
    ...base,
    wordOperators: wordOperators(base),
    tokenizer: { ...base.tokenizer, root: patchRootCases(base, '@operators', { '@wordOperators': 'keyword' }) },
  }
}
