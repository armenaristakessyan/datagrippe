// A single JSON document on disk: atomic writes (tmp + rename), corruption-tolerant reads and
// optional debounced saves. Every store in this folder is built on it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export interface JsonFileOptions<T> {
  /** Value used when the file is missing or unreadable. */
  fallback: () => T
  /** Narrow / repair the parsed JSON. Throwing marks the file as corrupt. */
  parse?: (raw: unknown) => T
  /** Delay before a scheduled save hits the disk (0 = write synchronously on every save). */
  debounceMs?: number
  /** Pretty-print (small, human-inspectable files). */
  pretty?: boolean
  log?: Pick<Console, 'warn' | 'error'>
}

export class JsonFile<T> {
  readonly path: string
  private value: T
  private timer: NodeJS.Timeout | null = null
  private dirty = false
  private readonly options: JsonFileOptions<T>

  constructor(path: string, options: JsonFileOptions<T>) {
    this.path = path
    this.options = options
    this.value = this.load()
  }

  get(): T {
    return this.value
  }

  /** Replace the value and persist it (immediately, or after the debounce delay). */
  set(value: T): void {
    this.value = value
    this.dirty = true
    const delay = this.options.debounceMs ?? 0
    if (delay <= 0) {
      this.flush()
      return
    }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, delay)
    this.timer.unref?.()
  }

  /** Write pending changes now. Safe to call at any time. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return
    this.dirty = false
    try {
      writeJsonAtomic(this.path, this.value, this.options.pretty ?? true)
    } catch (error) {
      this.dirty = true
      ;(this.options.log ?? console).error(`[store] Failed to write ${this.path}:`, error)
    }
  }

  private load(): T {
    const log = this.options.log ?? console
    if (!existsSync(this.path)) return this.options.fallback()
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      log.error(`[store] Cannot read ${this.path}:`, error)
      return this.options.fallback()
    }
    try {
      const raw: unknown = JSON.parse(text)
      return this.options.parse ? this.options.parse(raw) : (raw as T)
    } catch (error) {
      const backup = `${this.path}.corrupt-${Date.now()}`
      try {
        renameSync(this.path, backup)
        log.warn(`[store] ${this.path} is corrupt (${errorText(error)}); moved to ${backup}`)
      } catch (renameError) {
        log.error(`[store] ${this.path} is corrupt and could not be backed up:`, renameError)
      }
      return this.options.fallback()
    }
  }
}

export function writeJsonAtomic(path: string, value: unknown, pretty = true): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(value, null, pretty ? 2 : undefined) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // tmp file may not exist
    }
    throw error
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
