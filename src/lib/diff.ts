/**
 * Line-oriented diff (longest-common-subsequence) used by the composer's
 * changes label and the full-screen diff viewer.
 *
 * The common prefix/suffix is trimmed first — the bulk of typical edits —
 * and the remaining middle is solved with an LCS dynamic program. When the
 * middle is too large for the DP budget the file falls back to a simplified
 * "replace" diff (flagged via `simplified`) so a huge rewrite can never lock
 * the UI up.
 */

export type DiffLineType = 'context' | 'add' | 'del'

export interface DiffLine {
  type: DiffLineType
  text: string
  /** 1-based line number on the base (left) side; unset for additions. */
  oldNo?: number
  /** 1-based line number on the next (right) side; unset for deletions. */
  newNo?: number
}

export interface DiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

export interface LineDiff {
  added: number
  removed: number
  hunks: DiffHunk[]
  /** True when the change exceeded the LCS budget and was simplified. */
  simplified: boolean
}

/** Split text into lines; a single trailing newline does not create a line. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

interface Op {
  type: DiffLineType
  text: string
}

/** LCS edit script for the (already trimmed) middle section. */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((text) => ({ type: 'add' as const, text }))
  if (m === 0) return a.map((text) => ({ type: 'del' as const, text }))

  const stride = m + 1
  const dp = new Uint32Array((n + 1) * stride)
  for (let i = n - 1; i >= 0; i--) {
    const row = i * stride
    const nextRow = (i + 1) * stride
    const ai = a[i]!
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] =
        ai === b[j] ? dp[nextRow + j + 1]! + 1 : Math.max(dp[nextRow + j]!, dp[row + j + 1]!)
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'context', text: a[i]! })
      i++
      j++
    } else if (dp[(i + 1) * stride + j]! >= dp[i * stride + j + 1]!) {
      ops.push({ type: 'del', text: a[i]! })
      i++
    } else {
      ops.push({ type: 'add', text: b[j]! })
      j++
    }
  }
  while (i < n) {
    ops.push({ type: 'del', text: a[i]! })
    i++
  }
  while (j < m) {
    ops.push({ type: 'add', text: b[j]! })
    j++
  }
  return ops
}

export function diffLines(
  base: string,
  next: string,
  opts: { context?: number; maxCells?: number } = {},
): LineDiff {
  const context = opts.context ?? 3
  const maxCells = opts.maxCells ?? 2_000_000

  const a = splitLines(base)
  const b = splitLines(next)

  // Shared prefix …
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  // … shared suffix.
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  let ops: Op[]
  let simplified = false
  if (midA.length * midB.length > maxCells) {
    // Too big for an exact LCS — show the middle as a wholesale replacement.
    simplified = true
    ops = [
      ...midA.map((text): Op => ({ type: 'del', text })),
      ...midB.map((text): Op => ({ type: 'add', text })),
    ]
  } else {
    ops = lcsOps(midA, midB)
  }

  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.type === 'add') added++
    else if (op.type === 'del') removed++
  }

  // Full pass with line numbers: shared prefix, the edit script, suffix.
  const all: Op[] = []
  for (let i = 0; i < start; i++) all.push({ type: 'context', text: a[i]! })
  all.push(...ops)
  for (let i = endA; i < a.length; i++) all.push({ type: 'context', text: a[i]! })

  const numbered: DiffLine[] = []
  // Counters as they stood *before* each row — used for hunk headers whose
  // side has no lines of its own (pure insertion / pure deletion).
  const oldBefore: number[] = []
  const newBefore: number[] = []
  let oldNo = 1
  let newNo = 1
  for (const op of all) {
    oldBefore.push(oldNo)
    newBefore.push(newNo)
    if (op.type === 'context') {
      numbered.push({ ...op, oldNo, newNo })
      oldNo++
      newNo++
    } else if (op.type === 'del') {
      numbered.push({ ...op, oldNo })
      oldNo++
    } else {
      numbered.push({ ...op, newNo })
      newNo++
    }
  }

  if (added === 0 && removed === 0) return { added, removed, hunks: [], simplified }

  // Group changes into hunks with `context` lines of surrounding context.
  const ranges: [number, number][] = []
  for (let i = 0; i < numbered.length; i++) {
    if (numbered[i]!.type === 'context') continue
    const s = Math.max(0, i - context)
    const e = Math.min(numbered.length - 1, i + context)
    const last = ranges[ranges.length - 1]
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e)
    else ranges.push([s, e])
  }

  const hunks: DiffHunk[] = ranges.map(([s, e]) => {
    const lines = numbered.slice(s, e + 1)
    const oldLines = lines.filter((l) => l.type !== 'add')
    const newLines = lines.filter((l) => l.type !== 'del')
    return {
      oldStart: oldLines[0]?.oldNo ?? oldBefore[s]!,
      oldCount: oldLines.length,
      newStart: newLines[0]?.newNo ?? newBefore[s]!,
      newCount: newLines.length,
      lines,
    }
  })

  return { added, removed, hunks, simplified }
}
