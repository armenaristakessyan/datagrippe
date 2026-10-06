// Debounce for run triggers: ⌘↵ may reach both Monaco's keybinding and the native menu accelerator.

export interface TriggerGuard {
  /** True when a trigger for `key` at `now` should proceed; false when it repeats one within the window. */
  accept: (key: string, now?: number) => boolean
}

export function createTriggerGuard(windowMs: number): TriggerGuard {
  const last = new Map<string, number>()
  return {
    accept: (key, now = Date.now()) => {
      const previous = last.get(key)
      if (previous !== undefined && now - previous < windowMs) return false
      last.set(key, now)
      return true
    },
  }
}
