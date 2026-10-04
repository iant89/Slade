/**
 * Pending-changes computation: what would land on GitHub if the user
 * committed the Local Files workspace to the selected repository/branch.
 *
 * The rules mirror `commitFsToGitHub`:
 *  - a local file tracked by this repo counts when it is dirty or was synced
 *    from a different branch;
 *  - a local file with no remote (or another repo's remote) is new here;
 *  - a locally-deleted file that came from this repo is a removal.
 *
 * Base ("theirs") content is fetched through the GitHub contents API and
 * cached per `repo@ref:path`. When the loaded file tree covers the active
 * branch, blob shas from the tree validate the cache — so re-renders during
 * an editing session cost no API calls. A tree that is absent or truncated
 * falls back to a short TTL instead.
 */

import type { FsFile, RemoteSource } from '../types'
import {
  githubErrorMessage,
  isGitHubError,
  isTextualPath,
  mimeForPath,
  readFile,
  type GitHubTreeEntry,
} from './github'
import { diffLines, type DiffHunk } from './diff'

export type ChangeStatus = 'added' | 'modified' | 'deleted'

export interface FileChange {
  path: string
  status: ChangeStatus
  binary: boolean
  added: number
  removed: number
  hunks: DiffHunk[]
  /** True when the diff was too large for an exact LCS pass. */
  simplified: boolean
  /** Set when the remote copy could not be loaded. */
  note?: string
}

export interface ChangesSummary {
  added: number
  removed: number
  files: FileChange[]
  /** At least one remote copy failed to load — totals may be understated. */
  incomplete: boolean
}

export interface ChangesTree {
  repo: string
  ref: string
  truncated: boolean
  entries: GitHubTreeEntry[]
}

export interface ComputeChangesInput {
  repo?: string
  ref?: string
  token?: string
  files: Record<string, FsFile>
  deletedRemotes: Record<string, RemoteSource>
  tree?: ChangesTree
}

export const EMPTY_CHANGES: ChangesSummary = { added: 0, removed: 0, files: [], incomplete: false }

/* ------------------------------------------------------------------ */
/* Base-content cache                                                  */
/* ------------------------------------------------------------------ */

type BaseResult =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'binary' }
  | { kind: 'error'; message: string }

interface BaseCacheEntry {
  /** Blob sha used to validate the entry against the loaded tree. */
  sha: string
  result: BaseResult
  at: number
}

const baseCache = new Map<string, BaseCacheEntry>()
const BASE_TTL_MS = 90_000

async function loadBase(o: {
  repo: string
  ref: string
  path: string
  token?: string
  /** Tree blob sha when known, `null` when the tree proves absence, `undefined` when unknown. */
  treeSha: string | null | undefined
}): Promise<BaseResult> {
  // The active branch's tree says the file isn't there — no network needed.
  if (o.treeSha === null) return { kind: 'missing' }

  const key = `${o.repo}@${o.ref} ${o.path}`
  const cached = baseCache.get(key)
  if (
    cached &&
    ((o.treeSha !== undefined && cached.sha === o.treeSha) || Date.now() - cached.at < BASE_TTL_MS)
  ) {
    return cached.result
  }

  try {
    // A base copy is fetched for the changes chip on a debounce, without the
    // user asking for anything: quiet, so it never lands in the conversation.
    const file = await readFile(o.repo, o.path, o.ref, { token: o.token, quiet: true })
    const result: BaseResult = file.text != null ? { kind: 'text', text: file.text } : { kind: 'binary' }
    // Under a tree sha, the tree remains the validity key even if the fetch
    // raced an external push — that keeps the cache stable until refresh.
    baseCache.set(key, { sha: o.treeSha ?? file.sha, result, at: Date.now() })
    return result
  } catch (err) {
    if (isGitHubError(err) && err.kind === 'not_found') {
      const result: BaseResult = { kind: 'missing' }
      baseCache.set(key, { sha: o.treeSha ?? '', result, at: Date.now() })
      return result
    }
    const result: BaseResult = { kind: 'error', message: isGitHubError(err) ? err.message : githubErrorMessage(err) }
    // Negative-cached without the tree sha: a tree-validated hit would stick
    // forever, so transient server errors retry after the normal TTL instead.
    baseCache.set(key, { sha: '', result, at: Date.now() })
    return result
  }
}

/* ------------------------------------------------------------------ */
/* Change set                                                          */
/* ------------------------------------------------------------------ */

export async function computeChanges(input: ComputeChangesInput): Promise<ChangesSummary> {
  const { repo, ref, token } = input
  if (!repo || !ref) return EMPTY_CHANGES

  const tree =
    input.tree && input.tree.repo === repo && input.tree.ref === ref ? input.tree : undefined
  const treeShas = new Map<string, string>()
  if (tree) for (const e of tree.entries) if (e.type === 'blob') treeShas.set(e.path, e.sha)

  /** `string` = blob sha, `null` = proven absent, `undefined` = unknown. */
  const shaFor = (path: string): string | null | undefined => {
    if (!tree) return undefined
    const sha = treeShas.get(path)
    if (sha !== undefined) return sha
    return tree.truncated ? undefined : null
  }

  const files: FileChange[] = []
  const jobs: Promise<void>[] = []
  let incomplete = false

  const add = (change: FileChange) => files.push(change)

  for (const f of Object.values(input.files)) {
    const tracked = f.remote?.repo === repo
    const candidate = !tracked || f.dirty || f.remote!.ref !== ref
    if (!candidate) continue

    // Tree proof that the active branch already has this path — otherwise a
    // foreign/local file counts as brand new without a network round-trip.
    const sha = shaFor(f.path)
    const existsOnBranch = sha != null

    const textual = f.encoding !== 'base64' && isTextualPath(f.path, f.mime)
    if (!textual) {
      add({
        path: f.path,
        status: tracked || existsOnBranch ? 'modified' : 'added',
        binary: true,
        added: 0,
        removed: 0,
        hunks: [],
        simplified: false,
      })
      continue
    }

    if (!tracked && !existsOnBranch) {
      const d = diffLines('', f.content)
      add({ path: f.path, status: 'added', binary: false, added: d.added, removed: 0, hunks: d.hunks, simplified: d.simplified })
      continue
    }

    jobs.push(
      (async () => {
        const base = await loadBase({ repo, ref, path: f.path, token, treeSha: sha })
        if (base.kind === 'error') {
          incomplete = true
          add({ path: f.path, status: 'modified', binary: false, added: 0, removed: 0, hunks: [], simplified: false, note: base.message })
          return
        }
        if (base.kind === 'binary') {
          add({ path: f.path, status: 'modified', binary: true, added: 0, removed: 0, hunks: [], simplified: false })
          return
        }
        if (base.kind === 'missing') {
          // Remote copy is gone — the local file becomes a fresh addition.
          const d = diffLines('', f.content)
          if (d.added === 0) return // empty local file, nothing to show
          add({ path: f.path, status: 'added', binary: false, added: d.added, removed: 0, hunks: d.hunks, simplified: d.simplified })
          return
        }
        const d = diffLines(base.text, f.content)
        if (d.added === 0 && d.removed === 0) return // e.g. cross-branch content is identical
        add({
          path: f.path,
          status: 'modified',
          binary: false,
          added: d.added,
          removed: d.removed,
          hunks: d.hunks,
          simplified: d.simplified,
        })
      })(),
    )
  }

  for (const [path, rem] of Object.entries(input.deletedRemotes)) {
    if (rem.repo !== repo) continue
    if (!isTextualPath(path, mimeForPath(path))) {
      add({ path, status: 'deleted', binary: true, added: 0, removed: 0, hunks: [], simplified: false })
      continue
    }
    jobs.push(
      (async () => {
        const base = await loadBase({ repo, ref, path, token, treeSha: shaFor(path) })
        if (base.kind === 'missing') return // already gone on this branch
        if (base.kind === 'error') {
          incomplete = true
          add({ path, status: 'deleted', binary: false, added: 0, removed: 0, hunks: [], simplified: false, note: base.message })
          return
        }
        if (base.kind === 'binary') {
          add({ path, status: 'deleted', binary: true, added: 0, removed: 0, hunks: [], simplified: false })
          return
        }
        const d = diffLines(base.text, '')
        add({
          path,
          status: 'deleted',
          binary: false,
          added: 0,
          removed: d.removed,
          hunks: d.hunks,
          simplified: d.simplified,
        })
      })(),
    )
  }

  await Promise.all(jobs)

  files.sort((a, b) => a.path.localeCompare(b.path))
  let added = 0
  let removed = 0
  for (const f of files) {
    added += f.added
    removed += f.removed
  }
  return { added, removed, files, incomplete }
}

/** Test/hot-reload seam — drop cached base copies. */
export function clearChangeBaseCache(): void {
  baseCache.clear()
}
