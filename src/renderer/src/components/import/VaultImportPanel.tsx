// "Vault settings for imported connections": one Vault server / sign-in for every selected Vault row, the
// role, and "Suggest paths from Vault" (the database mounts the token sees, matched to each row). A secret
// path template remains available for setups with predictable paths.
import { useRef, useState } from 'react'
import { ChevronRight, CircleCheck, Info, KeyRound, Sparkles, TriangleAlert } from 'lucide-react'
import type { VaultLoginMethod } from '@shared/types'
import { Button, Field, Input, Select, Spinner, Switch, Tooltip } from '@/components/ui'
import { DEFAULT_DISCOVERY_ROLE } from '@/components/vault/config'
import { cn } from '@/lib/cn'
import {
  defaultAuthMount,
  needsUsername,
  SECRET_PATH_EXAMPLE,
  SECRET_PATH_TOKENS,
  VAULT_LOGIN_OPTIONS,
  type ImportValidation,
  type VaultImportSettings,
} from './dbeaver-import'

const TOKEN_HELP: Record<(typeof SECRET_PATH_TOKENS)[number], string> = {
  database: 'Database name',
  name: 'DBeaver connection name',
  host: 'Server host name',
}

const METHOD_HINT: Record<VaultLoginMethod, string> = {
  oidc: 'Signs in through your browser when a connection opens.',
  token: 'Uses the token of “vault login” (~/.vault-token or VAULT_TOKEN), like DBeaver’s Vault plugin.',
  ldap: 'Your LDAP password is asked when a connection opens.',
  userpass: 'Your Vault password is asked when a connection opens.',
}

export type SuggestState =
  | { status: 'idle' }
  | { status: 'running'; loginPending: boolean }
  | { status: 'done'; matched: number; total: number; mounts: number; warnings: string[] }
  | { status: 'error'; message: string; detail?: string }

export interface VaultImportPanelProps {
  settings: VaultImportSettings
  onChange: (patch: Partial<VaultImportSettings>) => void
  validation: ImportValidation
  showErrors: boolean
  /** Number of selected rows using Vault. */
  count: number
  /** Where the defaults came from: an existing connection's name, or the shell's VAULT_ADDR. */
  prefilledFrom?: string
  /** ~/.vault-token exists (vault login); undefined = unknown. */
  cliTokenFile?: boolean
  suggest: SuggestState
  onSuggest: () => void
  disabled?: boolean
}

export function VaultImportPanel({ settings, onChange, validation, showErrors, count, prefilledFrom, cliTokenFile, suggest, onSuggest, disabled }: VaultImportPanelProps) {
  const templateRef = useRef<HTMLInputElement>(null)
  const method = settings.loginMethod
  const fallback = method === 'token' && settings.oidcFallback
  const [templateOpen, setTemplateOpen] = useState(() => settings.template.trim() !== '')
  // Custom auth mount per sign-in method (as in the connection dialog): a userpass mount is not OIDC's.
  const mounts = useRef<Partial<Record<VaultLoginMethod, string>>>({ [settings.loginMethod]: settings.authMount })
  const changeMethod = (loginMethod: VaultLoginMethod) => {
    mounts.current[method] = settings.authMount
    onChange({ loginMethod, authMount: mounts.current[loginMethod] ?? '' })
  }
  const err = (message: string | undefined) => (showErrors ? message : undefined)

  /** Insert a {token} at the caret of the template input. */
  const insertToken = (token: string) => {
    const input = templateRef.current
    const text = `{${token}}`
    const start = input?.selectionStart ?? settings.template.length
    const end = input?.selectionEnd ?? start
    const next = settings.template.slice(0, start) + text + settings.template.slice(end)
    onChange({ template: next })
    requestAnimationFrame(() => {
      input?.focus()
      input?.setSelectionRange(start + text.length, start + text.length)
    })
  }

  const running = suggest.status === 'running'

  return (
    <fieldset
      disabled={disabled}
      aria-label="Vault settings for imported connections"
      className="flex shrink-0 animate-fade-in flex-col gap-3 border-t border-line bg-panel/60 px-5 pb-4 pt-3"
    >
      <div className="flex h-5 items-center gap-2">
        <KeyRound size={13} strokeWidth={2} className="shrink-0 text-accent" />
        <h3 className="text-xs font-semibold text-fg">Vault settings for imported connections</h3>
        <span className="text-2xs text-subtle tabular">· {count === 1 ? '1 connection' : `${count} connections`}</span>
        <span className="flex-1" />
        {prefilledFrom && (
          <span className="truncate text-2xs text-subtle" title={`Prefilled from ${prefilledFrom}`}>
            Prefilled from {prefilledFrom}
          </span>
        )}
      </div>

      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,0.7fr)_minmax(0,1.2fr)] items-start gap-3">
        <Field label="Vault address" htmlFor="dbv-vault-address" required error={err(validation.address)}>
          <Input
            id="dbv-vault-address"
            mono
            value={settings.address}
            placeholder="https://vault.example.com"
            invalid={Boolean(err(validation.address))}
            spellCheck={false}
            onChange={(e) => onChange({ address: e.target.value })}
          />
        </Field>
        <Field label="Namespace" htmlFor="dbv-vault-namespace">
          <Input id="dbv-vault-namespace" mono value={settings.namespace} placeholder="Optional" spellCheck={false} onChange={(e) => onChange({ namespace: e.target.value })} />
        </Field>
        <Field label="Sign-in method" htmlFor="dbv-vault-method">
          <Select<VaultLoginMethod>
            id="dbv-vault-method"
            value={method}
            disabled={disabled}
            onValueChange={changeMethod}
            options={VAULT_LOGIN_OPTIONS.map((o) => ({ value: o.value, label: o.label, hint: o.hint }))}
          />
        </Field>
      </div>

      {method === 'token' && (
        <div className="-mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
          {cliTokenFile !== undefined && (
            <p className={cn('flex items-center gap-1.5 text-2xs', cliTokenFile ? 'text-success' : 'text-subtle')}>
              {cliTokenFile ? <CircleCheck size={12} strokeWidth={2} className="shrink-0" /> : <Info size={12} strokeWidth={2} className="shrink-0" />}
              {cliTokenFile ? (
                <span>
                  <span className="font-mono">~/.vault-token</span> found (vault login)
                </span>
              ) : (
                <span>
                  No <span className="font-mono">~/.vault-token</span> yet
                </span>
              )}
            </p>
          )}
          <Switch
            checked={settings.oidcFallback}
            onCheckedChange={(oidcFallback) => onChange({ oidcFallback })}
            label="Sign in with the browser when the token is missing or expired"
            size="sm"
          />
        </div>
      )}

      {(method !== 'token' || fallback || needsUsername(method)) && (
        <div className="grid grid-cols-[minmax(0,0.75fr)_minmax(0,0.75fr)_minmax(0,1.6fr)] items-start gap-3">
          {(method !== 'token' || fallback) && (
            <Field label={fallback ? 'OIDC auth mount' : 'Auth mount'} htmlFor="dbv-vault-mount">
              <Input
                id="dbv-vault-mount"
                mono
                value={settings.authMount}
                placeholder={fallback ? defaultAuthMount('oidc') : defaultAuthMount(method)}
                spellCheck={false}
                onChange={(e) => onChange({ authMount: e.target.value })}
              />
            </Field>
          )}
          {(method === 'oidc' || fallback) && (
            <Field label="OIDC role" htmlFor="dbv-vault-role">
              <Input id="dbv-vault-role" mono value={settings.oidcRole} placeholder="Default role" spellCheck={false} onChange={(e) => onChange({ oidcRole: e.target.value })} />
            </Field>
          )}
          {needsUsername(method) && (
            <Field label="Username" htmlFor="dbv-vault-username" required error={err(validation.username)}>
              <Input
                id="dbv-vault-username"
                mono
                value={settings.username}
                placeholder="jane.doe"
                invalid={Boolean(err(validation.username))}
                spellCheck={false}
                autoComplete="username"
                onChange={(e) => onChange({ username: e.target.value })}
              />
            </Field>
          )}
        </div>
      )}

      {/* Secret paths: suggested from the database mounts the Vault token can see. */}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Role" htmlFor="dbv-vault-path-role" error={err(validation.role)} hint="Appended to each mount: <mount>/creds/<role>.">
          <Input
            id="dbv-vault-path-role"
            mono
            value={settings.role}
            placeholder={DEFAULT_DISCOVERY_ROLE}
            invalid={Boolean(err(validation.role))}
            spellCheck={false}
            onChange={(e) => onChange({ role: e.target.value.trim() })}
            wrapperClassName="w-40"
          />
        </Field>
        <div className="flex min-w-0 flex-1 flex-col gap-1 pb-[18px]">
          <div className="flex min-w-0 items-center gap-2">
            <Button size="sm" variant="primary" leadingIcon={Sparkles} loading={running} disabled={disabled || running || count === 0} onClick={onSuggest}>
              Suggest paths from Vault
            </Button>
            <SuggestSummary state={suggest} />
          </div>
        </div>
      </div>
      {suggest.status === 'done' && suggest.warnings.length > 0 && (
        <p className="-mt-2 flex items-start gap-1.5 text-2xs text-warning">
          <TriangleAlert size={12} strokeWidth={2} className="mt-px shrink-0" />
          <span>{suggest.warnings.join(' ')}</span>
        </p>
      )}

      <div className="flex flex-col gap-2">
        <button
          type="button"
          aria-expanded={templateOpen}
          onClick={() => setTemplateOpen((o) => !o)}
          className="-ml-1 flex h-6 w-fit items-center gap-1 rounded px-1 text-xs font-medium text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
        >
          <ChevronRight size={13} strokeWidth={2} className={cn('transition-transform duration-100 motion-reduce:transition-none', templateOpen && 'rotate-90')} />
          Use a path template instead
          {!templateOpen && settings.template.trim() && <span className="size-1.5 rounded-full bg-accent" aria-label="Template set" />}
        </button>
        {templateOpen && (
          <Field
            label="Secret path template"
            htmlFor="dbv-vault-template"
            error={err(validation.template)}
            hint="Fills the rows without a path of their own."
            labelAside={
              <span className="flex items-center gap-1">
                {SECRET_PATH_TOKENS.map((token) => (
                  <Tooltip key={token} content={`Insert ${TOKEN_HELP[token].toLowerCase()}`}>
                    <button
                      type="button"
                      onClick={() => insertToken(token)}
                      className="h-[18px] rounded-[4px] bg-active px-1.5 font-mono text-[10.5px] text-muted outline-none transition-colors hover:bg-line-strong hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
                    >
                      {`{${token}}`}
                    </button>
                  </Tooltip>
                ))}
              </span>
            }
          >
            <Input
              ref={templateRef}
              id="dbv-vault-template"
              mono
              value={settings.template}
              placeholder={SECRET_PATH_EXAMPLE}
              invalid={Boolean(err(validation.template))}
              spellCheck={false}
              onChange={(e) => onChange({ template: e.target.value })}
            />
          </Field>
        )}
      </div>
      <p className="-mt-1 text-2xs text-subtle">{METHOD_HINT[method]} Passwords are never imported from DBeaver.</p>
    </fieldset>
  )
}

function SuggestSummary({ state }: { state: SuggestState }) {
  if (state.status === 'idle') {
    return <span className="truncate text-2xs text-subtle">Signs in to Vault and matches each connection to a database mount.</span>
  }
  if (state.status === 'running') {
    return (
      <span className="flex items-center gap-1.5 truncate text-2xs text-muted" role="status">
        <Spinner size={11} />
        {state.loginPending ? 'Waiting for browser sign-in…' : 'Listing the database mounts…'}
      </span>
    )
  }
  if (state.status === 'error') {
    return (
      <span className="min-w-0 truncate text-2xs text-danger" role="alert" title={state.detail ? `${state.message} ${state.detail}` : state.message}>
        {state.message}
      </span>
    )
  }
  const all = state.matched === state.total
  const mounts = `${state.mounts} database ${state.mounts === 1 ? 'mount' : 'mounts'} visible to your token`
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5 text-2xs', all ? 'text-success' : 'text-warning')} role="status" title={mounts}>
      {all ? <CircleCheck size={12} strokeWidth={2} className="shrink-0" /> : <TriangleAlert size={12} strokeWidth={2} className="shrink-0" />}
      <span className="truncate">
        {state.matched} of {state.total} matched{!all && ' · pick the others in their row'}
      </span>
    </span>
  )
}
