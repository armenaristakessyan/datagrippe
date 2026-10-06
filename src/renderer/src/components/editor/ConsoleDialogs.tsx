// Dialogs a console asks through its store (useConsoles().prompts): query parameter values before a run,
// what to do with an open transaction when the tab closes, and the user snippets.
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AlertTriangle, Braces, Pencil, Plus, Search, TextQuote, Trash2 } from 'lucide-react'
import { Button, CodeBlock, Dialog, EmptyState, Field, IconButton, Input, Kbd, SegmentedControl, Textarea } from '@/components/ui'
import { cn } from '@/lib/cn'
import { getEditor } from '@/lib/editor-registry'
import { uid } from '@/lib/id'
import { deleteSnippet, saveSnippet, snippetPreview, snippetsOf, validateSnippet, type UserSnippet } from '@/lib/monaco/snippets'
import { registerConsolePromptHost, useConsoles, type ConsolePrompt } from '@/stores/consoles'
import { useTabs } from '@/stores/tabs'
import { renderParameter, type ParameterMode, type ParameterValue } from './sql-parameters'

/** Exit animation length before the dialog unmounts. */
const EXIT_MS = 120

export function ConsoleDialogs({ tabId }: { tabId: string }) {
  useEffect(() => registerConsolePromptHost(tabId), [tabId])
  const prompt = useConsoles((s) => s.prompts[tabId])
  if (!prompt) return null
  const dismiss = () => useConsoles.getState().dismissPrompt(tabId, prompt)
  if (prompt.kind === 'parameters') return <ParametersDialog key={keyOf(prompt)} prompt={prompt} onDismiss={dismiss} />
  if (prompt.kind === 'snippets') return <SnippetsDialog key={keyOf(prompt)} tabId={tabId} prompt={prompt} onDismiss={dismiss} />
  return <CloseTransactionDialog key={keyOf(prompt)} prompt={prompt} onDismiss={dismiss} />
}

const keys = new WeakMap<ConsolePrompt, string>()
let nextKey = 0
function keyOf(prompt: ConsolePrompt): string {
  let key = keys.get(prompt)
  if (!key) {
    key = `p${++nextKey}`
    keys.set(prompt, key)
  }
  return key
}

/** Answer at once, then drop the prompt once the dialog's exit animation has played. */
function useAnswer<T>(resolve: (value: T) => void, onDismiss: () => void) {
  const [open, setOpen] = useState(true)
  const answered = useRef(false)
  const answer = (value: T) => {
    if (answered.current) return
    answered.current = true
    setOpen(false)
    resolve(value)
    setTimeout(onDismiss, EXIT_MS)
  }
  return { open, answer }
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const MODES: { value: ParameterMode; label: string }[] = [
  { value: 'value', label: 'Value' },
  { value: 'sql', label: 'SQL' },
  { value: 'null', label: 'NULL' },
]

const MODE_HINT: Record<ParameterMode, string> = {
  value: 'Numbers as typed, anything else as a quoted string',
  sql: 'Inserted verbatim (an expression such as now() or ARRAY[1, 2])',
  null: 'NULL',
}

function ParametersDialog({ prompt, onDismiss }: { prompt: Extract<ConsolePrompt, { kind: 'parameters' }>; onDismiss: () => void }) {
  const { open, answer } = useAnswer(prompt.resolve, onDismiss)
  const [values, setValues] = useState<Record<string, ParameterValue>>(() =>
    Object.fromEntries(prompt.parameters.map((p) => [p.key, prompt.initial[p.key] ?? { mode: 'value', text: '' }])),
  )
  const firstEmpty = prompt.parameters.find((p) => !values[p.key]?.text && values[p.key]?.mode !== 'null')?.key ?? prompt.parameters[0]?.key
  const inputs = useRef(new Map<string, HTMLInputElement>())
  const count = prompt.parameters.length

  const update = (key: string, patch: Partial<ParameterValue>) => setValues((v) => ({ ...v, [key]: { ...(v[key] ?? { mode: 'value', text: '' }), ...patch } }))
  const submit = (event: FormEvent) => {
    event.preventDefault()
    answer(values)
  }
  const preview = useMemo(
    () => prompt.parameters.map((p) => `${p.label} → ${renderParameter(values[p.key], prompt.dialect)}`).join('\n'),
    [prompt.parameters, prompt.dialect, values],
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && answer(null)}
      size="md"
      icon={Braces}
      tone="accent"
      title={count === 1 ? 'Value for the query parameter' : `Values for ${count} query parameters`}
      description="The statement has placeholders. Their values are inserted as SQL literals before it runs."
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        if (firstEmpty) inputs.current.get(firstEmpty)?.focus()
      }}
      footer={
        <>
          <Button variant="ghost" className="mr-auto text-subtle" onClick={() => answer('as-is')}>
            Run as written
          </Button>
          <Button variant="ghost" onClick={() => answer(null)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="dg-parameters">
            Run
          </Button>
        </>
      }
    >
      <form id="dg-parameters" onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex max-h-[44vh] flex-col gap-2 overflow-y-auto pr-0.5" role="group" aria-label="Parameters">
          {prompt.parameters.map((p, index) => {
            const value = values[p.key] ?? { mode: 'value', text: '' }
            const id = `dg-param-${index}`
            const label = p.style === 'question' ? `? #${index + 1}` : p.label
            return (
              <div key={p.key} className="grid grid-cols-[minmax(84px,auto)_1fr_auto] items-center gap-2">
                <label htmlFor={id} className="truncate font-mono text-xs text-fg" title={p.occurrences > 1 ? `${label} (used ${p.occurrences} times)` : label}>
                  {label}
                  {p.occurrences > 1 && <span className="ml-1 text-2xs text-subtle">×{p.occurrences}</span>}
                </label>
                <Input
                  id={id}
                  ref={(el) => {
                    if (el) inputs.current.set(p.key, el)
                    else inputs.current.delete(p.key)
                  }}
                  size="sm"
                  mono
                  disabled={value.mode === 'null'}
                  value={value.mode === 'null' ? '' : value.text}
                  placeholder={value.mode === 'null' ? 'NULL' : value.mode === 'sql' ? 'SQL expression' : 'Value'}
                  aria-describedby={`${id}-mode`}
                  onChange={(e) => update(p.key, { text: e.target.value })}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <SegmentedControl
                  aria-label={`How ${label} is inserted`}
                  size="xs"
                  value={value.mode}
                  options={MODES}
                  onValueChange={(mode) => {
                    update(p.key, { mode })
                    if (mode !== 'null') requestAnimationFrame(() => inputs.current.get(p.key)?.focus())
                  }}
                />
                <span id={`${id}-mode`} className="sr-only">
                  {MODE_HINT[value.mode]}
                </span>
              </div>
            )
          })}
        </div>
        <div>
          <div className="mb-1 text-2xs font-medium text-subtle">Inserted as</div>
          <CodeBlock code={preview} maxHeight={120} />
        </div>
        <p className={cn('text-2xs text-subtle')}>Values are remembered for this console. Enter runs, Esc cancels.</p>
      </form>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Close with an open transaction
// ---------------------------------------------------------------------------

function CloseTransactionDialog({ prompt, onDismiss }: { prompt: Extract<ConsolePrompt, { kind: 'close-transaction' }>; onDismiss: () => void }) {
  const { open, answer } = useAnswer(prompt.resolve, onDismiss)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const where = prompt.connectionName ? ` on “${prompt.connectionName}”` : ''
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && answer('cancel')}
      size="sm"
      icon={AlertTriangle}
      tone="warning"
      title={`Close “${prompt.tabTitle}” with an open transaction?`}
      description={`This console has uncommitted changes${where}. Commit them, or roll them back, before it closes.`}
      bodyClassName="hidden"
      onOpenAutoFocus={(event) => {
        // Neither choice is undoable: a stray Enter keeps the console open.
        event.preventDefault()
        cancelRef.current?.focus()
      }}
      footer={
        <>
          <Button ref={cancelRef} variant="ghost" onClick={() => answer('cancel')}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => answer('rollback')}>
            Roll back and close
          </Button>
          <Button variant="primary" onClick={() => answer('commit')}>
            Commit and close
          </Button>
        </>
      }
    />
  )
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

type SnippetDraft = { id?: string; name: string; abbreviation: string; body: string }

const EMPTY_DRAFT: SnippetDraft = { name: '', abbreviation: '', body: '' }

function SnippetsDialog({ tabId, prompt, onDismiss }: { tabId: string; prompt: Extract<ConsolePrompt, { kind: 'snippets' }>; onDismiss: () => void }) {
  const { open, answer } = useAnswer<void>(() => undefined, onDismiss)
  const snippets = useTabs((s) => s.layout)
  const list = useMemo(() => snippetsOf(snippets), [snippets])
  const [draft, setDraft] = useState<SnippetDraft | null>(prompt.view === 'edit' ? (prompt.draft ?? EMPTY_DRAFT) : null)
  // Opened straight on the editor (e.g. "Save as snippet…"): leaving it closes the dialog.
  const editOnly = prompt.view === 'edit'

  const insert = (snippet: UserSnippet) => {
    answer()
    // After the dialog returns focus, so the snippet session (tab stops) belongs to the editor.
    setTimeout(() => getEditor(tabId)?.insertSnippet(snippet.body), EXIT_MS + 10)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && answer()}
      size="md"
      icon={TextQuote}
      tone="accent"
      title={draft ? (draft.id ? 'Edit snippet' : 'New snippet') : 'Snippets'}
      description={
        draft
          ? 'Type its abbreviation in a console to insert it from autocompletion.'
          : 'Reusable SQL. Type an abbreviation in the editor, or pick a snippet here to insert it.'
      }
      flush={!draft}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        const root = event.currentTarget instanceof HTMLElement ? event.currentTarget : document
        root.querySelector<HTMLElement>('[role="dialog"] [data-autofocus], [data-autofocus]')?.focus()
      }}
      footer={
        draft ? (
          <SnippetFormFooter
            onCancel={() => (editOnly ? answer() : setDraft(null))}
            cancelLabel={editOnly ? 'Cancel' : 'Back'}
          />
        ) : (
          <>
            <Button variant="ghost" leadingIcon={Plus} className="mr-auto" onClick={() => setDraft(EMPTY_DRAFT)}>
              New snippet
            </Button>
            <Button variant="ghost" onClick={() => answer()}>
              Close
            </Button>
          </>
        )
      }
    >
      {draft ? (
        <SnippetForm
          draft={draft}
          existing={list}
          onSave={(snippet) => {
            saveSnippet(snippet)
            if (editOnly) answer()
            else setDraft(null)
          }}
        />
      ) : (
        <SnippetList
          snippets={list}
          onInsert={insert}
          onEdit={(s) => setDraft(s)}
          onDelete={(s) => deleteSnippet(s.id)}
          onNew={() => setDraft(EMPTY_DRAFT)}
        />
      )}
    </Dialog>
  )
}

function SnippetList({
  snippets,
  onInsert,
  onEdit,
  onDelete,
  onNew,
}: {
  snippets: UserSnippet[]
  onInsert: (s: UserSnippet) => void
  onEdit: (s: UserSnippet) => void
  onDelete: (s: UserSnippet) => void
  onNew: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = [...snippets].sort((a, b) => a.abbreviation.localeCompare(b.abbreviation))
    return q ? all.filter((s) => `${s.abbreviation} ${s.name} ${s.body}`.toLowerCase().includes(q)) : all
  }, [snippets, query])
  const index = Math.min(active, Math.max(shown.length - 1, 0))

  if (snippets.length === 0) {
    return (
      <EmptyState
        size="compact"
        icon={TextQuote}
        title="No snippets yet"
        description="Save a query you run often, then type its abbreviation to insert it."
        action={
          <Button size="sm" variant="primary" leadingIcon={Plus} onClick={onNew} data-autofocus="">
            New snippet
          </Button>
        }
        className="py-8"
      />
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => Math.min(i + 1, shown.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const s = shown[index]
      if (s) onInsert(s)
    }
  }

  return (
    <div className="flex flex-col">
      <div className="px-5 pb-2">
        <Input
          data-autofocus=""
          size="sm"
          leadingIcon={Search}
          placeholder="Search snippets…"
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="dg-snippet-list"
          aria-activedescendant={shown[index] ? `dg-snippet-${shown[index].id}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <ul id="dg-snippet-list" role="listbox" aria-label="Snippets" className="max-h-[46vh] overflow-y-auto border-t border-line px-2 py-1.5">
        {shown.length === 0 && <li className="px-3 py-6 text-center text-xs text-subtle">No snippet matches “{query}”.</li>}
        {shown.map((s, i) => (
          <li
            key={s.id}
            id={`dg-snippet-${s.id}`}
            role="option"
            aria-selected={i === index}
            className={cn('group flex cursor-default items-center gap-3 rounded-md px-3 py-1.5', i === index ? 'bg-hover' : 'hover:bg-hover/60')}
            onMouseEnter={() => setActive(i)}
            onClick={() => onInsert(s)}
          >
            <span className="w-24 shrink-0 truncate rounded-[4px] bg-accent-soft px-1.5 py-0.5 text-center font-mono text-2xs font-medium text-accent">{s.abbreviation}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-fg">{s.name}</span>
              <span className="block truncate font-mono text-2xs text-subtle">{snippetPreview(s.body).replace(/\s+/g, ' ')}</span>
            </span>
            <span className={cn('flex shrink-0 items-center gap-0.5', i === index ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
              <IconButton
                icon={Pencil}
                label={`Edit ${s.name}`}
                size="xs"
                onClick={(e) => {
                  e.stopPropagation()
                  onEdit(s)
                }}
              />
              <IconButton
                icon={Trash2}
                label={`Delete ${s.name}`}
                size="xs"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(s)
                }}
              />
            </span>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3 border-t border-line px-5 py-2 text-2xs text-subtle">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to choose
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> to insert
        </span>
      </div>
    </div>
  )
}

const SNIPPET_FORM = 'dg-snippet-form'

function SnippetFormFooter({ onCancel, cancelLabel }: { onCancel: () => void; cancelLabel: string }) {
  return (
    <>
      <Button variant="ghost" onClick={onCancel}>
        {cancelLabel}
      </Button>
      <Button variant="primary" type="submit" form={SNIPPET_FORM}>
        Save snippet
      </Button>
    </>
  )
}

function SnippetForm({ draft, existing, onSave }: { draft: SnippetDraft; existing: UserSnippet[]; onSave: (s: UserSnippet) => void }) {
  const [name, setName] = useState(draft.name)
  const [abbreviation, setAbbreviation] = useState(draft.abbreviation)
  const [body, setBody] = useState(draft.body)
  const [error, setError] = useState<string | null>(null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const snippet = { id: draft.id ?? uid('snip'), name: name.trim(), abbreviation: abbreviation.trim(), body }
    const problem = validateSnippet(snippet, existing)
    if (problem) {
      setError(problem)
      return
    }
    onSave(snippet)
  }
  return (
    <form id={SNIPPET_FORM} onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid grid-cols-[1fr_160px] gap-3">
        <Field label="Name" htmlFor="dg-snippet-name">
          <Input id="dg-snippet-name" data-autofocus="" value={name} placeholder="Active sessions" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Abbreviation" htmlFor="dg-snippet-abbr">
          <Input id="dg-snippet-abbr" mono value={abbreviation} placeholder="sessions" onChange={(e) => setAbbreviation(e.target.value.replace(/\s+/g, ''))} />
        </Field>
      </div>
      <Field
        label="SQL"
        htmlFor="dg-snippet-body"
        error={error ?? undefined}
        hint={
          <>
            <code className="font-mono">$1</code>, <code className="font-mono">${'{'}1:default{'}'}</code> are tab stops,{' '}
            <code className="font-mono">$0</code> is where the caret ends.
          </>
        }
      >
        <Textarea
          id="dg-snippet-body"
          mono
          rows={9}
          value={body}
          placeholder={'SELECT * FROM pg_stat_activity WHERE state = \'${1:active}\'$0'}
          onChange={(e) => {
            setBody(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter saves from the body
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              e.currentTarget.form?.requestSubmit()
            }
          }}
        />
      </Field>
    </form>
  )
}
