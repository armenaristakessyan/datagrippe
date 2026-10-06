// WHERE predicates built from cell values: "Filter by this value" in the table editor and the
// foreign-key navigation ("Open referenced row", "Rows referencing this"). Pure helpers.
import { quoteIdent } from '@shared/sql'
import type { CellValue, ColumnMeta, Dialect, ForeignKeyInfo } from '@shared/types'
import { columnLiteral } from '@/lib/export-format'

export interface ColumnValue {
  column: string
  dataType: string
  value: CellValue
}

/** `col = value` / `col <> value`, `col IS [NOT] NULL` for NULL. */
export function valuePredicate({ column, dataType, value }: ColumnValue, exclude: boolean, dialect: Dialect): string {
  const ident = quoteIdent(column, dialect)
  if (value === null) return `${ident} IS ${exclude ? 'NOT ' : ''}NULL`
  return `${ident} ${exclude ? '<>' : '='} ${columnLiteral(value, dataType, dialect)}`
}

/** Every column equal to its value (`a = 1 AND b = 'x'`). */
export function equalityPredicate(values: readonly ColumnValue[], dialect: Dialect): string {
  return values.map((v) => valuePredicate(v, false, dialect)).join(' AND ')
}

/** Add a predicate to the current filter (AND), keeping the user's text intact. */
export function combineWhere(current: string, predicate: string): string {
  const where = current.trim()
  if (!where) return predicate
  if (where === predicate) return where
  return `(${where}) AND ${predicate}`
}

export interface RowLink {
  /** Menu label, e.g. "Open referenced row in customers". */
  label: string
  schema: string
  table: string
  /** Filter that selects the linked rows in the target table. */
  where: string
  /** The foreign key (name) behind the link. */
  constraint: string
}

function valuesOf(columns: readonly ColumnMeta[], row: readonly CellValue[], names: readonly string[]): ColumnValue[] | null {
  const out: ColumnValue[] = []
  for (const name of names) {
    const index = columns.findIndex((c) => c.name === name)
    if (index < 0) return null
    out.push({ column: name, dataType: columns[index]!.dataType, value: row[index] ?? null })
  }
  return out
}

function target(schema: string, table: string, currentSchema: string): string {
  return schema === currentSchema ? table : `${schema}.${table}`
}

/**
 * Rows this row points to through its foreign keys, for the FKs that involve `column` (all of them
 * when undefined). A key with a NULL part references nothing.
 */
export function referencedRows(
  foreignKeys: readonly ForeignKeyInfo[],
  columns: readonly ColumnMeta[],
  row: readonly CellValue[],
  column: string | undefined,
  currentSchema: string,
  dialect: Dialect,
): RowLink[] {
  const links: RowLink[] = []
  for (const fk of foreignKeys) {
    if (column !== undefined && !fk.columns.includes(column)) continue
    const values = valuesOf(columns, row, fk.columns)
    if (!values || values.some((v) => v.value === null)) continue
    const where = equalityPredicate(
      values.map((v, i) => ({ ...v, column: fk.refColumns[i] ?? v.column })),
      dialect,
    )
    links.push({
      label: `Open referenced row in ${target(fk.refSchema, fk.refTable, currentSchema)}`,
      schema: fk.refSchema,
      table: fk.refTable,
      where,
      constraint: fk.name,
    })
  }
  return links
}

/** Rows of other tables whose foreign keys point at this row. */
export function referencingRows(
  referencedBy: readonly ForeignKeyInfo[],
  columns: readonly ColumnMeta[],
  row: readonly CellValue[],
  currentSchema: string,
  dialect: Dialect,
): RowLink[] {
  const links: RowLink[] = []
  for (const fk of referencedBy) {
    const values = valuesOf(columns, row, fk.refColumns)
    if (!values || values.some((v) => v.value === null)) continue
    const where = equalityPredicate(
      values.map((v, i) => ({ ...v, column: fk.columns[i] ?? v.column })),
      dialect,
    )
    links.push({
      label: `Rows in ${target(fk.schema, fk.table, currentSchema)} referencing this (${fk.columns.join(', ')})`,
      schema: fk.schema,
      table: fk.table,
      where,
      constraint: fk.name,
    })
  }
  return links
}

/** Header tooltip line of each column that is part of a foreign key: "→ sales.customers (id)". */
export function foreignKeyLabels(foreignKeys: readonly ForeignKeyInfo[], columns: readonly ColumnMeta[], currentSchema: string): Map<number, string> {
  const out = new Map<number, string>()
  for (const fk of foreignKeys) {
    fk.columns.forEach((name, i) => {
      const index = columns.findIndex((c) => c.name === name)
      if (index < 0) return
      const line = `→ ${target(fk.refSchema, fk.refTable, currentSchema)} (${fk.refColumns[i] ?? '?'})`
      out.set(index, out.has(index) ? `${out.get(index)}\n${line}` : line)
    })
  }
  return out
}
