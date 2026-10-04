/**
 * GitHub REST client.
 *
 * A thin, typed wrapper over `api.github.com` (which *is* CORS-enabled, so the
 * browser can call it directly with a user token). Every failure is turned into
 * a `GitHubError` that carries a stable `kind` for the UI to branch on and the
 * provider's own sentence as the message — the same contract the model
 * providers use, so an error shown to the user always says *why*.
 *
 * OAuth itself cannot happen here: github.com's token endpoints send no CORS
 * headers, so the device flow goes through the bundled relay
 * (see `github-auth.ts`).
 */

import { redactSecrets } from '../providers/base'
import { describeGitHubOutput, type GitHubCallLike } from './github-actions'
import type { GitHubActionOutput } from '../types'

export const GITHUB_API = 'https://api.github.com'
export const GITHUB_API_VERSION = '2022-11-28'

/* ------------------------------------------------------------------ */
/* Shapes (only the fields Slade actually reads)                       */
/* ------------------------------------------------------------------ */

export interface GitHubUser {
  id: number
  login: string
  name: string | null
  avatar_url: string
  html_url: string
}

export interface GitHubRepo {
  id: number
  name: string
  full_name: string
  owner: { login: string; avatar_url: string }
  private: boolean
  fork: boolean
  archived: boolean
  disabled?: boolean
  description: string | null
  default_branch: string
  html_url: string
  pushed_at: string | null
  updated_at: string | null
  language: string | null
  stargazers_count: number
  permissions?: { admin: boolean; push: boolean; pull: boolean }
}

export interface GitHubTreeEntry {
  path: string
  mode: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
  size?: number
}

export interface GitHubBranch {
  name: string
  commit: { sha: string }
  protected?: boolean
}

export interface GitHubSearchHit {
  path: string
  name: string
  sha: string
  html_url: string
  repository?: { full_name: string }
  text_matches?: { fragment: string; matches?: { text: string }[] }[]
}

export interface GitHubRate {
  limit: number
  remaining: number
  resetAt: number
}

export type GitHubErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limit'
  | 'conflict'
  | 'validation'
  | 'network'
  | 'server'
  | 'unknown'

export class GitHubError extends Error {
  kind: GitHubErrorKind
  status?: number
  /** Epoch ms at which a rate-limited window resets. */
  resetAt?: number
  constructor(kind: GitHubErrorKind, message: string, status?: number, resetAt?: number) {
    super(redactSecrets(message))
    this.name = 'GitHubError'
    this.kind = kind
    this.status = status
    this.resetAt = resetAt
  }
}

export function isGitHubError(err: unknown): err is GitHubError {
  return err instanceof GitHubError
}

/** Human-friendly one-liner for any thrown value. */
export function githubErrorMessage(err: unknown): string {
  if (isGitHubError(err)) return err.message
  if (err instanceof Error) return redactSecrets(err.message)
  return String(err)
}

/* ------------------------------------------------------------------ */
/* Header / response plumbing                                          */
/* ------------------------------------------------------------------ */

export interface GitHubRateInfo {
  rate?: GitHubRate
  /** Scopes the token was granted, from `x-oauth-scopes`. */
  scopes?: string[]
}

let lastRate: GitHubRateInfo = {}
const rateListeners = new Set<(r: GitHubRateInfo) => void>()

export function onRateInfo(fn: (r: GitHubRateInfo) => void): () => void {
  rateListeners.add(fn)
  return () => rateListeners.delete(fn)
}

export function lastRateInfo(): GitHubRateInfo {
  return lastRate
}

/* ------------------------------------------------------------------ */
/* Call observers — one event per GitHub API call                      */
/*                                                                     */
/* `ghFetch` is the single funnel every request goes through, so hook- */
/* ing here means *every* GitHub call is observable: repo browsing,    */
/* file reads, commits, search, publishing. Subscribers get a `start`  */
/* and a matching `end` (paired by `callId`) and turn them into the    */
/* GitHub action cards the UI shows. A listener that throws can never  */
/* break a request, so each notification is wrapped.                   */
/* ------------------------------------------------------------------ */

export interface GitHubCallEvent extends GitHubCallLike {
  /** Monotonic id; the `start` and `end` of one request share it. */
  callId: number
  phase: 'start' | 'end'
  /** Epoch ms when this event fired. */
  at: number
  /** `end` only: wall-clock ms the request took. */
  elapsedMs?: number
  /** `end` only: HTTP status when GitHub answered. */
  status?: number
  /** `end` only: false when the call failed or was cancelled. */
  ok?: boolean
  /** `end` only: the redacted, humanized failure sentence. */
  error?: string
  /** `end` only: Slade cancelled this request (a superseded search, a sign-in abort). */
  aborted?: boolean
  /** `end` only: a compact extract of the response, for the card's output panel. */
  output?: GitHubActionOutput
}

type GitHubCallListener = (event: GitHubCallEvent) => void

const callListeners = new Set<GitHubCallListener>()

/** Subscribe to every GitHub REST call. Returns an unsubscribe function. */
export function onGitHubCall(fn: GitHubCallListener): () => void {
  callListeners.add(fn)
  return () => callListeners.delete(fn)
}

let callSeq = 0

function emitCall(event: GitHubCallEvent): void {
  for (const fn of callListeners) {
    try {
      fn(event)
    } catch {
      /* observers are cosmetic — a broken listener must not fail a request */
    }
  }
}

function publishRate(headers: Headers): void {
  const limit = Number(headers.get('x-ratelimit-limit') ?? NaN)
  const remaining = Number(headers.get('x-ratelimit-remaining') ?? NaN)
  const reset = Number(headers.get('x-ratelimit-reset') ?? NaN)
  const scopes = headers.get('x-oauth-scopes')
  const next: GitHubRateInfo = { ...lastRate }
  if (Number.isFinite(limit) && Number.isFinite(remaining)) {
    next.rate = { limit, remaining, resetAt: Number.isFinite(reset) ? reset * 1000 : Date.now() }
  }
  if (scopes != null) {
    next.scopes = scopes
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  lastRate = next
  for (const fn of rateListeners) fn(next)
}

export interface GhRequest {
  token?: string
  /** Overrides the API host — used by tests against a local fake. */
  baseUrl?: string
  signal?: AbortSignal
}

interface CallOptions extends GhRequest {
  method?: string
  body?: unknown
  /** Query string params; undefined/empty values are dropped. */
  query?: Record<string, string | number | boolean | undefined>
  /** Extra headers (media types etc). */
  headers?: Record<string, string>
}

function buildUrl(baseUrl: string, path: string, query?: CallOptions['query']): string {
  const url = new URL(baseUrl.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`))
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === '') continue
    url.searchParams.set(k, String(v))
  }
  return url.toString()
}

/** Render a GitHub validation error (`errors: [{resource, field, code}]`). */
function validationDetail(json: unknown): string | undefined {
  const errors = (json as { errors?: unknown } | null)?.errors
  if (!Array.isArray(errors) || errors.length === 0) return undefined
  return errors
    .map((e) => {
      if (typeof e === 'string') return e
      const o = e as { field?: string; code?: string; message?: string; resource?: string }
      const bits = [o.resource, o.field, o.code ?? o.message].filter(Boolean)
      return bits.join(': ') || JSON.stringify(e)
    })
    .slice(0, 3)
    .join('; ')
}

function classify(res: Response, body: string): GitHubError {
  let json: { message?: string; documentation_url?: string } | null = null
  try {
    json = JSON.parse(body) as { message?: string }
  } catch {
    /* non-JSON body (proxy, HTML error page) */
  }
  const apiMessage = typeof json?.message === 'string' ? json.message.trim() : ''
  const remaining = res.headers.get('x-ratelimit-remaining')
  const resetSec = Number(res.headers.get('x-ratelimit-reset') ?? NaN)
  const resetAt = Number.isFinite(resetSec) ? resetSec * 1000 : undefined
  const detail = validationDetail(json)
  const status = res.status
  // GitHub repeats itself a lot ("Not Found", "Bad credentials"); Slade's own
  // sentence already says it, so only add a message that carries new facts.
  const GENERIC = /^(not found|bad credentials|validation failed|requires authentication|server error|forbidden)$/i

  const withDetail = (head: string) => {
    const parts = [
      apiMessage && !GENERIC.test(apiMessage) && !head.includes(apiMessage) ? apiMessage : '',
      detail ?? '',
    ].filter(Boolean)
    return parts.length ? `${head} — ${parts.join(' · ')}` : head
  }

  if (status === 401) {
    return new GitHubError('auth', withDetail('GitHub rejected the token (bad credentials) — sign in again.'), status)
  }
  if (status === 404) {
    return new GitHubError(
      'not_found',
      withDetail('Not found on GitHub — the repo, branch or path may not exist, or this token cannot see it.'),
      status,
    )
  }
  if (status === 403 && remaining === '0') {
    return new GitHubError(
      'rate_limit',
      `GitHub API rate limit reached${resetAt ? ` — resets ${new Date(resetAt).toLocaleTimeString()}` : ''}.`,
      status,
      resetAt,
    )
  }
  if (status === 403) {
    const scopeish = /scope|permission|forbidden|not accessible|resource not accessible/i.test(apiMessage)
    return new GitHubError(
      'forbidden',
      withDetail(
        scopeish
          ? 'GitHub refused the token — it is missing a scope this action needs (repo / gist / read:user).'
          : 'GitHub refused the request.',
      ),
      status,
    )
  }
  // 405 is what GitHub answers when an action is refused outright — a pull
  // request that cannot be merged, for instance.
  if (status === 405) return new GitHubError('validation', withDetail('GitHub refused this action.'), status)
  if (status === 409) return new GitHubError('conflict', withDetail('Conflict — the file changed on GitHub.'), status)
  if (status === 422) return new GitHubError('validation', withDetail('GitHub rejected the request.'), status)
  if (status >= 500) return new GitHubError('server', withDetail(`GitHub had a server error (${status}).`), status)
  return new GitHubError('unknown', withDetail(`GitHub request failed (${status}).`), status)
}

async function ghFetch<T>(path: string, opts: CallOptions = {}): Promise<T> {
  const base = opts.baseUrl ?? GITHUB_API
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET')
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    ...opts.headers,
  }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  // Observability: one start/end pair per call, which is what renders the
  // GitHub action cards. Only the URL and the (already-parsed) body object are
  // handed over — never the token, never the file payload.
  const callId = ++callSeq
  const startedAt = Date.now()
  emitCall({ callId, phase: 'start', at: startedAt, method, path, query: opts.query, body: opts.body })
  const finish = (end: { ok: boolean; status?: number; error?: string; aborted?: boolean; output?: GitHubActionOutput }) =>
    emitCall({
      callId,
      phase: 'end',
      at: Date.now(),
      method,
      path,
      query: opts.query,
      body: opts.body,
      elapsedMs: Date.now() - startedAt,
      ...end,
    })

  let res: Response
  try {
    res = await fetch(buildUrl(base, path, opts.query), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      finish({ ok: false, aborted: true, error: 'cancelled' })
      throw err
    }
    const message = 'Could not reach api.github.com — check your connection, an ad blocker, or a proxy blocking the request.'
    finish({ ok: false, error: message })
    throw new GitHubError('network', message)
  }

  publishRate(res.headers)

  if (res.status === 204) {
    finish({ ok: true, status: res.status })
    return undefined as T
  }

  const text = await res.text()
  if (!res.ok) {
    const err = classify(res, text)
    finish({ ok: false, status: res.status, error: err.message })
    throw err
  }
  if (!text) {
    finish({ ok: true, status: res.status })
    return undefined as T
  }
  try {
    const parsed = JSON.parse(text) as T
    // The card is a request *and* its result: the observer carries a compact,
    // clipped extract of the response so the card has output to show.
    finish({
      ok: true,
      status: res.status,
      output: describeGitHubOutput({ method, path, query: opts.query, body: opts.body, json: parsed }),
    })
    return parsed
  } catch {
    const message = 'GitHub returned a response Slade could not parse.'
    finish({ ok: false, status: res.status, error: message })
    throw new GitHubError('unknown', message)
  }
}

/* ------------------------------------------------------------------ */
/* base64 helpers (browser-safe, no Node Buffer)                       */
/* ------------------------------------------------------------------ */

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(out)
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '')
  const bin = atob(clean)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text))
}

export function base64ToUtf8(b64: string): string {
  return new TextDecoder().decode(base64ToBytes(b64))
}

/* ------------------------------------------------------------------ */
/* Repo identifiers                                                    */
/* ------------------------------------------------------------------ */

export interface RepoRef {
  owner: string
  name: string
  fullName: string
}

/**
 * Accepts `owner/repo`, `https://github.com/owner/repo`, `git@github.com:owner/repo.git`
 * or a bare `repo` when an owner is supplied.
 */
export function parseRepoInput(input: string, fallbackOwner?: string): RepoRef | null {
  let s = input.trim()
  if (!s) return null
  s = s.replace(/^git@github\.com:/i, '').replace(/^ssh:\/\/git@github\.com\//i, '')
  s = s.replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
  s = s.split(/[?#]/)[0]!
  // `.../demo.git/` and `.../demo.git` are the same repo.
  s = s.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  const parts = s.split('/').filter(Boolean)
  if (parts.length === 1 && fallbackOwner) parts.unshift(fallbackOwner)
  if (parts.length < 2) return null
  const [owner, name] = parts as [string, string]
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null
  return { owner, name, fullName: `${owner}/${name}` }
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

export function getUser(o: GhRequest = {}): Promise<GitHubUser> {
  return ghFetch<GitHubUser>('/user', o)
}

export interface ListReposOptions extends GhRequest {
  page?: number
  perPage?: number
  sort?: 'updated' | 'pushed' | 'full_name' | 'created'
  visibility?: 'all' | 'public' | 'private'
}

export function listRepos(o: ListReposOptions = {}): Promise<GitHubRepo[]> {
  return ghFetch<GitHubRepo[]>('/user/repos', {
    ...o,
    query: {
      page: o.page ?? 1,
      per_page: o.perPage ?? 50,
      sort: o.sort ?? 'updated',
      direction: 'desc',
      visibility: o.visibility ?? 'all',
      affiliation: 'owner,collaborator,organization_member',
    },
  })
}

export function getRepo(fullName: string, o: GhRequest = {}): Promise<GitHubRepo> {
  return ghFetch<GitHubRepo>(`/repos/${fullName}`, o)
}

export function listBranches(fullName: string, o: GhRequest = {}): Promise<GitHubBranch[]> {
  return ghFetch<GitHubBranch[]>(`/repos/${fullName}/branches`, { ...o, query: { per_page: 100 } })
}

export function getBranchSha(fullName: string, branch: string, o: GhRequest = {}): Promise<string> {
  return ghFetch<{ object: { sha: string } }>(`/repos/${fullName}/git/ref/heads/${encodeURIComponent(branch)}`, o).then(
    (r) => r.object.sha,
  )
}

export function createBranch(fullName: string, branch: string, fromSha: string, o: GhRequest = {}): Promise<void> {
  return ghFetch<void>(`/repos/${fullName}/git/refs`, {
    ...o,
    body: { ref: `refs/heads/${branch}`, sha: fromSha },
  })
}

export interface TreeResult {
  entries: GitHubTreeEntry[]
  truncated: boolean
  ref: string
}

export async function getTree(fullName: string, ref: string, o: GhRequest = {}): Promise<TreeResult> {
  const res = await ghFetch<{ tree: GitHubTreeEntry[]; truncated: boolean; sha: string }>(
    `/repos/${fullName}/git/trees/${encodeURIComponent(ref)}`,
    { ...o, query: { recursive: 1 } },
  )
  return {
    // `commit` entries are submodules — nothing to read, so drop them.
    entries: (res.tree ?? []).filter((e) => e.type === 'blob' || e.type === 'tree'),
    truncated: Boolean(res.truncated),
    ref,
  }
}

/** Refuse to pull anything larger than this into the browser. */
export const MAX_FILE_BYTES = 4_000_000

export interface RemoteFile {
  path: string
  sha: string
  size: number
  mime: string
  /** Present for text files we decoded. */
  text?: string
  /** Present for binary files (raw base64, no data-URL prefix). */
  base64?: string
}

interface ContentsResponse {
  type: string
  name: string
  path: string
  sha: string
  size: number
  encoding?: string
  content?: string
}

/**
 * Read one file. Uses the contents API (base64) and falls back to the blobs
 * API, which is the only route that works for files over ~1 MB — the contents
 * endpoint returns `encoding: "none"` for those.
 */
export async function readFile(
  fullName: string,
  path: string,
  ref: string,
  o: GhRequest = {},
): Promise<RemoteFile> {
  const res = await ghFetch<ContentsResponse | ContentsResponse[]>(`/repos/${fullName}/contents/${encodePath(path)}`, {
    ...o,
    query: { ref },
  })
  if (Array.isArray(res)) {
    throw new GitHubError('validation', `${path} is a directory on GitHub, not a file.`)
  }
  if (res.type !== 'file') {
    throw new GitHubError('validation', `${path} is not a regular file on GitHub.`)
  }
  if (res.size > MAX_FILE_BYTES) {
    throw new GitHubError(
      'validation',
      `${path} is ${(res.size / 1_000_000).toFixed(1)} MB — too large to attach (limit ${MAX_FILE_BYTES / 1_000_000} MB).`,
    )
  }

  let base64: string | undefined
  let sha = res.sha
  let size = res.size
  if (res.encoding === 'base64' && res.content) {
    base64 = res.content.replace(/\s+/g, '')
  } else {
    const blob = await ghFetch<{ content: string; size: number; sha: string; encoding: string }>(
      `/repos/${fullName}/git/blobs/${res.sha}`,
      o,
    )
    base64 = (blob.content ?? '').replace(/\s+/g, '')
    size = blob.size ?? size
    sha = blob.sha ?? sha
  }

  const name = path.split('/').pop() ?? path
  const mime = mimeForPath(name)
  const text = isTextualPath(name, mime) ? base64ToUtf8(base64 ?? '') : undefined
  return { path, sha, size, mime, text, base64: text == null ? base64 : undefined }
}

export function encodePath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

export interface WriteFileOptions extends GhRequest {
  message: string
  /** Raw base64 of the new file contents. */
  contentBase64: string
  branch?: string
  /** Required when updating an existing file; omit to create. */
  sha?: string
}

export interface WriteResult {
  path: string
  sha: string
  htmlUrl?: string
  commitSha?: string
  commitUrl?: string
  created: boolean
}

export async function writeFile(fullName: string, path: string, o: WriteFileOptions): Promise<WriteResult> {
  const res = await ghFetch<{
    content: { path: string; sha: string; html_url: string } | null
    commit: { sha: string; html_url: string } | null
  }>(`/repos/${fullName}/contents/${encodePath(path)}`, {
    token: o.token,
    baseUrl: o.baseUrl,
    signal: o.signal,
    method: 'PUT',
    body: {
      message: o.message,
      content: o.contentBase64,
      branch: o.branch,
      sha: o.sha,
    },
  })
  return {
    path: res?.content?.path ?? path,
    sha: res?.content?.sha ?? '',
    htmlUrl: res?.content?.html_url,
    commitSha: res?.commit?.sha,
    commitUrl: res?.commit?.html_url,
    created: !o.sha,
  }
}

/** The blob sha of a path on a branch, or undefined when the file does not exist. */
export async function fileSha(fullName: string, path: string, ref: string, o: GhRequest = {}): Promise<string | undefined> {
  try {
    const res = await ghFetch<ContentsResponse>(`/repos/${fullName}/contents/${encodePath(path)}`, {
      ...o,
      query: { ref },
    })
    return Array.isArray(res) ? undefined : res.sha
  } catch (err) {
    if (isGitHubError(err) && err.kind === 'not_found') return undefined
    throw err
  }
}

export interface DeleteFileOptions extends GhRequest {
  message: string
  sha: string
  branch?: string
}

export async function deleteRemoteFile(fullName: string, path: string, o: DeleteFileOptions): Promise<{ commitSha?: string }> {
  const res = await ghFetch<{ commit?: { sha: string } }>(`/repos/${fullName}/contents/${encodePath(path)}`, {
    token: o.token,
    baseUrl: o.baseUrl,
    signal: o.signal,
    method: 'DELETE',
    body: {
      message: o.message,
      sha: o.sha,
      branch: o.branch,
    },
  })
  return { commitSha: res?.commit?.sha }
}

/** The modes Slade will record for a blob. */
export type GitFileMode = '100644' | '100755'

export interface CommitTreeEntryInput {
  path: string
  /** UTF-8 text content, or omit when `base64` or `deleted` is set. */
  content?: string
  /** Raw base64 content for binary files. */
  base64?: string
  /** True to delete this file from the Git tree. */
  deleted?: boolean
  /**
   * File mode to record. Omit to keep the mode the path already has on the
   * branch (`100644` / `100755`); new files default to `100644`.
   */
  mode?: GitFileMode
}

/**
 * Which mode to write for a blob entry.
 *
 * Local Files has no concept of a file mode, so a commit that wrote `100644`
 * for everything would strip the executable bit off every file it touched —
 * including files the user never edited. Carrying the mode the path already has
 * on the branch is what makes an edit a *content* change.
 *
 * Only regular-file modes are carried over: `120000` (symlink) and `160000`
 * (submodule) describe something that is not a blob's contents, so writing file
 * content under them would corrupt the entry.
 */
function blobModeFor(path: string, explicit: GitFileMode | undefined, baseModes: Map<string, string>): GitFileMode {
  if (explicit) return explicit
  return baseModes.get(path) === '100755' ? '100755' : '100644'
}

export interface CommitTreeOptions extends GhRequest {
  /** Base branch to read the parent commit and tree from (defaults to repo default_branch). */
  branch?: string
  /** Optional new branch to create/update with the commit. */
  newBranch?: string
  message: string
  entries: CommitTreeEntryInput[]
}

export interface CommitTreeResult {
  branch: string
  commitSha: string
  treeSha: string
  htmlUrl: string
  fileShas: Record<string, string>
}

/**
 * Commit multiple file creations, updates, and deletions atomically in a
 * single Git commit via GitHub's Git Data API.
 */
export async function commitTree(fullName: string, o: CommitTreeOptions): Promise<CommitTreeResult> {
  if (o.entries.length === 0) {
    throw new GitHubError('validation', 'No file changes to commit.')
  }
  const reqOpts: GhRequest = { token: o.token, baseUrl: o.baseUrl, signal: o.signal }

  let baseBranch = o.branch?.trim()
  if (!baseBranch) {
    const repo = await getRepo(fullName, reqOpts)
    baseBranch = repo.default_branch
  }

  const baseCommitSha = await getBranchSha(fullName, baseBranch, reqOpts)
  const baseCommit = await ghFetch<{ sha: string; tree?: { sha: string } }>(
    `/repos/${fullName}/git/commits/${baseCommitSha}`,
    reqOpts,
  )
  const baseTreeSha = baseCommit?.tree?.sha ?? baseCommitSha

  // Read the modes the branch already has, so a commit can't clear the
  // executable bit by omission. Only fetched when an entry has no explicit mode.
  const baseModes = new Map<string, string>()
  if (o.entries.some((e) => !e.deleted && !e.mode)) {
    const base = await getTree(fullName, baseTreeSha, reqOpts)
    for (const entry of base.entries) {
      if (entry.type === 'blob') baseModes.set(entry.path, entry.mode)
    }
  }

  const fileShas: Record<string, string> = {}
  const treeItems: Array<{
    path: string
    mode: GitFileMode
    type: 'blob'
    content?: string
    sha?: string | null
  }> = []

  for (const entry of o.entries) {
    const cleanPath = entry.path.replace(/^\/+/, '')
    if (!cleanPath) continue
    if (entry.deleted) {
      treeItems.push({ path: cleanPath, mode: '100644', type: 'blob', sha: null })
    } else if (entry.base64 != null) {
      const blob = await ghFetch<{ sha: string }>(`/repos/${fullName}/git/blobs`, {
        ...reqOpts,
        method: 'POST',
        body: { content: entry.base64, encoding: 'base64' },
      })
      fileShas[cleanPath] = blob.sha
      treeItems.push({ path: cleanPath, mode: blobModeFor(cleanPath, entry.mode, baseModes), type: 'blob', sha: blob.sha })
    } else {
      treeItems.push({
        path: cleanPath,
        mode: blobModeFor(cleanPath, entry.mode, baseModes),
        type: 'blob',
        content: entry.content ?? '',
      })
    }
  }

  const createdTree = await ghFetch<{ sha: string; tree?: Array<{ path: string; sha: string }> }>(
    `/repos/${fullName}/git/trees`,
    {
      ...reqOpts,
      method: 'POST',
      body: { base_tree: baseTreeSha, tree: treeItems },
    },
  )
  for (const t of createdTree.tree ?? []) {
    if (t.path && t.sha) fileShas[t.path] = t.sha
  }

  const createdCommit = await ghFetch<{ sha: string; html_url?: string }>(`/repos/${fullName}/git/commits`, {
    ...reqOpts,
    method: 'POST',
    body: {
      message: o.message,
      tree: createdTree.sha,
      parents: [baseCommitSha],
    },
  })

  const targetBranch = o.newBranch?.trim() || baseBranch
  if (o.newBranch?.trim() && o.newBranch.trim() !== baseBranch) {
    try {
      await createBranch(fullName, targetBranch, createdCommit.sha, reqOpts)
    } catch (err) {
      if (isGitHubError(err) && (err.kind === 'validation' || err.kind === 'conflict')) {
        await ghFetch(`/repos/${fullName}/git/refs/heads/${encodeURIComponent(targetBranch)}`, {
          ...reqOpts,
          method: 'PATCH',
          body: { sha: createdCommit.sha },
        })
      } else {
        throw err
      }
    }
  } else {
    await ghFetch(`/repos/${fullName}/git/refs/heads/${encodeURIComponent(targetBranch)}`, {
      ...reqOpts,
      method: 'PATCH',
      body: { sha: createdCommit.sha },
    })
  }

  return {
    branch: targetBranch,
    commitSha: createdCommit.sha,
    treeSha: createdTree.sha,
    htmlUrl: createdCommit.html_url ?? `https://github.com/${fullName}/commit/${createdCommit.sha}`,
    fileShas,
  }
}

export interface GistFile {
  name: string
  content: string
}

export interface GistResult {
  id: string
  htmlUrl: string
  public: boolean
}

export async function createGist(
  o: GhRequest & { files: GistFile[]; description?: string; public: boolean },
): Promise<GistResult> {
  const files: Record<string, { content: string }> = {}
  for (const f of o.files) files[f.name] = { content: f.content }
  const res = await ghFetch<{ id: string; html_url: string; public: boolean }>('/gists', {
    token: o.token,
    baseUrl: o.baseUrl,
    signal: o.signal,
    method: 'POST',
    body: { description: o.description, public: o.public, files },
  })
  return { id: res.id, htmlUrl: res.html_url, public: res.public }
}

export interface PullRequestResult {
  number: number
  htmlUrl: string
  state?: string
}

/**
 * Open a pull request. The response GitHub returns is what the card shows, so
 * this hands back only what a caller needs to point at it — the card itself is
 * drawn from the response the REST client already observed.
 */
export async function createPullRequest(
  fullName: string,
  o: GhRequest & { title: string; head: string; base: string; body?: string; draft?: boolean },
): Promise<PullRequestResult> {
  const res = await ghFetch<{ number: number; html_url: string; state?: string }>(`/repos/${fullName}/pulls`, {
    token: o.token,
    baseUrl: o.baseUrl,
    signal: o.signal,
    method: 'POST',
    body: { title: o.title, head: o.head, base: o.base, body: o.body, draft: o.draft },
  })
  return { number: res.number, htmlUrl: res.html_url, state: res.state }
}

export interface MergeResult {
  merged: boolean
  /** The merge commit, when GitHub made one. */
  sha?: string
  /** GitHub's own sentence — "Pull Request successfully merged", or why not. */
  message: string
}

/**
 * Merge a pull request. GitHub answers `200` with `merged: true`, and `405` /
 * `409` with `merged: false` and a reason, so a refusal comes back as a result
 * here rather than as a thrown error.
 */
export async function mergePullRequest(
  fullName: string,
  number: number,
  o: GhRequest & { method?: MergeMethod; commitTitle?: string; commitMessage?: string } = {},
): Promise<MergeResult> {
  try {
    const res = await ghFetch<{ merged?: boolean; sha?: string | null; message?: string }>(
      `/repos/${fullName}/pulls/${number}/merge`,
      {
        token: o.token,
        baseUrl: o.baseUrl,
        signal: o.signal,
        method: 'PUT',
        body: {
          merge_method: o.method ?? 'merge',
          commit_title: o.commitTitle,
          commit_message: o.commitMessage,
        },
      },
    )
    return { merged: res.merged === true, sha: res.sha ?? undefined, message: res.message ?? '' }
  } catch (err) {
    // A merge GitHub refuses comes back as 405 (not mergeable) or 409 (conflict)
    // rather than as a 200 with `merged: false`. Both are the answer to the
    // question the card asked, not a failed call — so they read as a result.
    if (isGitHubError(err) && (err.status === 405 || err.status === 409)) {
      return { merged: false, message: githubErrorMessage(err) }
    }
    throw err
  }
}

export type MergeMethod = 'merge' | 'squash' | 'rebase'

export interface IssueResult {
  number: number
  htmlUrl: string
}

export async function createIssue(
  fullName: string,
  o: GhRequest & { title: string; body: string; labels?: string[] },
): Promise<IssueResult> {
  const res = await ghFetch<{ number: number; html_url: string }>(`/repos/${fullName}/issues`, {
    token: o.token,
    baseUrl: o.baseUrl,
    signal: o.signal,
    method: 'POST',
    body: { title: o.title, body: o.body, labels: o.labels?.length ? o.labels : undefined },
  })
  return { number: res.number, htmlUrl: res.html_url }
}

export interface SearchOptions extends GhRequest {
  page?: number
  perPage?: number
  signal?: AbortSignal
}

export async function searchCode(fullName: string, query: string, o: SearchOptions = {}): Promise<GitHubSearchHit[]> {
  const q = `${query.trim()} repo:${fullName}`
  const res = await ghFetch<{ items: GitHubSearchHit[] }>('/search/code', {
    ...o,
    query: { q, per_page: o.perPage ?? 25, page: o.page ?? 1 },
    headers: { Accept: 'application/vnd.github.text-match+json' },
  })
  return res.items ?? []
}

export function getRateLimit(o: GhRequest = {}): Promise<{ resources: { core: { limit: number; remaining: number; reset: number } } }> {
  return ghFetch('/rate_limit', o)
}

/* ------------------------------------------------------------------ */
/* Path helpers                                                        */
/* ------------------------------------------------------------------ */

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon',
  ts: 'text/typescript', tsx: 'text/typescript', js: 'text/javascript', jsx: 'text/javascript',
  mjs: 'text/javascript', cjs: 'text/javascript', json: 'application/json', html: 'text/html',
  css: 'text/css', scss: 'text/css', less: 'text/css',
  py: 'text/x-python', rs: 'text/x-rust', go: 'text/x-go', java: 'text/x-java', kt: 'text/x-kotlin',
  rb: 'text/x-ruby', php: 'text/x-php', cs: 'text/x-csharp', swift: 'text/x-swift',
  c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-cpp', hpp: 'text/x-cpp',
  sh: 'text/x-sh', bash: 'text/x-sh', zsh: 'text/x-sh', ps1: 'text/x-powershell',
  sql: 'text/x-sql', yml: 'application/x-yaml', yaml: 'application/x-yaml',
  toml: 'application/toml', ini: 'application/toml', xml: 'text/xml', csv: 'text/csv', tsv: 'text/csv',
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', log: 'text/plain', rst: 'text/plain',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  lock: 'text/plain', env: 'text/plain', gitignore: 'text/plain',
}

export function extOf(path: string): string {
  const name = path.split('/').pop() ?? path
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

export function mimeForPath(path: string): string {
  return EXT_MIME[extOf(path)] ?? 'application/octet-stream'
}

/** Files we are willing to decode as UTF-8 text. */
export function isTextualPath(path: string, mime = mimeForPath(path)): boolean {
  if (mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/')) return false
  if (mime === 'application/octet-stream') return false
  if (mime.startsWith('text/')) return true
  return ['application/json', 'application/xml', 'application/x-yaml', 'application/toml'].includes(mime)
}

/** `src/lib/foo.ts` → `foo.ts` (what a download is named). */
export function baseName(path: string): string {
  return path.split('/').pop() || path
}

/** Directory portion of a repo path, '' at the root. */
export function dirName(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** Join a user-typed path prefix with a file name, collapsing stray slashes. */
export function joinPath(prefix: string, name: string): string {
  const left = prefix.replace(/^\/+|\/+$/g, '')
  const right = name.replace(/^\/+/g, '')
  return left ? `${left}/${right}` : right
}

export function guessLanguage(path: string): string {
  const ext = extOf(path)
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', cs: 'csharp',
    c: 'c', h: 'c', cpp: 'cpp', sh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml',
    md: 'markdown', json: 'json', html: 'xml', svg: 'xml', css: 'css', sql: 'sql', toml: 'ini',
    php: 'php', swift: 'swift',
  }
  return map[ext] ?? ''
}
