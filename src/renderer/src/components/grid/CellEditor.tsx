// Inline cell editors: a borderless input over the cell, or — for multi-line / long values — a
// textarea popover anchored to it. Enter (⌘↵ in the textarea) commits, Esc cancels, Tab commits
// and moves; clicking elsewhere commits.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button, Kbd, Popover, PopoverAnchor, PopoverContent } from '@/components/ui'
import { cn } from '@/lib/cn'
import { registerOpenCellEditor } from './edit-session'
import { canvasMeasure, CELL_FONT } from './measure'

export type CommitMove = 'right' | 'left' | null

export interface CellEditorProps {
  left: number
  top: number
  width: number
  height: number
  initial: string
  multiline: boolean
  /** Started by typing: caret at the end instead of selecting the whole value. */
  caretAtEnd: boolean
  numeric: boolean
  columnName: string
  onCommit: (text: string, move: CommitMove) => void
  onCancel: () => void
}

export function CellEditor(props: CellEditorProps) {
  return props.multiline ? <TextareaEditor {...props} /> : <InputEditor {...props} />
}

/**
 * Commit-once handler of an editor. While mounted, the editor is registered as the open one so
 * actions without a blur (⌘S from the native menu) can commit the text being typed.
 */
function useFinish(text: string, onCommit: CellEditorProps['onCommit'], onCancel: () => void) {
  const done = useRef(false)
  const latest = useRef({ text, onCommit, onCancel })
  latest.current = { text, onCommit, onCancel }
  const finish = useCallback((commit: boolean, move: CommitMove = null) => {
    if (done.current) return
    done.current = true
    if (commit) latest.current.onCommit(latest.current.text, move)
    else latest.current.onCancel()
  }, [])
  useEffect(() => registerOpenCellEditor(() => finish(true)), [finish])
  return finish
}

function InputEditor({ left, top, width, height, initial, caretAtEnd, numeric, columnName, onCommit, onCancel }: CellEditorProps) {
  const ref = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(initial)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    if (caretAtEnd) el.setSelectionRange(el.value.length, el.value.length)
    else el.select()
  }, [caretAtEnd])

  const finish = useFinish(text, onCommit, onCancel)

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      finish(true, e.shiftKey ? 'left' : 'right')
    }
  }

  return (
    <input
      ref={ref}
      value={text}
      aria-label={`Edit ${columnName}`}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn(
        'absolute z-[8] rounded-[2px] bg-surface px-2 font-mono text-xs text-fg outline-none ring-[1.5px] ring-inset ring-accent',
        'shadow-[0_0_0_3px_var(--c-accent-soft)] selection:bg-selection',
        numeric && 'text-right tabular',
      )}
      // grows with the text (up to 480px) so long values stay readable while typing
      style={{ left, top, height, width: Math.max(width, Math.min(480, Math.ceil(canvasMeasure(text, CELL_FONT)) + 24)) }}
    />
  )
}

function TextareaEditor({ left, top, width, height, initial, caretAtEnd, columnName, onCommit, onCancel }: CellEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(initial)

  const finish = useFinish(text, onCommit, onCancel)

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Tab' && !e.altKey) {
      e.preventDefault()
      finish(true, e.shiftKey ? 'left' : 'right')
    }
  }

  return (
    <Popover open onOpenChange={(open) => !open && finish(true)}>
      <PopoverAnchor asChild>
        <div aria-hidden className="pointer-events-none absolute z-[8] ring-[1.5px] ring-inset ring-accent" style={{ left, top, width, height }} />
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        sideOffset={2}
        className="flex w-[min(560px,80vw)] flex-col gap-2 p-2"
        style={{ minWidth: Math.min(Math.max(width, 360), 560) }}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          const el = ref.current
          if (!el) return
          el.focus({ preventScroll: true })
          if (caretAtEnd) el.setSelectionRange(el.value.length, el.value.length)
          else el.select()
        }}
        onEscapeKeyDown={(e) => {
          e.preventDefault()
          finish(false)
        }}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <textarea
          ref={ref}
          value={text}
          aria-label={`Edit ${columnName}`}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={8}
          className="selectable block max-h-[50vh] min-h-24 w-full resize-y rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs leading-5 text-fg outline-none focus:border-accent/70"
        />
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-2xs text-subtle">
            <Kbd shortcut="CmdOrCtrl+Enter" /> apply
            <Kbd shortcut="Escape" className="ml-2" /> cancel
          </span>
          <span className="flex-1" />
          <Button size="xs" variant="ghost" onClick={() => finish(false)}>
            Cancel
          </Button>
          <Button size="xs" variant="primary" onClick={() => finish(true)}>
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
