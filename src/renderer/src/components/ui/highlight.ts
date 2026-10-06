// Tiny SQL tokenizer for read-only previews (CodeBlock, confirm dialogs, history).
// Not a parser: it only needs to color keywords, strings, numbers, comments and calls.

export type SqlTokenType = 'keyword' | 'type' | 'function' | 'string' | 'number' | 'comment' | 'operator' | 'identifier' | 'plain'

export interface SqlToken {
  type: SqlTokenType
  text: string
}

const KEYWORDS = new Set(
  `add all alter always analyze and any as asc at begin between by cascade case check close collate column
  comment commit concurrently conflict constraint create cross current_date current_time current_timestamp
  current_user cursor database deallocate declare default deferrable deferred delete desc distinct do drop else
  end except exec execute exists explain extension fetch filter first for foreign from full function generated
  go grant group having identity if ilike immediate in include index initially inner insert intersect into is
  join key last lateral left like limit local materialized merge natural next not nothing null nulls of offset
  on only or order outer over owner partition password primary procedure recursive references release rename
  replace restrict return returning returns revoke right role rollback row rows savepoint schema select
  sequence session set show some stored table tablespace temp temporary then to top transaction trigger
  truncate union unique update use user using vacuum values view when where while window with without zone`
    .split(/\s+/)
    .filter(Boolean),
)

const TYPES = new Set(
  `bigint bigserial binary bit bool boolean bytea char character cidr date datetime datetime2 datetimeoffset
  decimal double float image inet int int2 int4 int8 integer interval json jsonb money nchar ntext numeric
  nvarchar real serial smalldatetime smallint smallmoney smallserial text time timestamp timestamptz timetz
  tinyint uniqueidentifier uuid varbinary varchar xml`
    .split(/\s+/)
    .filter(Boolean),
)

const LITERAL_WORDS = new Set(['true', 'false', 'null'])

/**
 * Keywords followed by an object name: `CREATE TABLE public.customers (`, `INSERT INTO t (`,
 * `REFERENCES t (`, `USING btree (` name a table / access method, not a function call.
 */
const OBJECT_INTRO = new Set(['table', 'into', 'references', 'using', 'view', 'update'])
/** Keywords allowed between the intro keyword and the name (`CREATE TABLE IF NOT EXISTS t`). */
const OBJECT_INTRO_SKIP = new Set(['if', 'not', 'exists', 'only'])

function isWordStart(c: string): boolean {
  return /[A-Za-z_@#À-￿]/.test(c)
}
function isWordPart(c: string): boolean {
  return /[A-Za-z0-9_$@#À-￿]/.test(c)
}

export function highlightSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = []
  const push = (type: SqlTokenType, text: string) => {
    const last = tokens[tokens.length - 1]
    if (last && last.type === type && (type === 'plain' || type === 'operator')) last.text += text
    else tokens.push({ type, text })
  }
  let i = 0
  const n = sql.length
  // An object name is expected (after TABLE, INTO…; ON inside CREATE INDEX): `name (` is not a call.
  let objectName = false
  // The current statement creates an index: its ON introduces the table name.
  let indexStatement = false
  const nextSignificant = (from: number) => {
    let k = from
    while (k < n && /\s/.test(sql[k]!)) k += 1
    return sql[k]
  }
  while (i < n) {
    const c = sql[i]!
    const next = sql[i + 1]

    // line comment
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? n : end
      push('comment', sql.slice(i, stop))
      i = stop
      continue
    }
    // block comment (nested comments are rare enough to ignore)
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      push('comment', sql.slice(i, stop))
      i = stop
      continue
    }
    // strings: '...', E'...', N'...'
    if (c === "'" || ((c === 'E' || c === 'e' || c === 'N' || c === 'n') && next === "'")) {
      let j = c === "'" ? i + 1 : i + 2
      const escapes = c === 'E' || c === 'e'
      while (j < n) {
        if (escapes && sql[j] === '\\') {
          j += 2
          continue
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      push('string', sql.slice(i, Math.min(j, n)))
      i = Math.min(j, n)
      continue
    }
    // dollar-quoted strings: $$...$$ / $tag$...$tag$
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        const stop = end === -1 ? n : end + tag.length
        push('string', sql.slice(i, stop))
        i = stop
        continue
      }
    }
    // quoted identifiers "..." and [...]
    if (c === '"' || c === '[' || c === '`') {
      const close = c === '[' ? ']' : c
      let j = i + 1
      while (j < n) {
        if (sql[j] === close) {
          if (sql[j + 1] === close) {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      push('identifier', sql.slice(i, j))
      if (objectName) objectName = nextSignificant(j) === '.'
      i = j
      continue
    }
    // numbers
    if (/[0-9]/.test(c) || (c === '.' && next !== undefined && /[0-9]/.test(next))) {
      const m = /^(0x[0-9a-fA-F]+|\d*\.?\d+(?:[eE][+-]?\d+)?)/.exec(sql.slice(i))
      if (m && !(i > 0 && isWordPart(sql[i - 1]!))) {
        push('number', m[0])
        i += m[0].length
        continue
      }
    }
    // words
    if (isWordStart(c)) {
      let j = i + 1
      while (j < n && isWordPart(sql[j]!)) j += 1
      const word = sql.slice(i, j)
      const lower = word.toLowerCase()
      const prev = tokens[tokens.length - 1]
      const afterDot = prev?.type === 'operator' && prev.text.endsWith('.')
      let k = j
      while (k < n && (sql[k] === ' ' || sql[k] === '\t')) k += 1
      const isCall = sql[k] === '('
      let type: SqlTokenType = 'plain'
      if (objectName && !afterDot && OBJECT_INTRO_SKIP.has(lower)) {
        type = 'keyword'
      } else if (objectName && (afterDot || !KEYWORDS.has(lower))) {
        // A (qualified) object name: stays in name context only while a "." follows.
        type = 'plain'
        objectName = nextSignificant(j) === '.'
      } else {
        if (afterDot) type = isCall ? 'function' : 'plain'
        else if (LITERAL_WORDS.has(lower)) type = 'keyword'
        else if (TYPES.has(lower)) type = 'type'
        else if (KEYWORDS.has(lower)) type = 'keyword'
        else if (isCall) type = 'function'
        objectName = type === 'keyword' && (OBJECT_INTRO.has(lower) || (lower === 'on' && indexStatement))
        if (lower === 'index') indexStatement = true
      }
      push(type, word)
      i = j
      continue
    }
    if (/[=<>!+\-*/%|&^~:.,;()]/.test(c)) {
      push('operator', c)
      if (c === ';') indexStatement = false
      if (c !== '.') objectName = false
      i += 1
      continue
    }
    push('plain', c)
    if (!/\s/.test(c)) objectName = false
    i += 1
  }
  return tokens
}

/** Tailwind text class per token type (uses the --c-syn-* tokens). */
export const SQL_TOKEN_CLASS: Record<SqlTokenType, string> = {
  keyword: 'text-syn-keyword',
  type: 'text-syn-type',
  function: 'text-syn-function',
  string: 'text-syn-string',
  number: 'text-syn-number',
  comment: 'text-syn-comment italic',
  operator: 'text-syn-operator',
  identifier: 'text-fg',
  plain: 'text-fg',
}
