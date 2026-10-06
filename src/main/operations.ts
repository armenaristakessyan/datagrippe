// Long-running main-process operations (exports, imports) addressed by a caller-chosen id, so the
// renderer can cancel them (files:cancelExport / files:cancelImport).
import { DriverError } from './db/errors'

export class OperationRegistry {
  private readonly running = new Map<string, AbortController>()

  /** A signal for a new operation; `release` must be called when it ends. Without an id it cannot be cancelled. */
  start(id: string | undefined): { signal: AbortSignal | undefined; release: () => void } {
    if (!id) return { signal: undefined, release: () => undefined }
    if (this.running.has(id)) throw DriverError.of('invalid-input', 'An operation with this id is already running.')
    const controller = new AbortController()
    this.running.set(id, controller)
    return {
      signal: controller.signal,
      release: () => {
        if (this.running.get(id) === controller) this.running.delete(id)
      },
    }
  }

  /** No-op for an unknown or finished id. */
  cancel(id: string): void {
    this.running.get(id)?.abort()
  }

  /** Stop everything (renderer reload / quit). */
  cancelAll(): void {
    for (const controller of this.running.values()) controller.abort()
  }
}
