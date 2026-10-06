// Streaming row formatters for query exports (CSV/TSV/JSON/SQL INSERTs). Field semantics come from
// @shared/export-format, the same module the renderer's "Save rows as…" uses.
import { cellText, csvField as csvText, isJsonType, jsonObject, tsvField as tsvText, uniqueColumnNames } from '@shared/export-format'
import { columnLiteral, qualifiedName, quoteIdent } from '@shared/sql'
import type { CellValue, ColumnMeta, Dialect, ExportFormat } from '@shared/types'

export type FileExportFormat = Exclude<ExportFormat, 'markdown'>

export const EXPORT_FORMATS: FileExportFormat[] = ['csv', 'tsv', 'json', 'sql']

export const EXPORT_FILTERS: Record<FileExportFormat, { name: string; extensions: string[] }> = {
  csv: { name: 'CSV', extensions: ['csv'] },
  tsv: { name: 'TSV', extensions: ['tsv', 'txt'] },
  json: { name: 'JSON', extensions: ['json'] },
  sql: { name: 'SQL', extensions: ['sql'] },
}

export interface RowFormatter {
  begin(): string
  rows(rows: CellValue[][]): string
  end(): string
}

export interface FormatterOptions {
  dialect: Dialect
  /** Target of INSERT statements ("table" or "schema.table"). */
  tableName?: string
}

/** RFC 4180 field: quoted when it contains a quote, comma, CR/LF or leading/trailing spaces. */
export function csvField(value: CellValue): string {
  return csvText(cellText(value))
}

/** TSV field, spreadsheet style (quoted only when it holds a tab, a line break or a leading quote). */
export function tsvField(value: CellValue): string {
  return tsvText(cellText(value))
}

/** Unique object keys for JSON export ("id", "id_2", …). */
export function uniqueNames(columns: ColumnMeta[]): string[] {
  return uniqueColumnNames(columns)
}

export function insertTarget(tableName: string | undefined, dialect: Dialect): string {
  const raw = tableName?.trim() || 'exported_table'
  if (/["[\]`]/.test(raw)) return raw
  const parts = raw.split('.').filter((p) => p !== '')
  if (parts.length === 2) return qualifiedName(parts[0], parts[1], dialect)
  return parts.map((p) => quoteIdent(p, dialect)).join('.')
}

export function createFormatter(format: FileExportFormat, columns: ColumnMeta[], options: FormatterOptions): RowFormatter {
  switch (format) {
    case 'csv':
      return {
        begin: () => columns.map((c) => csvField(c.name)).join(',') + '\r\n',
        rows: (rows) => rows.map((r) => r.map(csvField).join(',') + '\r\n').join(''),
        end: () => '',
      }
    case 'tsv':
      return {
        begin: () => columns.map((c) => tsvField(c.name)).join('\t') + '\n',
        rows: (rows) => rows.map((r) => r.map(tsvField).join('\t') + '\n').join(''),
        end: () => '',
      }
    case 'json': {
      // json / jsonb columns are embedded as JSON; rows are serialized by hand (a "__proto__" column is kept).
      const names = uniqueNames(columns)
      const embed = columns.map((c) => isJsonType(c.dataType))
      let first = true
      return {
        begin: () => '[',
        rows: (rows) =>
          rows
            .map((r) => {
              const prefix = first ? '\n  ' : ',\n  '
              first = false
              return prefix + jsonObject(names, embed, r)
            })
            .join(''),
        end: () => (first ? ']\n' : '\n]\n'),
      }
    }
    case 'sql': {
      // Column-aware literals: SQL Server binary as 0x…, bytea as '\x…'::bytea, numeric text unquoted.
      const target = insertTarget(options.tableName, options.dialect)
      const cols = columns.map((c) => quoteIdent(c.name, options.dialect)).join(', ')
      const literal = (v: CellValue, i: number) => columnLiteral(v, columns[i]?.dataType ?? '', options.dialect)
      return {
        begin: () => '',
        rows: (rows) =>
          rows.map((r) => `INSERT INTO ${target} (${cols}) VALUES (${columns.map((_, i) => literal(r[i] ?? null, i)).join(', ')});\n`).join(''),
        end: () => '',
      }
    }
  }
}
