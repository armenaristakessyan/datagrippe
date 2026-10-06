// Vault settings of the connection dialog (General section, authentication = Vault): server, sign-in
// method and its credentials, secret path, an Advanced disclosure, and "Fetch credentials" with its result.
import { useEffect, useId, useRef, useState } from 'react'
import { ChevronRight, CircleCheck, ExternalLink, Info, KeyRound, KeySquare, TriangleAlert } from 'lucide-react'
import { DEFAULT_VAULT_AUTH_MOUNT, type VaultLoginMethod, type VaultTestResult } from '@shared/types'
import { Button, Callout, Field, Input, Select, Spinner, Switch } from '@/components/ui'
import { toastError } from '@/components/vault/actions'
import { sameVaultAddress, VAULT_METHOD_OPTIONS } from '@/components/vault/config'
import { SecretPathSuggest, type SecretPathSuggestProps } from '@/components/vault/SecretPathSuggest'
import { describeFetched, signedInVia, vaultMessage } from '@/components/vault/format'
import { cn } from '@/lib/cn'
import { api } from '@/lib/api'
import { formatDuration } from '@/lib/format'
import { useVault } from '@/stores/vault'
import { typeSecret, updateForm, vaultSecretStored, type ConnectionForm, type FormErrors, type VaultForm } from './connection-form'
import { PathInput, SecretInput } from './controls'

export type VaultCheck = { status: 'running' } | { status: 'done'; result: VaultTestResult } | null

export { VAULT_METHOD_OPTIONS }

export const VAULT_METHOD_HINT: Record<VaultLoginMethod, string> = {
  oidc: 'Your SSO, in the browser.',
  // Same order as main (VaultAuth.tokenLogin): the environment and the CLI token win over a typed one.
  token: 'The token of “vault login” (~/.vault-token, or VAULT_TOKEN), like DBeaver’s Vault plugin.',
  ldap: 'Your directory username and password.',
  userpass: 'A Vault username and password.',
}

export interface VaultFieldsProps {
  form: ConnectionForm
  setForm: (updater: (form: ConnectionForm) => ConnectionForm) => void
  errors: FormErrors
  editing: boolean
  check: VaultCheck
  onFetch: () => void
  /** "Suggest" a secret path from the mounts the Vault token can see (vault:discover). */
  suggest?: Pick<SecretPathSuggestProps, 'discover' | 'canStart'>
}

export function VaultFields({ form, setForm, errors, editing, check, onFetch, suggest }: VaultFieldsProps) {
  const v = form.vault
  const vault = (p: Partial<VaultForm>) => setForm((f) => updateForm(f, { vault: { ...f.vault, ...p } }))
  const userLogin = v.loginMethod === 'ldap' || v.loginMethod === 'userpass'
  const tokenMethod = v.loginMethod === 'token'
  const environment = useVault((s) => s.defaults)
  const fromShell = Boolean(environment?.address && sameVaultAddress(environment.address, v.address))
  // The token method's own token is a last resort (the CLI token and the browser come first): Advanced.
  const advancedSet = Boolean(
    v.usernameKey.trim() || v.passwordKey.trim() || v.caPath.trim() || !v.revokeOnDisconnect || (tokenMethod && (v.token.action !== 'keep' || vaultSecretStored(form))),
  )
  const [advancedOpen, setAdvancedOpen] = useState(advancedSet)
  // Fetch credentials found that this Vault behaves differently (e.g. the policy forbids revoking leases).
  const revokeWarnings = check?.status === 'done' && check.result.ok ? (check.result.warnings ?? []) : []
  // An error in the advanced fields, or a warning about them, must be visible.
  useEffect(() => {
    if (errors.vaultKeys) setAdvancedOpen(true)
  }, [errors.vaultKeys])
  useEffect(() => {
    if (revokeWarnings.length > 0) setAdvancedOpen(true)
  }, [revokeWarnings.length])
  const advancedId = useId()
  const running = check?.status === 'running'
  // The stored secret belongs to the sign-in method the connection was saved with.
  const stored = vaultSecretStored(form)
  // Custom auth mount per sign-in method, restored when switching back (Userpass → Token → Userpass).
  const mounts = useRef<Partial<Record<VaultLoginMethod, string>>>({ [v.loginMethod]: v.authMount })
  const changeMethod = (loginMethod: VaultLoginMethod) => {
    mounts.current[v.loginMethod] = v.authMount
    vault({ loginMethod, authMount: mounts.current[loginMethod] ?? '' })
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-panel/40 p-3" role="group" aria-label="Vault settings">
      <p className="flex items-center gap-1.5 text-2xs text-subtle">
        <KeySquare size={12} strokeWidth={2} className="shrink-0 text-accent" />
        User and password are issued by Vault at connect time.
      </p>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.62fr)] gap-3">
        <Field
          label="Vault address"
          htmlFor="cd-vault-address"
          required
          error={errors.vaultAddress}
          hint={fromShell ? `From VAULT_ADDR in your shell${environment?.source === 'env' ? '' : ' profile'}.` : undefined}
        >
          <Input
            id="cd-vault-address"
            mono
            value={v.address}
            placeholder="https://vault.example.com"
            invalid={Boolean(errors.vaultAddress)}
            spellCheck={false}
            onChange={(e) => vault({ address: e.target.value })}
          />
        </Field>
        <Field label="Namespace" htmlFor="cd-vault-namespace">
          <Input id="cd-vault-namespace" mono value={v.namespace} placeholder="Optional" spellCheck={false} onChange={(e) => vault({ namespace: e.target.value })} />
        </Field>
      </div>

      <div className={cn('grid gap-3', v.loginMethod === 'token' ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)_minmax(0,0.62fr)]')}>
        <Field label="Sign-in method" htmlFor="cd-vault-method" hint={VAULT_METHOD_HINT[v.loginMethod]}>
          <Select<VaultLoginMethod>
            id="cd-vault-method"
            value={v.loginMethod}
            // A custom mount belongs to its method: switching keeps each method's own.
            onValueChange={changeMethod}
            options={VAULT_METHOD_OPTIONS}
            className="w-full"
          />
        </Field>
        {v.loginMethod !== 'token' && (
          <Field label="Auth mount" htmlFor="cd-vault-mount" error={errors.vaultMount}>
            <Input
              id="cd-vault-mount"
              mono
              value={v.authMount}
              placeholder={DEFAULT_VAULT_AUTH_MOUNT[v.loginMethod]}
              invalid={Boolean(errors.vaultMount)}
              spellCheck={false}
              onChange={(e) => vault({ authMount: e.target.value })}
            />
          </Field>
        )}
      </div>

      {tokenMethod && <CliTokenStatus found={environment?.cliTokenFile} />}

      {tokenMethod && (
        <Switch
          checked={v.oidcFallback}
          onCheckedChange={(oidcFallback) => vault({ oidcFallback })}
          label="Sign in with the browser when the token is missing or expired"
          description="Same as vault login -method=oidc: no token to paste, nothing written to ~/.vault-token."
          size="sm"
        />
      )}

      {(v.loginMethod === 'oidc' || (tokenMethod && v.oidcFallback)) && (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.62fr)] gap-3">
          <Field label="OIDC role" htmlFor="cd-vault-role" hint="Empty = the mount’s default role.">
            <Input id="cd-vault-role" mono value={v.oidcRole} placeholder="Default role" spellCheck={false} onChange={(e) => vault({ oidcRole: e.target.value })} />
          </Field>
          {tokenMethod && (
            <Field label="OIDC auth mount" htmlFor="cd-vault-mount" error={errors.vaultMount}>
              <Input
                id="cd-vault-mount"
                mono
                value={v.authMount}
                placeholder={DEFAULT_VAULT_AUTH_MOUNT.oidc}
                invalid={Boolean(errors.vaultMount)}
                spellCheck={false}
                onChange={(e) => vault({ authMount: e.target.value })}
              />
            </Field>
          )}
        </div>
      )}

      {userLogin && (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.62fr)] gap-3">
            <Field label="Username" htmlFor="cd-vault-user" required error={errors.vaultUser}>
              <Input
                id="cd-vault-user"
                mono
                value={v.username}
                placeholder="jane.doe"
                invalid={Boolean(errors.vaultUser)}
                spellCheck={false}
                onChange={(e) => vault({ username: e.target.value })}
              />
            </Field>
            <Field
              label="Password"
              htmlFor="cd-vault-password"
              hint={v.password.action === 'clear' ? 'The saved password will be removed.' : undefined}
              labelAside={<ClearSecret show={editing && stored} field={v.password} onChange={(password) => vault({ password })} />}
            >
              <SecretInput
                id="cd-vault-password"
                field={v.password}
                stored={editing && stored}
                placeholder="Asked at sign-in"
                onType={(value) => setForm((f) => updateForm(f, { vault: { ...f.vault, password: typeSecret(f.vault.password, value) } }))}
              />
            </Field>
          </div>
          <SaveSecretSwitch label="Save password" form={form} vault={vault} />
        </>
      )}

      {/* Deep mount paths are long: the input gets the full width, its actions sit on the label row. */}
      <Field
        label="Secret path"
        htmlFor="cd-vault-path"
        required
        error={errors.vaultSecretPath}
        hint="Dynamic role of a database secrets engine (<mount>/creds/<role>) or a KV path. Suggest lists the database mounts your token can see."
        labelAside={
          <span className="flex items-center gap-1">
            {suggest && (
              <SecretPathSuggest
                discover={suggest.discover}
                canStart={suggest.canStart}
                currentPath={v.secretPath}
                disabled={running}
                onPick={(secretPath) => vault({ secretPath })}
              />
            )}
            {/* Signs in and reads the secret without saving; the result shows under the form. */}
            <Button size="xs" variant="secondary" leadingIcon={KeyRound} loading={running} disabled={running} onClick={onFetch}>
              Fetch credentials
            </Button>
          </span>
        }
      >
        <Input
          id="cd-vault-path"
          mono
          value={v.secretPath}
          placeholder="database/creds/read_only"
          invalid={Boolean(errors.vaultSecretPath)}
          spellCheck={false}
          title={v.secretPath || undefined}
          onChange={(e) => vault({ secretPath: e.target.value })}
        />
      </Field>

      <div className="flex flex-col gap-3">
        <button
          type="button"
          aria-expanded={advancedOpen}
          aria-controls={advancedId}
          onClick={() => setAdvancedOpen((o) => !o)}
          className="-ml-1 flex h-6 w-fit items-center gap-1 rounded px-1 text-xs font-medium text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
        >
          <ChevronRight size={13} strokeWidth={2} className={cn('transition-transform duration-100 motion-reduce:transition-none', advancedOpen && 'rotate-90')} />
          Advanced
          {!advancedOpen && advancedSet && <span className="size-1.5 rounded-full bg-accent" aria-label="Customized" />}
        </button>
        {advancedOpen && (
          <div id={advancedId} className="flex flex-col gap-3 border-l border-line pl-3">
            {tokenMethod && (
              <>
                <Field
                  label="Token"
                  htmlFor="cd-vault-token"
                  hint={
                    v.token.action === 'clear'
                      ? 'The saved token will be removed.'
                      : 'Optional. Used only when VAULT_TOKEN and ~/.vault-token (vault login) are missing or rejected.'
                  }
                  labelAside={<ClearSecret show={editing && stored} field={v.token} onChange={(token) => vault({ token })} />}
                >
                  <SecretInput
                    id="cd-vault-token"
                    field={v.token}
                    stored={editing && stored}
                    placeholder="hvs.…"
                    onType={(value) => setForm((f) => updateForm(f, { vault: { ...f.vault, token: typeSecret(f.vault.token, value.trim()) } }))}
                  />
                </Field>
                <SaveSecretSwitch label="Save token" form={form} vault={vault} fullWidth />
              </>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Username key" htmlFor="cd-vault-ukey" hint="KV secrets only.">
                <Input id="cd-vault-ukey" mono value={v.usernameKey} placeholder="username" spellCheck={false} onChange={(e) => vault({ usernameKey: e.target.value })} />
              </Field>
              <Field label="Password key" htmlFor="cd-vault-pkey" error={errors.vaultKeys}>
                <Input
                  id="cd-vault-pkey"
                  mono
                  value={v.passwordKey}
                  placeholder="password"
                  spellCheck={false}
                  invalid={Boolean(errors.vaultKeys)}
                  onChange={(e) => vault({ passwordKey: e.target.value })}
                />
              </Field>
            </div>
            <Switch
              checked={v.revokeOnDisconnect}
              onCheckedChange={(revokeOnDisconnect) => vault({ revokeOnDisconnect })}
              label="Revoke lease on disconnect"
              description="Drops the temporary database user as soon as you disconnect."
              size="sm"
            />
            {v.revokeOnDisconnect && revokeWarnings.length > 0 && (
              <p id="cd-vault-revoke-warning" className="-mt-1 flex items-start gap-1.5 text-2xs text-warning">
                <TriangleAlert size={12} strokeWidth={2} className="mt-px shrink-0" />
                <span>{revokeWarnings.join(' ')}</span>
              </p>
            )}
            <Field
              label="Vault CA certificate"
              htmlFor="cd-vault-ca"
              hint={
                environment?.caPath
                  ? `PEM bundle to verify the Vault server. Empty = VAULT_CACERT (${environment.caPath}) and the macOS Keychain.`
                  : 'PEM bundle to verify the Vault server. Empty = the CAs this Mac trusts (Keychain), like your browser.'
              }
            >
              <PathInput id="cd-vault-ca" value={v.caPath} onChange={(caPath) => vault({ caPath })} pickerTitle="Choose the Vault CA certificate" />
            </Field>
          </div>
        )}
      </div>
    </div>
  )
}

/** Whether `vault login` left a token in ~/.vault-token (the value is never read by the renderer). */
function CliTokenStatus({ found }: { found: boolean | undefined }) {
  if (found === undefined) return null
  return (
    <p className={cn('-mt-1 flex items-start gap-1.5 text-2xs', found ? 'text-success' : 'text-subtle')}>
      {found ? <CircleCheck size={12} strokeWidth={2} className="mt-px shrink-0" /> : <Info size={12} strokeWidth={2} className="mt-px shrink-0" />}
      <span>
        {found ? (
          <>
            <span className="font-mono">~/.vault-token</span> found (from <span className="font-mono">vault login</span>).
          </>
        ) : (
          <>
            No <span className="font-mono">~/.vault-token</span>: run <span className="font-mono">vault login -method=oidc</span> in a terminal, or let
            DataGrippe open the browser.
          </>
        )}
      </span>
    </p>
  )
}

/** "Save password / token": under the secret's column, or left-aligned under a full-width field (token). */
function SaveSecretSwitch({ label, form, vault, fullWidth = false }: { label: string; form: ConnectionForm; vault: (p: Partial<VaultForm>) => void; fullWidth?: boolean }) {
  const toggle = <Switch checked={form.vault.savePassword} onCheckedChange={(savePassword) => vault({ savePassword })} label={label} size="sm" className={fullWidth ? 'w-fit' : 'w-full'} />
  return (
    <div className="-mt-1 flex flex-col gap-1">
      {fullWidth ? (
        toggle
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.62fr)] gap-3">
          <div />
          {toggle}
        </div>
      )}
      {!form.vault.savePassword && (
        <p className="flex items-center gap-1.5 text-2xs text-subtle">
          <Info size={12} strokeWidth={2} className="shrink-0" />
          Asked when signing in; it stays in memory until you quit.
        </p>
      )}
    </div>
  )
}

/** Clear (a stored secret) / Undo link of a secret field's label row. */
function ClearSecret({ show, field, onChange }: { show: boolean; field: VaultForm['token']; onChange: (field: VaultForm['token']) => void }) {
  if (field.action === 'clear') {
    return (
      <button
        type="button"
        onClick={() => onChange({ value: '', action: 'keep' })}
        className="rounded px-1 text-2xs font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
      >
        Undo
      </button>
    )
  }
  if (!show) return null
  return (
    <button
      type="button"
      onClick={() => onChange({ value: '', action: 'clear' })}
      className="rounded px-1 text-2xs font-medium text-subtle outline-none hover:text-danger focus-visible:ring-2 focus-visible:ring-focus"
    >
      Clear
    </button>
  )
}

/** Waiting state (running / browser sign-in) or the outcome of "Fetch credentials". */
export function VaultCheckResult({ check, loginPending, onCancelLogin }: { check: VaultCheck; loginPending: boolean; onCancelLogin: () => void }) {
  if (!check) return null
  if (check.status === 'running') return <PendingRow loginPending={loginPending} label="Signing in to Vault…" onCancelLogin={onCancelLogin} />
  const { result } = check
  if (result.ok && result.info) {
    const info = result.info
    return (
      <div id="cd-vault-result">
        <Callout tone="success" title={signedInVia(info)}>
          <span>
            user <span className="font-mono text-[11px] text-fg">{info.username}</span> · {describeFetched(info)}
          </span>
          {result.latencyMs !== undefined && <span className="text-subtle"> · {formatDuration(result.latencyMs)}</span>}
        </Callout>
        {result.warnings && result.warnings.length > 0 && (
          <Callout tone="warning" title="Works differently than configured" className="mt-2">
            <span className="flex flex-col gap-0.5">
              {result.warnings.map((warning) => (
                <span key={warning}>{warning}</span>
              ))}
            </span>
          </Callout>
        )}
      </div>
    )
  }
  const error = result.error
  return (
    <div id="cd-vault-result">
      <Callout tone="danger" icon={KeySquare} title={error?.kind === 'vault' ? 'Vault' : 'Could not fetch credentials'}>
        <span className="flex flex-col gap-0.5">
          <span>{error?.kind === 'vault' ? vaultMessage(error.message) : (error?.message ?? 'Vault did not return credentials.')}</span>
          {error?.detail && <span>{error.detail}</span>}
          {error?.hint && <span className="text-subtle">{error.hint}</span>}
          {error?.code && <span className="font-mono text-[11px] text-subtle">Code {error.code}</span>}
        </span>
      </Callout>
    </div>
  )
}

/**
 * "Signing in…" or, while the browser sign-in is pending, "Waiting for browser sign-in…" with Open again
 * (the SSO tab was closed or lost: the floating card that offers it is hidden behind the dialog) and Cancel.
 */
export function PendingRow({ loginPending, label, onCancelLogin }: { loginPending: boolean; label: string; onCancelLogin: () => void }) {
  const url = useVault((s) => s.login?.url)
  return (
    <div className="flex h-9 animate-fade-in items-center gap-2 rounded-lg border border-line bg-panel px-3 text-xs text-muted" role="status">
      <Spinner size={13} />
      <span className="min-w-0 flex-1 truncate">{loginPending ? 'Waiting for browser sign-in…' : label}</span>
      {loginPending && (
        <Button
          size="xs"
          variant="ghost"
          leadingIcon={ExternalLink}
          disabled={!url}
          onClick={() => {
            if (url) void api.app.openExternal(url).catch((error) => toastError('Could not open the browser', error))
          }}
        >
          Open again
        </Button>
      )}
      {loginPending && (
        <Button size="xs" variant="ghost" onClick={onCancelLogin}>
          Cancel
        </Button>
      )}
    </div>
  )
}
