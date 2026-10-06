// Single SQL lexer shared by the splitter, the classifier and the formatter.
// It never fails: unterminated strings / comments / quoted identifiers run to the end of input.

import type { Dialect } from '../types'

export type TokenKind =
  | 'whitespace'
  | 'line-comment'
  | 'block-comment'
  /** '…', E'…', N'…', $$…$$ / $tag$…$tag$ */
  | 'string'
  /** "…" (both dialects) and […] (mssql) */
  | 'quoted-ident'
  /** Identifiers, keywords and (mssql) @variables / #temp names. */
  | 'word'
  | 'number'
  /** PostgreSQL positional parameter $1. */
  | 'param'
  | 'punct'

export interface Token {
  kind: TokenKind
  start: number
  end: number
  /** Upper-cased text for 'word' tokens, empty otherwise. */
  upper: string
}

const CH_LF = 10
const CH_CR = 13
const CH_SPACE = 32
const CH_DQUOTE = 34
const CH_HASH = 35
const CH_DOLLAR = 36
const CH_QUOTE = 39
const CH_STAR = 42
const CH_MINUS = 45
const CH_DOT = 46
const CH_SLASH = 47
const CH_AT = 64
const CH_LBRACKET = 91
const CH_BACKSLASH = 92
const CH_RBRACKET = 93
const CH_UNDERSCORE = 95

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57
}

/**
 * Whitespace as SQL Server sees it (probed against SQL Server 2022): every ASCII control character, NEL
 * (U+0085), NBSP, U+1680, U+2000–U+200B, LINE / PARAGRAPH SEPARATOR (U+2028 / U+2029), U+202F, U+205F and
 * U+3000. PostgreSQL is stricter (space, \t, \n, \v, \f, \r) and rejects the others, so treating them all
 * as separators is safe for both: they must never be read as part of a word or number, otherwise
 * "SELECT 1<U+2028>DELETE FROM t" would hide the DELETE from the classifier.
 */
function isSpace(c: number): boolean {
  if (c >= 1 && c <= CH_SPACE) return true
  return c >= 0x80 && isUnicodeSpace(c)
}

function isUnicodeSpace(c: number): boolean {
  return c === 0x85 || c === 0x200b || /\s/.test(String.fromCharCode(c))
}

function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0x80 && !isUnicodeSpace(c))
}

/** End of a "--" comment: both servers stop at LF or CR (a lone CR ends the comment too). */
function lineCommentEnd(sql: string, from: number): number {
  const n = sql.length
  for (let j = from; j < n; j++) {
    const c = sql.charCodeAt(j)
    if (c === CH_LF || c === CH_CR) return j
  }
  return n
}

function isWordStart(c: number, dialect: Dialect): boolean {
  if (isLetter(c) || c === CH_UNDERSCORE) return true
  return dialect === 'mssql' && (c === CH_AT || c === CH_HASH)
}

function isWordPart(c: number, dialect: Dialect): boolean {
  if (isLetter(c) || isDigit(c) || c === CH_UNDERSCORE || c === CH_DOLLAR) return true
  return dialect === 'mssql' && (c === CH_AT || c === CH_HASH)
}

function isTagStart(c: number): boolean {
  return isLetter(c) || c === CH_UNDERSCORE
}

function isTagPart(c: number): boolean {
  return isLetter(c) || isDigit(c) || c === CH_UNDERSCORE
}

/** End of a '…' string starting at `i` (the opening quote). `backslash` enables E'…' escapes. */
function scanQuoted(sql: string, i: number, quote: number, backslash: boolean): number {
  const n = sql.length
  let j = i + 1
  while (j < n) {
    const c = sql.charCodeAt(j)
    if (backslash && c === CH_BACKSLASH) {
      j += 2
      continue
    }
    if (c === quote) {
      if (sql.charCodeAt(j + 1) === quote) {
        j += 2
        continue
      }
      return j + 1
    }
    j++
  }
  return n
}

function scanBracket(sql: string, i: number): number {
  const n = sql.length
  let j = i + 1
  while (j < n) {
    if (sql.charCodeAt(j) === CH_RBRACKET) {
      if (sql.charCodeAt(j + 1) === CH_RBRACKET) {
        j += 2
        continue
      }
      return j + 1
    }
    j++
  }
  return n
}

/** Nested block comment (both PostgreSQL and SQL Server nest them). */
function scanBlockComment(sql: string, i: number): number {
  const n = sql.length
  let depth = 1
  let j = i + 2
  while (j < n) {
    const c = sql.charCodeAt(j)
    if (c === CH_SLASH && sql.charCodeAt(j + 1) === CH_STAR) {
      depth++
      j += 2
    } else if (c === CH_STAR && sql.charCodeAt(j + 1) === CH_SLASH) {
      depth--
      j += 2
      if (depth === 0) return j
    } else {
      j++
    }
  }
  return n
}

/** Length of the `$tag$` opener at `i`, or 0 when `i` does not start a dollar quote. */
function dollarTagLength(sql: string, i: number): number {
  const n = sql.length
  let j = i + 1
  if (j < n && sql.charCodeAt(j) === CH_DOLLAR) return 2
  if (j >= n || !isTagStart(sql.charCodeAt(j))) return 0
  j++
  while (j < n && isTagPart(sql.charCodeAt(j))) j++
  return j < n && sql.charCodeAt(j) === CH_DOLLAR ? j + 1 - i : 0
}

function scanNumber(sql: string, i: number): number {
  const n = sql.length
  let j = i
  while (j < n && isDigit(sql.charCodeAt(j))) j++
  if (j < n && sql.charCodeAt(j) === CH_DOT && sql.charCodeAt(j + 1) !== CH_DOT) {
    j++
    while (j < n && isDigit(sql.charCodeAt(j))) j++
  }
  const e = sql.charCodeAt(j)
  if (e === 69 || e === 101) {
    let k = j + 1
    const sign = sql.charCodeAt(k)
    if (sign === 43 || sign === CH_MINUS) k++
    if (isDigit(sql.charCodeAt(k))) {
      j = k
      while (j < n && isDigit(sql.charCodeAt(j))) j++
    }
  }
  // Hex literals (0x1F), 1_000 and other trailing identifier characters stay in the number.
  while (j < n && (isLetter(sql.charCodeAt(j)) || isDigit(sql.charCodeAt(j)) || sql.charCodeAt(j) === CH_UNDERSCORE)) j++
  return j
}

export function tokenize(sql: string, dialect: Dialect): Token[] {
  const tokens: Token[] = []
  const n = sql.length
  let i = 0
  const push = (kind: TokenKind, end: number): void => {
    tokens.push({ kind, start: i, end, upper: kind === 'word' ? sql.slice(i, end).toUpperCase() : '' })
    i = end
  }

  while (i < n) {
    const c = sql.charCodeAt(i)
    const next = i + 1 < n ? sql.charCodeAt(i + 1) : -1

    if (isSpace(c)) {
      let j = i + 1
      while (j < n && isSpace(sql.charCodeAt(j))) j++
      push('whitespace', j)
    } else if (c === CH_MINUS && next === CH_MINUS) {
      push('line-comment', lineCommentEnd(sql, i + 2))
    } else if (c === CH_SLASH && next === CH_STAR) {
      push('block-comment', scanBlockComment(sql, i))
    } else if (c === CH_QUOTE) {
      push('string', scanQuoted(sql, i, CH_QUOTE, false))
    } else if (c === CH_DQUOTE) {
      push('quoted-ident', scanQuoted(sql, i, CH_DQUOTE, false))
    } else if (c === CH_LBRACKET && dialect === 'mssql') {
      push('quoted-ident', scanBracket(sql, i))
    } else if ((c === 69 || c === 101) && next === CH_QUOTE && dialect === 'postgres') {
      push('string', scanQuoted(sql, i + 1, CH_QUOTE, true))
    } else if ((c === 78 || c === 110) && next === CH_QUOTE) {
      push('string', scanQuoted(sql, i + 1, CH_QUOTE, false))
    } else if (c === CH_DOLLAR && dialect === 'postgres') {
      if (isDigit(next)) {
        let j = i + 1
        while (j < n && isDigit(sql.charCodeAt(j))) j++
        push('param', j)
      } else {
        const tagLen = dollarTagLength(sql, i)
        if (tagLen === 0) {
          push('punct', i + 1)
        } else {
          const close = sql.indexOf(sql.slice(i, i + tagLen), i + tagLen)
          push('string', close === -1 ? n : close + tagLen)
        }
      }
    } else if (isWordStart(c, dialect)) {
      let j = i + 1
      while (j < n && isWordPart(sql.charCodeAt(j), dialect)) j++
      push('word', j)
    } else if (isDigit(c) || (c === CH_DOT && isDigit(next))) {
      push('number', scanNumber(sql, c === CH_DOT ? i + 1 : i))
    } else {
      // Surrogate pairs (emoji…) are letters for isLetter, so a lone punct is always one UTF-16 unit.
      push('punct', i + 1)
    }
  }
  return tokens
}

/** Not whitespace and not a comment. */
export function isSignificant(token: Token): boolean {
  return token.kind !== 'whitespace' && token.kind !== 'line-comment' && token.kind !== 'block-comment'
}

export function isPunct(sql: string, token: Token, ch: string): boolean {
  return token.kind === 'punct' && sql.charCodeAt(token.start) === ch.charCodeAt(0)
}
