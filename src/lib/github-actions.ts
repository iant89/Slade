/**
 * GitHub action vocabulary.
 *
 * Slade talks to `api.github.com` from a lot of places: the repo browser, the
 * file drawer, the publish dialog, an agent pulling context into the local file
 * system. This module turns any one of those requests into a short, honest
 * sentence — a title ("GitHub Action: Get File Contents") and the thing it
 * touched ("/src/app.tsx") — so the UI can show one compact, non-expandable
 * card per API call instead of a raw request log.
 *
 * Pure on purpose: no stores, no React, no fetch. `src/lib/github.ts` hands the
 * raw request over, and everything derived here comes from the method, the URL
 * and the *scalar* fields of the body, so nothing that could be secret or huge
 * (file contents, base64 blobs) ever reaches the UI.
 */

/** Every GitHub call Slade can make, in one vocabulary. */
export type GitHubActionKind =
  /* files */
  | 'get-file'
  | 'create-file'
  | 'update-file'
  | 'delete-file'
  | 'get-blob'
  | 'create-blob'
  /* trees */
  | 'get-tree'
  | 'create-tree'
  /* branches + refs */
  | 'create-branch'
  | 'delete-branch'
  | 'get-branch'
  | 'list-branches'
  | 'update-ref'
  /* commits */
  | 'get-commit'
  | 'create-commit'
  /* pull requests */
  | 'create-pr'
  | 'merge-pr'
  | 'get-pr'
  | 'list-prs'
  /* issues + gists */
  | 'create-issue'
  | 'list-issues'
  | 'create-gist'
  | 'list-gists'
  /* search + repos */
  | 'search-code'
  | 'search-repos'
  | 'list-repos'
  | 'get-repo'
  | 'clone-repo'
  /* auth + quota */
  | 'test-token'
  | 'rate-limit'
  | 'sign-in'
  | 'sign-out'
  /** Anything not in the vocabulary above — still shown, never hidden. */
  | 'other'

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

export interface GitHubActionInfo {
  kind: GitHubActionKind
  /** Card title, already prefixed. */
  title: string
  /** Card sub-title: the path, branch, query or repo the call touched. */
  subject: string
  /** `owner/repo` when the call is repo-scoped. */
  repo?: string
  /** Branch / tag / sha the call was made against, when known. */
  ref?: string
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
  if (head === 'user' && second === 'repos') {
    return make('list-repos', 'your repositories', { ref })
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
