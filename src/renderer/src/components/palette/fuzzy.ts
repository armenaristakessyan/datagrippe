// Small fuzzy matcher for the command palette.
//
// Matches are ranked in tiers so that "obvious" hits always beat scattered subsequences:
//   exact > prefix > word-start substring > acronym (word initials) > substring > fuzzy subsequence.
// Within a tier, shorter targets and earlier matches win. Matching is case-insensitive.

export interface FuzzyMatch {
  score: number
  /** Indices of the matched characters in the target (ascending). */
  positions: number[]
}

export const FUZZY_TIER = {
  exact: 1000,
  prefix: 900,
  wordStart: 750,
  acronym: 650,
  substring: 500,
  /** Upper bound of scattered subsequence scores (always below `substring`). */
  fuzzyMax: 400,
} as const

const SEPARATOR = /[^\p{L}\p{N}]/u
const UPPER = /\p{Lu}/u
const LOWER = /\p{Ll}/u
const DIGIT = /\p{N}/u

/** Word starts: index 0, after a separator, lower→upper (camelCase) and letter↔digit transitions. */
export function wordStarts(target: string): boolean[] {
  const starts = new Array<boolean>(target.length).fill(false)
  for (let i = 0; i < target.length; i++) {
    const c = target[i] ?? ''
    if (SEPARATOR.test(c)) continue
    if (i === 0) {
      starts[i] = true
      continue
    }
    const p = target[i - 1] ?? ''
    if (SEPARATOR.test(p)) starts[i] = true
    else if (UPPER.test(c) && LOWER.test(p)) starts[i] = true
    else if (DIGIT.test(c) !== DIGIT.test(p)) starts[i] = true
  }
  return starts
}

const range = (start: number, length: number) => Array.from({ length }, (_, i) => start + i)

function isSubsequence(query: string, target: string): boolean {
  let j = 0
  for (let i = 0; i < target.length && j < query.length; i++) if (target[i] === query[j]) j++
  return j === query.length
}

/** Greedy match of every query char on a word start, in order. */
function acronym(query: string, target: string, starts: boolean[]): number[] | null {
  const positions: number[] = []
  let j = 0
  for (let i = 0; i < target.length && j < query.length; i++) {
    if (starts[i] && target[i] === query[j]) {
      positions.push(i)
      j++
    }
  }
  return j === query.length ? positions : null
}

// Subsequence scoring (DP over query × target, O(m·n)).
const MATCH = 1
const WORD_START_BONUS = 8
const FIRST_CHAR_BONUS = 4
const CONSECUTIVE_BONUS = 6
const GAP_PENALTY = 3
const MAX_PER_CHAR = MATCH + WORD_START_BONUS + FIRST_CHAR_BONUS + CONSECUTIVE_BONUS

function subsequence(query: string, target: string, starts: boolean[]): FuzzyMatch | null {
  const m = query.length
  const n = target.length
  const NONE = Number.NEGATIVE_INFINITY
  // score[i][j]: best score with query[i] matched at target[j]; from[i][j]: target index of query[i-1].
  const score: Float64Array[] = []
  const from: Int32Array[] = []
  for (let i = 0; i < m; i++) {
    const row = new Float64Array(n).fill(NONE)
    const back = new Int32Array(n).fill(-1)
    const prev = score[i - 1]
    // Running best of prev[0..j-2] (non-adjacent predecessor) and its index.
    let bestBefore = NONE
    let bestBeforeAt = -1
    for (let j = 0; j < n; j++) {
      if (prev && j >= 2) {
        const candidate = prev[j - 2] ?? NONE
        if (candidate > bestBefore) {
          bestBefore = candidate
          bestBeforeAt = j - 2
        }
      }
      if (target[j] !== query[i]) continue
      const bonus = MATCH + (starts[j] ? WORD_START_BONUS : 0) + (j === 0 ? FIRST_CHAR_BONUS : 0)
      if (i === 0) {
        row[j] = bonus - Math.min(j, 10) * 0.5
        continue
      }
      const adjacent = j >= 1 && prev ? (prev[j - 1] ?? NONE) + CONSECUTIVE_BONUS : NONE
      const gapped = bestBefore - GAP_PENALTY
      if (adjacent === NONE && gapped === NONE) continue
      if (adjacent >= gapped) {
        row[j] = bonus + adjacent
        back[j] = j - 1
      } else {
        row[j] = bonus + gapped
        back[j] = bestBeforeAt
      }
    }
    score.push(row)
    from.push(back)
  }
  const last = score[m - 1]
  if (!last) return null
  let end = -1
  let best = NONE
  for (let j = 0; j < n; j++) {
    if ((last[j] ?? NONE) > best) {
      best = last[j] ?? NONE
      end = j
    }
  }
  if (end < 0 || best === NONE) return null
  const positions = new Array<number>(m)
  for (let i = m - 1, j = end; i >= 0; i--) {
    positions[i] = j
    j = from[i]?.[j] ?? -1
  }
  const normalized = (best / (m * MAX_PER_CHAR)) * FUZZY_TIER.fuzzyMax - Math.min(20, (n - m) / 5)
  return { score: Math.max(1, Math.min(FUZZY_TIER.fuzzyMax, Math.round(normalized))), positions }
}

/** Score `query` against `target`; null when the query is not a subsequence of the target. */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase()
  if (!q) return { score: 0, positions: [] }
  const t = target.toLowerCase()
  if (q.length > t.length || !isSubsequence(q, t)) return null
  const extra = t.length - q.length

  if (t === q) return { score: FUZZY_TIER.exact, positions: range(0, q.length) }
  if (t.startsWith(q)) return { score: FUZZY_TIER.prefix - Math.min(99, extra), positions: range(0, q.length) }

  const starts = wordStarts(target)
  for (let at = t.indexOf(q, 1); at >= 0; at = t.indexOf(q, at + 1)) {
    if (starts[at]) {
      return { score: FUZZY_TIER.wordStart - Math.min(49, at) - Math.min(49, extra), positions: range(at, q.length) }
    }
  }
  if (q.length >= 2) {
    const initials = acronym(q, t, starts)
    if (initials) {
      const wordCount = starts.filter(Boolean).length
      return { score: FUZZY_TIER.acronym - Math.min(49, (wordCount - q.length) * 4) - Math.min(49, extra), positions: initials }
    }
  }
  const at = t.indexOf(q)
  if (at >= 0) return { score: FUZZY_TIER.substring - Math.min(49, at) - Math.min(49, extra), positions: range(at, q.length) }

  return subsequence(q, t, starts)
}

export interface SearchField {
  text: string
  /** Multiplier applied to the field's score (1 = primary label). */
  weight: number
  /** Map a position in this field to a position in the label (null = not part of the label). */
  toLabel?: (position: number) => number | null
  /**
   * Minimum raw score for this field to count. Context fields use FUZZY_TIER.substring so that
   * only contiguous matches count (a scattered "o…r…d" across "Local SQL Server" is noise).
   */
  minScore?: number
}

export interface ItemMatch {
  score: number
  /** Matched positions inside the label (field 0 / mapped fields). */
  labelPositions: number[]
}

/**
 * Score an item described by several fields. Whitespace separates query tokens; every token must
 * match at least one field and the item's score is the sum of each token's best weighted score.
 * An empty query matches everything with score 0.
 */
export function matchFields(query: string, fields: SearchField[]): ItemMatch | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { score: 0, labelPositions: [] }
  let total = 0
  const label = new Set<number>()
  for (const token of tokens) {
    let best: { score: number; positions: number[] } | null = null
    for (let f = 0; f < fields.length; f++) {
      const field = fields[f]
      if (!field || !field.text) continue
      const match = fuzzyMatch(token, field.text)
      if (!match || (field.minScore !== undefined && match.score < field.minScore)) continue
      const weighted = match.score * field.weight
      if (!best || weighted > best.score) {
        const mapped =
          f === 0
            ? match.positions
            : field.toLabel
              ? match.positions.map(field.toLabel).filter((p): p is number => p !== null)
              : []
        best = { score: weighted, positions: mapped }
      }
    }
    if (!best) return null
    total += best.score
    for (const p of best.positions) label.add(p)
  }
  return { score: total, labelPositions: [...label].sort((a, b) => a - b) }
}

/** Split `text` into runs of matched / unmatched characters for highlighting. */
export function highlightRuns(text: string, positions: number[]): { text: string; match: boolean }[] {
  if (positions.length === 0) return [{ text, match: false }]
  const set = new Set(positions)
  const runs: { text: string; match: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const match = set.has(i)
    const last = runs[runs.length - 1]
    if (last && last.match === match) last.text += text[i]
    else runs.push({ text: text[i] ?? '', match })
  }
  return runs
}
