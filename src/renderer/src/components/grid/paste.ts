// Clipboard text → a block of cell texts, for pasting into an editable grid. Reads what spreadsheets
// and this grid copy: tab-separated lines, with "quoted" fields for values holding tabs, line breaks
// or a leading quote (toTSV's rule). A single line without tabs is a single value.

/** Cells per paste at most (larger pastes are refused). */
export const PASTE_CELL_LIMIT = 10_000

export function parsePastedText(text: string): string[][] {
  if (text === '') return [['']]
  // a trailing line break (spreadsheets add one) is not an extra empty row
  const body = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '')
  if (!body.includes('\t') && !body.includes('\n')) return [[body]]
  const rows: string[][] = []
  let row: string[] = []
  let i = 0
  const n = body.length
  while (i <= n) {
    if (body[i] === '"') {
      // quoted field: "" is a literal quote; ends at the closing quote
      let value = ''
      let j = i + 1
      for (;;) {
        const q = body.indexOf('"', j)
        if (q < 0) {
          // unterminated: keep the rest verbatim
          value += body.slice(j)
          j = n
          break
        }
        value += body.slice(j, q)
        if (body[q + 1] === '"') {
          value += '"'
          j = q + 2
          continue
        }
        j = q + 1
        break
      }
      // anything up to the next separator belongs to the field (lenient)
      let k = j
      while (k < n && body[k] !== '\t' && body[k] !== '\n') k++
      row.push(value + body.slice(j, k))
      i = k
    } else {
      let k = i
      while (k < n && body[k] !== '\t' && body[k] !== '\n') k++
      row.push(body.slice(i, k))
      i = k
    }
    if (i >= n) {
      rows.push(row)
      break
    }
    if (body[i] === '\n') {
      rows.push(row)
      row = []
    }
    i++
    if (i === n) {
      // separator at the very end: one more empty field
      row.push('')
      rows.push(row)
      break
    }
  }
  return rows
}
