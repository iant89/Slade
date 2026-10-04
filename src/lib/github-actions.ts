/**
 * GitHub action vocabulary.
 *
 * Slade talks to `api.github.com` from a lot of places: the repo browser, the
 * file drawer, the publish dialog, an agent pulling context into the local file
 * system. This module turns any one of those requests into a short, honest
 * sentence — a title ("GitHub Action: Get File Contents") and the thing it
 * touched ("/src/app.tsx") — so the UI can show one compact, non-expandable
 * card per API call instead of a raw request log. Each call is inserted into
 * the conversation as its own message (see `store/githubActivity.ts`).
 *
 * Pure on purpose: no stores, no React, no fetch. `src/lib/github.ts` hands the
 * raw request over, and everything derived here comes from the method, the URL
 * and the *scalar* fields of the body, so nothing that could be secret or huge
 * (file contents, base64 blobs) ever reaches the UI.
 *
 * The same module also turns a response into the card's *output*: a clipped,
 * already-redacted extract (sha and URL for a write, a listing for a search,
 * the pull request a call opened) that the card can show behind its expand
 * toggle — and builds the one card that is not per-call: a batch of file reads,
 * folded into a single card whose block lists every repository path it fetched.
 */

import type { GitHubActionInfo, GitHubActionKind, GitHubActionOutput, GitHubPullRequestInfo } from '../types'
import { formatBytes } from './format'
import { redactSecrets } from '../providers/base'
export type { GitHubActionInfo, GitHubActionKind } from '../types'

/** Short action phrases; `GITHUB_ACTION_TITLE` is what follows "GitHub Action:". */
export const GITHUB_ACTION_TITLE: Record<GitHubActionKind, string> = {
  'get-file': 'Get File Contents',
  'create-file': 'Created File',
  'update-file': 'Updated File',
  'delete-file': 'Deleted File',
  'get-blob': 'Read File Blob',
  'create-blob': 'Uploaded File Blob',
  'get-tree': 'Read Repository Tree',
  'create-tree': 'Created Commit Tree',
  'create-branch': 'Created Branch',
  'delete-branch': 'Removed Branch',
  'get-branch': 'Fetching Branch',
  'list-branches': 'Fetching Branches',
  'update-ref': 'Moved Branch',
  'get-commit': 'Fetching Commit',
  'create-commit': 'Created Commit',
  'create-pr': 'Create Pull-Request',
  'merge-pr': 'Merge Pull-Request',
  'get-pr': 'Fetching Pull-Request',
  'list-prs': 'Fetching Pull Requests',
  'create-issue': 'Created Issue',
  'list-issues': 'Fetching Issues',
  'create-gist': 'Created Gist',
  'list-gists': 'Fetching Gists',
  'search-code': 'Performed Code Search',
  'search-repos': 'Searched Repositories',
  'list-repos': 'Refreshing Repository List',
  'get-repo': 'Fetching Repository',
  'clone-repo': 'Cloning Repository',
  'test-token': 'Testing API Token',
  'rate-limit': 'Checking API Budget',
  'sign-in': 'Signed in using OAuth',
  'sign-out': 'Signed out',
  other: 'Performed API Request',
}

/** The shared card prefix, so every card reads the same way. */
export const GITHUB_ACTION_PREFIX = 'GitHub Action:'

/** "Get File Contents" → "GitHub Action: Get File Contents". */
export function githubActionTitle(kind: GitHubActionKind): string {
  return `${GITHUB_ACTION_PREFIX} ${GITHUB_ACTION_TITLE[kind]}`
}

/**
 * "GitHub Action: Get File Contents" → "Get File Contents". Works on the title
 * a card carries rather than on its kind, so a card saved under an older
 * vocabulary still reads the way it did when it was made.
 */
export function githubActionPhrase(title: string): string {
  return title.startsWith(GITHUB_ACTION_PREFIX) ? title.slice(GITHUB_ACTION_PREFIX.length).trim() : title
}

/** What a listener sees for one in-flight request. */
export interface GitHubCallLike {
  method: string
  /** URL path only, e.g. `/repos/octo/demo/contents/src/app.tsx`. */
  path: string
  query?: Record<string, string | number | boolean | undefined>
  /** The parsed request body, if any. Only scalar fields are read. */
  body?: unknown
}

const MAX_SUBJECT = 72

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment.replace(/\+/g, ' '))
  } catch {
    return segment
  }
}

function segments(path: string): string[] {
  return path
    .split('?')[0]!
    .split('#')[0]!
    .split('/')
    .filter(Boolean)
    .map(safeDecode)
}

/** A scalar string field of a request body — never an object or a file payload. */
function field(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const v = (body as Record<string, unknown>)[key]
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}

function clip(value: string, max = MAX_SUBJECT): string {
  const clean = value.trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1)}…`
}

/** First line of a commit / issue message, clipped for one-line display. */
function firstLine(value: string | undefined): string {
  if (!value) return ''
  return clip(value.split(/\r?\n/)[0]!.trim())
}

function shortSha(value: string | undefined): string {
  return value && value.length > 7 ? value.slice(0, 7) : (value ?? '')
}

/** How many entries a tree request carries — a count only, never contents. */
function entryCount(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined
  const tree = (body as { tree?: unknown }).tree
  return Array.isArray(tree) ? tree.length : undefined
}

/** `refs/heads/feature/x` → `feature/x`. */
function branchOfRef(ref: string | undefined): string {
  if (!ref) return ''
  return clip(ref.replace(/^refs\/(heads|tags|notes)\//, ''))
}

function make(
  kind: GitHubActionKind,
  subject: string,
  extra?: { repo?: string; ref?: string },
): GitHubActionInfo {
  return {
    kind,
    title: githubActionTitle(kind),
    subject: clip(subject),
    repo: extra?.repo,
    ref: extra?.ref,
  }
}

/** Repo path tail (`/repos/o/r/<tail…>`) as segments. */
function tailOf(parts: string[], from: number): string[] {
  return parts.slice(from)
}

/**
 * Describe one GitHub REST call. Deliberately total: anything unrecognised
 * still gets a card, with the URL path as its sub-title, so an unexpected
 * request can never slip past unlogged.
 */
export function describeGitHubCall(call: GitHubCallLike): GitHubActionInfo {
  const method = (call.method || 'GET').toUpperCase()
  const parts = segments(call.path)
  const ref = call.query?.ref != null ? String(call.query.ref) : undefined
  const [head, second, third] = parts

  /* ---------------- repo-scoped calls ---------------- */
  if (head === 'repos' && second && third) {
    const repo = `${second}/${third}`
    // `parts` is ['repos', owner, name, …] — the repo tail starts at index 3.
    const tail = tailOf(parts, 3)
    const [a, b, c, d] = tail
    const body = call.body

    // Contents API: the file path is in the URL.
    if (a === 'contents') {
      const filePath = `/${tail.slice(1).join('/')}`
      if (method === 'DELETE') return make('delete-file', filePath, { repo, ref })
      if (method === 'PUT') {
        return make(field(body, 'sha') ? 'update-file' : 'create-file', filePath, {
          repo,
          ref: branchOfRef(`refs/heads/${field(body, 'branch') ?? ''}`) || ref,
        })
      }
      if (method === 'POST') return make('create-file', filePath, { repo, ref })
      return make('get-file', filePath === '/' ? repo : filePath, { repo, ref })
    }

    // Branches.
    if (a === 'branches') {
      if (b) return make('get-branch', b, { repo, ref: b })
      return make('list-branches', repo, { repo, ref })
    }

    // Pull requests.
    if (a === 'pulls') {
      if (b && c === 'merge') return make('merge-pr', `#${b} ${firstLine(field(body, 'commit_message'))}`.trim(), { repo })
      if (b) return make('get-pr', `#${b}`, { repo })
      if (method === 'POST') {
        const title = firstLine(field(body, 'title')) || `${field(body, 'head') ?? ''} → ${field(body, 'base') ?? ''}`
        return make('create-pr', title, { repo })
      }
      return make('list-prs', repo, { repo, ref })
    }

    // Issues.
    if (a === 'issues') {
      if (method === 'POST') return make('create-issue', firstLine(field(body, 'title')), { repo })
      return make('list-issues', repo, { repo, ref })
    }

    // Git data: refs, trees, commits, blobs.
    if (a === 'git') {
      if (b === 'ref') {
        const branch = d ?? ''
        return make('get-branch', branch, { repo, ref: branch })
      }
      if (b === 'refs') {
        if (c) {
          const branch = d ?? ''
          if (method === 'DELETE') return make('delete-branch', branch, { repo, ref: branch })
          if (method === 'PATCH' || method === 'PUT') {
            return make('update-ref', `${branch} → ${shortSha(field(body, 'sha'))}`.trim(), { repo, ref: branch })
          }
          return make('get-branch', branch, { repo, ref: branch })
        }
        if (method === 'DELETE') return make('delete-branch', branchOfRef(field(body, 'ref')), { repo })
        return make('create-branch', branchOfRef(field(body, 'ref')), { repo })
      }
      if (b === 'trees') {
        if (c) return make('get-tree', `${c}${ref ? ` (${ref})` : ''}`, { repo, ref: c })
        const n = entryCount(body)
        return make('create-tree', n == null ? repo : `${n} file${n === 1 ? '' : 's'} staged`, { repo, ref })
      }
      if (b === 'commits') {
        if (c) return make('get-commit', shortSha(c), { repo })
        return make('create-commit', firstLine(field(body, 'message')) || repo, { repo, ref })
      }
      if (b === 'blobs') {
        if (c) return make('get-blob', shortSha(c), { repo, ref })
        return make('create-blob', repo, { repo, ref })
      }
    }

    // A repo sub-path Slade does not use yet (releases, labels, …) still gets a
    // card — with the full path as its sub-title.
    if (tail.length === 0) return make('get-repo', repo, { repo, ref })
    return make('other', `/repos/${repo}/${tail.join('/')}`, { repo, ref })
  }

  /* ---------------- account + search + misc ---------------- */
  // `GET /user/repos` — the signed-in user's own list, and the only list Slade
  // can be about without saying whose it is. "Refreshing Repository List" is
  // already the whole sentence, so the card carries no subject and reads as
  // one line. A list for another account or an org still names it.
  if (head === 'user' && second === 'repos') {
    return make('list-repos', '', { ref })
  }
  if (head === 'users' && second) {
    if (third === 'repos') return make('list-repos', `@${second}`, { ref })
    return make('other', `/users/${second}`)
  }
  if (head === 'orgs' && second && third === 'repos') {
    return make('list-repos', `${second} (organisation)`, { ref })
  }
  if (head === 'search' && second === 'code') {
    const q = call.query?.q != null ? String(call.query.q) : ''
    return make('search-code', q, { ref })
  }
  if (head === 'search' && second === 'repositories') {
    return make('search-repos', call.query?.q != null ? String(call.query.q) : '')
  }
  if (head === 'gists') {
    if (method === 'POST') {
      const files = (call.body as { files?: Record<string, unknown> } | undefined)?.files
      const name = files ? Object.keys(files)[0] : undefined
      return make('create-gist', firstLine(field(call.body, 'description')) || name || 'new gist')
    }
    if (second) return make('list-gists', second)
    return make('list-gists', 'your gists')
  }
  if (head === 'rate_limit') return make('rate-limit', 'api.github.com budget')
  if (head === 'user' && !second) return make('test-token', '')

  return make('other', `/${parts.join('/')}`)
}

/**
 * A stable identity for one card's content, used to fold identical repeats of
 * the same call (25 file reads in a row) into a single card with a counter.
 */
export function githubActionSignature(info: Pick<GitHubActionInfo, 'kind' | 'subject' | 'repo' | 'ref'>): string {
  return [info.kind, info.repo ?? '', info.ref ?? '', info.subject].join('|')
}

/* ------------------------------------------------------------------ */
/* File reads: one card for the whole batch                            */
/*                                                                     */
/* Pulling a repository's files is twenty reads, not twenty things that */
/* happened — so the activity log folds every read of one repo into a   */
/* single "Get File Contents" card. The card's sub-title is how many    */
/* files it stands for, and its message block is the list of them: one  */
/* repository path per line, appended as each read lands, with the repo */
/* they came from as the block's caption. No file contents — the files  */
/* themselves land in Local Files, and a card that copied them would be */
/* a second, clipped copy of what is already there.                   */
/* ------------------------------------------------------------------ */

/** One file a read card stands for: its repository path, and how the read went. */
export interface GitHubFileRead {
  /** Repository path exactly as the describer saw it, e.g. `/src/lib/util.ts`. */
  path: string
  /** Set when this one read failed — the line says so rather than pretending. */
  failed?: boolean
  /** The failure sentence, kept on the line so the block explains itself. */
  error?: string
}

/** A read card's sub-title is the number of file entries in its block. */
export function fileReadSubject(count: number): string {
  return `${count} File${count === 1 ? '' : 's'}`
}

/**
 * The block a read card shows: which repository the files came from, then one
 * line per file. `undefined` for a card with no files yet, so it grows no
 * expand toggle until there is something behind it.
 */
export function fileReadOutput(
  repo: string | undefined,
  ref: string | undefined,
  files: GitHubFileRead[],
): GitHubActionOutput | undefined {
  if (files.length === 0) return undefined
  const shown = files.slice(0, MAX_OUTPUT_LINES)
  const lines = shown.map((file) =>
    file.failed ? `${file.path} — failed${file.error ? `: ${file.error}` : ''}` : file.path,
  )
  if (files.length > shown.length) lines.push(`… and ${files.length - shown.length} more`)
  const where = [repo ?? '', ref ? `@ ${ref}` : ''].filter(Boolean).join(' ')
  const caption = fileReadSubject(files.length)
  return { label: where ? `${where} · ${caption}` : caption, text: lines.join('\n') }
}

/* ------------------------------------------------------------------ */
/* What came back — the output a card shows                            */
/*                                                                     */
/* A card is a request *and* its result. `describeGitHubOutput` turns  */
/* one successful response into a compact, redacted extract: the file  */
/* a read returned, a listing, the sha a write produced. Only the head */
/* of a long response is kept — a card previews output, it never keeps */
/* the whole payload.                                                  */
/* ------------------------------------------------------------------ */

/** One request with its parsed response, as handed over by the REST client. */
export interface GitHubOutputInput extends GitHubCallLike {
  /** The parsed body of a successful call; absent for `204`/empty responses. */
  json?: unknown
}

/** The longest output text a card stores. */
export const MAX_OUTPUT_CHARS = 4_000
/** Entries a listing keeps before it stops counting. */
const MAX_OUTPUT_LINES = 120
/** Roughly how many bytes of a base64 file are decoded for a preview. */
const CONTENT_PREVIEW_BYTES = MAX_OUTPUT_CHARS * 2

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** `path/to/file.ts` → `ts`, so the panel can highlight what it shows. */
function languageForName(name: string): string | undefined {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const known: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
    sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', md: 'markdown',
    json: 'json', html: 'xml', svg: 'xml', css: 'css', scss: 'scss', sql: 'sql',
    toml: 'ini', ini: 'ini', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
    php: 'php', swift: 'swift', diff: 'diff',
  }
  return known[ext]
}

/** Join listing lines, saying how many were left out rather than dropping them silently. */
function listed(lines: string[], total = lines.length): string {
  const kept = lines.slice(0, MAX_OUTPUT_LINES)
  if (total > kept.length) kept.push(`… and ${total - kept.length} more`)
  return kept.join('\n')
}

/**
 * Whether a decoded preview is binary. A card shows text; a PNG decoded as
 * UTF-8 is replacement characters, so it is reported as a file instead.
 */
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 400)
  if (!sample) return false
  if (sample.includes('\u0000')) return true
  let odd = 0
  for (const ch of sample) {
    const code = ch.codePointAt(0)!
    if (code < 9 || (code > 13 && code < 32) || code === 0xfffd) odd++
  }
  return odd / sample.length > 0.1
}

/** Decode only the head of a base64 payload; undefined when it will not decode. */
function decodeBase64Preview(b64: string): string | undefined {
  try {
    const clean = b64.replace(/\s+/g, '')
    const slice = clean.slice(0, Math.ceil(CONTENT_PREVIEW_BYTES / 3) * 4)
    const bin = atob(slice)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return undefined
  }
}

/** Redact, normalize and clip one output text. */
function clipOutput(text: string): { text: string; truncated?: boolean } {
  const clean = redactSecrets(text.replace(/\r\n/g, '\n')).replace(/[ \t]+$/gm, '').trimEnd()
  if (clean.length <= MAX_OUTPUT_CHARS) return { text: clean }
  return { text: `${clean.slice(0, MAX_OUTPUT_CHARS).trimEnd()}\n…`, truncated: true }
}

function cardOutput(
  label: string | undefined,
  text: string,
  language?: string,
  pr?: GitHubPullRequestInfo,
): GitHubActionOutput | undefined {
  const clipped = clipOutput(text)
  // A pull request is worth a card even when it has no description to clip.
  if (!clipped.text.trim() && !pr) return undefined
  return { label: label?.trim() || undefined, text: clipped.text, truncated: clipped.truncated, language, pr }
}

/** How much of a pull request's description a card keeps. */
const MAX_PR_BODY_CHARS = 600

/**
 * Read one pull request out of a response, in the shape a card draws it.
 *
 * The request that opened it is passed along as a fallback: a proxy or a fake
 * that echoes the PR back without its branches would otherwise leave the card
 * unable to say what it merged into what. Only scalar fields are read — never
 * a diff, a patch or a file listing.
 */
function pullRequestFrom(json: unknown, requested?: unknown): GitHubPullRequestInfo | undefined {
  if (!isRecord(json)) return undefined
  const number = num(json.number)
  if (number == null) return undefined
  const asked = isRecord(requested) ? requested : {}
  const head = isRecord(json.head) ? json.head : {}
  const base = isRecord(json.base) ? json.base : {}
  const user = isRecord(json.user) ? json.user : {}
  const body = str(json.body) ?? str(asked.body)
  return {
    number,
    title: firstLine(str(json.title) ?? str(asked.title)) || '(no title)',
    state: str(json.state) ?? 'open',
    draft: json.draft === true ? true : undefined,
    head: str(head.ref) ?? str(asked.head) ?? '',
    base: str(base.ref) ?? str(asked.base) ?? '',
    url: str(json.html_url) ?? '',
    author: str(user.login),
    body: body ? clip(redactSecrets(body.replace(/\r\n/g, '\n')), MAX_PR_BODY_CHARS) : undefined,
    commits: num(json.commits),
    changedFiles: num(json.changed_files),
    additions: num(json.additions),
    deletions: num(json.deletions),
    mergeable: typeof json.mergeable === 'boolean' ? json.mergeable : undefined,
    mergeableState: str(json.mergeable_state),
    createdAt: str(json.created_at),
    merged: json.merged === true ? true : undefined,
  }
}

/** The scalar fields worth showing for any object we do not model. */
const GENERIC_KEYS = ['full_name', 'name', 'login', 'title', 'path', 'ref', 'sha', 'state', 'status', 'message', 'html_url'] as const

function genericLine(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`
  if (!isRecord(value)) return typeof value === 'string' ? value : ''
  const bits: string[] = []
  for (const key of GENERIC_KEYS) {
    const v = value[key]
    if (typeof v === 'string' && v.trim()) bits.push(key === 'sha' ? shortSha(v.trim()) : v.trim())
    if (bits.length === 2) break
  }
  if (bits.length === 0) {
    const id = num(value.id)
    if (id != null) bits.push(String(id))
  }
  return bits.join(' · ')
}

/** Last resort: a compact reading of whatever shape the response had. */
function summarizeUnknown(json: unknown): GitHubActionOutput | undefined {
  if (Array.isArray(json)) {
    const lines = json.slice(0, 20).map(genericLine).filter(Boolean)
    return cardOutput(`${json.length} item${json.length === 1 ? '' : 's'}`, listed(lines, json.length))
  }
  if (isRecord(json)) {
    const line = genericLine(json)
    return line ? cardOutput(undefined, line) : undefined
  }
  if (typeof json === 'string' && json.trim()) return cardOutput(undefined, json)
  return undefined
}

/**
 * Describe what one successful GitHub call returned, or `undefined` when there
 * is nothing worth showing (an empty `204`, a response with no readable body).
 * Pure: the REST client hands over the parsed JSON and gets text back.
 */
export function describeGitHubOutput(call: GitHubOutputInput): GitHubActionOutput | undefined {
  const method = (call.method || 'GET').toUpperCase()
  const parts = segments(call.path)
  const json = call.json
  /** What the call asked for: a fallback for fields a thin response omits. */
  const asked = call.body
  const [head, second, third] = parts

  /* ---------------- repo-scoped responses ---------------- */
  if (head === 'repos' && second && third) {
    const repo = `${second}/${third}`
    const tail = parts.slice(3)
    const [a, b, c, d] = tail

    if (a === 'contents') {
      const path = `/${tail.slice(1).join('/')}`
      const where = tail.length > 1 ? path : repo
      if (Array.isArray(json)) {
        const lines = json.map((entry) => {
          const e = isRecord(entry) ? entry : {}
          const name = str(e.name) ?? str(e.path) ?? '?'
          const size = num(e.size)
          const kind = str(e.type) === 'dir' ? 'dir' : 'file'
          return `${name} (${kind})${size == null ? '' : ` · ${formatBytes(size)}`}`
        })
        return cardOutput(`${where} · ${json.length} entr${json.length === 1 ? 'y' : 'ies'}`, listed(lines, json.length))
      }
      if (isRecord(json)) {
        const name = str(json.name) ?? path.split('/').pop() ?? repo
        const size = num(json.size)
        const sha = str(json.sha)
        const caption = [where, size == null ? '' : formatBytes(size), shortSha(sha)].filter(Boolean).join(' · ')
        const content = str(json.content)
        if (str(json.encoding) === 'base64' && content) {
          const decoded = decodeBase64Preview(content)
          if (decoded != null && !looksBinary(decoded)) return cardOutput(caption, decoded, languageForName(name))
          return cardOutput(caption, `Binary file${size == null ? '' : ` · ${formatBytes(size)}`} — nothing to preview.`)
        }
        const commit = isRecord(json.commit) ? json.commit : {}
        const commitBits = ['Commit', shortSha(str(commit.sha)), str(commit.html_url) ?? ''].filter(Boolean)
        if (commitBits.length > 1) return cardOutput(caption, commitBits.join(' '))
        return cardOutput(caption, `No inline text for this file${size == null ? '' : ` (${formatBytes(size)})`} — nothing to preview.`)
      }
    }

    if (a === 'contents' && (method === 'PUT' || method === 'DELETE')) {
      const path = `/${tail.slice(1).join('/')}`
      const record = isRecord(json) ? json : {}
      const content = isRecord(record.content) ? record.content : {}
      const commit = isRecord(record.commit) ? record.commit : {}
      const verb = method === 'DELETE' ? 'Deleted' : str(content.sha) ? 'Updated' : 'Created'
      const bits = [verb, str(content.path) ?? path, shortSha(str(commit.sha)), str(commit.html_url) ?? ''].filter(Boolean)
      return cardOutput(`${verb.toLowerCase()} ${path}`, bits.join(' · '))
    }

    if (a === 'branches') {
      if (Array.isArray(json)) {
        const lines = json.map((entry) => {
          const e = isRecord(entry) ? entry : {}
          const commit = isRecord(e.commit) ? e.commit : {}
          return `${str(e.name) ?? '?'} @ ${shortSha(str(commit.sha))}`
        })
        return cardOutput(`${json.length} branch${json.length === 1 ? '' : 'es'}`, listed(lines, json.length))
      }
      if (isRecord(json)) {
        const name = str(json.name)
        const sha = shortSha(str((isRecord(json.commit) ? json.commit : {}).sha))
        if (!name && !sha) return undefined
        return cardOutput(name, [name ?? '', sha ? `@ ${sha}` : ''].filter(Boolean).join(' '))
      }
    }

    if (a === 'pulls') {
      if (b && c === 'merge') {
        const record = isRecord(json) ? json : {}
        const message = firstLine(str(record.message))
        return cardOutput(
          `#${b} ${str(record.merged) === 'true' || record.merged === true ? 'merged' : 'merge result'}`,
          [`merged: ${String(record.merged ?? '?')}`, shortSha(str(record.sha)), message, str(record.html_url) ?? '']
            .filter(Boolean)
            .join(' · '),
        )
      }
      if (Array.isArray(json)) {
        const lines = json.map((entry) => {
          const e = isRecord(entry) ? entry : {}
          return `#${num(e.number) ?? '?'} ${firstLine(str(e.title)) || '(no title)'} · ${str(e.state) ?? ''}`.trim()
        })
        return cardOutput(`${json.length} pull request${json.length === 1 ? '' : 's'}`, listed(lines, json.length))
      }
      if (isRecord(json)) {
        // Opening or reading one pull request: the card keeps the whole thing,
        // not just a line of it — see `GitHubPullRequestInfo`.
        const pr = pullRequestFrom(json, asked)
        const number = num(json.number)
        const label = [number == null ? '' : `#${number}`, firstLine(str(json.title)) || ''].filter(Boolean).join(' ')
        const line = [
          str(json.state) ?? '',
          num(json.commits) == null ? '' : `${num(json.commits)} commit(s)`,
          num(json.additions) == null ? '' : `+${num(json.additions)}`,
          num(json.deletions) == null ? '' : `-${num(json.deletions)}`,
          str(json.html_url) ?? '',
        ].filter(Boolean).join(' · ')
        return cardOutput(pr ? `#${pr.number} ${pr.title}` : label || repo, line, undefined, pr)
      }
    }

    if (a === 'issues') {
      if (Array.isArray(json)) {
        const lines = json.map((entry) => {
          const e = isRecord(entry) ? entry : {}
          return `#${num(e.number) ?? '?'} ${firstLine(str(e.title)) || '(no title)'} · ${str(e.state) ?? ''}`.trim()
        })
        return cardOutput(`${json.length} issue${json.length === 1 ? '' : 's'}`, listed(lines, json.length))
      }
      if (isRecord(json)) {
        const number = num(json.number)
        const label = [number == null ? '' : `#${number}`, firstLine(str(json.title)) || ''].filter(Boolean).join(' ')
        return cardOutput(label || repo, [str(json.state) ?? '', str(json.html_url) ?? ''].filter(Boolean).join(' · '))
      }
    }

    if (a === 'commits') {
      if (Array.isArray(json)) {
        const lines = json.map((entry) => {
          const e = isRecord(entry) ? entry : {}
          const commit = isRecord(e.commit) ? e.commit : {}
          return `${shortSha(str(e.sha))} ${firstLine(str(commit.message))}`
        })
        return cardOutput(`${json.length} commit${json.length === 1 ? '' : 's'}`, listed(lines, json.length))
      }
      if (isRecord(json)) {
        const commit = isRecord(json.commit) ? json.commit : {}
        return cardOutput(
          shortSha(str(json.sha)),
          [firstLine(str(commit.message)), str(json.html_url) ?? ''].filter(Boolean).join(' · '),
        )
      }
    }

    if (a === 'git') {
      if (b === 'trees') {
        if (isRecord(json) && Array.isArray(json.tree)) {
          const entries = json.tree.filter(isRecord)
          const lines = entries.map((entry) => {
            const p = str(entry.path) ?? '?'
            const size = num(entry.size)
            return `${p}${size == null ? '' : ` · ${formatBytes(size)}`}`
          })
          const label = `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}${json.truncated === true ? ' · truncated' : ''}`
          return cardOutput(label, listed(lines, entries.length))
        }
        if (c) {
          const record = isRecord(json) ? json : {}
          const tree = Array.isArray(record.tree) ? record.tree.filter(isRecord) : []
          return cardOutput(
            `tree ${c}`,
            [shortSha(str(record.sha)), `${tree.length} entr${tree.length === 1 ? 'y' : 'ies'}`].filter(Boolean).join(' · '),
          )
        }
        return cardOutput(undefined, isRecord(json) ? shortSha(str(json.sha)) : '')
      }
      if (b === 'commits' && isRecord(json)) {
        const commit = isRecord(json.commit) ? json.commit : {}
        return cardOutput(shortSha(str(json.sha)), [firstLine(str(commit.message)), str(json.html_url) ?? ''].filter(Boolean).join(' · '))
      }
      if (b === 'blobs' && isRecord(json)) {
        const size = num(json.size)
        const caption = [shortSha(str(json.sha)), size == null ? '' : formatBytes(size)].filter(Boolean).join(' · ')
        const content = str(json.content)
        if (str(json.encoding) === 'base64' && content) {
          const decoded = decodeBase64Preview(content)
          if (decoded != null && !looksBinary(decoded)) return cardOutput(caption, decoded)
          return cardOutput(caption, 'Binary file — nothing to preview.')
        }
        return cardOutput(caption, [str(json.encoding) ?? ''].filter(Boolean).join(' · '))
      }
      if (b === 'ref' && isRecord(json)) {
        const branch = str(json.ref) ?? d ?? ''
        const sha = shortSha(str((isRecord(json.object) ? json.object : {}).sha))
        if (!branch && !sha) return undefined
        return cardOutput(branch, [branch, sha ? `@ ${sha}` : ''].filter(Boolean).join(' '))
      }
      if (b === 'refs') {
        const record = isRecord(json) ? json : {}
        const branch = str(record.ref) ?? ''
        const sha = shortSha(str((isRecord(record.object) ? record.object : {}).sha))
        if (!branch && !sha) return undefined
        return cardOutput(branch, [branch, sha ? `@ ${sha}` : ''].filter(Boolean).join(' '))
      }
    }

    if (tail.length === 0 && isRecord(json)) {
      return cardOutput(
        str(json.full_name) ?? repo,
        [
          str(json.description) ?? '',
          str(json.default_branch) ? `default ${str(json.default_branch)}` : '',
          num(json.stargazers_count) == null ? '' : `${num(json.stargazers_count)} ★`,
          str(json.html_url) ?? '',
        ]
          .filter(Boolean)
          .join(' · '),
      )
    }
  }

  /* ---------------- account, search, gists, budget ---------------- */
  if (head === 'user' && second === 'repos') {
    if (Array.isArray(json)) {
      const lines = json.map((entry) => (isRecord(entry) ? str(entry.full_name) ?? str(entry.name) ?? '' : ''))
      return cardOutput(`${json.length} repositor${json.length === 1 ? 'y' : 'ies'}`, listed(lines.filter(Boolean), json.length))
    }
  }
  if (head === 'user' && !second && isRecord(json)) {
    return cardOutput(str(json.login), [`@${str(json.login) ?? '?'}`, str(json.name) ?? ''].filter(Boolean).join(' · '))
  }
  if (head === 'search') {
    const record = isRecord(json) ? json : {}
    const total = num(record.total_count)
    const items = Array.isArray(record.items) ? record.items.filter(isRecord) : []
    const lines = items.map((item) => {
      const repo = isRecord(item.repository) ? item.repository : {}
      const where = str(repo.full_name) ?? str(item.repository_url) ?? ''
      const label = str(item.path) ?? str(item.full_name) ?? str(item.name) ?? str(item.title) ?? '(result)'
      const fragment = Array.isArray(item.text_matches) && isRecord(item.text_matches[0]) ? str(item.text_matches[0].fragment) : undefined
      return [label, where ? ` — ${where}` : '', fragment ? `\n  ${firstLine(fragment)}` : ''].join('')
    })
    return cardOutput(`${total ?? items.length} result${(total ?? items.length) === 1 ? '' : 's'}`, listed(lines, items.length))
  }
  if (head === 'gists') {
    if (isRecord(json)) {
      const files = isRecord(json.files) ? Object.keys(json.files) : []
      return cardOutput(str(json.id), [str(json.html_url) ?? '', files.join(', ')].filter(Boolean).join(' · '))
    }
    if (Array.isArray(json)) {
      const lines = json.map((entry) => {
        const e = isRecord(entry) ? entry : {}
        return `${str(e.id) ?? '?'} ${firstLine(str(e.description))}`
      })
      return cardOutput(`${json.length} gist${json.length === 1 ? '' : 's'}`, listed(lines, json.length))
    }
  }
  if (head === 'rate_limit' && isRecord(json)) {
    const resources = isRecord(json.resources) ? json.resources : {}
    const lines = Object.entries(resources)
      .filter(([, value]) => isRecord(value))
      .map(([name, value]) => {
        const v = value as Record<string, unknown>
        return `${name}: ${num(v.remaining) ?? '?'}/${num(v.limit) ?? '?'}`
      })
    return cardOutput('api.github.com budget', lines.join('\n'))
  }

  return summarizeUnknown(json)
}
