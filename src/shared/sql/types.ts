export interface SqlStatement {
  /** Statement / batch text, trimmed, without the trailing ';' (pg) or GO line (mssql). */
  text: string
  /** Offset of the first character of `text` in the source. */
  start: number
  /** Offset just after the last character of `text` in the source. */
  end: number
  /** SQL Server `GO n`: number of times the batch must run (default 1). */
  repeat?: number
}

export interface StatementClassification {
  /** Upper-case leading command, e.g. "SELECT", "WITH", "UPDATE", "CREATE". */
  command: string
  /** True when the statement cannot modify data or schema (SELECT, SHOW, EXPLAIN w/o ANALYZE, read-only WITH…). */
  readOnly: boolean
  /** True for DROP, TRUNCATE, DELETE/UPDATE without WHERE, ALTER … DROP. */
  destructive: boolean
  /** Human readable reason when destructive, e.g. "DELETE without WHERE clause". */
  reason?: string
}

export interface FormatOptions {
  keywordCase: 'upper' | 'lower' | 'preserve'
  tabWidth: number
}
