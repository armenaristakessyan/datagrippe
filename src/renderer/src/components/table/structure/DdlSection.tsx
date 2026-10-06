import { useState } from 'react'
import { Check, Copy, FileCode2, RotateCcw, SquareTerminal } from 'lucide-react'
import type { DbErrorInfo } from '@shared/types'
import { Button, Callout, CodeBlock, Skeleton } from '@/components/ui'
import { ErrorDetail } from '../ErrorDetail'
import { SectionEmpty } from './SectionTable'

export type DdlState = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; ddl: string } | { status: 'error'; error: DbErrorInfo }

export interface DdlSectionProps {
  state: DdlState
  onRetry: () => void
  onOpenInConsole: (ddl: string) => void
}

export function DdlSection({ state, onRetry, onOpenInConsole }: DdlSectionProps) {
  const [copied, setCopied] = useState(false)

  if (state.status === 'error') {
    return (
      <div className="p-4">
        <Callout
          tone="danger"
          title="Could not generate the DDL"
          actions={
            <Button size="xs" leadingIcon={RotateCcw} onClick={onRetry}>
              Retry
            </Button>
          }
        >
          <ErrorDetail error={state.error} />
        </Callout>
      </div>
    )
  }

  if (state.status !== 'ready') {
    return (
      <div className="p-4" aria-busy aria-label="Loading DDL">
        <div className="space-y-2.5 rounded-lg border border-line bg-panel px-3 py-3">
          {[46, 30, 38, 24, 52, 34, 28, 18].map((w, i) => (
            <Skeleton key={i} width={`${w}%`} className={i > 0 && i < 7 ? 'ml-4' : undefined} />
          ))}
        </div>
      </div>
    )
  }

  if (!state.ddl.trim()) {
    return <SectionEmpty icon={FileCode2} title="No DDL available" description="The server did not return a definition for this object." />
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(state.ddl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex items-center gap-1">
        <p className="flex-1 text-2xs text-subtle">Generated from the catalog. Review before running elsewhere.</p>
        <Button size="xs" variant="ghost" leadingIcon={copied ? Check : Copy} onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button size="xs" variant="ghost" leadingIcon={SquareTerminal} onClick={() => onOpenInConsole(state.ddl)}>
          Open in console
        </Button>
      </div>
      <CodeBlock code={state.ddl} wrap={false} copyable={false} className="bg-panel" />
    </div>
  )
}
