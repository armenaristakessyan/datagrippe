// Token-preserving JSON re-indentation. Values are never parsed into JS numbers, so integers above
// 2^53, decimal text ("1.10"), exponents and string escapes come out exactly as they went in.

/** Valid JSON text (any JSON value, surrounding whitespace allowed). */
export function isValidJson(text: string): boolean {
  if (text.trim() === '') return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Re-indent valid JSON text. `indent` is the indentation unit ('' gives compact output, like
 * JSON.stringify(value) without spacing); `depth` is the nesting level the value starts at, used when
 * the result is embedded inside another indented document. The output layout matches
 * JSON.stringify(JSON.parse(text), null, indent), except that numbers and strings are copied verbatim.
 * Returns null when the text is not valid JSON.
 */
export function reindentJson(text: string, indent = '  ', depth = 0): string | null {
  if (!isValidJson(text)) return null
  const pretty = indent !== ''
  const newline = (level: number) => (pretty ? '\n' + indent.repeat(level) : '')
  let out = ''
  let level = depth
  const n = text.length
  for (let i = 0; i < n; i++) {
    const ch = text[i]!
    if (ch === '"') {
      // copy the string literal verbatim, escapes included
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue
    if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']'
      let j = i + 1
      while (j < n && /\s/.test(text[j]!)) j++
      if (text[j] === close) {
        out += ch + close
        i = j
        continue
      }
      level++
      out += ch + newline(level)
      continue
    }
    if (ch === '}' || ch === ']') {
      level--
      out += newline(level) + ch
      continue
    }
    if (ch === ',') {
      out += ',' + newline(level)
      continue
    }
    if (ch === ':') {
      out += pretty ? ': ' : ':'
      continue
    }
    // numbers and literals (true / false / null): copy the run verbatim
    let j = i
    while (j < n && !/[\s,:{}[\]"]/.test(text[j]!)) j++
    out += text.slice(i, j)
    i = j - 1
  }
  return out
}
