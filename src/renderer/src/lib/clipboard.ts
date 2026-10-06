// Clipboard writes: the async Clipboard API, falling back to a hidden textarea + execCommand('copy')
// (focus loss or permission denial make the async API reject).

export async function copyText(text: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // fall through to the legacy path
  }
  if (!legacyCopy(text)) throw new Error('The clipboard is not available.')
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  active?.focus({ preventScroll: true })
  return ok
}
