// The four sections of the connection dialog. Each one renders fields of the shared ConnectionForm.
import { useEffect, useRef, useState, type ClipboardEvent, type ReactNode, type Ref } from 'react'
import { ClipboardPaste, Info, KeyRound, ShieldAlert, Sparkles } from 'lucide-react'
import { DEFAULT_PORT, DIALECT_LABEL, type ConnectionAuthMode, type Dialect, type SshAuthMethod, type SslMode } from '@shared/types'
import {
  Button,
  Callout,
  DialectIcon,
  Field,
  Input,
  NumberInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioCards,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { looksLikeConnectionString, parseConnectionString, type ParsedConnection } from '@/lib/connection-string'
import {
  applyParsed,
  changeDialect,
  suggestName,
  suggestsSafety,
  typeSecret,
  updateForm,
  type ConnectionForm,
  type FormErrors,
} from './connection-form'
import { ColorPicker, GroupInput, PathInput, SecretInput } from './controls'
import { VaultFields, type VaultFieldsProps } from './VaultFields'

/**
 * The one name of `productionGuard` across the app: this switch, the rail icon, the explorer's shield and the
 * global setting that gates it.
 */
export const PRODUCTION_LABEL = 'Production connection'

export interface SectionProps {
  form: ConnectionForm
  setForm: (updater: (form: ConnectionForm) => ConnectionForm) => void
  errors: FormErrors
  editing: boolean
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex h-5 items-center gap-3">
      <h3 className="text-2xs font-semibold uppercase tracking-[0.08em] text-subtle">{children}</h3>
      <div className="h-px flex-1 bg-line" />
      {aside}
    </div>
  )
}

const DIALECT_OPTIONS = (['postgres', 'mssql'] as const).map((d: Dialect) => ({
  value: d,
  title: DIALECT_LABEL[d],
  description: `Default port ${DEFAULT_PORT[d]}`,
  icon: <DialectIcon dialect={d} size={22} title="" />,
}))

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

const AUTH_MODE_OPTIONS: { value: ConnectionAuthMode; label: string }[] = [
  { value: 'password', label: 'Password' },
  { value: 'vault', label: 'Vault' },
]

export type VaultCheckProps = Pick<VaultFieldsProps, 'check' | 'onFetch' | 'suggest'>

export function GeneralSection({
  form,
  setForm,
  errors,
  editing,
  groups,
  hostRef,
  vaultCheck,
}: SectionProps & { groups: string[]; hostRef: Ref<HTMLInputElement>; vaultCheck: VaultCheckProps }) {
  const vaultMode = form.authMode === 'vault'
  const patch = (p: Partial<ConnectionForm>) => setForm((f) => updateForm(f, p))
  const [filled, setFilled] = useState(false)
  useEffect(() => {
    if (!filled) return
    const t = setTimeout(() => setFilled(false), 2400)
    return () => clearTimeout(t)
  }, [filled])

  const apply = (parsed: ParsedConnection) => {
    setForm((f) => applyParsed(f, parsed))
    setFilled(true)
  }
  const onHostPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text/plain')
    if (!looksLikeConnectionString(text)) return
    const parsed = parseConnectionString(text)
    if (!parsed.ok) return
    e.preventDefault()
    apply(parsed.value)
  }

  return (
    <div className="flex flex-col gap-3.5">
      <RadioCards
        aria-label="Database type"
        value={form.dialect}
        onValueChange={(d) => setForm((f) => changeDialect(f, d))}
        options={DIALECT_OPTIONS}
        columns={2}
        className="[&>button]:py-2.5"
      />

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.72fr)] gap-3">
        <Field label="Name" htmlFor="cd-name" required error={errors.name}>
          <Input
            id="cd-name"
            value={form.name}
            placeholder={suggestName(form) || 'My database'}
            invalid={Boolean(errors.name)}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>
        <Field label="Group" htmlFor="cd-group">
          <GroupInput id="cd-group" value={form.group} groups={groups} onChange={(group) => patch({ group })} />
        </Field>
      </div>

      <Field label="Color">
        <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1.5">
          <ColorPicker value={form.color} onChange={(color) => patch({ color })} />
          {suggestsSafety(form) && (
            <button
              type="button"
              onClick={() => patch({ readOnly: true, productionGuard: true })}
              className="flex h-6 items-center gap-1.5 rounded-md bg-warning-soft px-2 text-xs font-medium text-warning outline-none transition-colors hover:brightness-110 focus-visible:ring-2 focus-visible:ring-focus"
            >
              <ShieldAlert size={13} strokeWidth={2} />
              Production? Enable safety
            </button>
          )}
        </div>
      </Field>

      <SectionTitle
        aside={
          filled ? (
            <span className="flex animate-fade-in items-center gap-1 text-2xs font-medium text-success">
              <Sparkles size={12} strokeWidth={2} />
              Filled from connection string
            </span>
          ) : (
            <PasteConnectionString onApply={apply} />
          )
        }
      >
        Server
      </SectionTitle>

      <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-3">
        <Field label="Host" htmlFor="cd-host" required error={errors.host}>
          <Input
            ref={hostRef}
            id="cd-host"
            mono
            value={form.host}
            placeholder="localhost"
            invalid={Boolean(errors.host)}
            onChange={(e) => patch({ host: e.target.value })}
            onPaste={onHostPaste}
          />
        </Field>
        <Field label="Port" htmlFor="cd-port" error={errors.port}>
          <NumberInput
            id="cd-port"
            value={form.port}
            min={1}
            max={65535}
            allowEmpty
            invalid={Boolean(errors.port)}
            placeholder={String(DEFAULT_PORT[form.dialect])}
            onValueChange={(port) => patch({ port, portEdited: true })}
          />
        </Field>
      </div>

      <div className={cn('grid gap-3', vaultMode ? 'grid-cols-1' : 'grid-cols-2')}>
        <Field label="Database" htmlFor="cd-database">
          <Input
            id="cd-database"
            mono
            value={form.database}
            placeholder={form.dialect === 'postgres' ? 'postgres' : 'default database'}
            onChange={(e) => patch({ database: e.target.value })}
          />
        </Field>
        {!vaultMode && (
          <Field label="User" htmlFor="cd-user">
            <Input
              id="cd-user"
              mono
              value={form.user}
              placeholder={form.dialect === 'postgres' ? 'postgres' : 'sa'}
              onChange={(e) => patch({ user: e.target.value })}
            />
          </Field>
        )}
      </div>

      <SectionTitle
        aside={
          <SegmentedControl
            aria-label="Authentication"
            size="xs"
            value={form.authMode}
            // Both sets of values are kept while switching; only the selected one is saved.
            onValueChange={(authMode) => patch({ authMode })}
            options={AUTH_MODE_OPTIONS}
          />
        }
      >
        Authentication
      </SectionTitle>

      {vaultMode ? (
        <VaultFields form={form} setForm={setForm} errors={errors} editing={editing} {...vaultCheck} />
      ) : (
        <PasswordFields form={form} setForm={setForm} errors={errors} editing={editing} />
      )}
    </div>
  )
}

function PasswordFields({ form, setForm, editing }: SectionProps) {
  const patch = (p: Partial<ConnectionForm>) => setForm((f) => updateForm(f, p))
  return (
    <>
      <div className="grid grid-cols-2 items-end gap-3">
        <Field
          label="Password"
          htmlFor="cd-password"
          hint={form.password.action === 'clear' ? 'The stored password will be removed.' : undefined}
          labelAside={
            editing && form.passwordStored && form.password.action !== 'clear' ? (
              <button
                type="button"
                onClick={() => patch({ password: { value: '', action: 'clear' } })}
                className="rounded px-1 text-2xs font-medium text-subtle outline-none hover:text-danger focus-visible:ring-2 focus-visible:ring-focus"
              >
                Clear
              </button>
            ) : form.password.action === 'clear' ? (
              <button
                type="button"
                onClick={() => patch({ password: { value: '', action: 'keep' } })}
                className="rounded px-1 text-2xs font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
              >
                Undo
              </button>
            ) : undefined
          }
        >
          <SecretInput
            id="cd-password"
            field={form.password}
            stored={editing && form.passwordStored}
            onType={(value) => setForm((f) => updateForm(f, { password: typeSecret(f.password, value) }))}
          />
        </Field>
        <div className={cn('flex h-7 items-center', form.password.action === 'clear' && 'mb-5')}>
          <Switch
            checked={form.savePassword}
            onCheckedChange={(savePassword) => patch({ savePassword })}
            label="Save password"
            className="w-full"
            size="sm"
          />
        </div>
      </div>
      {!form.savePassword && (
        <p className="-mt-1.5 flex items-center gap-1.5 text-2xs text-subtle">
          <Info size={12} strokeWidth={2} className="shrink-0" />
          You will be asked for the password when connecting; it stays in memory until you quit.
        </p>
      )}
    </>
  )
}

function PasteConnectionString({ onApply }: { onApply: (parsed: ParsedConnection) => void }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const result = text.trim() ? parseConnectionString(text) : null
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const apply = () => {
    if (!result?.ok) return
    onApply(result.value)
    setOpen(false)
    setText('')
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) return
        // Prefill from the clipboard when it already holds a connection string.
        void navigator.clipboard
          .readText()
          .then((clip) => {
            if (looksLikeConnectionString(clip)) setText((current) => current || clip.trim())
          })
          .catch(() => undefined)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-5 items-center gap-1 rounded px-1 text-2xs font-medium text-accent outline-none hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-focus"
        >
          <ClipboardPaste size={12} strokeWidth={2} />
          Paste connection string
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[380px]"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          textareaRef.current?.focus()
        }}
      >
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-fg">Paste a connection string</p>
          <Textarea
            ref={textareaRef}
            mono
            rows={3}
            value={text}
            placeholder={'postgres://user:password@host:5432/db?sslmode=require\nServer=host,1433;Database=db;User Id=sa;Password=…'}
            invalid={result?.ok === false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                e.stopPropagation()
                apply()
              }
            }}
            className="resize-none text-[11.5px]"
          />
          <div className="flex min-h-6 items-center gap-2">
            <p className={cn('min-w-0 flex-1 truncate text-2xs', result?.ok === false ? 'text-danger' : 'text-subtle')}>
              {result === null
                ? 'URLs, libpq keywords, ADO.NET and JDBC strings.'
                : result.ok
                  ? describeParsed(result.value)
                  : result.error}
            </p>
            <Button size="xs" variant="primary" disabled={!result?.ok} onClick={apply}>
              Fill form
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function describeParsed(p: ParsedConnection): string {
  const target = `${p.user ? `${p.user}@` : ''}${p.host ?? '…'}${p.instanceName ? `\\${p.instanceName}` : ''}${p.port ? `:${p.port}` : ''}${p.database ? `/${p.database}` : ''}`
  return `${DIALECT_LABEL[p.dialect]} · ${target}`
}

// ---------------------------------------------------------------------------
// SSL
// ---------------------------------------------------------------------------

const SSL_EXPLANATION: Record<Dialect, Record<SslMode, string>> = {
  postgres: {
    disable: 'Plain TCP. Only for trusted local networks.',
    prefer: 'Uses TLS when the server offers it, without verifying the certificate.',
    require: 'TLS is mandatory; the certificate is not verified.',
    'verify-full': 'TLS with the certificate chain and host name verified (optionally against your CA).',
  },
  mssql: {
    disable: 'Encrypt=false. Credentials still use TLS during login.',
    prefer: 'Encrypt=true and TrustServerCertificate=true.',
    require: 'Encrypt=true and TrustServerCertificate=true (self-signed certificates accepted).',
    'verify-full': 'Encrypt=true, TrustServerCertificate=false: the certificate and host name are verified.',
  },
}

const SSL_OPTIONS: { value: SslMode; label: string; hint: string }[] = [
  { value: 'disable', label: 'Disable', hint: 'No TLS' },
  { value: 'prefer', label: 'Prefer', hint: 'TLS if available' },
  { value: 'require', label: 'Require', hint: 'TLS, no verification' },
  { value: 'verify-full', label: 'Verify full', hint: 'TLS, verified' },
]

export function SslSection({ form, setForm }: SectionProps) {
  const ssl = (p: Partial<ConnectionForm['ssl']>) => setForm((f) => updateForm(f, { ssl: { ...f.ssl, ...p } }))
  const pg = form.dialect === 'postgres'
  return (
    <div className="flex flex-col gap-4">
      <Field label="Mode" htmlFor="cd-ssl-mode" hint={SSL_EXPLANATION[form.dialect][form.ssl.mode]}>
        <Select
          id="cd-ssl-mode"
          value={form.ssl.mode}
          onValueChange={(mode) => ssl({ mode })}
          options={SSL_OPTIONS.map((o) => ({ value: o.value, label: o.label, hint: o.hint }))}
          className="w-full"
        />
      </Field>
      <SectionTitle>Certificates</SectionTitle>
      <Field
        label="CA certificate"
        htmlFor="cd-ssl-ca"
        hint={form.ssl.mode === 'verify-full' ? 'PEM bundle used to verify the server. Leave empty to use the system store.' : 'Used with Verify full.'}
      >
        <PathInput id="cd-ssl-ca" value={form.ssl.caPath} onChange={(caPath) => ssl({ caPath })} pickerTitle="Choose a CA certificate" disabled={form.ssl.mode === 'disable'} />
      </Field>
      {pg ? (
        <>
          <Field label="Client certificate" htmlFor="cd-ssl-cert" hint="For servers that require mutual TLS.">
            <PathInput id="cd-ssl-cert" value={form.ssl.certPath} onChange={(certPath) => ssl({ certPath })} pickerTitle="Choose a client certificate" disabled={form.ssl.mode === 'disable'} />
          </Field>
          <Field label="Client key" htmlFor="cd-ssl-key">
            <PathInput
              id="cd-ssl-key"
              value={form.ssl.keyPath}
              onChange={(keyPath) => ssl({ keyPath })}
              pickerTitle="Choose a client key"
              placeholder="/path/to/client.key"
              disabled={form.ssl.mode === 'disable'}
            />
          </Field>
        </>
      ) : (
        <p className="flex items-start gap-1.5 text-2xs leading-4 text-subtle">
          <Info size={12} strokeWidth={2} className="mt-0.5 shrink-0" />
          SQL Server connections authenticate with a user and password; client certificates are not used.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------

const AUTH_OPTIONS: { value: SshAuthMethod; label: string }[] = [
  { value: 'password', label: 'Password' },
  { value: 'privateKey', label: 'Private key' },
  { value: 'agent', label: 'Agent' },
]

export function SshSection({ form, setForm, errors, editing }: SectionProps) {
  const ssh = (p: Partial<ConnectionForm['ssh']>) => setForm((f) => updateForm(f, { ssh: { ...f.ssh, ...p } }))
  const on = form.ssh.enabled
  return (
    <div className="flex flex-col gap-4">
      <Switch
        checked={on}
        onCheckedChange={(enabled) => ssh({ enabled })}
        label="Connect through an SSH tunnel"
        description="The database host and port are resolved from the SSH server."
      />
      <fieldset disabled={!on} className={cn('flex flex-col gap-3.5 transition-opacity', !on && 'opacity-50')}>
        <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-3">
          <Field label="SSH host" htmlFor="cd-ssh-host" required={on} error={on ? errors.sshHost : undefined}>
            <Input id="cd-ssh-host" mono value={form.ssh.host} placeholder="bastion.example.com" invalid={on && Boolean(errors.sshHost)} onChange={(e) => ssh({ host: e.target.value })} />
          </Field>
          <Field label="Port" htmlFor="cd-ssh-port" error={on ? errors.sshPort : undefined}>
            <NumberInput id="cd-ssh-port" value={form.ssh.port} min={1} max={65535} allowEmpty placeholder="22" invalid={on && Boolean(errors.sshPort)} onValueChange={(port) => ssh({ port })} />
          </Field>
        </div>
        <Field label="Username" htmlFor="cd-ssh-user" required={on} error={on ? errors.sshUser : undefined}>
          <Input id="cd-ssh-user" mono value={form.ssh.username} placeholder="ubuntu" invalid={on && Boolean(errors.sshUser)} onChange={(e) => ssh({ username: e.target.value })} />
        </Field>
        <Field label="Authentication">
          <SegmentedControl aria-label="SSH authentication" value={form.ssh.authMethod} onValueChange={(authMethod) => ssh({ authMethod })} options={AUTH_OPTIONS} fill />
        </Field>
        {form.ssh.authMethod === 'privateKey' && (
          <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-3">
            <Field label="Private key" htmlFor="cd-ssh-key" required={on} error={on ? errors.sshKey : undefined}>
              <PathInput id="cd-ssh-key" value={form.ssh.privateKeyPath} onChange={(privateKeyPath) => ssh({ privateKeyPath })} pickerTitle="Choose an SSH private key" placeholder="~/.ssh/id_ed25519" invalid={on && Boolean(errors.sshKey)} />
            </Field>
            <Field label="Passphrase" htmlFor="cd-ssh-passphrase">
              <SecretInput id="cd-ssh-passphrase" field={form.ssh.passphrase} editing={editing} placeholder="Optional" onType={(v) => setForm((f) => updateForm(f, { ssh: { ...f.ssh, passphrase: typeSecret(f.ssh.passphrase, v) } }))} />
            </Field>
          </div>
        )}
        {form.ssh.authMethod === 'password' && (
          <Field label="SSH password" htmlFor="cd-ssh-password" hint={editing ? 'Leave empty to keep the saved password.' : undefined}>
            <SecretInput id="cd-ssh-password" field={form.ssh.password} editing={editing} onType={(v) => setForm((f) => updateForm(f, { ssh: { ...f.ssh, password: typeSecret(f.ssh.password, v) } }))} />
          </Field>
        )}
        {form.ssh.authMethod === 'agent' && (
          <p className="flex items-start gap-1.5 text-2xs leading-4 text-subtle">
            <KeyRound size={12} strokeWidth={2} className="mt-0.5 shrink-0" />
            Keys are provided by the running SSH agent (SSH_AUTH_SOCK), e.g. ssh-agent, 1Password or Secretive.
          </p>
        )}
      </fieldset>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Advanced
// ---------------------------------------------------------------------------

export function AdvancedSection({ form, setForm, errors }: SectionProps) {
  const patch = (p: Partial<ConnectionForm>) => setForm((f) => updateForm(f, p))
  const mssql = form.dialect === 'mssql'
  return (
    <div className="flex flex-col gap-3.5">
      <SectionTitle>Connection</SectionTitle>
      <div className="grid grid-cols-[minmax(0,1fr)_128px] gap-3">
        <Field label="Application name" htmlFor="cd-app">
          <Input id="cd-app" value={form.applicationName} placeholder="DataGrippe" onChange={(e) => patch({ applicationName: e.target.value })} />
        </Field>
        <Field label="Connect timeout" htmlFor="cd-timeout" error={errors.timeout}>
          <NumberInput
            id="cd-timeout"
            value={form.connectTimeoutSec}
            min={1}
            max={600}
            allowEmpty
            placeholder="15"
            invalid={Boolean(errors.timeout)}
            onValueChange={(connectTimeoutSec) => patch({ connectTimeoutSec })}
            trailing={<span className="text-xs text-subtle">s</span>}
          />
        </Field>
      </div>
      <div className={cn('grid gap-3', mssql ? 'grid-cols-2' : 'grid-cols-1')}>
        {mssql && (
          <Field label="Instance name" htmlFor="cd-instance" hint="Named instance, e.g. SQLEXPRESS.">
            <Input id="cd-instance" mono value={form.instanceName} placeholder="Default instance" onChange={(e) => patch({ instanceName: e.target.value })} />
          </Field>
        )}
        <Field label="Default schema" htmlFor="cd-schema" hint={mssql ? 'Revealed in the explorer after connecting.' : 'Sets search_path and is revealed after connecting.'}>
          <Input id="cd-schema" mono value={form.defaultSchema} placeholder={mssql ? 'dbo' : 'public'} onChange={(e) => patch({ defaultSchema: e.target.value })} />
        </Field>
      </div>
      {!mssql && <TimeZoneField value={form.timeZone} onChange={(timeZone) => patch({ timeZone })} />}
      {mssql && form.ssh.enabled && form.instanceName.trim() !== '' && (
        <p className="flex items-start gap-1.5 text-2xs leading-4 text-subtle">
          <Info size={12} strokeWidth={2} className="mt-0.5 shrink-0" />
          Through an SSH tunnel the instance is reached by its TCP port: set Port to the instance’s port (the instance name is not used).
        </p>
      )}
      <Switch
        checked={form.showSystemObjects}
        onCheckedChange={(showSystemObjects) => patch({ showSystemObjects })}
        label="Show system objects"
        description={mssql ? 'master, msdb, sys and INFORMATION_SCHEMA in the explorer.' : 'pg_catalog, information_schema and template databases in the explorer.'}
      />

      <SectionTitle>Safety</SectionTitle>
      {suggestsSafety(form) && (
        <Callout
          tone="warning"
          title="Red usually means production"
          actions={
            <Button size="xs" variant="secondary" onClick={() => patch({ readOnly: true, productionGuard: true })}>
              Enable both
            </Button>
          }
        >
          Make this connection read-only and mark it as a production connection to avoid accidents.
        </Callout>
      )}
      <Switch
        checked={form.readOnly}
        onCheckedChange={(readOnly) => patch({ readOnly })}
        label="Read-only"
        description="Block every statement that may modify data or schema, in consoles and the table editor."
      />
      <Switch
        checked={form.productionGuard}
        onCheckedChange={(productionGuard) => patch({ productionGuard })}
        label={PRODUCTION_LABEL}
        description="Consoles ask before DROP, TRUNCATE, and DELETE or UPDATE without a WHERE clause (see Settings › Query)."
      />
    </div>
  )
}

type TimeZoneMode = 'server' | 'local' | 'custom'

const localZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
  } catch {
    return 'local'
  }
}

/** PostgreSQL session time zone: how timestamptz values are shown in results. */
function TimeZoneField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const stored = value.trim()
  const initial: TimeZoneMode = stored === '' || stored.toLowerCase() === 'server' ? 'server' : stored.toLowerCase() === 'local' ? 'local' : 'custom'
  const [mode, setMode] = useState<TimeZoneMode>(initial)
  const zone = localZone()
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
      <Field label="Session time zone" htmlFor="cd-tz" hint="How timestamptz values are shown.">
        <Select<TimeZoneMode>
          id="cd-tz"
          value={mode}
          onValueChange={(next) => {
            setMode(next)
            onChange(next === 'server' ? '' : next === 'local' ? 'local' : '')
          }}
          options={[
            { value: 'server', label: 'Server default' },
            { value: 'local', label: `Local (${zone})` },
            { value: 'custom', label: 'Other zone…' },
          ]}
        />
      </Field>
      {mode === 'custom' && (
        <Field label="Zone name" htmlFor="cd-tz-name" hint="IANA name, e.g. Europe/Paris or UTC.">
          <Input id="cd-tz-name" mono value={stored.toLowerCase() === 'local' ? '' : value} placeholder="UTC" onChange={(e) => onChange(e.target.value)} />
        </Field>
      )}
    </div>
  )
}
