// Loads the tedious instance used by `mssql` (so the session and the metadata pool share one copy,
// even though tedious is not a direct dependency and would otherwise be bundled separately), and
// installs exact decoders for decimal / numeric / money / datetimeoffset / sql_variant values, and
// records the statement type (CurCmd) of DONE tokens, which tedious parses but does not emit.
//
// tedious offers no option to receive decimals as strings: it computes `magnitude / 10^scale` as a
// double and drops the datetimeoffset offset. Its row parser calls `valueParser.readValue` through
// the module's exports object, so wrapping that export lets us re-decode the raw bytes exactly.
// If a future tedious changes this shape the patch is skipped and values fall back to tedious'
// lossy numbers (see `exactValuesInstalled`).

import { createRequire } from 'node:module'
import type * as Tedious from 'tedious'
import { decodeDateTimeOffset, decodeDecimal, decodeMoney, decodeVariant } from './exact-values'

const requireHere = createRequire(import.meta.url)
const requireFromMssql = createRequire(requireHere.resolve('mssql'))

export const tedious = requireFromMssql('tedious') as typeof Tedious

interface ParsedValue {
  value: unknown
  offset: number
}

interface ValueMetadata {
  type: { name: string }
  scale?: number
}

type ReadValue = (buf: Buffer, offset: number, metadata: ValueMetadata, options: unknown) => ParsedValue

const PATCHED = Symbol.for('datagrippe.mssql.exactValues')

function isParsedValue(value: unknown): value is ParsedValue {
  return typeof value === 'object' && value !== null && 'value' in value && 'offset' in value
}

function exactValue(buf: Buffer, start: number, end: number, metadata: ValueMetadata): string | undefined {
  switch (metadata.type.name) {
    case 'DecimalN':
    case 'NumericN':
      // 1 length byte, then sign + magnitude
      return decodeDecimal(buf.subarray(start + 1, end), metadata.scale ?? 0)
    case 'MoneyN':
      return decodeMoney(buf.subarray(start + 1, end))
    case 'Money':
    case 'SmallMoney':
      return decodeMoney(buf.subarray(start, end))
    case 'DateTimeOffset':
      return decodeDateTimeOffset(buf.subarray(start + 1, end), metadata.scale ?? 7)
    case 'Variant':
      // 4 length bytes, then base type, property length, properties and value
      return decodeVariant(buf.subarray(start + 4, end))
    default:
      return undefined
  }
}

function installExactValues(): boolean {
  let parser: Record<string | symbol, unknown>
  try {
    parser = requireFromMssql('tedious/lib/value-parser') as Record<string | symbol, unknown>
  } catch {
    return false
  }
  if (parser[PATCHED] === true) return true
  const original = parser.readValue
  if (typeof original !== 'function') return false
  const originalRead = original as ReadValue

  const patched: ReadValue = (buf, offset, metadata, options) => {
    const result = originalRead(buf, offset, metadata, options)
    if (!isParsedValue(result) || result.value === null || result.value === undefined) return result
    const exact = exactValue(buf, offset, result.offset, metadata)
    if (exact !== undefined) result.value = exact
    return result
  }
  try {
    parser.readValue = patched
    parser[PATCHED] = true
  } catch {
    return false
  }
  return parser.readValue === patched
}

/** True when decimal/money/datetimeoffset/sql_variant values arrive as exact strings. */
export const exactValuesInstalled = installExactValues()

/** Request property holding the CurCmd of the last DONE / DONEINPROC token it received. */
export const DONE_CUR_CMD = Symbol.for('datagrippe.mssql.doneCurCmd')
const DONE_PATCHED = Symbol.for('datagrippe.mssql.doneCurCmdPatched')

type TokenHandlerMethod = (this: { request?: object }, token: { curCmd?: unknown }) => unknown

function installDoneCommands(): boolean {
  let handlers: Record<string, unknown>
  try {
    handlers = requireFromMssql('tedious/lib/token/handler') as Record<string, unknown>
  } catch {
    return false
  }
  const handlerClass = handlers.RequestTokenHandler
  if (typeof handlerClass !== 'function') return false
  const prototype = (handlerClass as { prototype: Record<string | symbol, unknown> }).prototype
  if (prototype[DONE_PATCHED] === true) return true
  for (const name of ['onDone', 'onDoneInProc']) {
    const original = prototype[name]
    if (typeof original !== 'function') return false
    const wrapped: TokenHandlerMethod = function (token) {
      if (this.request && typeof token.curCmd === 'number') {
        ;(this.request as Record<symbol, unknown>)[DONE_CUR_CMD] = token.curCmd
      }
      return (original as TokenHandlerMethod).call(this, token)
    }
    prototype[name] = wrapped
  }
  prototype[DONE_PATCHED] = true
  return true
}

/** True when CountEvents carry the statement type of their DONE token. */
export const doneCommandsInstalled = installDoneCommands()
