// Small form controls used by the connection dialog: colour swatches, group input with suggestions,
// secret (password) input with show/hide and stored placeholder, file path input with Browse….
import { useId, useMemo, useState, type KeyboardEvent } from 'react'
import { RadioGroup } from 'radix-ui'
import { Check, Eye, EyeOff, Folder, FolderOpen } from 'lucide-react'
import { CONNECTION_COLORS, type ConnectionColor } from '@shared/types'
import { Button, CONNECTION_COLOR_LABEL, connectionColorVar, Input, Popover, PopoverAnchor, PopoverContent, Tooltip } from '@/components/ui'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { SecretField } from './connection-form'

// ---------------------------------------------------------------------------
// Colour tag picker
// ---------------------------------------------------------------------------

export function ColorPicker({ value, onChange, id }: { value: ConnectionColor; onChange: (color: ConnectionColor) => void; id?: string }) {
  return (
    <RadioGroup.Root
      id={id}
      value={value}
      onValueChange={(v) => {
        const color = CONNECTION_COLORS.find((c) => c === v)
        if (color) onChange(color)
      }}
      aria-label="Color tag"
      orientation="horizontal"
      loop
      className="flex h-7 items-center gap-1"
    >
      {CONNECTION_COLORS.map((color) => {
        const css = connectionColorVar(color)
        return (
          <Tooltip key={color} content={CONNECTION_COLOR_LABEL[color]} side="bottom">
            <RadioGroup.Item
              value={color}
              aria-label={CONNECTION_COLOR_LABEL[color]}
              className={cn(
                'group relative flex size-[22px] items-center justify-center rounded-full outline-none transition-transform duration-100',
                'hover:scale-110 focus-visible:ring-2 focus-visible:ring-focus',
                // Tooltip's trigger owns data-state, so the checked look keys off aria-checked.
                'aria-checked:shadow-[0_0_0_2px_var(--c-elevated),0_0_0_3.5px_var(--c-muted)]',
              )}
            >
              <span
                className={cn('size-4 rounded-full', !css && 'border border-dashed border-line-strong')}
                style={css ? { background: css, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${css} 60%, black 10%)` } : undefined}
              />
              <Check
                size={10}
                strokeWidth={3}
                className={cn('absolute opacity-0 group-aria-checked:opacity-100', css ? 'text-on-solid' : 'text-muted')}
              />
            </RadioGroup.Item>
          </Tooltip>
        )
      })}
    </RadioGroup.Root>
  )
}

// ---------------------------------------------------------------------------
// Group: free text with suggestions from existing groups
// ---------------------------------------------------------------------------

export function GroupInput({ value, onChange, groups, id }: { value: string; onChange: (value: string) => void; groups: string[]; id?: string }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const listId = useId()
  const suggestions = useMemo(() => {
    const q = value.trim().toLowerCase()
    return groups.filter((g) => g.toLowerCase().includes(q) && g !== value.trim()).slice(0, 8)
  }, [groups, value])
  const visible = open && suggestions.length > 0

  const pick = (g: string) => {
    onChange(g)
    setOpen(false)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!visible) {
      if (e.key === 'ArrowDown' && suggestions.length > 0) {
        e.preventDefault()
        setOpen(true)
        setActive(0)
      }
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const dir = e.key === 'ArrowDown' ? 1 : -1
      setActive((a) => (a + dir + suggestions.length) % suggestions.length)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      const g = suggestions[active]
      if (g && e.key === 'Enter') {
        e.preventDefault()
        pick(g)
      } else setOpen(false)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <Popover open={visible} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div>
          <Input
            id={id}
            value={value}
            placeholder={groups.length > 0 ? 'None' : 'e.g. Production'}
            role="combobox"
            aria-expanded={visible}
            aria-controls={listId}
            aria-autocomplete="list"
            onChange={(e) => {
              onChange(e.target.value)
              setOpen(true)
              setActive(0)
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onKeyDown}
            leadingIcon={Folder}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        sideOffset={4}
        className="p-1"
        style={{ width: 'var(--radix-popover-trigger-width)' }}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div id={listId} role="listbox" aria-label="Existing groups">
          {suggestions.map((g, i) => (
            <div
              key={g}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(g)
              }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex h-7 cursor-default items-center gap-2 rounded-[5px] px-2 text-sm text-fg', i === active && 'bg-hover')}
            >
              <FolderOpen size={14} strokeWidth={1.75} className="text-subtle" />
              <span className="truncate">{g}</span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// Secret input
// ---------------------------------------------------------------------------

export interface SecretInputProps {
  id?: string
  field: SecretField
  onType: (value: string) => void
  /** A value is stored in main (only known for the database password). */
  stored?: boolean
  /** Editing an existing connection whose secret state is unknown (SSH secrets). */
  editing?: boolean
  placeholder?: string
  disabled?: boolean
}

export function SecretInput({ id, field, onType, stored, editing, placeholder, disabled }: SecretInputProps) {
  const [shown, setShown] = useState(false)
  const keepPlaceholder = stored ? '••••••• stored' : editing ? 'Unchanged' : (placeholder ?? '')
  return (
    <Input
      id={id}
      type={shown ? 'text' : 'password'}
      value={field.value}
      disabled={disabled}
      placeholder={field.action === 'clear' ? 'Will be removed on save' : keepPlaceholder}
      onChange={(e) => onType(e.target.value)}
      className={cn(!shown && field.value && 'tracking-[0.12em]')}
      trailing={
        <Tooltip content={shown ? 'Hide' : 'Show'}>
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            aria-label={shown ? 'Hide password' : 'Show password'}
            aria-pressed={shown}
            onClick={() => setShown((s) => !s)}
            className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded text-subtle outline-none hover:bg-active hover:text-fg"
          >
            {shown ? <EyeOff size={13} strokeWidth={1.75} /> : <Eye size={13} strokeWidth={1.75} />}
          </button>
        </Tooltip>
      }
    />
  )
}

// ---------------------------------------------------------------------------
// File path input
// ---------------------------------------------------------------------------

export function PathInput({
  id,
  value,
  onChange,
  pickerTitle,
  placeholder,
  disabled,
  invalid,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  pickerTitle: string
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
}) {
  const [picking, setPicking] = useState(false)
  const browse = async () => {
    setPicking(true)
    try {
      const path = await api.files.pickPath(pickerTitle)
      if (path) onChange(path)
    } catch {
      // The native dialog failing leaves the field as is; the path can still be typed.
    } finally {
      setPicking(false)
    }
  }
  return (
    <div className="flex min-w-0 gap-1.5">
      <Input
        id={id}
        mono
        value={value}
        disabled={disabled}
        invalid={invalid}
        placeholder={placeholder ?? '/path/to/file.pem'}
        onChange={(e) => onChange(e.target.value)}
        onClear={value ? () => onChange('') : undefined}
        wrapperClassName="min-w-0 flex-1"
      />
      <Button size="sm" variant="secondary" disabled={disabled} loading={picking} onClick={() => void browse()}>
        Browse…
      </Button>
    </div>
  )
}
