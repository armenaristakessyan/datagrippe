// SQL text produced by explorer actions (drop scripts, names to copy / drag). Pure functions.
import type { Dialect, DbObjectInfo, ObjectKind } from '@shared/types'
import { qualifiedName, quoteIdent } from '@shared/sql'

const DROP_KEYWORD: Record<ObjectKind, string> = {
  table: 'TABLE',
  view: 'VIEW',
  'materialized-view': 'MATERIALIZED VIEW',
  'foreign-table': 'FOREIGN TABLE',
  function: 'FUNCTION',
  procedure: 'PROCEDURE',
  sequence: 'SEQUENCE',
  type: 'TYPE',
}

export const KIND_LABEL: Record<ObjectKind, string> = {
  table: 'table',
  view: 'view',
  'materialized-view': 'materialized view',
  'foreign-table': 'foreign table',
  function: 'function',
  procedure: 'procedure',
  sequence: 'sequence',
  type: 'type',
}

const isRoutine = (kind: ObjectKind) => kind === 'function' || kind === 'procedure'

/** schema.name, quoted as needed (PostgreSQL routines include their identity arguments). */
export function objectQualifiedName(object: Pick<DbObjectInfo, 'schema' | 'name' | 'kind' | 'signature'>, dialect: Dialect, withSignature = false): string {
  const name = qualifiedName(object.schema, object.name, dialect)
  if (withSignature && dialect === 'postgres' && isRoutine(object.kind) && object.signature) return `${name}${object.signature}`
  return name
}

/** A DROP script to review in a console — never executed directly. */
export function generateDrop(object: Pick<DbObjectInfo, 'schema' | 'name' | 'kind' | 'signature'>, dialect: Dialect): string {
  const target = objectQualifiedName(object, dialect, true)
  return `-- Review before running: this permanently drops the ${KIND_LABEL[object.kind]}.\nDROP ${DROP_KEYWORD[object.kind]} ${target};\n`
}

/** Text dropped into the editor when dragging a column row. */
export function columnDragText(column: string, dialect: Dialect): string {
  return quoteIdent(column, dialect)
}
