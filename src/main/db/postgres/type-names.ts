// Resolves result-column type OIDs to display names ('int4', 'varchar', '_int4' → 'int4[]'), and
// source-table OIDs to relation names (ColumnMeta.table).
import type { FieldDef } from 'pg'
import type { ColumnMeta } from '@shared/types'
import { num, select, str, type Queryable } from './rows'

// Only true array types are renamed: int2vector / oidvector also have category 'A' and a typelem, but they
// are not their element's array type (and print as '1 2', not '{1,2}').
const NAME_EXPR = `CASE WHEN e.oid IS NOT NULL AND e.typarray = t.oid THEN e.typname || '[]' ELSE t.typname END`

const LOOKUP_SQL = `SELECT t.oid::int8::text AS oid, ${NAME_EXPR} AS name
FROM pg_catalog.pg_type t LEFT JOIN pg_catalog.pg_type e ON e.oid = t.typelem
WHERE t.oid = ANY($1::oid[])`

const BUILTIN_SQL = `SELECT t.oid::int8::text AS oid, ${NAME_EXPR} AS name
FROM pg_catalog.pg_type t LEFT JOIN pg_catalog.pg_type e ON e.oid = t.typelem
WHERE t.typnamespace = 'pg_catalog'::regnamespace`

const RELATION_SQL = `SELECT c.oid::int8::text AS oid, c.relname AS name FROM pg_catalog.pg_class c WHERE c.oid = ANY($1::oid[])`

export class TypeNameCache {
  private readonly names = new Map<number, string>()
  private readonly relations = new Map<number, string>()

  name(oid: number): string {
    return this.names.get(oid) ?? String(oid)
  }

  missing(fields: readonly FieldDef[]): number[] {
    const out = new Set<number>()
    for (const f of fields) if (!this.names.has(f.dataTypeID)) out.add(f.dataTypeID)
    return [...out]
  }

  /** Source-table OIDs of the fields whose relation name is not cached yet. */
  missingRelations(fields: readonly FieldDef[]): number[] {
    const out = new Set<number>()
    for (const f of fields) if (f.tableID && !this.relations.has(f.tableID)) out.add(f.tableID)
    return [...out]
  }

  /** Resolve source-table names; failures are ignored (ColumnMeta.table stays unset). */
  async resolveRelations(q: Queryable, oids: number[]): Promise<void> {
    if (oids.length === 0) return
    try {
      for (const row of await select(q, RELATION_SQL, [oids])) this.relations.set(num(row, 'oid'), str(row, 'name'))
    } catch {
      // Display only.
    }
  }

  /** Preload every pg_catalog type (a few hundred rows) so most results need no lookup. */
  async preload(q: Queryable): Promise<void> {
    this.add(await select(q, BUILTIN_SQL))
  }

  /** Resolve unknown OIDs; failures are ignored (the OID is shown instead). */
  async resolve(q: Queryable, oids: number[]): Promise<void> {
    if (oids.length === 0) return
    try {
      this.add(await select(q, LOOKUP_SQL, [oids]))
    } catch {
      // Display only — never fail a query because a type name could not be resolved.
    }
  }

  columns(fields: readonly FieldDef[]): ColumnMeta[] {
    return fields.map((f) => {
      const table = f.tableID ? this.relations.get(f.tableID) : undefined
      return table ? { name: f.name, dataType: this.name(f.dataTypeID), table } : { name: f.name, dataType: this.name(f.dataTypeID) }
    })
  }

  private add(rows: Record<string, unknown>[]): void {
    for (const row of rows) this.names.set(num(row, 'oid'), str(row, 'name'))
  }
}
