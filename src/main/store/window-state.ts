// window-state.json — main window bounds, restored only when still visible on a display.
import { join } from 'node:path'
import { isRecord, JsonFile } from './json-file'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  bounds?: Bounds
  maximized: boolean
}

export class WindowStateStore {
  private readonly file: JsonFile<WindowState>

  constructor(baseDir: string, options: { debounceMs?: number; log?: Pick<Console, 'warn' | 'error'> } = {}) {
    this.file = new JsonFile<WindowState>(join(baseDir, 'window-state.json'), {
      fallback: () => ({ maximized: false }),
      parse: (raw) => {
        if (!isRecord(raw)) throw new Error('expected an object')
        const state: WindowState = { maximized: raw.maximized === true }
        if (isBounds(raw.bounds)) state.bounds = raw.bounds
        return state
      },
      debounceMs: options.debounceMs ?? 400,
      log: options.log,
    })
  }

  get(): WindowState {
    return structuredClone(this.file.get())
  }

  save(state: WindowState): void {
    this.file.set(structuredClone(state))
  }

  flush(): void {
    this.file.flush()
  }
}

function isBounds(raw: unknown): raw is Bounds {
  return (
    isRecord(raw) &&
    ['x', 'y', 'width', 'height'].every((k) => typeof raw[k] === 'number' && Number.isFinite(raw[k] as number))
  )
}

/**
 * Saved bounds if at least a usable part of the window (title bar area) is inside one of the
 * displays' work areas; otherwise undefined (the window is centered with default size).
 */
export function fitBounds(saved: Bounds | undefined, workAreas: Bounds[], min = { width: 960, height: 600 }): Bounds | undefined {
  if (!saved) return undefined
  const width = Math.max(min.width, Math.round(saved.width))
  const height = Math.max(min.height, Math.round(saved.height))
  const bounds = { x: Math.round(saved.x), y: Math.round(saved.y), width, height }
  const visible = workAreas.some((area) => {
    const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
    const titleBarVisible = bounds.y >= area.y - 8 && bounds.y < area.y + area.height - 40
    return overlapX >= 100 && titleBarVisible
  })
  if (!visible) return undefined
  const area = workAreas.find((a) => bounds.x < a.x + a.width && bounds.x + bounds.width > a.x) ?? workAreas[0]
  if (area) {
    bounds.width = Math.min(bounds.width, area.width)
    bounds.height = Math.min(bounds.height, area.height)
  }
  return bounds
}
