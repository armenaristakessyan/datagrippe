// Renders the promise-based dialogs queued in useUi().dialogs (confirm, prompt, password) and the
// Vault secret prompts queued in useVault().prompts (Vault token, Vault ldap/userpass password).
// Every answer resolves the request's promise first, then dismisses it.
import { useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, Eye, EyeOff, HelpCircle, KeyRound, PenLine, KeySquare } from 'lucide-react'
import type { DbErrorInfo } from '@shared/types'
import { Button, Callout, CodeBlock, ColorTag, Dialog, DialectIcon, Field, Input, Tooltip } from '@/components/ui'
import { errorInfo } from '@/lib/api'
import { vaultMessage } from '@/components/vault/format'
import { useUi, type ConfirmOptions, type DialogRequest, type PromptOptions } from '@/stores/ui'
import { useVault, type SecretPromptTarget, type VaultSecretField, type VaultSecretRequest } from '@/stores/vault'

export function DialogHost() {
  const dialogs = useUi((s) => s.dialogs)
  const vaultPrompt = useVault((s) => s.prompts[0])
  // Only the oldest request is shown; the rest wait their turn (confirmations first: a host key or a
  // discard question may be what a Vault prompt is waiting for).
  const current = dialogs[0]
  if (current) return <DialogSwitch key={current.id} request={current} />
  if (vaultPrompt) return <VaultPromptHost key={vaultPrompt.id} request={vaultPrompt} />
  return null
}

function VaultPromptHost({ request }: { request: VaultSecretRequest }) {
  const dismiss = useVault((s) => s.dismissPrompt)
  const answered = useRef(false)
  const onAnswer = (value: string | null) => {
    if (answered.current) return
    answered.current = true
    request.resolve(value)
    setTimeout(() => dismiss(request.id), EXIT_MS)
  }
  return (
    <SecretDialog
      field={request.field}
      target={request.target}
      savePassword={request.target.savePassword}
      submit={request.submit}
      initialError={request.error}
      confirmLabel={request.confirmLabel ?? 'Sign in'}
      onAnswer={onAnswer}
    />
  )
}

/** Exit animation length (see --animate-dialog-out) before the request leaves the queue. */
const EXIT_MS = 120

function DialogSwitch({ request }: { request: DialogRequest }) {
  const dismiss = useUi((s) => s.dismissDialog)
  const answered = useRef(false)
  const finish = (resolve: () => void) => {
    if (answered.current) return
    answered.current = true
    resolve()
    setTimeout(() => dismiss(request.id), EXIT_MS)
  }
  switch (request.type) {
    case 'confirm':
      return <ConfirmDialog options={request.options} onAnswer={(v) => finish(() => request.resolve(v))} />
    case 'prompt':
      return <PromptDialog options={request.options} onAnswer={(v) => finish(() => request.resolve(v))} />
    case 'password':
      return (
        <SecretDialog
          field="password"
          target={request.connection}
          user={request.connection.user}
          savePassword={request.connection.savePassword}
          submit={request.submit}
          onAnswer={(v) => finish(() => request.resolve(v))}
        />
      )
  }
}

function ConfirmDialog({ options, onAnswer }: { options: ConfirmOptions; onAnswer: (value: boolean) => void }) {
  const [open, setOpen] = useState(true)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const answer = (value: boolean) => {
    setOpen(false)
    onAnswer(value)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && answer(false)}
      size={options.detail ? 'md' : 'sm'}
      icon={options.danger ? AlertTriangle : HelpCircle}
      tone={options.danger ? 'danger' : 'neutral'}
      title={options.title}
      description={options.message}
      bodyClassName={options.detail ? undefined : 'hidden'}
      onOpenAutoFocus={(e) => {
        // Destructive confirmations focus Cancel so a stray Enter does not run them.
        e.preventDefault()
        ;(options.danger ? cancelRef : confirmRef).current?.focus()
      }}
      footer={
        <>
          <Button ref={cancelRef} variant="ghost" onClick={() => answer(false)}>
            {options.cancelLabel ?? 'Cancel'}
          </Button>
          <Button ref={confirmRef} variant={options.danger ? 'danger' : 'primary'} onClick={() => answer(true)}>
            {options.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      {options.detail && <CodeBlock code={options.detail} maxHeight={240} />}
    </Dialog>
  )
}

function PromptDialog({ options, onAnswer }: { options: PromptOptions; onAnswer: (value: string | null) => void }) {
  const [open, setOpen] = useState(true)
  const [value, setValue] = useState(options.defaultValue ?? '')
  const answer = (v: string | null) => {
    setOpen(false)
    onAnswer(v)
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (value.trim()) answer(value.trim())
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && answer(null)}
      size="sm"
      icon={PenLine}
      title={options.title}
      footer={
        <>
          <Button variant="ghost" onClick={() => answer(null)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="dg-prompt" disabled={!value.trim()}>
            {options.confirmLabel ?? 'OK'}
          </Button>
        </>
      }
    >
      <form id="dg-prompt" onSubmit={submit}>
        <Field label={options.label} htmlFor="dg-prompt-input">
          <Input
            id="dg-prompt-input"
            autoFocus
            value={value}
            placeholder={options.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
          />
        </Field>
      </form>
    </Dialog>
  )
}

type SecretKind = 'password' | VaultSecretField

/** Title, description and label of each kind of secret prompt. */
export function secretPromptCopy(
  field: SecretKind,
  target: Pick<SecretPromptTarget, 'vault'>,
  savePassword?: boolean,
): { title: string; description: string; label: string; hint?: string } {
  // Where the typed secret goes (unknown for a Vault prompt opened without a connection: said nothing).
  const kept = savePassword === undefined ? '' : savePassword ? ' It will be stored encrypted for next time.' : ' It is kept in memory until you quit DataGrippe.'
  if (field === 'vaultToken') {
    return {
      title: 'Vault token',
      description: `Paste a token for ${target.vault?.address ?? 'Vault'}.${kept}`,
      label: 'Token',
      hint: 'Or run “vault login” in a terminal: the CLI token (~/.vault-token) is used next time.',
    }
  }
  if (field === 'vaultPassword') {
    const user = target.vault?.username
    const where = target.vault?.address ?? 'Vault'
    return {
      title: 'Vault password',
      description: `${user ? `For ${user} on ${where}.` : `For ${where}.`}${kept}`,
      label: 'Vault password',
    }
  }
  return {
    title: 'Password required',
    description: kept.trim() || 'It is kept in memory until you quit DataGrippe.',
    label: 'Password',
  }
}

function SecretDialog({
  field,
  target,
  user,
  savePassword,
  submit,
  confirmLabel = 'Connect',
  initialError,
  onAnswer,
}: {
  initialError?: DbErrorInfo
  field: SecretKind
  target: SecretPromptTarget
  /** Database user shown in the connection card (password prompts). */
  user?: string
  savePassword?: boolean
  submit?: (password: string) => Promise<void>
  confirmLabel?: string
  onAnswer: (value: string | null) => void
}) {
  const copy = secretPromptCopy(field, target, savePassword)
  const vault = field !== 'password'
  const [open, setOpen] = useState(true)
  const [value, setValue] = useState('')
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<DbErrorInfo | null>(initialError ?? null)
  const inputRef = useRef<HTMLInputElement>(null)
  const answer = (v: string | null) => {
    setOpen(false)
    onAnswer(v)
  }
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    // A pasted token often carries a trailing newline.
    const password = field === 'vaultToken' ? value.trim() : value
    // An empty Vault secret is never an answer (it would re-prompt silently, or clear a stored one).
    if (vault && !password) return
    if (!submit) {
      answer(password)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await submit(password)
      answer(password)
    } catch (failure) {
      setError(errorInfo(failure))
      setBusy(false)
      // Keep the typed text so a typo can be fixed; select it so retyping replaces it.
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }
  const where = `${user ? `${user}@` : ''}${target.host}:${target.port}`
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !busy && answer(null)}
      size="sm"
      icon={vault ? KeySquare : KeyRound}
      tone="accent"
      title={copy.title}
      description={copy.description}
      footer={
        <>
          <Button variant="ghost" onClick={() => answer(null)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="dg-password" loading={busy} disabled={vault && !(field === 'vaultToken' ? value.trim() : value)}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form id="dg-password" onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
        <div className="flex items-center gap-2.5 rounded-lg border border-line bg-panel px-3 py-2">
          <DialectIcon dialect={target.dialect} size={20} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-sm font-medium text-fg">
              <ColorTag color={target.color} />
              <span className="truncate">{target.name}</span>
            </div>
            <div className="truncate font-mono text-2xs text-subtle">{where}</div>
          </div>
        </div>
        <Field label={copy.label} htmlFor="dg-password-input" hint={error ? undefined : copy.hint}>
          <Input
            ref={inputRef}
            id="dg-password-input"
            mono={field === 'vaultToken' && shown}
            type={shown ? 'text' : 'password'}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={value}
            invalid={error !== null}
            readOnly={busy}
            aria-describedby={error ? 'dg-password-error' : undefined}
            onChange={(e) => {
              setValue(e.target.value)
              if (error) setError(null)
            }}
            trailing={
              <Tooltip content={shown ? 'Hide' : 'Show'}>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={shown ? 'Hide' : 'Show'}
                  aria-pressed={shown}
                  disabled={busy}
                  onClick={() => setShown((v) => !v)}
                  className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded text-subtle outline-none hover:bg-active hover:text-fg"
                >
                  {shown ? <EyeOff size={13} strokeWidth={1.75} /> : <Eye size={13} strokeWidth={1.75} />}
                </button>
              </Tooltip>
            }
          />
        </Field>
        {error && (
          <div id="dg-password-error">
            <Callout tone="danger" title={vault ? vaultMessage(error.message) : error.message}>
              {vault && error.detail ? vaultMessage(error.detail) : (error.detail ?? error.hint)}
            </Callout>
          </div>
        )}
      </form>
    </Dialog>
  )
}
