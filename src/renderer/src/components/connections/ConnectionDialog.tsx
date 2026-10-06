// Create/edit connection dialog (driven by useUi().connectionDialog): section rail (General · SSL ·
// SSH · Advanced), inline validation, connection test, dirty-state guard, save / save & connect.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Tabs as RadixTabs } from 'radix-ui'
import { Lock, Network, PlugZap, Server, ShieldAlert, ShieldCheck, SlidersHorizontal, KeySquare, type LucideIcon } from 'lucide-react'
import {
  DIALECT_LABEL,
  type ConnectionInput,
  type ConnectionSecrets,
  type DbErrorInfo,
  type TestConnectionResult,
  type VaultDefaults,
  type VaultDiscoverResult,
  type VaultTestResult,
} from '@shared/types'
import { nodeIds } from '@/components/explorer/tree'
import { Button, Callout, DialectIcon, Dialog, toast, Tooltip } from '@/components/ui'
import { toastError } from '@/components/vault/actions'
import { vaultMessage } from '@/components/vault/format'
import type { DiscoverOutcome } from '@/components/vault/SecretPathSuggest'
import { cancelVaultLogin } from '@/components/vault/VaultLoginOverlay'
import { confirmHostKey } from '@/lib/host-key'
import { api, errorInfo } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/format'
import { connectionById, useConnections } from '@/stores/connections'
import { useExplorer } from '@/stores/explorer'
import { useUi } from '@/stores/ui'
import { useVault } from '@/stores/vault'
import {
  emptyForm,
  FIELD_SECTION,
  formFromConfig,
  formToInput,
  isDirty,
  newVaultDefaults,
  prefillVault,
  updateForm,
  validateForm,
  validateVault,
  type ConnectionForm,
  type FieldKey,
  type FormErrors,
  type SectionId,
} from './connection-form'
import { fillPromptedSecret, promptedVaultSecret, vaultPromptOpening } from './vault-prompt'
import { AdvancedSection, GeneralSection, PRODUCTION_LABEL, SshSection, SslSection } from './sections'
import { PendingRow, VaultCheckResult, type VaultCheck } from './VaultFields'

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: 'general', label: 'General', icon: Server },
  { id: 'ssl', label: 'SSL', icon: ShieldCheck },
  { id: 'ssh', label: 'SSH', icon: Network },
  { id: 'advanced', label: 'Advanced', icon: SlidersHorizontal },
]

const SSL_SHORT = { disable: 'Off', prefer: 'Prefer', require: 'Require', 'verify-full': 'Verify' } as const

export function ConnectionDialog() {
  const state = useUi((s) => s.connectionDialog)
  // A new session (fresh form) every time the dialog opens; the old one stays mounted to animate out.
  const [session, setSession] = useState(0)
  const [wasOpen, setWasOpen] = useState(false)
  if (state.open !== wasOpen) {
    setWasOpen(state.open)
    if (state.open) setSession((s) => s + 1)
  }
  if (session === 0) return null
  return <ConnectionDialogSession key={session} open={state.open} editId={state.editId} dialect={state.dialect} group={state.group} />
}

/** Scroll a field into view once the result strip has rendered. */
function revealField(id: string): void {
  requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'nearest' }))
}

type TestState = { status: 'running' } | { status: 'done'; result: TestConnectionResult } | null

function ConnectionDialogSession({
  open,
  editId,
  dialect,
  group,
}: {
  open: boolean
  editId?: string
  dialect?: 'postgres' | 'mssql'
  group?: string
}) {
  const existing = editId ? connectionById(editId) : undefined
  const editing = existing !== undefined
  const freshForm = (environment: VaultDefaults | null) =>
    // A new connection reuses the Vault server settings of the last Vault connection saved, else the vault
    // CLI's environment (VAULT_ADDR of the shell profile, ~/.vault-token).
    prefillVault(updateForm(emptyForm(dialect), group ? { group } : {}), newVaultDefaults(useConnections.getState().connections, environment))
  const computedInitial = useMemo(
    () => (existing ? formFromConfig(existing) : freshForm(useVault.getState().defaults)),
    [existing, dialect, group],
  )
  const [initial, setInitial] = useState<ConnectionForm>(computedInitial)
  const [form, setFormState] = useState<ConnectionForm>(computedInitial)
  // The environment arrived after the dialog opened (just after startup): prefill while nothing was typed.
  const environment = useVault((s) => s.defaults)
  const prefilledWith = useRef(useVault.getState().defaults)
  useEffect(() => {
    if (editing || !environment || prefilledWith.current === environment) return
    prefilledWith.current = environment
    if (isDirty(initial, form)) return
    const next = freshForm(environment)
    setInitial(next)
    setFormState(next)
  }, [environment, editing, initial, form])
  const [section, setSection] = useState<SectionId>('general')
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState<'save' | 'connect' | null>(null)
  const [saveError, setSaveError] = useState<DbErrorInfo | null>(null)
  const [test, setTest] = useState<TestState>(null)
  const [vaultCheck, setVaultCheck] = useState<VaultCheck>(null)
  const testRun = useRef(0)
  const vaultLogin = useVault((s) => s.login)
  const loginPending = vaultLogin !== null && (test?.status === 'running' || vaultCheck?.status === 'running')
  const hostRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLDivElement>(null)

  const connections = useConnections((s) => s.connections)
  const groups = useMemo(
    () => [...new Set(connections.map((c) => c.group?.trim()).filter((g): g is string => Boolean(g)))].sort((a, b) => a.localeCompare(b)),
    [connections],
  )

  const errors = validateForm(form)
  const visibleErrors: FormErrors = submitted ? errors : {}
  const sectionHasError = (id: SectionId) => (Object.keys(visibleErrors) as FieldKey[]).some((k) => FIELD_SECTION[k] === id)

  const setForm = (updater: (f: ConnectionForm) => ConnectionForm) => {
    setFormState(updater)
    // Results describe the settings they ran with: any change makes them stale.
    testRun.current++
    setTest(null)
    setVaultCheck(null)
    setSaveError(null)
  }

  /**
   * Run a test; when main needs a Vault token / password that is not stored, ask for it and run it
   * again with that secret (also filled into the form, so saving keeps it). Null = prompt cancelled.
   */
  const withVaultPrompts = async <R extends { ok: boolean; error?: DbErrorInfo }>(
    run: number,
    attempt: (input: ConnectionInput) => Promise<R>,
  ): Promise<R | null> => {
    const extra: ConnectionSecrets = {}
    for (let round = 0; ; round++) {
      const input = formToInput(form, editId)
      const result = await attempt({ ...input, secrets: { ...input.secrets, ...extra } })
      const field = promptedVaultSecret(result)
      if (!field || round >= 3 || run !== testRun.current) return result
      // A value was refused (typed now, or stored / VAULT_TOKEN / ~/.vault-token): say so in the prompt.
      const error = vaultPromptOpening(result, Boolean(input.secrets?.[field] || extra[field]))
      const value = await useVault.getState().askSecret({
        field,
        target: input,
        confirmLabel: 'Continue',
        ...(error ? { error } : {}),
      })
      if (value === null || run !== testRun.current) return null
      extra[field] = value
      setFormState((f) => fillPromptedSecret(f, field, value))
    }
  }

  // Editing a connection deleted meanwhile: nothing to edit.
  useEffect(() => {
    if (open && editId && !existing) useUi.getState().closeConnectionDialog()
  }, [open, editId, existing])

  const close = () => useUi.getState().closeConnectionDialog()

  const requestClose = async () => {
    if (saving) return
    if (isDirty(initial, form)) {
      const discard = await useUi.getState().confirm({
        title: editing ? 'Discard your changes?' : 'Discard this connection?',
        message: editing ? `Edits to “${existing?.name}” will be lost.` : 'The settings you entered will be lost.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        danger: true,
      })
      if (!discard) return
    }
    close()
  }

  /** Vault settings must be valid before asking Vault anything: show their errors instead. */
  const vaultInvalid = () => {
    if (form.authMode !== 'vault' || Object.keys(validateVault(form.vault)).length === 0) return false
    setSubmitted(true)
    setSection('general')
    return true
  }

  const runTest = async () => {
    if (vaultInvalid()) return
    const run = ++testRun.current
    setTest({ status: 'running' })
    setVaultCheck(null)
    let result: TestConnectionResult | null
    try {
      result = await withVaultPrompts(run, (input) => api.connections.test(input))
      // An unknown SSH host key: confirm its fingerprint, trust it, and test again.
      if (result && !result.ok && result.error?.kind === 'needs-host-key' && result.error.hostKey && run === testRun.current) {
        if (await confirmHostKey(result.error.hostKey)) result = await withVaultPrompts(run, (input) => api.connections.test(input))
      }
    } catch (error) {
      result = { ok: false, error: errorInfo(error) }
    }
    if (run !== testRun.current) return
    // Prompt or browser sign-in cancelled: nothing to report.
    if (result === null || result.error?.kind === 'cancelled') {
      setTest(null)
      return
    }
    setTest({ status: 'done', result })
    // The fields to fix (credentials) stay visible above the result, even in a short window.
    if (!result.ok && section === 'general') revealField(form.authMode === 'vault' ? 'cd-vault-path' : 'cd-password')
  }

  const fetchCredentials = async () => {
    if (vaultInvalid()) return
    const run = ++testRun.current
    setVaultCheck({ status: 'running' })
    setTest(null)
    let result: VaultTestResult | null
    try {
      result = await withVaultPrompts(run, (input) => api.vault.test(input))
    } catch (error) {
      result = { ok: false, error: errorInfo(error) }
    }
    if (run !== testRun.current) return
    if (result === null || result.error?.kind === 'cancelled') {
      setVaultCheck(null)
      return
    }
    setVaultCheck({ status: 'done', result })
    // Keep the secret path and Fetch credentials visible above the error, even in a short window.
    if (!result.ok && section === 'general') revealField('cd-vault-path')
  }

  /** Vault server settings (everything but the secret path) must be valid before listing its mounts. */
  const vaultServerInvalid = () => {
    if (form.authMode !== 'vault') return true
    const { vaultSecretPath: _ignored, ...problems } = validateVault(form.vault)
    if (Object.keys(problems).length === 0) return false
    setSubmitted(true)
    setSection('general')
    return true
  }

  /** "Suggest": sign in like Fetch credentials (prompts included) and list the mounts the token sees. */
  const discoverPaths = async (role: string): Promise<DiscoverOutcome> => {
    const run = ++testRun.current
    setTest(null)
    setVaultCheck(null)
    type Attempt = { ok: boolean; error?: DbErrorInfo; result?: VaultDiscoverResult }
    let outcome: Attempt | null
    try {
      outcome = await withVaultPrompts<Attempt>(run, async (input) => {
        if (!input.vault) return { ok: false, error: { message: 'Vault settings are required.', kind: 'invalid-input' } }
        try {
          const result = await api.vault.discover({
            vault: input.vault,
            ...(editId ? { connectionId: editId } : {}),
            ...(input.secrets ? { secrets: input.secrets } : {}),
            role,
            targets: [{ key: 'self', dialect: input.dialect, host: input.host, database: input.database, name: input.name, ...(input.group ? { group: input.group } : {}) }],
          })
          return { ok: true, result }
        } catch (error) {
          return { ok: false, error: errorInfo(error) }
        }
      })
    } catch (error) {
      outcome = { ok: false, error: errorInfo(error) }
    }
    if (outcome === null || outcome.error?.kind === 'cancelled') return null
    if (outcome.ok && outcome.result) return { ok: true, result: outcome.result }
    return { ok: false, error: outcome.error ?? { message: 'Vault did not answer.', kind: 'vault' } }
  }

  const submit = async (connectAfter: boolean) => {
    setSubmitted(true)
    const keys = Object.keys(errors) as FieldKey[]
    if (keys.length > 0) {
      const first = keys[0]!
      setSection(FIELD_SECTION[first])
      return
    }
    setSaving(connectAfter ? 'connect' : 'save')
    setSaveError(null)
    try {
      const saved = await useConnections.getState().save(formToInput(form, editId))
      toast.success(editing ? 'Connection updated' : 'Connection saved', { description: saved.name })
      useExplorer.getState().select(nodeIds.connection(saved.id))
      close()
      if (connectAfter) {
        // The explorer reveals the default database / schema once the connection is up.
        void useConnections
          .getState()
          .connect(saved.id)
          .catch((error) => toastError(`Could not connect to ${saved.name}`, error, saved.name))
      }
    } catch (error) {
      setSaveError(errorInfo(error))
    } finally {
      setSaving(null)
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void submit(true)
  }

  const title = editing ? 'Edit connection' : `New ${DIALECT_LABEL[form.dialect]} connection`
  const busy = saving !== null

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void requestClose()
      }}
      size="lg"
      flush
      modalLock
      icon={<DialectIcon dialect={form.dialect} size={32} title="" />}
      title={title}
      description={editing ? existing?.name : 'Connection settings are stored locally; passwords are encrypted by the OS keychain.'}
      onOpenAutoFocus={(e) => {
        e.preventDefault()
        const target = editing ? nameRef.current?.querySelector('input') : hostRef.current
        target?.focus()
        target?.select()
      }}
      bodyClassName="mt-3 flex min-h-0 flex-col overflow-hidden border-t border-line"
      footer={
        <>
          <Button
            variant="secondary"
            leadingIcon={PlugZap}
            loading={test?.status === 'running'}
            onClick={() => void runTest()}
            disabled={busy}
            className="mr-auto"
          >
            Test connection
          </Button>
          <Button variant="ghost" onClick={() => void requestClose()} disabled={busy}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => void submit(false)} loading={saving === 'save'} disabled={busy}>
            Save
          </Button>
          <Button variant="primary" type="submit" form="dg-connection-form" loading={saving === 'connect'} disabled={busy}>
            Save & connect
          </Button>
        </>
      }
    >
      <RadixTabs.Root
        value={section}
        onValueChange={(v) => {
          const next = SECTIONS.find((s) => s.id === v)
          if (next) setSection(next.id)
        }}
        orientation="vertical"
        // Fixed height (stable across sections); it only gives way when the test result below needs
        // room in a short window, and the form then scrolls.
        className="flex h-[min(468px,calc(80vh-150px))] min-h-[120px] shrink"
      >
        <RadixTabs.List aria-label="Connection settings" className="flex w-[156px] shrink-0 flex-col gap-0.5 border-r border-line bg-panel/50 p-2">
          {SECTIONS.map((s) => (
            <RadixTabs.Trigger
              key={s.id}
              value={s.id}
              className={cn(
                'group flex h-7 items-center gap-2 rounded-md px-2 text-left text-sm text-muted outline-none transition-colors',
                'hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus',
                'data-[state=active]:bg-active data-[state=active]:text-fg',
              )}
            >
              <s.icon size={14} strokeWidth={1.75} className="shrink-0 text-subtle group-data-[state=active]:text-accent" />
              <span className="min-w-0 flex-1 truncate">{s.label}</span>
              <RailAdornment section={s.id} form={form} error={sectionHasError(s.id)} />
            </RadixTabs.Trigger>
          ))}
        </RadixTabs.List>

        <form id="dg-connection-form" onSubmit={onSubmit} noValidate className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]" ref={nameRef}>
            <RadixTabs.Content value="general" className="outline-none">
              <GeneralSection
                form={form}
                setForm={setForm}
                errors={visibleErrors}
                editing={editing}
                groups={groups}
                hostRef={hostRef}
                vaultCheck={{
                  check: vaultCheck,
                  onFetch: () => void fetchCredentials(),
                  suggest: { discover: discoverPaths, canStart: () => !vaultServerInvalid() },
                }}
              />
            </RadixTabs.Content>
            <RadixTabs.Content value="ssl" className="outline-none">
              <SslSection form={form} setForm={setForm} errors={visibleErrors} editing={editing} />
            </RadixTabs.Content>
            <RadixTabs.Content value="ssh" className="outline-none">
              <SshSection form={form} setForm={setForm} errors={visibleErrors} editing={editing} />
            </RadixTabs.Content>
            <RadixTabs.Content value="advanced" className="outline-none">
              <AdvancedSection form={form} setForm={setForm} errors={visibleErrors} editing={editing} />
            </RadixTabs.Content>
          </div>
        </form>
      </RadixTabs.Root>
      {/* Below the form, not inside it: the result adds height to the dialog instead of hiding fields. */}
      <StatusStrip test={test} vaultCheck={vaultCheck} saveError={saveError} loginPending={loginPending} onCancelLogin={() => void cancelVaultLogin()} />
    </Dialog>
  )
}

function RailAdornment({ section, form, error }: { section: SectionId; form: ConnectionForm; error: boolean }) {
  if (error) return <span aria-label="Has errors" className="size-1.5 shrink-0 rounded-full bg-danger" />
  if (section === 'advanced') {
    // Icons, not words: the rail is narrow and the section name must never truncate.
    if (!form.readOnly && !form.productionGuard) return null
    return (
      <span className="flex shrink-0 items-center gap-1 text-warning">
        {form.readOnly && (
          <Tooltip content="Read-only" side="right">
            <Lock size={12} strokeWidth={2} aria-label="Read-only" />
          </Tooltip>
        )}
        {form.productionGuard && (
          <Tooltip content={PRODUCTION_LABEL} side="right">
            <ShieldAlert size={12} strokeWidth={2} aria-label={PRODUCTION_LABEL} />
          </Tooltip>
        )}
      </span>
    )
  }
  let text: ReactNode = null
  if (section === 'ssl') text = SSL_SHORT[form.ssl.mode]
  if (section === 'ssh' && form.ssh.enabled) text = 'On'
  if (!text) return null
  return <span className="shrink-0 text-2xs text-subtle">{text}</span>
}

function StatusStrip({
  test,
  vaultCheck,
  saveError,
  loginPending,
  onCancelLogin,
}: {
  test: TestState
  vaultCheck: VaultCheck
  saveError: DbErrorInfo | null
  loginPending: boolean
  onCancelLogin: () => void
}) {
  let content: ReactNode = null
  if (saveError) {
    content = (
      <Callout tone="danger" title="Could not save the connection">
        {saveError.message}
      </Callout>
    )
  } else if (vaultCheck) {
    content = <VaultCheckResult check={vaultCheck} loginPending={loginPending} onCancelLogin={onCancelLogin} />
  } else if (test?.status === 'running') {
    content = <PendingRow loginPending={loginPending} label="Testing connection…" onCancelLogin={onCancelLogin} />
  } else if (test?.status === 'done') {
    const { result } = test
    if (result.ok && result.info) {
      const info = result.info
      content = (
        <Callout tone="success" title={`Connected to ${DIALECT_LABEL[info.dialect]} ${info.versionShort}`}>
          <span className="font-mono text-[11px]">
            {info.currentUser}@{info.currentDatabase}
            {info.currentSchema ? ` · ${info.currentSchema}` : ''}
          </span>
          {result.latencyMs !== undefined && <span className="text-subtle"> · {formatDuration(result.latencyMs)}</span>}
        </Callout>
      )
    } else {
      const error = result.error
      const isVault = error?.kind === 'vault'
      content = (
        <Callout tone="danger" icon={isVault ? KeySquare : undefined} title={isVault ? 'Vault' : (error?.message ?? 'Connection failed')}>
          {(isVault || error?.code || error?.detail || error?.hint) && (
            <span className="flex flex-col gap-0.5">
              {isVault && <span>{vaultMessage(error?.message)}</span>}
              {error?.detail && <span>{error.detail}</span>}
              {error?.hint && <span className="text-subtle">{error.hint}</span>}
              {error?.code && <span className="font-mono text-[11px] text-subtle">Code {error.code}</span>}
            </span>
          )}
        </Callout>
      )
    }
  }
  if (!content) return null
  return <div className="max-h-32 shrink-0 animate-fade-in overflow-y-auto border-t border-line px-5 py-3">{content}</div>
}
