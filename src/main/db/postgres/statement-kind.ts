// PostgreSQL-specific statement inspection on significant tokens (strings, comments and quoted
// identifiers never match), built on the shared lexer.
import { isPunct, isSignificant, tokenize, type Token } from '@shared/sql/lexer'

interface Words {
  sql: string
  tokens: Token[]
}

function significant(sql: string): Words {
  return { sql, tokens: tokenize(sql, 'postgres').filter(isSignificant) }
}

const word = (token: Token | undefined): string => (token?.kind === 'word' ? token.upper : '')

/** Significant tokens outside any parentheses (depth 0), in order. */
function topLevel({ sql, tokens }: Words): Token[] {
  const out: Token[] = []
  let depth = 0
  for (const token of tokens) {
    if (isPunct(sql, token, '(')) depth++
    else if (isPunct(sql, token, ')')) depth = Math.max(0, depth - 1)
    else if (depth === 0) out.push(token)
  }
  return out
}

/** COPY … FROM STDIN / COPY … TO STDOUT: the console has no client-side stream to offer. */
export function isCopyStdio(text: string): boolean {
  const tokens = topLevel(significant(text))
  if (word(tokens[0]) !== 'COPY') return false
  for (let i = 1; i < tokens.length - 1; i++) {
    const keyword = word(tokens[i])
    const target = word(tokens[i + 1])
    if ((keyword === 'FROM' && target === 'STDIN') || (keyword === 'TO' && target === 'STDOUT')) return true
  }
  return false
}

/**
 * Commands PostgreSQL refuses inside a transaction block ("… cannot run inside a transaction block").
 * Returns a short label for messages ("VACUUM", "CREATE INDEX CONCURRENTLY", …) or null.
 * CALL is deliberately absent: a procedure without COMMIT is valid inside the user's transaction.
 */
export function noTransactionBlockCommand(text: string): string | null {
  const words = significant(text)
  const tokens = topLevel(words)
  const w = tokens.map(word)
  const has = (keyword: string, from = 0) => w.indexOf(keyword, from) !== -1
  switch (w[0]) {
    case 'VACUUM':
      return 'VACUUM'
    case 'CREATE':
    case 'DROP': {
      const verb = w[0]
      if (w[1] === 'DATABASE') return `${verb} DATABASE`
      if (w[1] === 'TABLESPACE') return `${verb} TABLESPACE`
      if (w[1] === 'SUBSCRIPTION') return `${verb} SUBSCRIPTION`
      // CREATE [UNIQUE] INDEX CONCURRENTLY … / DROP INDEX CONCURRENTLY …
      const index = w[1] === 'UNIQUE' ? 2 : 1
      if (w[index] === 'INDEX' && w[index + 1] === 'CONCURRENTLY') return `${verb} INDEX CONCURRENTLY`
      return null
    }
    case 'REINDEX': {
      // REINDEX [(options)] {INDEX | TABLE | SCHEMA | DATABASE | SYSTEM} [CONCURRENTLY] name
      if (has('CONCURRENTLY')) return 'REINDEX CONCURRENTLY'
      if (w[1] === 'DATABASE' || w[1] === 'SYSTEM') return `REINDEX ${w[1]}`
      return null
    }
    case 'ALTER':
      if (w[1] === 'SYSTEM') return 'ALTER SYSTEM'
      if (w[1] === 'DATABASE' && w[3] === 'SET' && w[4] === 'TABLESPACE') return 'ALTER DATABASE … SET TABLESPACE'
      if (w[1] === 'TABLE') {
        const detach = w.indexOf('DETACH')
        if (detach !== -1 && w[detach + 1] === 'PARTITION' && has('CONCURRENTLY', detach)) return 'DETACH PARTITION CONCURRENTLY'
      }
      if (w[1] === 'SUBSCRIPTION' && has('REFRESH', 2)) return 'ALTER SUBSCRIPTION … REFRESH PUBLICATION'
      return null
    case 'DISCARD':
      return w[1] === 'ALL' ? 'DISCARD ALL' : null
    case 'CLUSTER':
      // Without a table, CLUSTER re-clusters every table and runs one transaction per table.
      return w.length === 1 || (w.length === 2 && w[1] === 'VERBOSE') ? 'CLUSTER' : null
    default:
      return null
  }
}
