// "Suggest" next to a Vault secret path: signs in, lists the database secrets engines the token can see
// (vault:discover) and lets the user pick "<mount>/creds/<role>", the best match first.
import { useEffect, useMemo, useState } from 'react'
import { Command } from 'cmdk'
import { RefreshCw, Search, Sparkles, TriangleAlert } from 'lucide-react'
import type { DbErrorInfo, VaultDiscoverResult } from '@shared/types'
import { Button, Popover, PopoverContent, PopoverTrigger, Spinner } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useVault } from '@/stores/vault'
import { credsPath, DEFAULT_DISCOVERY_ROLE, isDiscoveryRole } from './config'
import { vaultMessage } from './format'

export type DiscoverOutcome = { ok: true; result: VaultDiscoverResult } | { ok: false; error: DbErrorInfo } | null

export interface SecretPathSuggestProps {
  /** Run the discovery for this role (null = the user cancelled a prompt / the sign-in). */
  discover: (role: string) => Promise<DiscoverOutcome>
  onPick: (path: string) => void
  /** Current secret path: its role ("…/creds/<role>") is the default role. */
  currentPath: string
  /** Checked before signing in (invalid Vault settings → the form shows its errors and nothing opens). */
  canStart: () => boolean
  disabled?: boolean
  /** Ranking key of the target in the result (default "self"). */
  targetKey?: string
  /** Icon-only trigger (table rows). */
  compact?: boolean
  /** Role to start with (else the role of currentPath). */
  initialRole?: string
}

/** The role of "…/creds/<role>", or the default. */
export function roleOf(path: string): string {
  const match = /\/creds\/([^/]+)$/.exec(path.trim())
  return match && isDiscoveryRole(match[1]) ? match[1] : DEFAULT_DISCOVERY_ROLE
}

interface Row {
  mount: string
  score?: number
  suggested: boolean
  reason?: string
}

/** Ranked mounts first (best first), then every other database mount, alphabetically. */
export function suggestionRows(result: VaultDiscoverResult, key: string): Row[] {
  const suggestion = result.suggestions.find((s) => s.key === key)
  const ranked = result.ranking?.[key] ?? []
  const rows: Row[] = ranked.map((r) => ({
    mount: r.mount,
    score: r.score,
    suggested: suggestion?.mount === r.mount,
    reason: suggestion?.mount === r.mount ? suggestion.reason : undefined,
  }))
  const seen = new Set(rows.map((r) => r.mount))
  for (const m of result.mounts) if (!seen.has(m.path)) rows.push({ mount: m.path, suggested: false })
  return rows
}

export function SecretPathSuggest({ discover, onPick, currentPath, canStart, disabled, targetKey = 'self', compact = false, initialRole }: SecretPathSuggestProps) {
  const [open, setOpen] = useState(false)
  const startRole = () => (currentPath.trim() ? roleOf(currentPath) : initialRole && isDiscoveryRole(initialRole) ? initialRole : roleOf(currentPath))
  const [role, setRole] = useState(startRole)
  const [state, setState] = useState<{ status: 'idle' } | { status: 'running' } | { status: 'done'; outcome: DiscoverOutcome }>({ status: 'idle' })
  const loginPending = useVault((s) => s.login !== null)
  const roleValid = isDiscoveryRole(role)

  const run = async (forRole: string) => {
    setState({ status: 'running' })
    const outcome = await discover(forRole)
    if (outcome === null) {
      setOpen(false)
      setState({ status: 'idle' })
      return
    }
    setState({ status: 'done', outcome })
  }

  useEffect(() => {
    if (open) setRole(startRole())
    // Only when the popover opens: typing a role must not be overwritten.
  }, [open])

  const rows = useMemo(() => (state.status === 'done' && state.outcome?.ok ? suggestionRows(state.outcome.result, targetKey) : []), [state, targetKey])
  const result = state.status === 'done' && state.outcome?.ok ? state.outcome.result : null
  const failure = state.status === 'done' && state.outcome && !state.outcome.ok ? state.outcome.error : null

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next && !canStart()) return
        setOpen(next)
        if (next && state.status !== 'running') void run(roleValid ? role : DEFAULT_DISCOVERY_ROLE)
      }}
    >
      <PopoverTrigger asChild>
        {compact ? (
          <Button size="xs" variant="ghost" leadingIcon={Sparkles} disabled={disabled} aria-label="Pick a database mount" title="Pick a database mount" />
        ) : (
          <Button size="xs" variant="secondary" leadingIcon={Sparkles} disabled={disabled} aria-label="Suggest a secret path from Vault">
            Suggest
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-[min(560px,calc(100vw-48px))] overflow-hidden p-0">
        <Command loop shouldFilter className="flex max-h-[min(var(--radix-popover-content-available-height),420px)] flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-2.5">
            <Search size={14} strokeWidth={1.75} className="shrink-0 text-subtle" />
            <Command.Input
              autoFocus
              placeholder="Filter database mounts…"
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-faint"
            />
            <label className="flex shrink-0 items-center gap-1.5 text-2xs text-subtle" htmlFor="vault-suggest-role">
              Role
              <input
                id="vault-suggest-role"
                value={role}
                spellCheck={false}
                onChange={(e) => setRole(e.target.value.trim())}
                className={cn(
                  'h-6 w-28 rounded-[5px] border bg-input px-1.5 font-mono text-[11px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus',
                  roleValid ? 'border-line' : 'border-danger',
                )}
                aria-invalid={!roleValid}
              />
            </label>
            <Button
              size="xs"
              variant="ghost"
              leadingIcon={RefreshCw}
              aria-label="List the mounts again"
              disabled={state.status === 'running' || !roleValid}
              onClick={() => void run(role)}
            />
          </div>

          {state.status === 'running' && (
            <div className="flex h-16 items-center justify-center gap-2 text-xs text-muted" role="status">
              <Spinner size={13} />
              {loginPending ? 'Waiting for browser sign-in…' : 'Signing in to Vault and listing its secrets engines…'}
            </div>
          )}

          {failure && (
            <div className="flex items-start gap-2 px-3 py-3 text-xs text-danger" role="alert">
              <TriangleAlert size={13} strokeWidth={2} className="mt-px shrink-0" />
              <span className="flex flex-col gap-0.5">
                <span>{failure.kind === 'vault' ? vaultMessage(failure.message) : failure.message}</span>
                {failure.detail && <span className="text-muted">{failure.detail}</span>}
              </span>
            </div>
          )}

          {result && result.warnings.length > 0 && (
            <div className="flex items-start gap-2 border-b border-line bg-warning-soft px-3 py-2 text-2xs text-warning">
              <TriangleAlert size={12} strokeWidth={2} className="mt-px shrink-0" />
              <span>{result.warnings.join(' ')}</span>
            </div>
          )}

          {result && (
            <Command.List className="min-h-0 flex-1 overflow-y-auto p-1">
              <Command.Empty className="px-3 py-5 text-center text-xs text-subtle">No mount matches this filter.</Command.Empty>
              {rows.map((row) => (
                <Command.Item
                  key={row.mount}
                  value={row.mount}
                  disabled={!roleValid}
                  onSelect={() => {
                    onPick(credsPath(row.mount, role))
                    setOpen(false)
                  }}
                  className="flex cursor-default select-none flex-col gap-0.5 rounded-[5px] px-2 py-1.5 outline-none data-[selected=true]:bg-hover data-[disabled=true]:opacity-40"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={credsPath(row.mount, role)}>
                      {row.mount}
                      <span className="text-subtle">/creds/{role || DEFAULT_DISCOVERY_ROLE}</span>
                    </span>
                    {row.suggested && <span className="shrink-0 rounded-[4px] bg-accent-soft px-1.5 py-px text-[10.5px] font-medium text-accent">Suggested</span>}
                    {row.score !== undefined && <ScoreMeter score={row.score} />}
                  </span>
                  {row.reason && <span className="truncate pl-0.5 text-2xs text-subtle">{row.reason}</span>}
                </Command.Item>
              ))}
            </Command.List>
          )}
          {result && (
            <div className="shrink-0 border-t border-line px-3 py-1.5 text-2xs text-subtle">
              {result.mounts.length === 1 ? '1 database mount' : `${result.mounts.length} database mounts`} visible to your Vault token · ↵ to use
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Tiny 0..1 bar + percentage. */
function ScoreMeter({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  return (
    <span className="flex shrink-0 items-center gap-1.5" title={`Match ${pct}%`}>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-line">
        <span className={cn('block h-full rounded-full', score >= 0.75 ? 'bg-success' : score >= 0.5 ? 'bg-accent' : 'bg-faint')} style={{ width: `${pct}%` }} />
      </span>
      <span className="w-8 text-right text-2xs text-subtle tabular">{pct}%</span>
    </span>
  )
}
