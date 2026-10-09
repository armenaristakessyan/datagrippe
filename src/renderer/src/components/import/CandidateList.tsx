// Candidate rows of the DBeaver import, grouped by DBeaver folder, with per-group select all / none
// and, for Vault rows, the row's own secret path.
import { useId, type ReactNode } from 'react'
import { Check, Database, Folder, KeyRound, Lock, Network, RotateCcw, ShieldAlert, Sparkles } from 'lucide-react'
import type { DbeaverImportCandidate, VaultPathSuggestion } from '@shared/types'
import { Badge, Button, Checkbox, DialectIcon, Input, Tooltip } from '@/components/ui'
import { cn } from '@/lib/cn'
import { PRODUCTION_LABEL } from '@/components/connections/sections'
import {
  candidateKey,
  candidateTarget,
  expandSecretPath,
  groupSelectionState,
  isImportable,
  secretPathValues,
  usesVault,
  visibleNotes,
  type CandidateGroup,
} from './dbeaver-import'

export type RowOutcome = { state: 'imported'; connectionId: string } | { state: 'failed'; message: string }

export interface CandidateListProps {
  groups: CandidateGroup[]
  selected: ReadonlySet<string>
  /** Rows already imported in this session: no longer selectable. */
  outcomes: ReadonlyMap<string, RowOutcome>
  onToggle: (candidates: DbeaverImportCandidate[], on: boolean) => void
  /** Secret path of each Vault row (template expansion or own edit). */
  secretPath: (c: DbeaverImportCandidate) => string
  overridden: (c: DbeaverImportCandidate) => boolean
  onSecretPathChange: (c: DbeaverImportCandidate, value: string) => void
  onSecretPathReset: (c: DbeaverImportCandidate) => void
  rowErrors: Record<string, string>
  showErrors: boolean
  template: string
  /** Name of the existing connection a duplicate row matches. */
  connectionName: (id: string) => string | undefined
  /** The suggestion that filled a Vault row's path (shown as a tag), if any. */
  suggested?: (c: DbeaverImportCandidate) => VaultPathSuggestion | undefined
  /** After "Suggest paths from Vault": a picker of the visible mounts for a Vault row. */
  pathPicker?: (c: DbeaverImportCandidate) => ReactNode
  /** Paths were suggested from Vault: an empty row says "no match" rather than "required". */
  suggestRan?: boolean
  disabled?: boolean
  /** Accessible name of the list (default "DBeaver connections"). */
  label?: string
}

export function CandidateList(props: CandidateListProps) {
  const { groups, selected, outcomes, onToggle } = props
  const baseId = useId()
  const selectable = (list: DbeaverImportCandidate[]) => list.filter((c) => isImportable(c) && outcomes.get(candidateKey(c))?.state !== 'imported')
  return (
    <div role="list" aria-label={props.label ?? 'DBeaver connections'}>
      {groups.map((group, index) => {
        const rows = selectable(group.candidates)
        const state = groupSelectionState({ ...group, candidates: rows }, selected)
        const on = rows.filter((c) => selected.has(candidateKey(c))).length
        return (
          <section key={group.folder || '\u0000'} aria-label={group.label} className="pb-1">
            <div className="sticky top-0 z-10 flex h-8 items-center gap-2.5 border-b border-line bg-elevated px-5">
              <Checkbox
                id={`${baseId}-${index}`}
                checked={state}
                disabled={props.disabled || rows.length === 0}
                onCheckedChange={(next) => onToggle(rows, next)}
              />
              <Folder size={13} strokeWidth={1.75} className="shrink-0 text-subtle" />
              <h3 className="min-w-0 truncate text-xs font-semibold text-fg">
                <label htmlFor={`${baseId}-${index}`}>{group.label}</label>
              </h3>
              <span className="text-2xs text-subtle tabular">
                {on} of {group.candidates.length}
              </span>
              <span className="flex-1" />
              <Button size="xs" variant="ghost" disabled={props.disabled || on === rows.length} onClick={() => onToggle(rows, true)}>
                Select all
              </Button>
              <Button size="xs" variant="ghost" disabled={props.disabled || on === 0} onClick={() => onToggle(rows, false)}>
                Select none
              </Button>
            </div>
            {group.candidates.map((c) => (
              <CandidateRow key={candidateKey(c)} candidate={c} {...props} />
            ))}
          </section>
        )
      })}
    </div>
  )
}

function CandidateRow({
  candidate: c,
  selected,
  outcomes,
  onToggle,
  secretPath,
  overridden,
  onSecretPathChange,
  onSecretPathReset,
  rowErrors,
  showErrors,
  template,
  connectionName,
  suggested,
  pathPicker,
  suggestRan,
  disabled,
}: CandidateListProps & { candidate: DbeaverImportCandidate }) {
  const id = useId()
  const key = candidateKey(c)
  const input = c.input
  const outcome = outcomes.get(key)
  const imported = outcome?.state === 'imported'
  const importable = isImportable(c) && !imported
  const checked = importable && selected.has(key)
  const vault = usesVault(c)
  const error = checked ? rowErrors[key] : undefined
  const showError = Boolean(error) && showErrors
  const duplicateName = c.duplicateOf ? (connectionName(c.duplicateOf) ?? 'an existing connection') : undefined

  return (
    <div
      role="listitem"
      aria-label={c.sourceName}
      className={cn(
        'flex items-start gap-3 border-b border-line/50 px-5 py-2 transition-colors last:border-b-0',
        importable ? 'hover:bg-hover/60' : 'opacity-60',
        checked && 'bg-accent-soft/40 hover:bg-accent-soft/60',
      )}
    >
      <span className="flex h-5 shrink-0 items-center">
        <Checkbox id={id} checked={checked} disabled={disabled || !importable} onCheckedChange={(on) => onToggle([c], on)} />
      </span>
      <span className="mt-px shrink-0">
        {input ? (
          <DialectIcon dialect={input.dialect} size={18} />
        ) : (
          <span className="flex size-[18px] items-center justify-center rounded-[5px] bg-active text-subtle" title={c.sourceProvider}>
            <Database size={11} strokeWidth={2} />
          </span>
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <label htmlFor={id} className={cn('min-w-0 max-w-full truncate text-sm font-medium leading-5 text-fg', importable && 'cursor-default')} title={c.sourceName}>
            {c.sourceName}
          </label>
          <RowBadges candidate={c} imported={imported} duplicateName={duplicateName} />
        </div>
        <div className="truncate font-mono text-2xs leading-4 text-subtle" title={candidateTarget(c)}>
          {candidateTarget(c)}
          {input?.user && !vault ? <span className="text-faint"> · {input.user}</span> : null}
        </div>
        {visibleNotes(c).map((note, i) => (
          <p key={i} className="mt-0.5 text-2xs leading-4 text-subtle">
            {note}
          </p>
        ))}
        {outcome?.state === 'failed' && (
          <p role="alert" className="mt-0.5 text-2xs leading-4 text-danger [overflow-wrap:anywhere]">
            Could not import: {outcome.message}
          </p>
        )}
      </div>

      {vault && (
        <div className="w-[332px] shrink-0">
          <div className="flex items-center gap-1">
          <Input
            wrapperClassName="min-w-0 flex-1"
            size="sm"
            mono
            value={secretPath(c)}
            // Long paths are cut by the 300px field: the full one on hover.
            title={secretPath(c) || undefined}
            placeholder={template ? expandSecretPath(template, secretPathValues(c)) : 'Secret path'}
            aria-label={`Vault secret path for ${c.sourceName}`}
            disabled={disabled || !checked}
            invalid={showError}
            spellCheck={false}
            onChange={(e) => onSecretPathChange(c, e.target.value)}
            trailing={
              overridden(c) && template && checked ? (
                <Tooltip content="Use the template">
                  <button
                    type="button"
                    aria-label="Use the template"
                    onClick={() => onSecretPathReset(c)}
                    className="flex size-5 items-center justify-center rounded text-subtle outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    <RotateCcw size={11} strokeWidth={2} />
                  </button>
                </Tooltip>
              ) : undefined
            }
          />
          {checked && pathPicker?.(c)}
          </div>
          {showError ? (
            <p className="mt-0.5 text-2xs leading-4 text-danger">
              {suggestRan && !secretPath(c).trim() ? 'No matching mount: pick one (✦) or type the path' : error}
            </p>
          ) : (
            checked && <SuggestedTag suggestion={suggested?.(c)} path={secretPath(c)} />
          )}
        </div>
      )}
    </div>
  )
}

/** "Suggested from Vault (92 %)" under a row's path, while the path is still the suggested one. */
function SuggestedTag({ suggestion, path }: { suggestion: VaultPathSuggestion | undefined; path: string }) {
  if (!suggestion || suggestion.path !== path) return null
  return (
    <Tooltip content={suggestion.reason}>
      <p tabIndex={0} className="mt-0.5 flex w-fit items-center gap-1 rounded text-2xs leading-4 text-accent outline-none focus-visible:ring-2 focus-visible:ring-focus">
        <Sparkles size={10} strokeWidth={2} className="shrink-0" />
        Suggested from Vault · {Math.round(suggestion.score * 100)}% match
      </p>
    </Tooltip>
  )
}

function RowBadges({ candidate: c, imported, duplicateName }: { candidate: DbeaverImportCandidate; imported: boolean; duplicateName?: string }) {
  const input = c.input
  return (
    <span className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
      {imported && (
        <Badge tone="success" icon={Check}>
          Imported
        </Badge>
      )}
      {!input && <Badge tone="neutral">Unsupported</Badge>}
      {usesVault(c) && (
        <Badge tone="accent" icon={KeyRound}>
          Vault
        </Badge>
      )}
      {input?.productionGuard && (
        <Tooltip content={PRODUCTION_LABEL}>
          <Badge tone="danger" icon={ShieldAlert}>
            Production
          </Badge>
        </Tooltip>
      )}
      {input?.readOnly && (
        <Badge tone="warning" icon={Lock}>
          Read-only
        </Badge>
      )}
      {input?.ssh.enabled && (
        <Badge tone="neutral" icon={Network}>
          SSH
        </Badge>
      )}
      {duplicateName && !imported && (
        <Tooltip content="A connection to the same server and database already exists. Select the row to import a copy.">
          <Badge tone="outline" className="min-w-0 max-w-[280px]">
            <span className="truncate">Duplicate of “{duplicateName}”</span>
          </Badge>
        </Tooltip>
      )}
    </span>
  )
}
