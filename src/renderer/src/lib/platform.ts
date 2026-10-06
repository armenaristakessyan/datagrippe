// Environment facts for the renderer. Safe to import from node (unit tests): everything is guarded.

/** `process.platform` of the host as exposed by the preload ("darwin", "win32", "linux"). */
export function hostPlatform(): string {
  if (typeof window !== 'undefined' && window.datagrippe?.platform) return window.datagrippe.platform
  if (typeof navigator !== 'undefined') {
    const p = navigator.platform.toLowerCase()
    if (p.startsWith('mac')) return 'darwin'
    if (p.startsWith('win')) return 'win32'
    return 'linux'
  }
  return 'linux'
}

export function isMac(): boolean {
  return hostPlatform() === 'darwin'
}

/** True when the preload bridge is present (false in a plain browser / tests). */
export function hasBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.datagrippe?.invoke === 'function'
}

declare global {
  interface Window {
    /** Uncaught renderer errors, read by scripts/snap.mjs and e2e tests. */
    __datagrippeErrors?: string[]
  }
}

/** Record an uncaught renderer error in `window.__datagrippeErrors` (bounded). */
export function recordRendererError(error: unknown, context?: string): void {
  if (typeof window === 'undefined') return
  const text =
    error instanceof Error ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}` : String(error)
  const list = (window.__datagrippeErrors ??= [])
  list.push(context ? `[${context}] ${text}` : text)
  if (list.length > 100) list.splice(0, list.length - 100)
}
