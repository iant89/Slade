/**
 * Roadmap tracking for the orchestrator's completion report.
 *
 * When an orchestrated run finishes and the workspace holds a roadmap or
 * milestone file, Slade shows the user where the project stands: the previous,
 * current and next step, plus overall completion. Everything in this module is
 * pure and deterministic — the numbers come from parsing the file before and
 * after the run, never from what a model claims about it — so the report can
 * never say more than the roadmap itself does.
 *
 * Kept free of store imports on purpose (types only) so `lib/fs.ts`, the
 * simulator and the smoke tests can all use it without import cycles.
 */

import type {
  RoadmapChange,
  RoadmapProgress,
  RoadmapReport,
  RoadmapStatus,
  RoadmapTimelineStep,
} from '../types'

/* ------------------------------------------------------------------ */
/* Which files count as a roadmap                                      */
/* ------------------------------------------------------------------ */

/** `roadmap` / `milestone(s)` as a whole word of the file stem: ROADMAP, product-roadmap, docs/milestones … */
const ROADMAP_STEM_RE = /(?:^|[\s._-])(?:roadmap|milestone)s?(?:$|[\s._-])/i
const ROADMAP_EXTS = new Set(['', 'md', 'markdown', 'mdx', 'txt'])
const VENDORED_DIR_RE = /(?:^|\/)(?:node_modules|\.git|vendor|dist|build|coverage)\//i

/** True for `ROADMAP.md`, `MILESTONES.md`, `docs/roadmap.md`, `product-roadmap.txt` … but not `roadmap.ts`. */
export function isRoadmapPath(path: string): boolean {
  const norm = path.replace(/\\/g, '/').replace(/^\.?\//, '')
  if (VENDORED_DIR_RE.test(norm)) return false
  const base = norm.slice(norm.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  return ROADMAP_EXTS.has(ext) && ROADMAP_STEM_RE.test(stem)
}

function pathDepth(path: string): number {
  return path.split('/').length - 1
}

export interface RoadmapFileSnapshot {
  path: string
  content: string
}

/** The text roadmap files among `files`, as plain path + content pairs. */
export function snapshotRoadmapFiles(
  files: readonly { path: string; content: string; encoding?: 'utf8' | 'base64' }[],
): RoadmapFileSnapshot[] {
  return files
    .filter((f) => f.encoding !== 'base64' && isRoadmapPath(f.path))
    .map((f) => ({ path: f.path, content: f.content }))
}

/**
 * Roadmap blobs in a GitHub tree worth pulling into the workspace so the
 * agent can read them: shallowest first, capped, and skipping anything large.
 */
export function findRoadmapBlobs(
  entries: readonly { path: string; type: string; size?: number }[],
  max = 2,
  maxBytes = 200_000,
): string[] {
  return entries
    .filter((e) => e.type === 'blob' && isRoadmapPath(e.path) && (e.size ?? 0) <= maxBytes)
    .map((e) => e.path)
    .sort((a, b) => pathDepth(a) - pathDepth(b) || a.localeCompare(b))
    .slice(0, max)
}

/* ------------------------------------------------------------------ */
/* Status vocabulary                                                   */
/* ------------------------------------------------------------------ */

const STATUS_WORDS = new Map<string, RoadmapStatus>([
  ...['done', 'complete', 'completed', 'finished', 'shipped', 'released', 'delivered', 'merged', 'implemented', 'resolved', 'closed'].map(
    (w) => [w, 'done'] as [string, RoadmapStatus],
  ),
  ...['in progress', 'wip', 'ongoing', 'underway', 'started', 'active', 'current', 'in development', 'in review', 'building', 'now'].map(
    (w) => [w, 'active'] as [string, RoadmapStatus],
  ),
  ...[
    'todo',
    'to do',
    'planned',
    'pending',
    'not started',
    'upcoming',
    'backlog',
    'queued',
    'next',
    'proposed',
    'open',
    'later',
    'tbd',
    'blocked',
    'on hold',
    'deferred',
    'postponed',
    'future',
  ].map((w) => [w, 'todo'] as [string, RoadmapStatus]),
])
const STATUS_WORDS_LONGEST_FIRST = [...STATUS_WORDS.keys()].sort((a, b) => b.length - a.length)

/** Lower-case, drop emphasis, unify `in-progress` / `in_progress` → `in progress`. */
function normalizeWords(s: string): string {
  return s.toLowerCase().replace(/[*`]/g, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Status for a phrase that is *exactly* a status word: "Done", "in-progress", "Not started". */
function statusOfPhrase(s: string): RoadmapStatus | undefined {
  return STATUS_WORDS.get(normalizeWords(s).replace(/[.!:]+$/, ''))
}

/** Status for text that *starts with* a status word: "In progress (60%)", "Done, shipped Jan 5". */
function statusOfPrefix(s: string): RoadmapStatus | undefined {
  const n = normalizeWords(s)
  for (const word of STATUS_WORDS_LONGEST_FIRST) {
    if (n === word) return STATUS_WORDS.get(word)
    if (n.startsWith(word) && !/[a-z0-9]/.test(n.charAt(word.length))) return STATUS_WORDS.get(word)
  }
  return undefined
}

const EMOJI_STATUS = new Map<string, RoadmapStatus>([
  ['✅', 'done'],
  ['✔', 'done'],
  ['☑', 'done'],
  ['🟢', 'done'],
  ['🔄', 'active'],
  ['🚧', 'active'],
  ['🔨', 'active'],
  ['🛠', 'active'],
  ['🏗', 'active'],
  ['▶', 'active'],
  ['🟡', 'active'],
  ['⏳', 'todo'],
  ['⌛', 'todo'],
  ['⬜', 'todo'],
  ['☐', 'todo'],
  ['🔲', 'todo'],
  ['⚪', 'todo'],
  ['🔴', 'todo'],
  ['⏸', 'todo'],
  ['📅', 'todo'],
  ['🗓', 'todo'],
  ['🔜', 'todo'],
])
const EMOJI_ALT = [...EMOJI_STATUS.keys()].join('|')
const LEADING_EMOJI_RE = new RegExp(`^\\s*(${EMOJI_ALT})\\uFE0F?\\s*`, 'u')
// A trailing marker may be followed by a small note: "Core chat ✅ (Jan 5)".
const TRAILING_EMOJI_RE = new RegExp(`\\s*(${EMOJI_ALT})\\uFE0F?\\s*(?:\\([^)]*\\)|\\[[^\\]]*\\])?\\s*$`, 'u')

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

const MAX_LABEL = 140
const MAX_LINE = 2000

/** Strip Markdown decoration and stray separators so a label reads as plain text. */
export function cleanLabel(raw: string): string {
  const s = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*([^\s*][^*]*?)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_([^\s_][^_]*?)_(?![\w])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:—–|·-]+|[\s:—–|·-]+$/g, '')
    .trim()
  return s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1).trimEnd()}…` : s
}

/**
 * Split a status marker off a heading / list item / table cell and return the
 * remaining label. Understands, in any combination:
 *   ✅ Core chat        Core chat ✅ (Jan 5)
 *   Core chat (done)    Core chat [in progress]
 *   Core chat — done    Core chat: in progress    Core chat - wip
 *   **Done** — Core chat    [Done] Core chat    Done: Core chat
 * An explicit word wins over an emoji when both are present.
 */
function splitStatus(raw: string): { label: string; status?: RoadmapStatus } {
  let text = raw.replace(/\uFE0F/g, '').trim()
  let word: RoadmapStatus | undefined
  let emoji: RoadmapStatus | undefined

  for (let pass = 0; pass < 4; pass++) {
    let changed = false

    const lead = LEADING_EMOJI_RE.exec(text)
    if (lead) {
      emoji ??= EMOJI_STATUS.get(lead[1]!)
      text = text.slice(lead[0].length)
      changed = true
    }
    const trail = TRAILING_EMOJI_RE.exec(text)
    if (trail) {
      emoji ??= EMOJI_STATUS.get(trail[1]!)
      text = text.slice(0, trail.index)
      changed = true
    }

    if (!word) {
      // "(done)" / "[in progress]" — first phrase inside the trailing group.
      const paren = /\s*[([]\s*([^)\]]{1,40}?)\s*[)\]]\s*$/.exec(text)
      const inner = paren ? statusOfPrefix(paren[1]!) : undefined
      if (paren && inner) {
        word = inner
        text = text.slice(0, paren.index)
        changed = true
      } else {
        // "— done" / ": in progress" / " - wip" / " | planned"
        const tail = /(?:\s*[—–]\s*|\s*:\s*|\s+-\s+|\s*\|\s*)(?:\*\*|__)?([A-Za-z][A-Za-z _-]{1,20}?)(?:\*\*|__)?\s*$/.exec(text)
        const tailStatus = tail ? statusOfPhrase(tail[1]!) : undefined
        if (tail && tailStatus) {
          word = tailStatus
          text = text.slice(0, tail.index)
          changed = true
        } else {
          // "**Done** — X" / "Done: X" / "Done - X" / "[Done] X"
          const badge =
            /^(?:\*\*|__)([^*_]{2,24})(?:\*\*|__)\s*(?:[—–:|]|\s-)\s*(.+)$/.exec(text) ??
            /^\[([A-Za-z][A-Za-z _-]{1,20})\]\s+(.+)$/.exec(text) ??
            /^([A-Za-z][A-Za-z _-]{1,20}?)\s*(?:[—–:|]|\s-)\s+(.+)$/.exec(text)
          const badgeStatus = badge ? statusOfPhrase(badge[1]!) : undefined
          if (badge && badgeStatus) {
            word = badgeStatus
            text = badge[2]!
            changed = true
          }
        }
      }
    }

    if (!changed) break
  }

  return { label: cleanLabel(text), status: word ?? emoji }
}

/** Status from a "Status:" value or table cell: "✅ Done", "In progress", "🚧", "Done (Jan)". */
function valueStatus(value: string, loose: boolean): RoadmapStatus | undefined {
  const sp = splitStatus(value)
  if (sp.status && !sp.label) return sp.status
  const byWord = loose && sp.label.length <= 40 ? statusOfPrefix(sp.label) : statusOfPhrase(sp.label)
  return byWord ?? sp.status
}

/** Headings that name a status ("Done", "In progress", "Planned", "Next steps") group their plain bullets. */
const BUCKET_LABEL_RE =
  /^(done|completed?|finished|shipped|released|delivered|in[ -]progress|wip|ongoing|underway|current|active|now|planned|upcoming|next|later|backlog|to[ -]?do|pending|not started|future|on hold|deferred|postponed|blocked|proposed|open)(?:\s+(?:milestones?|items?|work|tasks?|features?|steps?|phases?|goals?|releases?|deliverables?|stories|epics?|so far|up next))?$/i

function bucketStatusOf(label: string): RoadmapStatus | undefined {
  const m = BUCKET_LABEL_RE.exec(label.trim())
  return m ? statusOfPhrase(m[1]!) : undefined
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

export interface RoadmapStep {
  /** 1-based position among all steps, in document order. */
  index: number
  label: string
  status: RoadmapStatus
  /** Enclosing milestone / section, when the roadmap has one. */
  group?: string
  /** 0-based source line — lets callers edit the step in place. */
  line: number
}

export interface ParsedRoadmap {
  title?: string
  steps: RoadmapStep[]
}

interface Candidate {
  kind: 'item' | 'row' | 'heading'
  line: number
  label: string
  status: RoadmapStatus
  group?: string
  /** Heading level; 7 for list items and table rows. */
  level: number
  indent: number
  hasChildren: boolean
}

interface HeadingCtx {
  level: number
  label: string
  /** 0-based source line of the heading itself. */
  line: number
  isTitle: boolean
  /** Set for status-named sections ("Done", "In progress"…): their plain bullets are steps. */
  bucket?: RoadmapStatus
  /** Indent of the first list item under a bucket; deeper plain bullets are notes, not steps. */
  baseIndent?: number
  hadContent: boolean
  candidate?: Candidate
}

const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/
const ITEM_RE = /^([ \t]*)(?:[-*+]|\d{1,3}[.)])[ \t]+(.*)$/
const CHECKBOX_RE = /^\[([ xX✓✔~\/>-])\](?:\s+([\s\S]*))?$/
const STATUS_LINE_RE = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__)?status(?:\*\*|__)?[ \t]*[:：-][ \t]*(?:\*\*|__)?[ \t]*(.+?)[ \t]*$/i
const TABLE_SEP_RE = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/
const STATUS_HEADER_RE = /^(status|state|progress|stage)$/i
/** Table columns that name the step (as opposed to owner, date, notes …). */
const LABEL_HEADER_RE = /^(name|title|milestone|step|item|feature|task|deliverable|phase|goal|epic|initiative|description|summary|work|scope)s?$/i
/** "M1", "Phase 2", "3" — an id that only makes sense next to the step's name. */
const ID_LIKE_RE = /^(?:m|ms|p|phase|milestone|step|stage|q|v)?\s?\d+[a-z]?$/i
const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})/
const FENCE_CLOSE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/

function indentOf(ws: string): number {
  return ws.replace(/\t/g, '    ').length
}

function splitCells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  return t
    .replace(/\\\|/g, '\u0000')
    .split('|')
    .map((c) => c.replace(/\u0000/g, '|').trim())
}

function isTableLine(line: string): boolean {
  return line.trimStart().startsWith('|')
}

/** How many level-1 headings the document has (outside code fences). */
function countTopHeadings(lines: readonly string[]): number {
  let n = 0
  let fence: { ch: string; len: number } | null = null
  for (const line of lines) {
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line)
      if (close && close[1]!.charAt(0) === fence.ch && close[1]!.length >= fence.len) fence = null
      continue
    }
    const open = FENCE_OPEN_RE.exec(line)
    if (open) {
      fence = { ch: open[1]!.charAt(0), len: open[1]!.length }
      continue
    }
    const h = HEADING_RE.exec(line)
    if (h && h[1]!.length === 1) n++
  }
  return n
}

/**
 * Read a roadmap / milestone Markdown file into ordered steps.
 *
 * A *step* is one leaf line that carries a status:
 *  - a task-list item — `- [x]` done, `- [~]` in progress, `- [ ]` not started;
 *  - a list item, heading or table row with a status marker (✅ 🚧 ⏳, "(done)",
 *    "— in progress", a `Status:` line or column);
 *  - a plain bullet under a status-named section ("## Done", "## In progress",
 *    "## Planned", "## Now / Next / Later").
 * Headings that merely group other steps become each step's `group`. Fenced
 * code, struck-through (~~cancelled~~) items and prose are ignored, so a
 * document without status markers simply yields no steps.
 */
export function parseRoadmap(markdown: string): ParsedRoadmap {
  const lines = markdown.split(/\r?\n/)
  const singleH1 = countTopHeadings(lines) === 1

  const candidates: Candidate[] = []
  const headingLines: { line: number; level: number }[] = []
  const headingStack: HeadingCtx[] = []
  let listStack: Candidate[] = []
  let lastHeading: HeadingCtx | undefined
  let title: string | undefined
  let table: { statusCol: number; labelCols: number[] } | null = null
  let fence: { ch: string; len: number } | null = null

  const groupFor = (ownLevel: number): string | undefined => {
    for (let k = headingStack.length - 1; k >= 0; k--) {
      const h = headingStack[k]!
      if (h.bucket || h.isTitle) continue
      if (h.level < ownLevel && h.label) return h.label
    }
    return undefined
  }

  /** Status a plain bullet inherits from the status-named section it sits in. */
  const bucketAbove = (): HeadingCtx | undefined => {
    for (let k = headingStack.length - 1; k >= 0; k--) {
      const h = headingStack[k]!
      if (h.bucket) return h
      if (h.candidate) return undefined
    }
    return undefined
  }

  for (let i = 0; i < lines.length; i++) {
    // Roadmap lines are short; clip anything absurd so a stray minified blob
    // can't make the marker regexes crawl.
    const line = lines[i]!.length > MAX_LINE ? lines[i]!.slice(0, MAX_LINE) : lines[i]!

    /* ---- code fences: never contain steps ---- */
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line)
      if (close && close[1]!.charAt(0) === fence.ch && close[1]!.length >= fence.len) fence = null
      continue
    }
    const open = FENCE_OPEN_RE.exec(line)
    if (open) {
      fence = { ch: open[1]!.charAt(0), len: open[1]!.length }
      listStack = []
      table = null
      if (lastHeading) lastHeading.hadContent = true
      continue
    }

    if (!line.trim()) {
      table = null // a blank line ends a table; loose lists continue across blanks
      continue
    }

    /* ---- headings ---- */
    const hm = HEADING_RE.exec(line)
    if (hm) {
      const level = hm[1]!.length
      const sp = splitStatus(hm[2]!)
      const label = sp.label || cleanLabel(hm[2]!)
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) headingStack.pop()
      const ctx: HeadingCtx = {
        level,
        label,
        line: i,
        isTitle: level === 1 && singleH1,
        bucket: sp.label ? bucketStatusOf(sp.label) : sp.status,
        hadContent: false,
      }
      if (ctx.isTitle) title = label
      if (!ctx.bucket && sp.status && label) {
        ctx.candidate = { kind: 'heading', line: i, label, status: sp.status, group: groupFor(level), level, indent: 0, hasChildren: false }
        candidates.push(ctx.candidate)
      }
      headingLines.push({ line: i, level })
      headingStack.push(ctx)
      lastHeading = ctx
      listStack = []
      table = null
      continue
    }

    /* ---- "Status: …" lines: belong to the heading above, never a step ---- */
    const sm = STATUS_LINE_RE.exec(line)
    if (sm) {
      const h = lastHeading
      if (h && !h.hadContent && !h.bucket && !h.candidate && h.label) {
        const status = valueStatus(sm[1]!, true)
        if (status) {
          // `h` is always the top of the heading stack, so `groupFor(h.level)`
          // skips it and lands on its enclosing section.
          h.candidate = { kind: 'heading', line: h.line, label: h.label, status, group: groupFor(h.level), level: h.level, indent: 0, hasChildren: false }
          candidates.push(h.candidate)
        }
      }
      if (h) h.hadContent = true
      continue
    }

    /* ---- tables ---- */
    if (isTableLine(line)) {
      if (lastHeading) lastHeading.hadContent = true
      listStack = []
      if (line.includes('|') && TABLE_SEP_RE.test(line)) continue // the |---|---| rule
      const cells = splitCells(line)
      const next = lines[i + 1]
      if (!table && next !== undefined && next.includes('|') && TABLE_SEP_RE.test(next)) {
        // Header row: remember which column (if any) is declared as the status.
        const names = cells.map((c) => cleanLabel(c))
        table = {
          statusCol: names.findIndex((c) => STATUS_HEADER_RE.test(c)),
          labelCols: names.flatMap((c, idx) => (LABEL_HEADER_RE.test(c) ? [idx] : [])),
        }
        continue
      }
      if (!table) table = { statusCol: -1, labelCols: [] }

      // A status cell holds only a status ("Done", "🚧 In progress", "✅"). A label
      // cell may carry a marker too ("✅ Core chat") — that one keeps its text.
      const isPureStatus = (cell: string): boolean => {
        const sp = splitStatus(cell)
        return !sp.label || statusOfPhrase(sp.label) !== undefined
      }
      let statusCol = table.statusCol
      let status: RoadmapStatus | undefined
      if (statusCol >= 0) status = valueStatus(cells[statusCol] ?? '', true)
      else {
        for (let c = 0; c < cells.length; c++) {
          const s = valueStatus(cells[c]!, false)
          if (s) {
            status = s
            statusCol = isPureStatus(cells[c]!) ? c : -1
            break
          }
        }
      }
      if (!status) continue
      // Prefer the columns the header names as the step; otherwise any non-status cell.
      const labelIdx = table.labelCols.filter((idx) => idx !== statusCol)
      const texts = (labelIdx.length > 0 ? labelIdx : cells.map((_, idx) => idx).filter((idx) => idx !== statusCol))
        .map((idx) => splitStatus(cells[idx] ?? '').label)
        .filter(Boolean)
      if (texts.length === 0) continue
      const first = texts[0]!
      const label = texts.length > 1 && ID_LIKE_RE.test(first) ? `${first} — ${texts[1]}` : first
      candidates.push({ kind: 'row', line: i, label, status, group: groupFor(7), level: 7, indent: 0, hasChildren: false })
      continue
    }
    table = null

    /* ---- list items ---- */
    const im = ITEM_RE.exec(line)
    if (im) {
      if (lastHeading) lastHeading.hadContent = true
      const indent = indentOf(im[1]!)
      const body = im[2]!
      while (listStack.length > 0 && listStack[listStack.length - 1]!.indent >= indent) listStack.pop()
      const parent = listStack[listStack.length - 1]

      const bucket = bucketAbove()
      if (bucket && bucket.baseIndent === undefined) bucket.baseIndent = indent

      let status: RoadmapStatus | undefined
      let label = ''
      const cb = CHECKBOX_RE.exec(body)
      if (cb) {
        const sp = splitStatus(cb[2] ?? '')
        label = sp.label
        const mark = cb[1]!
        status = mark === ' ' ? (sp.status === 'active' ? 'active' : 'todo') : /[xX✓✔]/.test(mark) ? 'done' : 'active'
      } else {
        const sp = splitStatus(body)
        if (sp.status) {
          status = sp.status
          label = sp.label
        } else if (bucket?.bucket && indent <= (bucket.baseIndent ?? indent)) {
          status = bucket.bucket
          label = sp.label
        }
      }

      if (status && label && !/^~~.+~~$/.test(label)) {
        const group = [groupFor(7), parent?.label].filter(Boolean).join(' › ') || undefined
        const cand: Candidate = { kind: 'item', line: i, label, status, group, level: 7, indent, hasChildren: false }
        if (parent) parent.hasChildren = true
        candidates.push(cand)
        listStack.push(cand)
      }
      continue
    }

    /* ---- prose ---- */
    if (!/^[ \t]/.test(line)) listStack = [] // an unindented paragraph ends any list
    if (lastHeading) lastHeading.hadContent = true
  }

  // A parent with steps of its own is a group, not a step (leaf steps only).
  const leaves = candidates.filter((c) => !c.hasChildren)
  // Likewise a status-marked heading that contains other steps just groups them.
  const kept = leaves.filter((c) => {
    if (c.kind !== 'heading') return true
    const end = headingLines.find((h) => h.line > c.line && h.level <= c.level)?.line ?? Infinity
    return !leaves.some((o) => o !== c && o.line > c.line && o.line < end)
  })

  kept.sort((a, b) => a.line - b.line)
  return {
    title,
    steps: kept.map((c, k) => ({ index: k + 1, label: c.label, status: c.status, group: c.group, line: c.line })),
  }
}

/* ------------------------------------------------------------------ */
/* Progress, diffing, timeline                                         */
/* ------------------------------------------------------------------ */

export function progressOf(steps: readonly { status: RoadmapStatus }[]): RoadmapProgress {
  const total = steps.length
  const done = steps.filter((s) => s.status === 'done').length
  const active = steps.filter((s) => s.status === 'active').length
  return { done, active, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
}

function keyOf(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

interface Pair {
  after: RoadmapStep
  before?: RoadmapStep
}

/**
 * Pair each step after the run with the same step before it. First by
 * section + label, then by label alone (so moving a step between sections or
 * re-numbering a milestone still counts as the same step).
 */
function matchSteps(before: readonly RoadmapStep[], after: readonly RoadmapStep[]): { pairs: Pair[]; removed: RoadmapStep[] } {
  const pairs: Pair[] = after.map((a) => ({ after: a }))
  const used = new Set<RoadmapStep>()

  const take = (pool: Map<string, RoadmapStep[]>, key: string): RoadmapStep | undefined => pool.get(key)?.shift()
  const fill = (steps: readonly RoadmapStep[], keyFn: (s: RoadmapStep) => string): Map<string, RoadmapStep[]> => {
    const pool = new Map<string, RoadmapStep[]>()
    for (const s of steps) {
      const k = keyFn(s)
      const list = pool.get(k)
      if (list) list.push(s)
      else pool.set(k, [s])
    }
    return pool
  }

  const exactKey = (s: RoadmapStep) => `${keyOf(s.group ?? '')}|${keyOf(s.label)}`
  const exact = fill(before, exactKey)
  for (const p of pairs) {
    const b = take(exact, exactKey(p.after))
    if (b) {
      p.before = b
      used.add(b)
    }
  }
  const loose = fill(
    before.filter((b) => !used.has(b)),
    (s) => keyOf(s.label),
  )
  for (const p of pairs) {
    if (p.before) continue
    const b = take(loose, keyOf(p.after.label))
    if (b) {
      p.before = b
      used.add(b)
    }
  }
  return { pairs, removed: before.filter((b) => !used.has(b)) }
}

function toTimelineStep(p: Pair, hadBaseline: boolean): RoadmapTimelineStep {
  const changed = hadBaseline && (!p.before || p.before.status !== p.after.status)
  return {
    index: p.after.index,
    label: p.after.label,
    status: p.after.status,
    ...(p.after.group ? { group: p.after.group } : {}),
    ...(changed ? { changed: true } : {}),
  }
}

/**
 * Which step is "current". What the run actually did wins: the last step it
 * completed, else the last it started, else the last it otherwise touched.
 * With no change to point at, the current step is simply where the roadmap
 * stands — the first step in progress, else the first not started, else the
 * final step when everything is done.
 */
function pickCurrent(pairs: readonly Pair[], hadBaseline: boolean): number {
  const last = (ps: readonly Pair[]) => ps[ps.length - 1]!.after.index - 1
  if (hadBaseline) {
    const completed = pairs.filter((p) => p.after.status === 'done' && p.before?.status !== 'done')
    if (completed.length > 0) return last(completed)
    const started = pairs.filter((p) => p.after.status === 'active' && p.before?.status !== 'active')
    if (started.length > 0) return last(started)
    const touched = pairs.filter((p) => !p.before || p.before.status !== p.after.status)
    if (touched.length > 0) return last(touched)
  }
  const active = pairs.findIndex((p) => p.after.status === 'active')
  if (active >= 0) return active
  const todo = pairs.findIndex((p) => p.after.status === 'todo')
  if (todo >= 0) return todo
  return pairs.length - 1
}

const MAX_CHANGES = 30

/**
 * Turn the roadmap files before and after an orchestrated run into the
 * completion timeline — or `undefined` when there is nothing to show.
 *
 * A roadmap counts as *used* when the run changed it, or delegated work while
 * one was in the workspace; a greeting answered next to an unrelated roadmap
 * does not produce a report. If several roadmap files exist, the one the run
 * changed wins, then the shallowest, then `ROADMAP` over `MILESTONES`.
 */
export function buildRoadmapReport(input: {
  before: readonly RoadmapFileSnapshot[]
  after: readonly RoadmapFileSnapshot[]
  /** The orchestrator delegated a plan (as opposed to answering directly). */
  delegated: boolean
}): RoadmapReport | undefined {
  const beforeByPath = new Map(input.before.map((f) => [f.path, f.content] as const))

  const candidates = input.after
    .map((f) => {
      const parsed = parseRoadmap(f.content)
      const prev = beforeByPath.get(f.path)
      return { path: f.path, parsed, prev, changed: prev !== f.content }
    })
    .filter((c) => c.parsed.steps.length > 0)
  if (candidates.length === 0) return undefined

  const score = (c: (typeof candidates)[number]): number =>
    (c.changed ? 100 : 0) - pathDepth(c.path) * 10 + (/roadmap/i.test(c.path) ? 5 : 0)
  candidates.sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path))
  const best = candidates[0]!
  if (!best.changed && !input.delegated) return undefined

  const beforeParsed = best.prev !== undefined ? parseRoadmap(best.prev) : undefined
  const hadBaseline = Boolean(beforeParsed && beforeParsed.steps.length > 0)
  const steps = best.parsed.steps

  const { pairs, removed } = hadBaseline ? matchSteps(beforeParsed!.steps, steps) : { pairs: steps.map((a): Pair => ({ after: a })), removed: [] }

  const changes: RoadmapChange[] = []
  if (hadBaseline) {
    for (const p of pairs) {
      if (!p.before) changes.push({ label: p.after.label, from: 'new', to: p.after.status })
      else if (p.before.status !== p.after.status) changes.push({ label: p.after.label, from: p.before.status, to: p.after.status })
    }
    for (const r of removed) changes.push({ label: r.label, from: r.status, to: 'removed' })
  }

  const at = pickCurrent(pairs, hadBaseline)
  const currentPair = pairs[at]!
  const previousPair = pairs[at - 1]
  const nextPair = pairs.slice(at + 1).find((p) => p.after.status !== 'done')

  return {
    path: best.path,
    ...(best.parsed.title ? { title: best.parsed.title } : {}),
    ...(previousPair ? { previous: toTimelineStep(previousPair, hadBaseline) } : {}),
    current: toTimelineStep(currentPair, hadBaseline),
    ...(nextPair ? { next: toTimelineStep(nextPair, hadBaseline) } : {}),
    progress: progressOf(steps),
    ...(hadBaseline ? { before: progressOf(beforeParsed!.steps) } : {}),
    changes: changes.slice(0, MAX_CHANGES),
  }
}

/** One-line account of a report for screen-reader announcements. */
export function describeRoadmapReport(report: RoadmapReport): string {
  const { progress, current } = report
  const head = `Roadmap ${progress.percent}% complete, ${progress.done} of ${progress.total} steps done`
  return current ? `${head}. Current step: ${current.label}.` : `${head}.`
}

/* ------------------------------------------------------------------ */
/* Simulator support                                                   */
/* ------------------------------------------------------------------ */

/**
 * Tick the first open task-list step of a roadmap (`[ ]` / `[~]` → `[x]`).
 * Used by the built-in simulator so agent mode can demo roadmap tracking
 * without an API key; real models update the file themselves.
 */
export function tickFirstOpenStep(markdown: string): { content: string; label: string } | undefined {
  const lines = markdown.split('\n')
  for (const step of parseRoadmap(markdown).steps) {
    if (step.status === 'done') continue
    const line = lines[step.line]
    if (line === undefined) continue
    const m = /^([ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+\[)[ ~\/>-](\]\s[\s\S]*)$/.exec(line)
    if (!m) continue
    lines[step.line] = `${m[1]}x${m[2]}`
    return { content: lines.join('\n'), label: step.label }
  }
  return undefined
}
