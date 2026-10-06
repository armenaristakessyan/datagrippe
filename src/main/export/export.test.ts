import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CellValue, ColumnMeta, ExecutionResult, StatementResult } from '@shared/types'
import { ExportRegistry, exportQuery, type ExportDeps } from './export-query'
import { createFormatter, csvField, insertTarget, tsvField, uniqueNames } from './format'

const cols = (...names: string[]): ColumnMeta[] => names.map((name) => ({ name, dataType: 'text' }))

function run(format: 'csv' | 'tsv' | 'json' | 'sql', columns: ColumnMeta[], batches: CellValue[][][], tableName?: string) {
  const f = createFormatter(format, columns, { dialect: 'postgres', tableName })
  return f.begin() + batches.map((b) => f.rows(b)).join('') + f.end()
}

describe('export formatters', () => {
  it('csv follows RFC 4180 with CRLF', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('line\nbreak')).toBe('"line\nbreak"')
    expect(csvField(' padded')).toBe('" padded"')
    expect(csvField(null)).toBe('')
    expect(csvField(true)).toBe('true')
    expect(run('csv', cols('id', 'name'), [[[1, 'a'], [2, null]], [[3, 'x,y']]])).toBe('id,name\r\n1,a\r\n2,\r\n3,"x,y"\r\n')
  })

  it('tsv quotes fields with separators, as spreadsheets (and "Save rows as…") do', () => {
    expect(tsvField('a\tb\nc\\d')).toBe('"a\tb\nc\\d"')
    expect(tsvField('"quoted')).toBe('"""quoted"')
    expect(tsvField('{"a": 1}')).toBe('{"a": 1}')
    expect(run('tsv', cols('a', 'b'), [[[1, null]]])).toBe('a\tb\n1\t\n')
  })

  it('json streams an array of objects with unique keys', () => {
    expect(uniqueNames(cols('id', 'id', 'name', 'id'))).toEqual(['id', 'id_2', 'name', 'id_3'])
    const text = run('json', cols('id', 'id', 'v'), [[[1, 2, 'x']], [[3, 4, null]]])
    expect(JSON.parse(text)).toEqual([
      { id: 1, id_2: 2, v: 'x' },
      { id: 3, id_2: 4, v: null },
    ])
    expect(JSON.parse(run('json', cols('a'), []))).toEqual([])
  })

  it('json keeps a column named __proto__ and embeds json columns', () => {
    const text = run('json', [{ name: '__proto__', dataType: 'int4' }, { name: 'doc', dataType: 'jsonb' }, { name: 'big', dataType: 'int8' }], [
      [[1, '{"n": 12345678901234567890}', '9007199254740993']],
    ])
    expect(text).toContain('"doc":{"n": 12345678901234567890}')
    expect(text).toContain('"big":"9007199254740993"')
    const parsed = JSON.parse(text) as Record<string, unknown>[]
    expect(Object.keys(parsed[0])).toEqual(['__proto__', 'doc', 'big'])
  })

  it('sql uses column-aware literals', () => {
    const columns = [
      { name: 'bin', dataType: 'varbinary' },
      { name: 'amount', dataType: 'decimal(12,2)' },
      { name: 'label', dataType: 'nvarchar' },
    ]
    const f = createFormatter('sql', columns, { dialect: 'mssql', tableName: 'dbo.t' })
    expect(f.rows([['0xDEADBEEF', '12.50', "it's"]])).toBe("INSERT INTO dbo.t (bin, amount, label) VALUES (0xDEADBEEF, 12.50, N'it''s');\n")
    const pg = createFormatter('sql', [{ name: 'b', dataType: 'bytea' }], { dialect: 'postgres', tableName: 't' })
    expect(pg.rows([['\\xdeadbeef']])).toBe("INSERT INTO t (b) VALUES ('\\xdeadbeef'::bytea);\n")
  })

  it('sql renders INSERT statements', () => {
    expect(insertTarget(undefined, 'postgres')).toBe('exported_table')
    expect(insertTarget('sales.orders', 'postgres')).toBe('sales.orders')
    expect(run('sql', cols('id', 'Name'), [[[1, "O'Brien"], [2, null]]], 'people')).toBe(
      `INSERT INTO people (id, "Name") VALUES (1, 'O''Brien');\nINSERT INTO people (id, "Name") VALUES (2, NULL);\n`,
    )
  })
})

describe('exportQuery', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dg-export-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function rows(from: number, n: number): CellValue[][] {
    return Array.from({ length: n }, (_, i) => [from + i, `r${from + i}`])
  }

  function deps(first: Partial<StatementResult>, pages: CellValue[][][] = [], extra: Partial<ExportDeps> = {}) {
    const closeSession = vi.fn(async () => undefined)
    const execute = vi.fn(
      async (): Promise<ExecutionResult> => ({
        executionId: 'e',
        sessionId: 's',
        results: [
          {
            index: 0,
            sql: 'select',
            offset: 0,
            kind: 'rows',
            columns: cols('id', 'name'),
            rows: [],
            rowCount: 0,
            hasMore: false,
            durationMs: 1,
            ...first,
          },
        ],
        messages: [],
        durationMs: 1,
        cancelled: false,
        transaction: { autoCommit: true, inTransaction: false },
      }),
    )
    let page = 0
    const fetchMore = vi.fn(async () => {
      const r = pages[page++] ?? []
      return { rows: r, hasMore: page < pages.length }
    })
    const setSchema = vi.fn(async () => ({ sessionId: 's', connectionId: 'c', database: 'app', transaction: { autoCommit: true, inTransaction: false } }))
    const cancel = vi.fn(async () => undefined)
    const d: ExportDeps = {
      sessions: {
        dialectOf: () => 'postgres',
        openSession: vi.fn(async () => ({ sessionId: 's', connectionId: 'c', database: 'app', transaction: { autoCommit: true, inTransaction: false } })),
        closeSession,
        execute,
        fetchMore,
        setSchema,
        cancel,
      },
      chooseFile: async () => join(dir, 'out.csv'),
      batchSize: 2,
      ...extra,
    }
    return { d, closeSession, execute, fetchMore, setSchema, cancel }
  }

  const req = { connectionId: 'c', sql: 'select * from t', format: 'csv' as const, defaultName: 'out' }

  it('streams every batch through fetchMore', async () => {
    const { d, closeSession, fetchMore } = deps({ rows: rows(1, 2), rowCount: 2, hasMore: true, cursorId: 'cur' }, [rows(3, 2), rows(5, 1)])
    const result = await exportQuery(req, d)
    expect(result).toEqual({ path: join(dir, 'out.csv'), rows: 5 })
    expect(fetchMore).toHaveBeenCalledWith('s', 'cur', 2)
    expect(readFileSync(join(dir, 'out.csv'), 'utf8')).toBe('id,name\r\n1,r1\r\n2,r2\r\n3,r3\r\n4,r4\r\n5,r5\r\n')
    expect(closeSession).toHaveBeenCalledWith('s')
  })

  it('returns a null path when the dialog is cancelled, without running anything', async () => {
    const { d, execute } = deps({}, [], { chooseFile: async () => null })
    expect(await exportQuery(req, d)).toEqual({ path: null, rows: 0 })
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects several statements', async () => {
    const { d } = deps({})
    await expect(exportQuery({ ...req, sql: 'select 1; select 2' }, d)).rejects.toMatchObject({ info: { kind: 'invalid-input' } })
  })

  it('fails clearly when the result is truncated without a cursor and removes the partial file', async () => {
    const { d, closeSession } = deps({ rows: rows(1, 2), rowCount: 2, hasMore: true })
    await expect(exportQuery(req, d)).rejects.toThrow(/truncated after 2 rows/)
    expect(existsSync(join(dir, 'out.csv'))).toBe(false)
    expect(closeSession).toHaveBeenCalled()
  })

  it('applies the console schema before running the query', async () => {
    const { d, setSchema, execute } = deps({ rows: rows(1, 1), rowCount: 1 })
    await exportQuery({ ...req, schema: 'sales' }, d)
    expect(setSchema).toHaveBeenCalledWith('s', 'sales')
    expect(setSchema.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0])
    const plain = deps({ rows: rows(1, 1), rowCount: 1 })
    await exportQuery(req, plain.d)
    expect(plain.setSchema).not.toHaveBeenCalled()
  })

  it('reports progress and stops when cancelled, removing the partial file', async () => {
    const controller = new AbortController()
    const progress: number[] = []
    const { d, cancel, closeSession } = deps({ rows: rows(1, 2), rowCount: 2, hasMore: true, cursorId: 'cur' }, [rows(3, 2), rows(5, 2), rows(7, 1)], {
      signal: controller.signal,
      onProgress: (n) => {
        progress.push(n)
        if (n >= 4) controller.abort()
      },
    })
    await expect(exportQuery(req, d)).rejects.toMatchObject({ info: { kind: 'cancelled' } })
    expect(progress).toEqual([2, 4])
    expect(cancel).toHaveBeenCalledWith('s')
    expect(closeSession).toHaveBeenCalledWith('s')
    expect(existsSync(join(dir, 'out.csv'))).toBe(false)
  })

  it('does not leak error listeners while waiting for drain', async () => {
    const big = Array.from({ length: 30 }, (_, i) => rows(i * 200, 200))
    const { d } = deps({ rows: big[0], rowCount: 200, hasMore: true, cursorId: 'cur' }, big.slice(1).map((r) => r.map(([id]) => [id, 'x'.repeat(2000)])))
    const warn = vi.spyOn(process, 'emitWarning')
    await exportQuery(req, d)
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('MaxListeners'))).toEqual([])
    warn.mockRestore()
  })

  it('registry cancels by id and refuses duplicate ids', () => {
    const registry = new ExportRegistry()
    const a = registry.start('x')
    expect(() => registry.start("x")).toThrow(/already running/)
    registry.cancel('x')
    expect(a.signal?.aborted).toBe(true)
    a.release()
    expect(registry.start('x').signal?.aborted).toBe(false)
    expect(registry.start(undefined).signal).toBeUndefined()
  })

  it('reports SQL errors and non-row statements', async () => {
    const failing = deps({ kind: 'error', error: { message: 'syntax error', code: '42601' } })
    await expect(exportQuery(req, failing.d)).rejects.toMatchObject({ info: { message: 'syntax error', code: '42601', kind: 'database' } })
    const command = deps({ kind: 'command', columns: [] })
    await expect(exportQuery(req, command.d)).rejects.toMatchObject({ info: { kind: 'invalid-input' } })
  })
})
