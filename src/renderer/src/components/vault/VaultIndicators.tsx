// Vault lease indicators: the badge of a Vault connection in the explorer and the "Vault · 47 min" chip
// of the status bar, both with a details tooltip. They subscribe to useVault() themselves.
import { useEffect, useState } from 'react'
import { KeySquare } from 'lucide-react'
import type { ConnectionConfig, VaultStatus } from '@shared/types'
import { Tooltip } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useVault } from '@/stores/vault'
import { chipText, LOGIN_METHOD_LABEL, statusDetails, vaultTone, type VaultTone } from './format'

/** Current time, refreshed every `intervalMs` (30 s by default) while mounted. */
export function useNow(intervalMs = 30_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs, enabled])
  return now
}

const TONE_TEXT: Record<VaultTone, string> = {
  neutral: 'text-subtle',
  warning: 'text-warning',
  danger: 'text-danger',
}

/** Tooltip body: state, user, kind, lease, how the token was obtained (or the server when not connected). */
export function VaultStatusDetails({ connection, status, now }: { connection: ConnectionConfig; status?: VaultStatus; now: number }) {
  const vault = connection.vault
  const server = vault ? `${vault.address}${vault.namespace ? ` · ${vault.namespace}` : ''}` : ''
  if (!status) {
    return (
      <span className="flex flex-col gap-0.5 py-0.5">
        <span className="font-medium text-fg">Credentials from Vault</span>
        <span className="text-subtle">
          Issued at connect time{vault ? ` · ${LOGIN_METHOD_LABEL[vault.loginMethod]}` : ''}
        </span>
        {server && <span className="font-mono text-2xs text-subtle">{server}</span>}
      </span>
    )
  }
  const tone = vaultTone(status, now)
  const details = statusDetails(status, now)
  return (
    <span className="flex flex-col gap-1 py-0.5">
      <span className={cn('font-medium', tone === 'neutral' ? 'text-fg' : TONE_TEXT[tone])}>{details.title}</span>
      {details.lines.length > 0 && (
        <span className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          {details.lines.map((line) => (
            <span key={line.label} className="contents">
              <span className="text-subtle">{line.label}</span>
              {/* The dynamic user is long ("v-oidc-…-1791236937") and is the line people need: wrap it, never cut it. */}
              <span className={cn('text-fg', line.mono ? 'font-mono text-[11px] [overflow-wrap:anywhere]' : 'truncate')}>{line.value}</span>
            </span>
          ))}
        </span>
      )}
      {details.message && <span className="text-subtle [overflow-wrap:anywhere]">{details.message}</span>}
      {server && <span className="font-mono text-2xs text-subtle">{server}</span>}
    </span>
  )
}

/** Explorer: a small Vault glyph after the connection name; warning / danger colour when the lease needs attention. */
export function VaultBadge({ connection }: { connection: ConnectionConfig }) {
  const status = useVault((s) => s.statuses[connection.id])
  const now = useNow(30_000, status !== undefined)
  const tone = vaultTone(status, now)
  return (
    <Tooltip content={<VaultStatusDetails connection={connection} status={status} now={now} />} side="right" className="max-w-[360px]">
      <KeySquare
        size={11}
        strokeWidth={2}
        className={cn('shrink-0', status && tone === 'neutral' ? 'text-muted' : TONE_TEXT[tone])}
        aria-label={status ? `Vault: ${statusDetails(status, now).title}` : 'Credentials from Vault'}
        data-vault-tone={tone}
      />
    </Tooltip>
  )
}

/** Status bar: "Vault · 47 min" for a connected Vault connection. */
export function VaultStatusChip({ connection }: { connection: ConnectionConfig }) {
  const status = useVault((s) => s.statuses[connection.id])
  const now = useNow(30_000, status !== undefined)
  if (!status) return null
  const tone = vaultTone(status, now)
  return (
    <Tooltip content={<VaultStatusDetails connection={connection} status={status} now={now} />} side="top" align="start" className="max-w-[360px]">
      <span
        data-testid="vault-chip"
        data-vault-tone={tone}
        className={cn(
          'flex shrink-0 items-center gap-1 rounded-[3px] px-1.5 tabular',
          tone === 'neutral' && 'text-muted',
          tone === 'warning' && 'bg-warning-soft font-medium text-warning',
          tone === 'danger' && 'bg-danger-soft font-medium text-danger',
        )}
      >
        <KeySquare size={10} strokeWidth={2} aria-hidden className={tone === 'neutral' ? 'text-faint' : undefined} />
        Vault
        <span aria-hidden className={tone === 'neutral' ? 'text-faint' : 'opacity-60'}>
          ·
        </span>
        {chipText(status, now)}
      </span>
    </Tooltip>
  )
}
