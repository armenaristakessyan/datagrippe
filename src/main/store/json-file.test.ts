import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonFile, writeJsonAtomic } from './json-file'

const silent = { warn: vi.fn(), error: vi.fn() }

describe('JsonFile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dg-json-'))
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the fallback when the file is missing and writes atomically', () => {
    const file = new JsonFile<{ n: number }>(join(dir, 'a.json'), { fallback: () => ({ n: 0 }), log: silent })
    expect(file.get()).toEqual({ n: 0 })
    file.set({ n: 1 })
    expect(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8'))).toEqual({ n: 1 })
    // no tmp file left behind
    expect(readdirSync(dir)).toEqual(['a.json'])
  })

  it('backs up a corrupt file and starts empty', () => {
    const path = join(dir, 'b.json')
    writeFileSync(path, '{ not json')
    const file = new JsonFile<string[]>(path, { fallback: () => [], log: silent })
    expect(file.get()).toEqual([])
    const files = readdirSync(dir)
    expect(files.some((f) => /^b\.json\.corrupt-\d+$/.test(f))).toBe(true)
    expect(files).not.toContain('b.json')
    expect(silent.warn).toHaveBeenCalled()
  })

  it('treats a parse() failure as corruption', () => {
    const path = join(dir, 'c.json')
    writeFileSync(path, '"a string"')
    const file = new JsonFile<string[]>(path, {
      fallback: () => [],
      parse: (raw) => {
        if (!Array.isArray(raw)) throw new Error('expected array')
        return raw as string[]
      },
      log: silent,
    })
    expect(file.get()).toEqual([])
    expect(readdirSync(dir).some((f) => f.startsWith('c.json.corrupt-'))).toBe(true)
  })

  it('debounces writes and flushes on demand', () => {
    vi.useFakeTimers()
    const path = join(dir, 'd.json')
    const file = new JsonFile<number>(path, { fallback: () => 0, debounceMs: 500, log: silent })
    file.set(1)
    file.set(2)
    expect(readdirSync(dir)).toEqual([])
    vi.advanceTimersByTime(500)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toBe(2)
    file.set(3)
    file.flush()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toBe(3)
  })

  it('writeJsonAtomic replaces an existing file', () => {
    const path = join(dir, 'e.json')
    writeJsonAtomic(path, { a: 1 })
    writeJsonAtomic(path, { a: 2 })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 2 })
    expect(readdirSync(dir)).toEqual(['e.json'])
  })
})
