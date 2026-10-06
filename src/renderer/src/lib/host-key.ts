// SSH host key confirmation: main refuses an unknown (or changed) server key with kind 'needs-host-key'
// before any credential is sent; the user checks the fingerprint, and a confirmed key is trusted.
import type { SshHostKeyInfo } from '@shared/types'
import { ApiError, call } from '@/lib/api'
import { useUi } from '@/stores/ui'

export function hostKeyOf(error: unknown): SshHostKeyInfo | undefined {
  return error instanceof ApiError && error.info.kind === 'needs-host-key' ? error.info.hostKey : undefined
}

/** Ask the user to trust the key; stores it in main on confirmation. Resolves to whether it was trusted. */
export async function confirmHostKey(key: SshHostKeyInfo): Promise<boolean> {
  const target = `${key.host}:${key.port}`
  const ok = await useUi.getState().confirm(
    key.changed
      ? {
          title: `The SSH host key of ${target} changed`,
          message:
            'Someone could be intercepting the connection, or the server was reinstalled. Only continue if you know why the key changed.',
          detail: `${key.keyType}\nPreviously trusted  ${key.previousFingerprint ?? 'unknown'}\nPresented now      ${key.fingerprint}`,
          confirmLabel: 'Trust the new key',
          danger: true,
        }
      : {
          title: `Trust SSH host ${target}?`,
          message: 'This server is not known yet. Compare the fingerprint with the one your administrator gave you.',
          detail: `${key.keyType}\n${key.fingerprint}`,
          confirmLabel: 'Trust and connect',
        },
  )
  if (!ok) return false
  await call('ssh:trustHostKey', key)
  return true
}

/**
 * Run `attempt`; when it fails because the SSH host key must be confirmed, ask, trust and try again.
 * Resolves to null when the user declines.
 */
export async function withHostKeyTrust<T>(attempt: () => Promise<T>): Promise<T | null> {
  for (let tries = 0; ; tries++) {
    try {
      return await attempt()
    } catch (error) {
      const key = hostKeyOf(error)
      if (!key || tries >= 2) throw error
      if (!(await confirmHostKey(key))) return null
    }
  }
}
