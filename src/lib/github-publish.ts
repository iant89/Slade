/**
 * Publishing orchestration: turn a prepared payload into a gist, a commit or an
 * issue — including the "publish onto a fresh branch" path, which is the safe
 * default for anything the user might not want on `main`.
 *
 * Kept free of stores and React so it can be exercised headlessly.
 */

import {
  createBranch,
  createGist,
  createIssue,
  fileSha,
  getBranchSha,
  GitHubError,
  isGitHubError,
  writeFile,
} from './github'

export type PublishTarget = 'gist' | 'file' | 'issue'

export interface PublishRequest {
  target: PublishTarget
  /** File name used for gists and repo paths. */
  name: string
  /** Text contents (gist / code artifact / message body). */
  text?: string
  /** Raw base64 contents for binary repo commits. */
  base64?: string
  /** Gist description. */
  description?: string
  /** Gist visibility. */
  public?: boolean

  /** Repo commits + issues. */
  repo?: string
  branch?: string
  /** Commit onto a brand-new branch created from `branch`. */
  newBranch?: string
  path?: string
  commitMessage?: string
  /** Owning chat workspace for syncing a published Local Files artifact. */
  conversationId?: string

  /** Issues. */
  title?: string
  body?: string
  labels?: string[]
}

export interface PublishResult {
  kind: PublishTarget
  url: string
  /** `gist a1b2c3`, `commit 9f2c1d`, `issue #42` — short chip text. */
  label: string
  detail?: string
}

export interface PublishContext {
  token: string
  baseUrl?: string
  signal?: AbortSignal
  /** Progress pings for the dialog ("creating branch…"). */
  onStep?: (step: string) => void
}

export class PublishPreflightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublishPreflightError'
  }
}

function requireRepo(req: PublishRequest): string {
  const repo = req.repo?.trim()
  if (!repo) throw new PublishPreflightError('Choose a repository first.')
  return repo
}

export async function executePublish(req: PublishRequest, ctx: PublishContext): Promise<PublishResult> {
  if (!ctx.token) throw new PublishPreflightError('Connect GitHub first (Settings → GitHub).')

  switch (req.target) {
    case 'gist': {
      if (req.text == null) {
        throw new PublishPreflightError('Gists are text only — publish this artifact as a repository file.')
      }
      ctx.onStep?.('creating gist…')
      const gist = await createGist({
        token: ctx.token,
        baseUrl: ctx.baseUrl,
        signal: ctx.signal,
        files: [{ name: req.name, content: req.text }],
        description: req.description,
        public: Boolean(req.public),
      })
      return {
        kind: 'gist',
        url: gist.htmlUrl,
        label: `gist ${gist.id.slice(0, 7)}`,
        detail: req.public ? 'Public gist' : 'Secret gist (only people with the link can see it)',
      }
    }

    case 'file': {
      const repo = requireRepo(req)
      const path = (req.path ?? req.name).replace(/^\/+/, '')
      if (!path) throw new PublishPreflightError('Enter a path for the file.')
      if (req.text == null && req.base64 == null) {
        throw new PublishPreflightError('This artifact has no contents to commit.')
      }

      let targetBranch = req.branch?.trim() || undefined
      const baseBranch = req.branch?.trim() || undefined

      if (req.newBranch?.trim()) {
        const newBranch = req.newBranch.trim()
        if (!baseBranch) throw new PublishPreflightError('Pick the branch to branch off from.')
        ctx.onStep?.(`creating branch ${newBranch}…`)
        try {
          const sha = await getBranchSha(repo, baseBranch, { token: ctx.token, baseUrl: ctx.baseUrl, signal: ctx.signal })
          await createBranch(repo, newBranch, sha, { token: ctx.token, baseUrl: ctx.baseUrl, signal: ctx.signal })
        } catch (err) {
          // An existing branch is fine — we just commit onto it.
          if (!(isGitHubError(err) && (err.kind === 'validation' || err.kind === 'conflict'))) throw err
        }
        targetBranch = newBranch
      }

      ctx.onStep?.('looking up the current file…')
      const existingSha = targetBranch
        ? await fileSha(repo, path, targetBranch, { token: ctx.token, baseUrl: ctx.baseUrl, signal: ctx.signal })
        : undefined

      ctx.onStep?.(existingSha ? 'updating file…' : 'committing new file…')
      const res = await writeFile(repo, path, {
        token: ctx.token,
        baseUrl: ctx.baseUrl,
        signal: ctx.signal,
        message: req.commitMessage || `Add ${req.name} (via Slade)`,
        contentBase64: req.base64 ?? utf8Base64(req.text ?? ''),
        branch: targetBranch,
        sha: existingSha,
      })
      return {
        kind: 'file',
        url: res.htmlUrl ?? `https://github.com/${repo}/blob/${targetBranch ?? 'HEAD'}/${path}`,
        label: res.created ? `added ${path}` : `updated ${path}`,
        detail: `${repo} @ ${targetBranch ?? 'default branch'}${res.commitSha ? ` · ${res.commitSha.slice(0, 7)}` : ''}`,
      }
    }

    case 'issue': {
      const repo = requireRepo(req)
      const title = req.title?.trim()
      if (!title) throw new PublishPreflightError('Give the issue a title.')
      ctx.onStep?.('opening issue…')
      const issue = await createIssue(repo, {
        token: ctx.token,
        baseUrl: ctx.baseUrl,
        signal: ctx.signal,
        title,
        body: req.body ?? '',
        labels: req.labels,
      })
      return {
        kind: 'issue',
        url: issue.htmlUrl,
        label: `issue #${issue.number}`,
        detail: repo,
      }
    }

    default: {
      const exhaustive: never = req.target
      throw new PublishPreflightError(`Unsupported publish target: ${String(exhaustive)}`)
    }
  }
}

function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(out)
}

/** Turn any thrown value into a sentence worth showing in the dialog. */
export function publishErrorMessage(err: unknown): string {
  if (err instanceof PublishPreflightError) return err.message
  if (isGitHubError(err)) {
    if (err.kind === 'forbidden') {
      return `${err.message} A token with the \`repo\` scope can create commits and issues.`
    }
    return err.message
  }
  if (err instanceof GitHubError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
