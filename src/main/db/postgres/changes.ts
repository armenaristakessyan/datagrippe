// SQL for grid edits: parameterized ($n) for execution, with an inlined-literal twin for display.
import { qualifiedName, quoteIdent, sqlLiteral } from '@shared/sql'
import type { CellValue, EditValue, RowChange } from '@shared/types'
import { DriverError } from '../errors'

export interface BuiltChange {
  type: RowChange['type']
  text: string
  values: CellValue[]
  /** Same statement with literals inlined and a trailing ';' (display only, never executed). */
  display: string
  /** "id = 42, line_no = 1" — used in error messages. */
  keyLabel?: string
}

const isDefault = (value: EditValue): value is { $default: true } =>
  typeof value === 'object' && value !== null && '$default' in value && value.$default === true

/** Builds both renderings at once so they can never diverge. */
class Emitter {
  readonly values: CellValue[] = []
  private textParts: string[] = []
  private displayParts: string[] = []

  sql(fragment: string): this {
    this.textParts.push(fragment)
    this.displayParts.push(fragment)
    return this
  }

  value(value: CellValue): this {
    this.values.push(value)
    this.textParts.push(`$${this.values.length}`)
    this.displayParts.push(sqlLiteral(value, 'postgres'))
    return this
  }

  get text(): string {
    return this.textParts.join('')
  }

  get display(): string {
    return `${this.displayParts.join('')};`
  }
}

function keyLabel(key: Record<string, CellValue>): string {
  return Object.entries(key)
    .map(([column, value]) => `${column} = ${sqlLiteral(value, 'postgres')}`)
    .join(', ')
}

function emitWhere(out: Emitter, key: Record<string, CellValue>): void {
  const entries = Object.entries(key)
  if (entries.length === 0) throw DriverError.of('invalid-input', 'A row key is required to update or delete a row')
  out.sql(' WHERE ')
  entries.forEach(([column, value], i) => {
    if (i > 0) out.sql(' AND ')
    out.sql(quoteIdent(column, 'postgres'))
    if (value === null) out.sql(' IS NULL')
    else out.sql(' = ').value(value)
  })
}

/** Returns null for a change that has nothing to do (an update without values). */
export function buildChange(schema: string, table: string, change: RowChange): BuiltChange | null {
  const target = qualifiedName(schema, table, 'postgres')
  const out = new Emitter()
  switch (change.type) {
    case 'update': {
      const entries = Object.entries(change.values)
      if (entries.length === 0) return null
      out.sql(`UPDATE ${target} SET `)
      entries.forEach(([column, value], i) => {
        if (i > 0) out.sql(', ')
        out.sql(`${quoteIdent(column, 'postgres')} = `).value(value)
      })
      emitWhere(out, change.key)
      return { type: 'update', text: out.text, values: out.values, display: out.display, keyLabel: keyLabel(change.key) }
    }
    case 'delete': {
      out.sql(`DELETE FROM ${target}`)
      emitWhere(out, change.key)
      return { type: 'delete', text: out.text, values: out.values, display: out.display, keyLabel: keyLabel(change.key) }
    }
    case 'insert': {
      const entries = Object.entries(change.values).filter(
        (entry): entry is [string, CellValue] => !isDefault(entry[1]),
      )
      if (entries.length === 0) {
        out.sql(`INSERT INTO ${target} DEFAULT VALUES`)
      } else {
        out.sql(`INSERT INTO ${target} (${entries.map(([column]) => quoteIdent(column, 'postgres')).join(', ')}) VALUES (`)
        entries.forEach(([, value], i) => {
          if (i > 0) out.sql(', ')
          out.value(value)
        })
        out.sql(')')
      }
      return { type: 'insert', text: out.text, values: out.values, display: out.display }
    }
  }
}

/** Every column referenced by the changes, to validate against the catalog. */
export function referencedColumns(changes: readonly RowChange[]): Set<string> {
  const columns = new Set<string>()
  for (const change of changes) {
    if (change.type !== 'insert') for (const c of Object.keys(change.key)) columns.add(c)
    if (change.type !== 'delete') for (const c of Object.keys(change.values)) columns.add(c)
  }
  return columns
}
