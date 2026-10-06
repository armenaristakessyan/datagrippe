import { useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/cn'
import { highlightSql, SQL_TOKEN_CLASS } from './highlight'

export interface CodeBlockProps {
  code: string
  /** 'sql' colors tokens; 'text' renders plain monospace. */
  language?: 'sql' | 'text'
  /** Show the copy button (top-right, on hover/focus). Default true. */
  copyable?: boolean
  /** Max height before scrolling (px or CSS length). */
  maxHeight?: number | string
  /** Wrap long lines (default true). */
  wrap?: boolean
  className?: string
}

/** Read-only monospace block with selectable text and SQL highlighting. */
export function CodeBlock({ code, language = 'sql', copyable = true, maxHeight, wrap = true, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const tokens = useMemo(() => (language === 'sql' ? highlightSql(code) : null), [code, language])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className={cn('group relative rounded-lg border border-line bg-surface', className)}>
      <pre
        className={cn(
          'selectable overflow-auto px-3 py-2.5 font-mono text-xs leading-[18px] text-fg',
          wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre',
        )}
        style={{ maxHeight }}
      >
        <code>
          {tokens
            ? tokens.map((t, i) => (
                <span key={i} className={SQL_TOKEN_CLASS[t.type]}>
                  {t.text}
                </span>
              ))
            : code}
        </code>
      </pre>
      {copyable && (
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? 'Copied' : 'Copy'}
          className={cn(
            'absolute right-1.5 top-1.5 flex h-6 items-center gap-1 rounded-md border border-line bg-elevated px-1.5 text-2xs text-muted shadow-raised outline-none',
            'opacity-0 transition-opacity duration-100 hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus group-hover:opacity-100',
            copied && 'opacity-100',
          )}
        >
          {copied ? <Check size={12} strokeWidth={2.25} className="text-success" /> : <Copy size={12} strokeWidth={1.75} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
    </div>
  )
}

/** Inline highlighted SQL (single line contexts such as history rows). */
export function SqlText({ code, className }: { code: string; className?: string }) {
  const tokens = useMemo(() => highlightSql(code), [code])
  return (
    <code className={cn('font-mono', className)}>
      {tokens.map((t, i) => (
        <span key={i} className={SQL_TOKEN_CLASS[t.type]}>
          {t.text}
        </span>
      ))}
    </code>
  )
}
