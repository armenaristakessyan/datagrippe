// "Import from DBeaver" dialog (driven by useUi().dbeaverImportOpen): scans DBeaver's data-sources*.json
// (default workspace or a chosen file), lists the connections grouped by DBeaver folder, collects the
// Vault settings the imported Vault connections share, and saves the selection one by one.
// DBeaver's credentials files are never read (main side): no password is imported.
// "Import from DataGrip" (useUi().datagripImportOpen) is the same dialog reading the data sources DataGrip copies
// to the clipboard, pasted as text; their groups play the part of the folders.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ClipboardPaste, FileSearch, FolderOpen, Import, RefreshCw, Search, TriangleAlert } from 'lucide-react'
import type { ConnectionConfig, ConnectionSecrets, DbErrorInfo, DbeaverImportCandidate, DbeaverScanResult, VaultDiscoverResult, VaultPathSuggestion } from '@shared/types'
import { nodeIds } from '@/components/explorer/tree'
import { Button, Callout, Dialog, EmptyState, Input, Skeleton, Spinner, Textarea, toast, Tooltip } from '@/components/ui'
import { DEFAULT_DISCOVERY_ROLE } from '@/components/vault/config'
import { vaultMessage } from '@/components/vault/format'
import { SecretPathSuggest } from '@/components/vault/SecretPathSuggest'
import { api, errorInfo, errorMessage } from '@/lib/api'
import { cn } from '@/lib/cn'
import { focusExplorerTree } from '@/lib/focus'
import { hostPlatform, isMac } from '@/lib/platform'
import { pluralize } from '@/lib/format'
import { useConnections } from '@/stores/connections'
import { useExplorer } from '@/stores/explorer'
import { useUi } from '@/stores/ui'
import { useVault, vaultPromptError } from '@/stores/vault'
import { CandidateList, type RowOutcome } from './CandidateList'
import {
  applySuggestions,
  buildInput,
  candidateKey,
  discoveryTargets,
  defaultTemplate,
  defaultWorkspaceLabel,
  expandSecretPath,
  fillFromCandidates,
  groupCandidates,
  initialOverrides,
  initialSelection,
  isImportable,
  majorityVaultDialect,
  panelVaultConfig,
  recentVaultConnection,
  rowSecretPath,
  secretPathValues,
  selectedCandidates,
  setSelected as applySelection,
  shortenPath,
  usesVault,
  validateImport,
  vaultDefaultsFrom,
  withEnvironment,
  type VaultImportSettings,
} from './dbeaver-import'
import { useDbeaverImportCommand } from './useDbeaverImportCommand'
import { VaultImportPanel, type SuggestState } from './VaultImportPanel'

/** Folders can only be picked with files on macOS (files:pickPath 'any'). */
const CHOOSE_LABEL = isMac() ? 'Choose file or folder…' : 'Choose file…'

/** Show the filter box from this many candidates. */
const FILTER_FROM = 8

type ImportSource = 'dbeaver' | 'datagrip'

const SOURCE_TEXT: Record<ImportSource, { title: string; description: string; list: string; filter: string; warningsFrom: string; none: string }> = {
  dbeaver: {
    title: 'Import from DBeaver',
    description: 'Copies connection settings and folders. Passwords are never imported: Vault connections get fresh credentials each time they connect.',
    list: 'DBeaver connections',
    filter: 'Filter DBeaver connections',
    warningsFrom: 'DBeaver’s files',
    none: 'No DBeaver connection matches this filter.',
  },
  datagrip: {
    title: 'Import from DataGrip',
    description: 'Copies connection settings and groups. Passwords are never imported: enter them when a connection opens.',
    list: 'DataGrip data sources',
    filter: 'Filter DataGrip data sources',
    warningsFrom: 'the pasted data sources',
    none: 'No data source matches this filter.',
  },
}

function setImportOpen(source: ImportSource, open: boolean): void {
  if (source === 'dbeaver') useUi.getState().setDbeaverImportOpen(open)
  else useUi.getState().setDatagripImportOpen(open)
}

export function DbeaverImportDialog() {
  useDbeaverImportCommand()
  return <ImportDialog source="dbeaver" />
}

/** The same dialog, reading the data sources copied in DataGrip and pasted as text. */
export function DatagripImportDialog() {
  return <ImportDialog source="datagrip" />
}

function ImportDialog({ source }: { source: ImportSource }) {
  const open = useUi((s) => (source === 'dbeaver' ? s.dbeaverImportOpen : s.datagripImportOpen))
  // A fresh session (new scan, new selection) every time the dialog opens; the old one animates out.
  const [session, setSession] = useState(0)
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setSession((s) => s + 1)
  }
  if (session === 0) return null
  return <ImportSession key={session} open={open} source={source} />
}

type ScanState =
  | { status: 'paste' }
  | { status: 'loading'; path?: string }
  | { status: 'ready'; path?: string; result: DbeaverScanResult }
  | { status: 'error'; path?: string; error: DbErrorInfo }

function ImportSession({ open, source }: { open: boolean; source: ImportSource }) {
  const text = SOURCE_TEXT[source]
  const [scan, setScan] = useState<ScanState>(source === 'datagrip' ? { status: 'paste' } : { status: 'loading' })
  const [pasted, setPasted] = useState('')
  const scanRun = useRef(0)
  const [selected, setSelectedKeys] = useState<Set<string>>(new Set())
  const [overrides, setOverrides] = useState<Map<string, string>>(new Map())
  const [outcomes, setOutcomes] = useState<Map<string, RowOutcome>>(new Map())
  const [query, setQuery] = useState('')
  // Errors appear once the user starts filling the Vault settings (panel) / secret paths (rows).
  const [showErrors, setShowErrors] = useState(false)
  const [showRowErrors, setShowRowErrors] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [picking, setPicking] = useState(false)

  const connections = useConnections((s) => s.connections)
  // Vault defaults: copied once from the most recent Vault connection, else the vault CLI's environment
  // (VAULT_ADDR of the shell profile, ~/.vault-token), then the user's.
  const [prefill] = useState(() => {
    const all = useConnections.getState().connections
    const recent = recentVaultConnection(all)?.name
    const base = vaultDefaultsFrom(all)
    if (recent) return { settings: base, from: `“${recent}”` }
    const settings = withEnvironment(base, useVault.getState().defaults)
    return { settings, from: settings !== base ? 'VAULT_ADDR in your shell' : undefined }
  })
  const [settings, setSettings] = useState<VaultImportSettings>(prefill.settings)
  const [prefilledFrom, setPrefilledFrom] = useState(prefill.from)
  const environment = useVault((s) => s.defaults)
  // The environment arrived after the dialog opened: fill the address while the panel is untouched.
  useEffect(() => {
    if (!environment || settings !== prefill.settings) return
    const next = withEnvironment(settings, environment)
    if (next === settings) return
    setSettings(next)
    setPrefilledFrom('VAULT_ADDR in your shell')
  }, [environment, settings, prefill.settings])

  // "Suggest paths from Vault"
  const [suggest, setSuggest] = useState<SuggestState>({ status: 'idle' })
  const [discovered, setDiscovered] = useState<VaultDiscoverResult | null>(null)
  const [suggested, setSuggested] = useState<Map<string, VaultPathSuggestion>>(new Map())
  const loginPending = useVault((s) => s.login !== null)

  const close = () => {
    if (progress) return
    setImportOpen(source, false)
  }

  /** What a scan or a paste found: fill the Vault panel from it and select what can be imported. */
  const applyResult = (result: DbeaverScanResult, path?: string) => {
    setScan({ status: 'ready', path, result })
      setSettings((current) => {
        const filled = fillFromCandidates(current, result.candidates)
        // The prefilled template follows the engine most imported connections use (roles differ per engine).
        if (current.template !== prefill.settings.template) return filled
        const template = defaultTemplate(useConnections.getState().connections, majorityVaultDialect(result.candidates))
        return { ...filled, template: template || filled.template }
      })
      setSelectedKeys(initialSelection(result.candidates))
      setOverrides(initialOverrides(result.candidates))
      setOutcomes(new Map())
      setQuery('')
      setShowErrors(false)
      setShowRowErrors(false)
  }

  const runScan = async (path?: string) => {
    const run = ++scanRun.current
    setScan({ status: 'loading', path })
    try {
      const result = await api.importers.dbeaverScan(path)
      if (run !== scanRun.current) return
      applyResult(result, path)
    } catch (error) {
      if (run !== scanRun.current) return
      setScan({ status: 'error', path, error: errorInfo(error) })
    }
  }

  const readPasted = async () => {
    if (!pasted.trim()) return
    const run = ++scanRun.current
    setScan({ status: 'loading' })
    try {
      const result = await api.importers.datagripParse(pasted)
      if (run !== scanRun.current) return
      applyResult(result)
    } catch (error) {
      if (run !== scanRun.current) return
      setScan({ status: 'error', error: errorInfo(error) })
    }
  }

  useEffect(() => {
    if (source === 'dbeaver') void runScan()
    // Once per session; later scans come from "Choose file…" / "Try again".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const chooseFile = async () => {
    setPicking(true)
    try {
      // macOS can pick a file or a folder (.dbeaver, a project, workspace6…); other platforms a file.
      const path = await api.files.pickPath(isMac() ? 'Choose a DBeaver data-sources.json file or folder' : 'Choose a DBeaver data-sources.json file', 'any')
      if (path) await runScan(path)
    } catch (error) {
      toast.error('Could not open the file picker', error)
    } finally {
      setPicking(false)
    }
  }

  const candidates = useMemo(() => (scan.status === 'ready' ? scan.result.candidates : []), [scan])
  const groups = useMemo(() => groupCandidates(candidates, query), [candidates, query])
  const chosen = useMemo(() => selectedCandidates(candidates, selected), [candidates, selected])
  const vaultCount = chosen.filter(usesVault).length
  const validation = validateImport(candidates, selected, settings, overrides)
  const running = progress !== null

  const editSettings = (patch: Partial<VaultImportSettings>) => {
    setSettings((s) => ({ ...s, ...patch }))
    setShowErrors(true)
    if (patch.template !== undefined) setShowRowErrors(true)
  }

  const setRowPath = (c: DbeaverImportCandidate, value: string) => {
    const key = candidateKey(c)
    setOverrides((prev) => {
      const next = new Map(prev)
      // Typing exactly what the template gives goes back to following the template.
      if (settings.template && value === expandSecretPath(settings.template, secretPathValues(c))) next.delete(key)
      else next.set(key, value)
      return next
    })
    setShowRowErrors(true)
  }

  const resetRowPath = (c: DbeaverImportCandidate) =>
    setOverrides((prev) => {
      const next = new Map(prev)
      next.delete(candidateKey(c))
      return next
    })

  const toggle = (list: DbeaverImportCandidate[], on: boolean) => setSelectedKeys((prev) => applySelection(prev, list, on))

  const connectionName = (id: string) => connections.find((c) => c.id === id)?.name

  /**
   * Sign in to Vault with the panel's settings (browser SSO / prompts as needed) and fill each selected Vault
   * row with the database mount that matches it; rows the user typed keep their path.
   */
  const runSuggest = async () => {
    setShowErrors(true)
    if (validation.address || validation.username || validation.role) return
    const targets = discoveryTargets(chosen)
    if (targets.length === 0) return
    const vault = panelVaultConfig(settings)
    const role = settings.role.trim() || DEFAULT_DISCOVERY_ROLE
    const secrets: ConnectionSecrets = {}
    setSuggest({ status: 'running', loginPending: false })
    for (let round = 0; round < 4; round++) {
      try {
        const result = await api.vault.discover({ vault, ...(Object.keys(secrets).length > 0 ? { secrets } : {}), role, targets })
        const next = applySuggestions(overrides, suggested, result.suggestions)
        setOverrides(next.overrides)
        setSuggested(next.suggested)
        setDiscovered(result)
        setShowRowErrors(true)
        setSuggest({ status: 'done', matched: result.suggestions.length, total: targets.length, mounts: result.mounts.length, warnings: result.warnings })
        return
      } catch (error) {
        const info = errorInfo(error)
        if (info.kind === 'cancelled') {
          setSuggest({ status: 'idle' })
          return
        }
        const field = info.kind === 'needs-password' && (info.secretField === 'vaultToken' || info.secretField === 'vaultPassword') ? info.secretField : null
        if (field && round < 3) {
          const promptError = vaultPromptError(info, Boolean(secrets[field]))
          const first = chosen.find(usesVault)?.input
          const value = await useVault.getState().askSecret({
            field,
            target: {
              name: text.title,
              dialect: first?.dialect ?? 'postgres',
              color: 'none',
              host: first?.host ?? '',
              port: first?.port ?? 0,
              vault,
              savePassword: false,
            },
            confirmLabel: 'Continue',
            ...(promptError ? { error: promptError } : {}),
          })
          if (value === null) {
            setSuggest({ status: 'idle' })
            return
          }
          secrets[field] = value
          continue
        }
        setSuggest({ status: 'error', message: info.kind === 'vault' ? vaultMessage(info.message) : info.message, ...(info.detail ? { detail: info.detail } : {}) })
        return
      }
    }
  }

  /** A row's own picker over the mounts the last suggestion listed (no new sign-in). */
  const pathPicker = (c: DbeaverImportCandidate) =>
    discovered && discovered.mounts.length > 0 ? (
      <SecretPathSuggest
        compact
        targetKey={candidateKey(c)}
        currentPath={rowSecretPath(c, settings.template, overrides)}
        initialRole={settings.role}
        canStart={() => true}
        discover={async () => ({ ok: true, result: discovered })}
        onPick={(path) => setRowPath(c, path)}
        disabled={running}
      />
    ) : null

  const runImport = async () => {
    if (!validation.ok || chosen.length === 0) return
    const queue = [...chosen]
    const results = new Map(outcomes)
    const saved: ConnectionConfig[] = []
    setProgress({ done: 0, total: queue.length })
    for (const [i, c] of queue.entries()) {
      const key = candidateKey(c)
      try {
        const connection = await useConnections.getState().save(buildInput(c, settings, overrides))
        saved.push(connection)
        results.set(key, { state: 'imported', connectionId: connection.id })
      } catch (error) {
        results.set(key, { state: 'failed', message: errorMessage(error) })
      }
      setOutcomes(new Map(results))
      setProgress({ done: i + 1, total: queue.length })
    }
    setSelectedKeys((prev) => new Set([...prev].filter((k) => results.get(k)?.state !== 'imported')))
    setProgress(null)
    const failed = queue.length - saved.length
    if (saved.length > 0) {
      toast.success(`Imported ${pluralize(saved.length, 'connection')}`, {
        description: failed > 0 ? `${pluralize(failed, 'connection')} could not be imported.` : undefined,
        action: { label: 'Show in sidebar', onClick: () => revealInSidebar(saved) },
      })
    }
    if (failed === 0) setImportOpen(source, false)
    else if (saved.length === 0) toast.error(`Could not import ${pluralize(failed, 'connection')}`, undefined, { description: 'See the errors in the list.' })
  }

  const ready = scan.status === 'ready' && candidates.length > 0
  const emptyPath = scan.status === 'ready' ? (scan.path ?? scan.result.files[0]) : scan.status === 'paste' ? undefined : scan.path
  const footerNote = (() => {
    if (running) return null
    if (!ready) return null
    if (!validation.ok && validation.summary) return { tone: 'warn' as const, text: validation.summary }
    const parts = [`${chosen.length} of ${candidates.filter(isImportable).length} selected`]
    if (vaultCount > 0) parts.push(`${vaultCount} with Vault`)
    return { tone: 'muted' as const, text: parts.join(' · ') }
  })()

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
      size="xl"
      flush
      modalLock={running}
      hideClose={running}
      icon={Import}
      tone="accent"
      title={text.title}
      onOpenAutoFocus={(e) => {
        // The list is still loading: focus the dialog itself rather than ringing the close button.
        e.preventDefault()
        if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus()
      }}
      description={text.description}
      bodyClassName="mt-3 flex min-h-0 flex-col overflow-hidden border-t border-line"
      footer={
        <>
          <span className="mr-auto min-w-0 truncate text-xs">
            {progress ? (
              <span className="flex items-center gap-2 text-muted tabular">
                <Spinner size={12} />
                Importing {Math.min(progress.done + 1, progress.total)} of {progress.total}…
              </span>
            ) : footerNote ? (
              <span className={footerNote.tone === 'warn' ? 'text-warning' : 'text-subtle tabular'}>{footerNote.text}</span>
            ) : null}
          </span>
          <Button variant="ghost" onClick={close} disabled={running}>
            Cancel
          </Button>
          {scan.status === 'paste' ? (
            <Button variant="primary" leadingIcon={ClipboardPaste} disabled={!pasted.trim()} onClick={() => void readPasted()}>
              Read data sources
            </Button>
          ) : (
            <Button
              variant="primary"
              leadingIcon={Import}
              loading={running}
              disabled={!ready || !validation.ok || running}
              onClick={() => void runImport()}
            >
              {chosen.length === 0 ? 'Import' : `Import ${pluralize(chosen.length, 'connection')}`}
            </Button>
          )}
        </>
      }
    >
      {/* The list keeps room for a few rows under the Vault panel; a short window scrolls the whole body. */}
      <div className="flex h-[min(600px,calc(80vh-140px))] min-h-[260px] flex-col overflow-y-auto">
        {scan.status === 'paste' ? (
          <PastePanel value={pasted} onChange={setPasted} />
        ) : (
          <>
        <SourceBar
          scan={scan}
          source={source}
          count={candidates.length}
          picking={picking}
          disabled={running}
          onChoose={() => void chooseFile()}
          onPasteAgain={() => setScan({ status: 'paste' })}
          query={query}
          onQuery={setQuery}
          filterLabel={text.filter}
          showFilter={scan.status === 'ready' && candidates.length >= FILTER_FROM}
        />
        {/* With no connection at all the warnings are the explanation: the empty state shows them. */}
        {scan.status === 'ready' && candidates.length > 0 && scan.result.warnings.length > 0 && <Warnings warnings={scan.result.warnings} from={text.warningsFrom} />}

        <div className={cn('flex-1 overflow-y-auto', ready && validation.vault ? 'min-h-[196px]' : 'min-h-0')}>
          {scan.status === 'loading' ? (
            <LoadingRows />
          ) : scan.status === 'error' && source === 'datagrip' ? (
            <EmptyState
              tone="danger"
              icon={TriangleAlert}
              title="Could not read the pasted data sources"
              description={scan.error.message}
              action={
                <Button size="sm" leadingIcon={ClipboardPaste} onClick={() => setScan({ status: 'paste' })}>
                  Paste again
                </Button>
              }
            />
          ) : scan.status === 'error' ? (
            <EmptyState
              tone="danger"
              icon={TriangleAlert}
              title="Could not read the DBeaver configuration"
              description={scan.error.message}
              action={
                <>
                  <Button size="sm" leadingIcon={RefreshCw} onClick={() => void runScan(scan.path)}>
                    Try again
                  </Button>
                  <Button size="sm" variant="ghost" leadingIcon={FolderOpen} loading={picking} onClick={() => void chooseFile()}>
                    {CHOOSE_LABEL}
                  </Button>
                </>
              }
            />
          ) : candidates.length === 0 && source === 'datagrip' ? (
            <EmptyState
              icon={FileSearch}
              title="No DataGrip data source found"
              description={scan.status === 'ready' ? scan.result.warnings.join(' ') : undefined}
              action={
                <Button size="sm" variant="primary" leadingIcon={ClipboardPaste} onClick={() => setScan({ status: 'paste' })}>
                  Paste again
                </Button>
              }
            />
          ) : scan.status === 'ready' && candidates.length === 0 ? (
            <EmptyState
              icon={FileSearch}
              title={
                <>
                  {/* A file that was chosen or found but not read says so; an absent workspace is just empty. */}
                  {scan.result.warnings.length > 0 && (scan.path || scan.result.files.length > 0)
                    ? 'Could not read DBeaver connections from'
                    : 'No DBeaver connections found in'}
                  <span className="mt-0.5 block truncate font-mono text-xs font-normal text-muted" title={emptyPath}>
                    {emptyPath ? shortenPath(emptyPath, 3) : defaultWorkspaceLabel(hostPlatform())}
                  </span>
                </>
              }
              description={
                <>
                  {/* Why nothing was found (unreadable file, not a connections file, no workspace…). */}
                  {scan.result.warnings.map((w, i) => (
                    <span key={i} className="block text-warning [overflow-wrap:anywhere]">
                      {w}
                    </span>
                  ))}
                  <span className={cn('block', scan.result.warnings.length > 0 && 'mt-1.5')}>
                    Choose a data-sources.json file from your DBeaver workspace (the .dbeaver folder of a project).
                  </span>
                </>
              }
              action={
                <Button size="sm" variant="primary" leadingIcon={FolderOpen} loading={picking} onClick={() => void chooseFile()}>
                  {CHOOSE_LABEL}
                </Button>
              }
            />
          ) : groups.length === 0 ? (
            <EmptyState
              size="compact"
              icon={Search}
              title="No matches"
              description={text.none}
              action={
                <Button size="xs" onClick={() => setQuery('')}>
                  Clear filter
                </Button>
              }
            />
          ) : (
            <CandidateList
              label={text.list}
              groups={groups}
              selected={selected}
              outcomes={outcomes}
              onToggle={toggle}
              secretPath={(c) => rowSecretPath(c, settings.template, overrides)}
              overridden={(c) => overrides.has(candidateKey(c))}
              onSecretPathChange={setRowPath}
              onSecretPathReset={resetRowPath}
              rowErrors={validation.rows}
              showErrors={showRowErrors}
              template={settings.template}
              connectionName={connectionName}
              suggested={(c) => suggested.get(candidateKey(c))}
              pathPicker={pathPicker}
              suggestRan={discovered !== null}
              disabled={running}
            />
          )}
        </div>

        {ready && validation.vault && (
          <VaultImportPanel
            settings={settings}
            onChange={editSettings}
            validation={validation}
            showErrors={showErrors}
            count={vaultCount}
            prefilledFrom={prefilledFrom}
            cliTokenFile={environment?.cliTokenFile}
            suggest={suggest.status === 'running' ? { status: 'running', loginPending } : suggest}
            onSuggest={() => void runSuggest()}
            disabled={running}
          />
        )}
          </>
        )}
      </div>
    </Dialog>
  )
}

const SOURCE_LABEL: Record<ScanState['status'], string> = { paste: 'Paste', loading: 'Reading', ready: 'Read from', error: 'Location' }

function SourceBar({
  scan,
  source,
  count,
  picking,
  disabled,
  onChoose,
  onPasteAgain,
  query,
  onQuery,
  filterLabel,
  showFilter,
}: {
  scan: ScanState
  source: ImportSource
  /** Data sources read (DataGrip). */
  count: number
  picking: boolean
  disabled: boolean
  onChoose: () => void
  onPasteAgain: () => void
  query: string
  onQuery: (q: string) => void
  filterLabel: string
  showFilter: boolean
}) {
  const files = scan.status === 'ready' ? scan.result.files : []
  const [first, ...more] = files
  const filter = showFilter && (
    <Input
      size="sm"
      leadingIcon={Search}
      value={query}
      placeholder="Filter"
      aria-label={filterLabel}
      wrapperClassName="w-44"
      onChange={(e) => onQuery(e.target.value)}
      onClear={() => onQuery('')}
    />
  )
  if (source === 'datagrip') {
    return (
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-5">
        <span className="shrink-0 text-xs text-subtle">{scan.status === 'loading' ? 'Reading' : 'Pasted from'}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted">
          {scan.status === 'loading' && <Spinner size={12} />}
          DataGrip
          {scan.status === 'ready' && <span className="text-subtle tabular">· {pluralize(count, 'data source')}</span>}
        </span>
        {filter}
        <Button size="xs" variant="secondary" leadingIcon={ClipboardPaste} disabled={disabled || scan.status === 'loading'} onClick={onPasteAgain}>
          Paste again…
        </Button>
      </div>
    )
  }
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-5">
      <span className="shrink-0 text-xs text-subtle">{SOURCE_LABEL[scan.status]}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {scan.status === 'loading' ? (
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
            <Spinner size={12} />
            <span className="truncate font-mono text-2xs">{scan.path ? shortenPath(scan.path, 3) : 'DBeaver workspace'}</span>
          </span>
        ) : first ? (
          <>
            <Tooltip content={<span className="font-mono">{first}</span>}>
              <span tabIndex={0} className="min-w-0 truncate rounded-[4px] bg-active px-1.5 py-px font-mono text-2xs text-muted outline-none focus-visible:ring-2 focus-visible:ring-focus">
                {shortenPath(first)}
              </span>
            </Tooltip>
            {more.length > 0 && (
              <Tooltip
                content={
                  <span className="flex flex-col font-mono">
                    {more.map((f) => (
                      <span key={f}>{f}</span>
                    ))}
                  </span>
                }
              >
                <span tabIndex={0} className="shrink-0 rounded-[4px] px-1 text-2xs text-subtle outline-none focus-visible:ring-2 focus-visible:ring-focus tabular">
                  +{more.length} more
                </span>
              </Tooltip>
            )}
          </>
        ) : (
          <span className="truncate font-mono text-2xs text-subtle" title={scan.status === 'paste' ? undefined : scan.path}>
            {scan.status !== 'paste' && scan.path ? shortenPath(scan.path, 3) : 'DBeaver workspace'}
          </span>
        )}
      </span>
      {filter}
      <Button size="xs" variant="secondary" leadingIcon={FolderOpen} loading={picking} disabled={disabled || scan.status === 'loading'} onClick={onChoose}>
        {CHOOSE_LABEL}
      </Button>
    </div>
  )
}

function Warnings({ warnings, from }: { warnings: string[]; from: string }) {
  const [expanded, setExpanded] = useState(false)
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <div className="shrink-0 border-b border-line px-5 py-2.5">
      <Callout
        tone="warning"
        title={
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((e) => !e)}
            className="-mx-1 flex items-center gap-1 rounded px-1 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
          >
            {warnings.length === 1 ? `1 warning while reading ${from}` : `${warnings.length} warnings while reading ${from}`}
            <Chevron size={13} strokeWidth={2} className="text-subtle" />
          </button>
        }
      >
        {expanded && (
          <ul className="flex max-h-24 flex-col gap-0.5 overflow-y-auto">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </Callout>
    </div>
  )
}

/** Where the data sources copied in DataGrip are pasted. */
function PastePanel({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-5 py-4">
      <label htmlFor="dg-datagrip-paste" className="text-xs text-muted">
        In DataGrip, select data sources or a folder in the Database Explorer and copy them ({isMac() ? '⌘C' : 'Ctrl+C'}), then paste
        them here.
      </label>
      <Textarea
        id="dg-datagrip-paste"
        mono
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="#DataSourceSettings#…"
        className="min-h-0 flex-1 resize-none"
      />
      <p className="text-2xs text-subtle">Passwords are never imported, not even one written in a connection URL.</p>
    </div>
  )
}

function LoadingRows() {
  return (
    <div aria-busy="true" aria-label="Reading connections">
      <div className="flex h-8 items-center gap-2.5 border-b border-line px-5">
        <Skeleton className="size-[15px] rounded-[4px]" />
        <Skeleton width={80} />
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-start gap-3 border-b border-line/50 px-5 py-2.5">
          <Skeleton className="size-[15px] rounded-[4px]" />
          <Skeleton className="size-[18px] rounded-[5px]" />
          <div className="flex-1 space-y-1.5">
            <Skeleton width={`${46 - i * 5}%`} />
            <Skeleton width={`${34 + i * 4}%`} height={8} />
          </div>
          <Skeleton width={300} height={24} className="rounded-md" />
        </div>
      ))}
    </div>
  )
}

/** Show the imported connections in the explorer: sidebar visible, their folders open, first one selected. */
function revealInSidebar(saved: readonly ConnectionConfig[]): void {
  const first = saved[0]
  if (!first) return
  useUi.getState().setSidebarVisible(true)
  const explorer = useExplorer.getState()
  if (explorer.filter.trim()) explorer.setFilter('')
  const groups = [...new Set(saved.map((c) => c.group?.trim()).filter((g): g is string => Boolean(g)))]
  if (groups.length > 0) explorer.setExpandedMany(groups.map(nodeIds.group), true)
  explorer.select(nodeIds.connection(first.id))
  requestAnimationFrame(() => focusExplorerTree((id) => useExplorer.getState().select(id), true))
}
