// SQL text utilities shared by main (execution) and renderer (editor). No Node APIs here.
// Everything is built on one lexer (./lexer) so splitting, classification and formatting agree on
// where strings, comments, quoted identifiers and dollar-quoted bodies start and end.

export type { FormatOptions, SqlStatement, StatementClassification } from './types'

/**
 * Split a script into the units the server executes.
 * - postgres: one unit per statement, separated by ';' outside strings, quoted identifiers,
 *   dollar-quoted bodies ($$ / $tag$), E'' strings, line comments, nested block comments and
 *   SQL-standard function bodies (BEGIN ATOMIC … END).
 * - mssql: one unit per batch, separated by a line containing only `GO` (optionally `GO <count>`,
 *   case-insensitive, may be followed by a comment), ignoring GO inside strings/comments/[brackets].
 * Empty / comment-only units are dropped. `text` spans from the first to the last significant token
 * (leading and trailing comments excluded), so `text === sql.slice(start, end)`.
 *
 * splitStatementsFine — statement-level split (finer than batches on mssql): the units
 * statementAtOffset chooses from.
 * - postgres: identical to splitStatements.
 * - mssql: boundaries are GO lines, ';' at nesting depth 0 (BEGIN…END, CASE…END, parentheses)
 *   and blank lines at depth 0.
 *
 * statementAtOffset — the statement under the caret, used by "Run statement" (Cmd/Ctrl+Enter).
 * Caret inside a statement → it; caret in whitespace right after a statement on the same line
 * (e.g. after "SELECT 1;") → that statement; otherwise the next statement on the same line, then
 * the adjacent statement when no blank line separates it from the caret. Null when the caret is not
 * in or next to any statement.
 */
export { splitStatements, splitStatementsFine, statementAtOffset } from './split'

/** Classify one statement (comments ignored). For mssql batches / multi-statement input, the most dangerous statement wins. */
export { classifyStatement } from './classify'

/**
 * quoteIdent — quote an identifier only when needed ("Foo", "order", [My Table]).
 * qualifiedName — schema.name, each part quoted when needed.
 * sqlLiteral — render a cell value as a SQL literal (NULL, numbers, booleans, N'…' strings on mssql, escaped quotes).
 */
export { qualifiedName, quoteIdent, sqlLiteral } from './quote'

/** columnLiteral — sqlLiteral using the column type (0x… binary on mssql, '\\x…'::bytea on pg, numeric text unquoted). */
export { columnLiteral, literalKind } from './literal'

/** Pretty-print SQL with sql-formatter (postgresql / transactsql). Returns input unchanged on parse failure. */
export { formatSql } from './format'

/** Script templates used by explorer context menus. */
export { generateDelete, generateInsert, generateSelect, generateUpdate } from './templates'
