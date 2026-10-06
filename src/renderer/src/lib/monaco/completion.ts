// Autocompletion and hover logic, independent of Monaco (see providers.ts for the adapter).
import type { CompletionCatalog, CompletionObject, CompletionSchema, Dialect, ObjectKind } from '@shared/types'
import { qualifiedName, quoteIdent } from '@shared/sql'
import { BUILTIN_FUNCTIONS } from './functions'
import { VOCABULARY } from './keywords'
import { snippetPreview, type UserSnippet } from './snippets'
import {
  analyzeCaret,
  isName,
  isPunctTok,
  nameValue,
  RELATION_INTRO,
  relationLabel,
  visibleRelations,
  type CaretAnalysis,
  type RelationRef,
  type Tok,
} from './sql-context'

export interface CompletionEnv {
  dialect: Dialect
  catalog?: CompletionCatalog
  /** Schema used for unqualified names: the console's schema, else the catalog default. */
  defaultSchema?: string
  /**
   * Schema whose objects rank first without becoming the default (SQL Server: the console's schema
   * picker does not change name resolution, so these objects are still inserted qualified).
   */
  preferredSchema?: string
  /** User snippets, offered when their abbreviation is typed. */
  snippets?: UserSnippet[]
}

export type SqlCompletionKind =
  | 'column'
  | 'table'
  | 'view'
  | 'cte'
  | 'alias'
  | 'schema'
  | 'function'
  | 'routine'
  | 'keyword'
  | 'type'
  | 'snippet'

export interface SqlCompletionItem {
  label: string
  kind: SqlCompletionKind
  /** Right-aligned detail (data type, signature, object kind). */
  detail?: string
  /** Dim text next to the label (relation of a column, schema of an object). */
  description?: string
  /** Markdown for the details pane. */
  documentation?: string
  insertText: string
  /** insertText is a snippet ($0 placeholders). */
  snippet?: boolean
  sortText: string
  filterText?: string
  /** Re-open the suggest widget after inserting (e.g. a schema followed by '.'). */
  retrigger?: boolean
  /** Identifier parts the item inserts (raw names), used to re-quote it when the user typed a quote. */
  ident?: string[]
  /** Text inserted after the identifier ('.' for a schema, '($0)' for a routine snippet). */
  identSuffix?: string
}

export interface CompletionResult {
  items: SqlCompletionItem[]
  /** Replace range (absolute offsets): the word being typed. */
  from: number
  to: number
  analysis: CaretAnalysis
}

const RELATION_KINDS: ReadonlySet<ObjectKind> = new Set(['table', 'view', 'materialized-view', 'foreign-table'])
const ROUTINE_KINDS: ReadonlySet<ObjectKind> = new Set(['function', 'procedure'])

const OBJECT_KIND_LABEL: Record<ObjectKind, string> = {
  table: 'table',
  view: 'view',
  'materialized-view': 'materialized view',
  'foreign-table': 'foreign table',
  function: 'function',
  procedure: 'procedure',
  sequence: 'sequence',
  type: 'type',
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

// ---------------------------------------------------------------------------
// Catalog lookups
// ---------------------------------------------------------------------------

export function findSchema(catalog: CompletionCatalog | undefined, name: string): CompletionSchema | undefined {
  if (!catalog) return undefined
  return catalog.schemas.find((s) => s.name === name) ?? catalog.schemas.find((s) => eq(s.name, name))
}

function schemaSearchOrder(catalog: CompletionCatalog, env: CompletionEnv): CompletionSchema[] {
  const preferred = [env.defaultSchema, catalog.defaultSchema, env.dialect === 'postgres' ? 'public' : 'dbo']
  const first: CompletionSchema[] = []
  for (const name of preferred) {
    const s = name ? findSchema(catalog, name) : undefined
    if (s && !first.includes(s)) first.push(s)
  }
  return [...first, ...catalog.schemas.filter((s) => !first.includes(s))]
}

function findObjectIn(schema: CompletionSchema, name: string, kinds: ReadonlySet<ObjectKind>): CompletionObject | undefined {
  const candidates = schema.objects.filter((o) => kinds.has(o.kind))
  return candidates.find((o) => o.name === name) ?? candidates.find((o) => eq(o.name, name))
}

export interface ResolvedObject {
  schema: string
  object: CompletionObject
}

/** Find a relation by optional schema + name, searching the default schema first. */
export function findRelation(env: CompletionEnv, schema: string | undefined, name: string): ResolvedObject | undefined {
  const { catalog } = env
  if (!catalog) return undefined
  const schemas = schema ? [findSchema(catalog, schema)].filter((s): s is CompletionSchema => !!s) : schemaSearchOrder(catalog, env)
  for (const s of schemas) {
    const object = findObjectIn(s, name, RELATION_KINDS)
    if (object) return { schema: s.name, object }
  }
  return undefined
}

export interface ColumnLike {
  name: string
  dataType: string
}

/** Columns of a relation reference (statement-defined columns for CTEs / derived tables). */
export function relationColumns(env: CompletionEnv, ref: RelationRef): { columns: ColumnLike[]; resolved?: ResolvedObject } {
  if (ref.kind === 'cte' || ref.kind === 'derived') {
    return { columns: (ref.columns ?? []).map((name) => ({ name, dataType: '' })) }
  }
  const resolved = ref.kind === 'table' ? findRelation(env, ref.schema, ref.name) : undefined
  const catalogColumns = resolved?.object.columns ?? []
  if (ref.columns && ref.columns.length > 0) {
    // `t AS x(a, b)` renames the leading columns
    return {
      resolved,
      columns: ref.columns.map((name, i) => ({ name, dataType: catalogColumns[i]?.dataType ?? '' })),
    }
  }
  return { columns: catalogColumns, resolved }
}

type QualifierTarget =
  | { kind: 'relation'; ref: RelationRef; label: string }
  | { kind: 'schema'; schema: CompletionSchema }
  | { kind: 'unknown' }

function syntheticRef(name: string, schema: string | undefined): RelationRef {
  return { kind: 'table', name, schema, start: 0, end: 0, scopeStart: 0, scopeEnd: 0 }
}

/** What `a.` / `s.t.` refers to at `offset`: an alias / table of the statement, a schema, or a catalog table. */
export function resolveQualifier(env: CompletionEnv, analysis: CaretAnalysis, parts: string[], offset: number): QualifierTarget {
  const visible = visibleRelations(analysis.scope, offset)
  if (parts.length === 1) {
    const q = parts[0]!
    const byAlias = visible.find((r) => r.alias !== undefined && eq(r.alias, q)) ?? visible.find((r) => r.alias === undefined && eq(r.name, q))
    if (byAlias) return { kind: 'relation', ref: byAlias, label: relationLabel(byAlias) }
    const cte = analysis.scope.ctes.find((c) => eq(c.name, q))
    if (cte) return { kind: 'relation', ref: cte, label: cte.name }
    const schema = findSchema(env.catalog, q)
    if (schema) return { kind: 'schema', schema }
    const table = findRelation(env, undefined, q)
    if (table) return { kind: 'relation', ref: syntheticRef(table.object.name, table.schema), label: table.object.name }
    return { kind: 'unknown' }
  }
  // schema.table (or database.schema.table on SQL Server)
  const name = parts[parts.length - 1]!
  const schemaName = parts[parts.length - 2]!
  const table = findRelation(env, schemaName, name)
  if (table) {
    const inScope = visible.find((r) => r.alias === undefined && r.schema !== undefined && eq(r.schema, schemaName) && eq(r.name, name))
    return { kind: 'relation', ref: inScope ?? syntheticRef(table.object.name, table.schema), label: name }
  }
  // database.schema on SQL Server
  const schema = findSchema(env.catalog, name)
  if (schema && env.dialect === 'mssql') return { kind: 'schema', schema }
  return { kind: 'unknown' }
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

type CaseStyle = 'upper' | 'lower'

/** Keywords follow the case the user started typing (upper when nothing is typed yet). */
export function keywordCase(prefix: string, fallback: CaseStyle = 'upper'): CaseStyle {
  const letters = prefix.replace(/[^A-Za-z]/g, '')
  if (!letters) return fallback
  if (letters === letters.toLowerCase()) return 'lower'
  if (letters === letters.toUpperCase()) return 'upper'
  return fallback
}

const applyCase = (word: string, style: CaseStyle) => (style === 'upper' ? word.toUpperCase() : word.toLowerCase())

const pad = (n: number) => String(n).padStart(4, '0')

function escapeSnippet(text: string): string {
  return text.replace(/[\\$}]/g, (m) => `\\${m}`)
}

function columnsDoc(columns: ColumnLike[], limit = 40): string {
  if (columns.length === 0) return ''
  const lines = columns.slice(0, limit).map((c) => (c.dataType ? `\`${c.name}\` ${c.dataType}` : `\`${c.name}\``))
  if (columns.length > limit) lines.push(`… ${columns.length - limit} more`)
  return lines.join('  \n')
}

function relationDoc(title: string, kind: string, columns: ColumnLike[]): string {
  const head = `**${title}** · ${kind}${columns.length ? ` · ${columns.length} column${columns.length === 1 ? '' : 's'}` : ''}`
  const body = columnsDoc(columns)
  return body ? `${head}\n\n${body}` : head
}

function objectItemKind(kind: ObjectKind): SqlCompletionKind {
  if (kind === 'table' || kind === 'foreign-table') return 'table'
  if (RELATION_KINDS.has(kind)) return 'view'
  return 'routine'
}

interface Builder {
  items: SqlCompletionItem[]
  seen: Set<string>
  add: (item: SqlCompletionItem) => void
}

function builder(): Builder {
  const items: SqlCompletionItem[] = []
  const seen = new Set<string>()
  return {
    items,
    seen,
    add: (item) => {
      const key = `${item.kind}|${item.label}|${item.description ?? ''}`
      if (seen.has(key)) return
      seen.add(key)
      items.push(item)
    },
  }
}

function addObjects(
  b: Builder,
  env: CompletionEnv,
  schema: CompletionSchema,
  kinds: ReadonlySet<ObjectKind>,
  qualify: boolean,
  sortGroup: string,
): void {
  for (const o of schema.objects) {
    if (!kinds.has(o.kind)) continue
    const isRoutine = ROUTINE_KINDS.has(o.kind)
    const name = quoteIdent(o.name, env.dialect)
    const insert = qualify ? qualifiedName(schema.name, o.name, env.dialect) : name
    b.add({
      label: o.name,
      kind: objectItemKind(o.kind),
      description: qualify ? schema.name : undefined,
      detail: isRoutine ? (o.signature ?? OBJECT_KIND_LABEL[o.kind]) : OBJECT_KIND_LABEL[o.kind],
      documentation: isRoutine
        ? `**${schema.name}.${o.name}**${o.signature ? ` \`${o.signature}\`` : ''} · ${OBJECT_KIND_LABEL[o.kind]}`
        : relationDoc(`${schema.name}.${o.name}`, OBJECT_KIND_LABEL[o.kind], o.columns ?? []),
      insertText: insert,
      filterText: qualify ? `${o.name} ${schema.name}.${o.name}` : undefined,
      sortText: `${sortGroup}${o.name.toLowerCase()}`,
      ident: qualify ? [schema.name, o.name] : [o.name],
    })
  }
}

/** The ranking-only schema (SQL Server picker), when it is not already the default schema. */
function preferredSchemaOf(catalog: CompletionCatalog, env: CompletionEnv, defaultSchema: CompletionSchema | undefined): CompletionSchema | undefined {
  if (!env.preferredSchema) return undefined
  const s = findSchema(catalog, env.preferredSchema)
  return s && s !== defaultSchema ? s : undefined
}

function addRelationNames(b: Builder, env: CompletionEnv, analysis: CaretAnalysis, kinds: ReadonlySet<ObjectKind>): void {
  const { catalog } = env
  for (const cte of analysis.scope.ctes) {
    b.add({
      label: cte.name,
      kind: 'cte',
      detail: 'CTE',
      documentation: relationDoc(cte.name, 'CTE', (cte.columns ?? []).map((name) => ({ name, dataType: '' }))),
      insertText: quoteIdent(cte.name, env.dialect),
      sortText: `0${cte.name.toLowerCase()}`,
      ident: [cte.name],
    })
  }
  if (!catalog) return
  const order = schemaSearchOrder(catalog, env)
  const defaultSchema = order[0]
  const preferred = preferredSchemaOf(catalog, env, defaultSchema)
  if (preferred) addObjects(b, env, preferred, kinds, true, '10')
  if (defaultSchema) addObjects(b, env, defaultSchema, kinds, false, '11')
  for (const s of order.slice(1)) if (s !== preferred) addObjects(b, env, s, kinds, true, '2')
  for (const s of catalog.schemas) {
    b.add({
      label: s.name,
      kind: 'schema',
      detail: 'schema',
      insertText: `${quoteIdent(s.name, env.dialect)}.`,
      sortText: `3${s.name.toLowerCase()}`,
      retrigger: true,
      ident: [s.name],
      identSuffix: '.',
    })
  }
}

function addColumns(b: Builder, env: CompletionEnv, refs: { ref: RelationRef; label: string }[], sortGroup: string, qualifyAmbiguous: boolean): void {
  const lists = refs.map(({ ref, label }) => ({ label, ...relationColumns(env, ref) }))
  const counts = new Map<string, number>()
  for (const l of lists) for (const c of l.columns) counts.set(c.name.toLowerCase(), (counts.get(c.name.toLowerCase()) ?? 0) + 1)
  lists.forEach((l, ri) => {
    l.columns.forEach((c, ci) => {
      const ident = quoteIdent(c.name, env.dialect)
      const ambiguous = qualifyAmbiguous && (counts.get(c.name.toLowerCase()) ?? 0) > 1
      b.add({
        label: c.name,
        kind: 'column',
        detail: c.dataType || undefined,
        description: refs.length > 1 || qualifyAmbiguous ? l.label : undefined,
        insertText: ambiguous ? `${quoteIdent(l.label, env.dialect)}.${ident}` : ident,
        filterText: ambiguous ? c.name : undefined,
        sortText: `${sortGroup}${pad(ri)}${pad(ci)}`,
        ident: ambiguous ? [l.label, c.name] : [c.name],
      })
    })
  })
}

function addFunctions(b: Builder, env: CompletionEnv, prefix: string, sortGroup: string): void {
  const style = keywordCase(prefix, env.dialect === 'postgres' ? 'lower' : 'upper')
  for (const f of BUILTIN_FUNCTIONS[env.dialect]) {
    const name = applyCase(f.name, style)
    const noArgs = f.signature.startsWith('()')
    b.add({
      label: name,
      kind: 'function',
      detail: f.returns ? `${f.signature} → ${f.returns}` : f.signature,
      documentation: `\`${name}${f.signature}\`\n\n${f.doc}`,
      insertText: noArgs ? `${escapeSnippet(name)}()` : `${escapeSnippet(name)}($0)`,
      snippet: true,
      sortText: `${sortGroup}${f.name.toLowerCase()}`,
    })
  }
  const catalog = env.catalog
  if (!catalog) return
  const order = schemaSearchOrder(catalog, env)
  order.forEach((s, i) => {
    for (const o of s.objects) {
      if (o.kind !== 'function') continue
      const ident = i === 0 ? quoteIdent(o.name, env.dialect) : qualifiedName(s.name, o.name, env.dialect)
      b.add({
        label: o.name,
        kind: 'routine',
        description: i === 0 ? undefined : s.name,
        detail: o.signature,
        documentation: `**${s.name}.${o.name}**${o.signature ? ` \`${o.signature}\`` : ''}`,
        insertText: `${escapeSnippet(ident)}($0)`,
        snippet: true,
        sortText: `${sortGroup}~${o.name.toLowerCase()}`,
        ident: i === 0 ? [o.name] : [s.name, o.name],
        identSuffix: '($0)',
      })
    }
  })
}

function addKeywords(
  b: Builder,
  env: CompletionEnv,
  prefix: string,
  ranked: string[],
  sortGroup: string,
  includeTypes: boolean,
  exclude?: ReadonlySet<string>,
): void {
  const vocab = VOCABULARY[env.dialect]
  const style = keywordCase(prefix)
  ranked.forEach((k, i) => {
    b.add({ label: applyCase(k, style), kind: 'keyword', insertText: applyCase(k, style), sortText: `${sortGroup}0${pad(i)}` })
  })
  for (const k of vocab.phrases) {
    if (exclude?.has(k)) continue
    b.add({ label: applyCase(k, style), kind: 'keyword', insertText: applyCase(k, style), sortText: `${sortGroup}1${k.toLowerCase()}` })
  }
  for (const k of vocab.keywords) {
    if (exclude?.has(k)) continue
    b.add({ label: applyCase(k, style), kind: 'keyword', insertText: applyCase(k, style), sortText: `${sortGroup}2${k.toLowerCase()}` })
  }
  if (includeTypes) addTypes(b, env, prefix, `${sortGroup}3`)
}

function addTypes(b: Builder, env: CompletionEnv, prefix: string, sortGroup: string): void {
  const style = keywordCase(prefix, 'lower')
  for (const t of VOCABULARY[env.dialect].types) {
    b.add({ label: applyCase(t, style), kind: 'type', detail: 'type', insertText: applyCase(t, style), sortText: `${sortGroup}${t}` })
  }
}

/** Completion items for the caret at `offset` in `text`, or null when nothing should be suggested. */
export function computeCompletions(text: string, offset: number, env: CompletionEnv): CompletionResult | null {
  const analysis = analyzeCaret(text, offset, env.dialect)
  const { context, prefix } = analysis
  if (context.kind === 'none') return null
  const b = builder()

  switch (context.kind) {
    case 'relation': {
      if (context.qualifier.length > 0) {
        const schemaName = context.qualifier[context.qualifier.length - 1]!
        const schema = findSchema(env.catalog, schemaName)
        if (schema) addObjects(b, env, schema, RELATION_KINDS, false, '0')
      } else {
        addRelationNames(b, env, analysis, RELATION_KINDS)
      }
      break
    }
    case 'routine': {
      if (context.qualifier.length > 0) {
        const schema = findSchema(env.catalog, context.qualifier[context.qualifier.length - 1]!)
        if (schema) addObjects(b, env, schema, ROUTINE_KINDS, false, '0')
      } else if (env.catalog) {
        const order = schemaSearchOrder(env.catalog, env)
        const preferred = preferredSchemaOf(env.catalog, env, order[0])
        if (preferred) addObjects(b, env, preferred, ROUTINE_KINDS, true, '0')
        order.forEach((s, i) => {
          if (s !== preferred) addObjects(b, env, s, ROUTINE_KINDS, i > 0, i === 0 ? '0' : '1')
        })
      }
      break
    }
    case 'qualified': {
      const target = resolveQualifier(env, analysis, context.qualifier, offset)
      if (target.kind === 'relation') addColumns(b, env, [{ ref: target.ref, label: target.label }], '0', false)
      else if (target.kind === 'schema') {
        addObjects(b, env, target.schema, RELATION_KINDS, false, '0')
        addObjects(b, env, target.schema, ROUTINE_KINDS, false, '1')
      }
      break
    }
    case 'insert-columns': {
      const resolved = findRelation(env, context.schema, context.name)
      const cte = analysis.scope.ctes.find((c) => eq(c.name, context.name))
      const ref = cte ?? (resolved ? syntheticRef(resolved.object.name, resolved.schema) : undefined)
      if (ref) addColumns(b, env, [{ ref, label: context.name }], '0', false)
      break
    }
    case 'columns': {
      const visible = visibleRelations(analysis.scope, offset)
      addColumns(b, env, visible.map((ref) => ({ ref, label: relationLabel(ref) })), '0', visible.length > 1)
      for (const ref of visible) {
        const label = relationLabel(ref)
        b.add({
          label,
          kind: 'alias',
          detail: ref.kind === 'table' ? (ref.schema ? `${ref.schema}.${ref.name}` : ref.name) : ref.kind === 'cte' ? 'CTE' : 'subquery',
          insertText: quoteIdent(label, env.dialect),
          sortText: `1${label.toLowerCase()}`,
          ident: [label],
        })
      }
      addFunctions(b, env, prefix, '2')
      addKeywords(b, env, prefix, ['CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'NULL', 'NOT', 'AND', 'OR', 'DISTINCT', 'EXISTS', 'TRUE', 'FALSE'], '4', false)
      break
    }
    case 'type':
      addTypes(b, env, prefix, '0')
      break
    case 'keyword': {
      const vocab = VOCABULARY[env.dialect]
      if (context.after === 'start') addKeywords(b, env, prefix, vocab.statementStarters, '0', false)
      else if (context.after === 'expression') {
        const clause = currentClause(analysis.tokens.filter((t) => t.end <= analysis.from))
        const { ranked, exclude } = followersFor(clause, env.dialect)
        addKeywords(b, env, prefix, ranked, '0', !exclude, exclude)
      } else addKeywords(b, env, prefix, [], '0', true)
      break
    }
  }

  if (analysis.quoted) return { items: requoted(b.items, analysis.prefix), from: analysis.from, to: analysis.to, analysis }
  if (context.kind !== 'qualified') addSnippets(b, env, prefix)
  return { items: b.items, from: analysis.from, to: analysis.to, analysis }
}

/** User snippets whose abbreviation starts with the typed word (ranked first). */
function addSnippets(b: Builder, env: CompletionEnv, prefix: string): void {
  if (!env.snippets?.length || !prefix) return
  const typed = prefix.toLowerCase()
  for (const s of env.snippets) {
    if (!s.abbreviation.toLowerCase().startsWith(typed)) continue
    b.add({
      label: s.abbreviation,
      kind: 'snippet',
      description: s.name,
      detail: 'snippet',
      documentation: `**${s.name}**\n\n\`\`\`sql\n${snippetPreview(s.body)}\n\`\`\``,
      insertText: s.body,
      snippet: true,
      filterText: s.abbreviation,
      sortText: `00${s.abbreviation.toLowerCase()}`,
    })
  }
}

/**
 * The user started a quoted identifier (`"cust`, `[ord`): the replace range starts at the quote, so
 * names are inserted — and filtered — in the quote style typed. Keywords and built-in functions
 * cannot be quoted and are dropped.
 */
function requoted(items: SqlCompletionItem[], prefix: string): SqlCompletionItem[] {
  const bracket = prefix.startsWith('[')
  const quote = (name: string) => (bracket ? `[${name.replaceAll(']', ']]')}]` : `"${name.replaceAll('"', '""')}"`)
  const out: SqlCompletionItem[] = []
  for (const item of items) {
    if (!item.ident || item.ident.length === 0) continue
    const text = item.ident.map(quote).join('.')
    const suffix = item.identSuffix ?? ''
    out.push({
      ...item,
      insertText: item.snippet ? `${escapeSnippet(text)}${suffix}` : `${text}${suffix}`,
      filterText: quote(item.ident[item.ident.length - 1]!),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Clause-aware keyword followers
// ---------------------------------------------------------------------------

export type SqlClause = 'SELECT' | 'FROM' | 'WHERE' | 'GROUP BY' | 'HAVING' | 'WINDOW' | 'ORDER BY' | 'LIMIT'

const CLAUSE_RANK: Record<SqlClause, number> = { SELECT: 0, FROM: 1, WHERE: 2, 'GROUP BY': 3, HAVING: 4, WINDOW: 5, 'ORDER BY': 6, LIMIT: 7 }

/** Rank of the clause a follower keyword opens (absent: the keyword is not a clause of SELECT). */
const FOLLOWER_RANK: Record<string, number> = {
  FROM: 1, JOIN: 1, 'LEFT JOIN': 1, 'INNER JOIN': 1, 'RIGHT JOIN': 1, 'FULL JOIN': 1, 'CROSS JOIN': 1, 'CROSS APPLY': 1,
  'OUTER APPLY': 1, ON: 1, USING: 1, WHERE: 2, 'GROUP BY': 3, HAVING: 4, WINDOW: 5, 'ORDER BY': 6, LIMIT: 7, OFFSET: 7,
  FETCH: 7, 'FOR UPDATE': 8,
}
const ORDER_BY_FOLLOWERS: Record<Dialect, string[]> = {
  postgres: ['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST', 'LIMIT', 'OFFSET', 'FETCH', 'FOR UPDATE', 'UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT'],
  mssql: ['ASC', 'DESC', 'OFFSET', 'OPTION', 'FOR', 'UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT'],
}

/** The SELECT clause the caret is in (innermost parenthesis level), if any. */
export function currentClause(before: Tok[]): SqlClause | undefined {
  let depth = 0
  for (let k = before.length - 1; k >= 0; k--) {
    const t = before[k]!
    if (isPunctTok(t, ')')) depth++
    else if (isPunctTok(t, '(')) {
      if (depth === 0) return undefined
      depth--
    } else if (isPunctTok(t, ';')) return undefined
    if (depth > 0 || t.kind !== 'word') continue
    switch (t.upper) {
      case 'BY': {
        const p = before[k - 1]?.upper
        if (p === 'ORDER') return 'ORDER BY'
        if (p === 'GROUP') return 'GROUP BY'
        // PARTITION BY lives inside OVER (…), which the depth check skips
        break
      }
      case 'SELECT':
      case 'WHERE':
      case 'HAVING':
      case 'WINDOW':
        return t.upper
      case 'FROM':
      case 'JOIN':
      case 'APPLY':
        return 'FROM'
      case 'LIMIT':
      case 'OFFSET':
      case 'FETCH':
        return 'LIMIT'
    }
  }
  return undefined
}

/** Followers ranked for the clause; `exclude` drops vocabulary that cannot follow (earlier clauses). */
function followersFor(clause: SqlClause | undefined, dialect: Dialect): { ranked: string[]; exclude?: ReadonlySet<string> } {
  const all = VOCABULARY[dialect].followers
  if (!clause) return { ranked: all }
  const rank = CLAUSE_RANK[clause]
  // Earlier clauses, and the clause itself (`FROM t FROM` / `WHERE a WHERE`), cannot follow.
  const earlier = new Set(Object.entries(FOLLOWER_RANK).filter(([, r]) => r < rank).map(([k]) => k))
  if (clause !== 'LIMIT') earlier.add(clause)
  if (clause === 'ORDER BY') {
    for (const k of ['AS', 'AND', 'OR', 'IN', 'NOT', 'LIKE', 'ILIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL', 'SET', 'VALUES', 'RETURNING', 'THEN', 'ELSE', 'END']) earlier.add(k)
    return { ranked: ORDER_BY_FOLLOWERS[dialect], exclude: earlier }
  }
  return { ranked: all.filter((k) => !earlier.has(k)), exclude: earlier }
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

export interface HoverInfo {
  from: number
  to: number
  markdown: string
}

function tokenAt(tokens: Tok[], offset: number): number {
  const inside = tokens.findIndex((t) => isName(t) && t.start <= offset && offset < t.end)
  return inside >= 0 ? inside : tokens.findIndex((t) => isName(t) && t.end === offset)
}

/** Markdown describing the relation (or column) under `offset`, or null. */
export function hoverAt(text: string, offset: number, env: CompletionEnv): HoverInfo | null {
  const analysis = analyzeCaret(text, offset, env.dialect)
  const { tokens } = analysis
  const index = tokenAt(tokens, offset)
  if (index < 0) return null
  const tok = tokens[index]!
  // full name chain around the hovered token: parts before it, and the hovered part
  const parts: string[] = [nameValue(tok)]
  let k = index
  while (isPunctTok(tokens[k - 1], '.') && isName(tokens[k - 2])) {
    parts.unshift(nameValue(tokens[k - 2]!))
    k -= 2
  }
  const intro = tokens[k - 1]
  const range = { from: tok.start, to: tok.end }
  const isRelationPosition = !!intro && intro.kind === 'word' && RELATION_INTRO.has(intro.upper)
  // a relation reference of the statement (FROM users u → hovering "users")
  const ownRef = analysis.scope.relations.find((r) => r.end === tok.end && r.kind !== 'derived')
  if (isRelationPosition || ownRef) {
    return describeRelation(env, analysis, ownRef ?? syntheticRef(parts[parts.length - 1]!, parts.length >= 2 ? parts[parts.length - 2] : undefined), undefined, range)
  }
  if (parts.length === 1) {
    const target = resolveQualifier(env, analysis, parts, offset)
    if (target.kind === 'relation') {
      const alias = target.ref.alias !== undefined && eq(target.ref.alias, parts[0]!) ? target.ref.alias : undefined
      return describeRelation(env, analysis, target.ref, alias, range)
    }
    return null
  }
  // qualified: `u.email` → column; `public.users` → relation
  const qualifier = parts.slice(0, -1)
  const target = resolveQualifier(env, analysis, qualifier, offset)
  if (target.kind === 'relation') {
    const { columns, resolved } = relationColumns(env, target.ref)
    const column = columns.find((c) => c.name === parts[parts.length - 1]) ?? columns.find((c) => eq(c.name, parts[parts.length - 1]!))
    if (!column) return null
    const owner = resolved ? `${resolved.schema}.${resolved.object.name}` : target.label
    return { ...range, markdown: `\`${column.name}\`${column.dataType ? ` ${column.dataType}` : ''}\n\nColumn of **${owner}**` }
  }
  if (target.kind === 'schema') {
    const object = findObjectIn(target.schema, parts[parts.length - 1]!, RELATION_KINDS)
    if (object) return describeRelation(env, analysis, syntheticRef(object.name, target.schema.name), undefined, range)
  }
  return null
}

function describeRelation(
  env: CompletionEnv,
  analysis: CaretAnalysis,
  ref: RelationRef,
  alias: string | undefined,
  range: { from: number; to: number },
): HoverInfo | null {
  if (ref.kind === 'cte' || ref.kind === 'derived') {
    const cte = analysis.scope.ctes.find((c) => eq(c.name, ref.name))
    const columns = (ref.columns ?? cte?.columns ?? []).map((name) => ({ name, dataType: '' }))
    return { ...range, markdown: relationDoc(ref.alias && ref.kind === 'derived' ? ref.alias : ref.name, ref.kind === 'cte' ? 'CTE' : 'subquery', columns) }
  }
  const { columns, resolved } = relationColumns(env, ref)
  if (!resolved) return null
  const title = `${resolved.schema}.${resolved.object.name}`
  const doc = relationDoc(title, OBJECT_KIND_LABEL[resolved.object.kind], columns)
  return { ...range, markdown: alias ? `\`${alias}\` → ${doc}` : doc }
}
