// Pure value formatting for grid cells, the cell inspector and inline editing.
import type { CellValue } from '@shared/types'
import { binaryHex, binaryLength, isNumericText, type ColumnKind } from './column-types'
import { reindentJson } from './json-text'

/** Characters rendered in a cell; the rest is never laid out (the inspector shows everything). */
export const CELL_TEXT_CAP = 600
/** Hex digits rendered for binary values. */
const BINARY_HEX_CAP = 48

/** Text of a value as the user types / copies it. */
export function valueText(value: CellValue): string {
  if (value === null) return ''
  return typeof value === 'string' ? value : String(value)
}

export type CellDisplay =
  | { type: 'null' }
  | { type: 'empty' }
  /** Whitespace-only string: rendered as visible dots. */
  | { type: 'blank'; length: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'binary'; hex: string; bytes: number; truncated: boolean }
  /** `lines`: the text had line breaks (rendered as ↵ markers between segments). */
  | { type: 'text'; segments: string[]; truncated: boolean; badge?: 'json' | 'xml' }

const LINE_BREAK = /\r\n|\r|\n/

export function cellDisplay(value: CellValue, kind: ColumnKind): CellDisplay {
  if (value === null) return { type: 'null' }
  if (typeof value === 'boolean') return { type: 'boolean', value }
  if (kind === 'boolean' && typeof value === 'number' && (value === 0 || value === 1)) return { type: 'boolean', value: value === 1 }
  if (typeof value === 'number') return { type: 'text', segments: [formatNumber(value)], truncated: false }
  if (value === '') return { type: 'empty' }
  if (kind === 'binary') {
    const hex = binaryHex(value)
    if (hex !== null) {
      const prefix = value.slice(0, value.length - hex.length)
      return { type: 'binary', hex: prefix + hex.slice(0, BINARY_HEX_CAP), bytes: binaryLength(value), truncated: hex.length > BINARY_HEX_CAP }
    }
  }
  if (value.trim() === '' && value.length <= CELL_TEXT_CAP) return { type: 'blank', length: value.length }
  const truncated = value.length > CELL_TEXT_CAP
  const head = truncated ? value.slice(0, CELL_TEXT_CAP) : value
  const segments = head.split(LINE_BREAK)
  const badge = kind === 'json' ? 'json' : kind === 'xml' ? 'xml' : undefined
  if (badge === 'json' && segments.length > 1) {
    // multi-line JSON reads better collapsed on one line
    return { type: 'text', segments: [segments.map((s) => s.trim()).join(' ')], truncated, badge }
  }
  return { type: 'text', segments, truncated, badge }
}

function formatNumber(n: number): string {
  if (Object.is(n, -0)) return '0'
  return String(n)
}

/** Right-aligned in the grid: JS numbers and numeric text in numeric columns. */
export function isRightAligned(value: CellValue, kind: ColumnKind): boolean {
  if (typeof value === 'number') return kind !== 'boolean'
  return kind === 'number' && typeof value === 'string'
}

// --- inspector ---------------------------------------------------------------

/**
 * Pretty JSON text, or null when the value is not valid JSON. Re-indents the original text instead of
 * round-tripping it through JS values, so big integers and decimal text ("1.10") are kept exactly.
 */
export function prettyJson(text: string): string | null {
  const t = text.trim()
  if (t === '' || (t[0] !== '{' && t[0] !== '[' && t[0] !== '"')) return null
  return reindentJson(t, '  ')
}

/** Looks like a JSON document (object / array). */
export function looksLikeJson(text: string): boolean {
  const t = text.trimStart()
  return (t.startsWith('{') || t.startsWith('[')) && prettyJson(text) !== null
}

export function looksLikeXml(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('<') && t.trimEnd().endsWith('>')
}

/** Indent an XML fragment (one element / text node per line). Best effort: never throws. */
export function prettyXml(text: string, indent = '  '): string {
  const tokens = text.replace(/>\s+</g, '><').trim().match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)
  if (!tokens) return text
  const lines: string[] = []
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (tok.startsWith('</')) {
      depth = Math.max(0, depth - 1)
      lines.push(indent.repeat(depth) + tok)
    } else if (tok.startsWith('<?') || tok.startsWith('<!') || tok.endsWith('/>')) {
      lines.push(indent.repeat(depth) + tok)
    } else if (tok.startsWith('<')) {
      const text1 = tokens[i + 1]
      const close = tokens[i + 2]
      // <a>text</a> stays on one line
      if (text1 !== undefined && !text1.startsWith('<') && close?.startsWith('</')) {
        lines.push(indent.repeat(depth) + tok + text1 + close)
        i += 2
      } else {
        lines.push(indent.repeat(depth) + tok)
        depth++
      }
    } else {
      const trimmed = tok.trim()
      if (trimmed) lines.push(indent.repeat(depth) + trimmed)
    }
  }
  return lines.join('\n')
}

export type CodeTokenType = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'tag' | 'attr' | 'text' | 'comment'
export interface CodeToken {
  text: string
  type: CodeTokenType
}

/** Tokens of (pretty) JSON text for syntax colouring. Unknown characters become 'text'. */
export function tokenizeJson(text: string): CodeToken[] {
  const out: CodeToken[] = []
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)|\b(true|false|null)\b|([{}[\],:])|(\s+)|(.)/gy
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) {
      out.push({ text: m[1], type: m[2] !== undefined ? 'key' : 'string' })
      if (m[2] !== undefined) out.push({ text: m[2], type: 'punct' })
    } else if (m[3] !== undefined) out.push({ text: m[3], type: 'number' })
    else if (m[4] !== undefined) out.push({ text: m[4], type: 'literal' })
    else if (m[5] !== undefined) out.push({ text: m[5], type: 'punct' })
    else push(out, m[0], 'text')
  }
  return out
}

/** Tokens of XML text: tags, attribute names / values, comments and text. */
export function tokenizeXml(text: string): CodeToken[] {
  const out: CodeToken[] = []
  const re = /(<!--[\s\S]*?-->)|(<\/?[\w:.-]+)|(\s[\w:.-]+)(=)("[^"]*"|'[^']*')|(\/?>)|([^<]+)|(.)/gy
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) out.push({ text: m[1], type: 'comment' })
    else if (m[2] !== undefined) out.push({ text: m[2], type: 'tag' })
    else if (m[3] !== undefined) {
      out.push({ text: m[3], type: 'attr' })
      out.push({ text: m[4]!, type: 'punct' })
      out.push({ text: m[5]!, type: 'string' })
    } else if (m[6] !== undefined) out.push({ text: m[6], type: 'tag' })
    else push(out, m[0], 'text')
  }
  return out
}

function push(out: CodeToken[], text: string, type: CodeTokenType): void {
  const last = out[out.length - 1]
  if (last && last.type === type) last.text += text
  else out.push({ text, type })
}

// --- editing -----------------------------------------------------------------

/** Text placed in the editor for a value (NULL edits start empty). */
export function editText(value: CellValue): string {
  return valueText(value)
}

/** The value needs the multi-line editor (line breaks or long text). */
export function needsTextarea(text: string): boolean {
  return text.length > 120 || LINE_BREAK.test(text)
}

const TRUE_TEXT = new Set(['true', 't', '1', 'yes', 'y', 'on'])
const FALSE_TEXT = new Set(['false', 'f', '0', 'no', 'n', 'off'])

/**
 * Value committed for edited text. Keeps the type the column already uses: JS numbers stay numbers
 * when the text is numeric, booleans parse from true/false/1/0. Anything else stays text (string-
 * encoded numerics included, so no precision is lost); the server validates.
 */
export function parseEditedText(text: string, original: CellValue, kind: ColumnKind): CellValue {
  if (kind === 'boolean' || typeof original === 'boolean') {
    const t = text.trim().toLowerCase()
    if (TRUE_TEXT.has(t)) return true
    if (FALSE_TEXT.has(t)) return false
    return text
  }
  if (typeof original === 'number' || (kind === 'number' && original === null)) {
    const t = text.trim()
    if (isNumericText(t)) {
      const n = Number(t)
      // keep text when a double would lose digits (bigint, numeric(30,10)…)
      if (Number.isFinite(n) && (typeof original === 'number' || String(n) === t.replace(/^\+/, ''))) return n
      return t
    }
    return text
  }
  return text
}

/** Same value (an edit that changes nothing is not reported). */
export function sameValue(a: CellValue, b: CellValue): boolean {
  return a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b))
}
