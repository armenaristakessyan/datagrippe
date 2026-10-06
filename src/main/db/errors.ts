import type { DbErrorInfo, ErrorKind } from '@shared/types'

/** Error type thrown across the main process; serialized to DbErrorInfo for the renderer. */
export class DriverError extends Error {
  readonly info: DbErrorInfo

  constructor(info: DbErrorInfo) {
    super(info.message)
    this.name = 'DriverError'
    this.info = info
  }

  static of(kind: ErrorKind, message: string, extra: Partial<DbErrorInfo> = {}): DriverError {
    return new DriverError({ ...extra, message, kind })
  }
}

/** Convert anything thrown into a DbErrorInfo. Driver-specific fields are mapped by each driver beforehand. */
export function toErrorInfo(error: unknown): DbErrorInfo {
  if (error instanceof DriverError) return error.info
  if (error instanceof Error) {
    const e = error as Error & { code?: unknown }
    return {
      message: e.message || String(error),
      code: typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code) : undefined,
      kind: 'internal',
    }
  }
  return { message: String(error), kind: 'internal' }
}
