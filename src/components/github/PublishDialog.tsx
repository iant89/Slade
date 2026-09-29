import { useEffect, useMemo, useState } from 'react'
import type { Artifact, Message } from '../../types'
import { useArtifacts } from '../../store/artifacts'
import { useChat } from '../../store/chat'
import { useGitHub, canGist } from '../../store/github'
import { useUI } from '../../store/ui'
import { copyText } from '../../lib/clipboard'
import { formatBytes } from '../../lib/format'
import {
  artifactIssueBody,
  artifactIssueTitle,
  artifactPullRequestBody,
  artifactToFilePayload,
  artifactToGist,
  branchNameFor,
  isBinaryArtifact,
  messageIssueBody,
  messagePullRequestBody,
  messageToGist,
  PublishError,
  pullRequestTitleFor,
  slugify,
  suggestRepoPath,
  titleFromText,
} from '../../lib/github-payload'
import type { PublishRequest, PublishResult, PublishTarget } from '../../lib/github-publish'
import { Modal } from '../common/Modal'
import { GhError, Spinner } from './bits'
import { IconCheck, IconCopy, IconExternal, IconGithub, IconLock, IconUpload } from '../icons'

interface Resolved {
  label: string
  name: string
  title: string
  text?: string
  binary: boolean
  artifact?: Artifact
  origin: string
  model?: string
}

/** Resolve whatever the dialog was opened on into publishable content. */
function useSource(): Resolved | null {
  const source = useUI((s) => s.publishSource)
  const byId = useArtifacts((s) => s.byId)
  const conversations = useChat((s) => s.conversations)

  return useMemo(() => {
    if (!source) return null
    if (source.kind === 'artifact') {
      const a = byId[source.artifactId]
      if (!a) return null
      return {
        label: `${a.name} · ${formatBytes(a.size)}`,
        name: a.name,
        title: a.name,
        text: a.text,
        binary: isBinaryArtifact(a),
        artifact: a,
        origin: a.provenance.origin === 'user' ? 'you' : `${a.provenance.modelLabel} (via Slade)`,
        model: a.provenance.origin === 'model' ? a.provenance.modelLabel : undefined,
      }
    }
    let message: Message | undefined
    for (const conv of Object.values(conversations)) {
      message = conv.messages.find((m) => m.id === source.messageId)
      if (message) break
    }
    if (!message) return null
    return {
      label: `${message.role === 'user' ? 'Your message' : 'Assistant answer'} · ${message.content.length.toLocaleString()} chars`,
      name: `${slugify(titleFromText(message.content), 'slade-answer')}.md`,
      title: titleFromText(message.content),
      text: message.content,
      binary: false,
      origin: message.role === 'user' ? 'you' : 'an assistant answer',
    }
  }, [source, byId, conversations])
}

const TARGETS: { id: PublishTarget; label: string; hint: string }[] = [
  { id: 'gist', label: 'Gist', hint: 'One file, instantly — secret by default' },
  { id: 'file', label: 'Repo file', hint: 'Commit into a repository (binary files too)' },
  { id: 'pr', label: 'Pull request', hint: 'Open a pull request from one branch into another' },
  { id: 'issue', label: 'Issue', hint: 'Open an issue with the content in the body' },
]

/**
 * Publish something from the transcript to GitHub.
 *
 * Everything is a preview-then-send: the exact file name, path and commit
 * message are visible before anything leaves the browser, and a fresh branch is
 * one toggle away for anyone who does not want a direct commit.
 */
export function PublishDialog() {
  const source = useUI((s) => s.publishSource)
  const close = useUI((s) => s.closePublish)
  const toast = useUI((s) => s.toast)
  const resolved = useSource()

  const { token, login, scopes, repos, branches, activeRepo, activeBranch, publishDefaults: defaults } = useGitHub()
  const setPublishDefaults = useGitHub((s) => s.setPublishDefaults)
  const publish = useGitHub((s) => s.publish)
  const publishing = useGitHub((s) => s.publishing)
  const publishStep = useGitHub((s) => s.publishStep)
  const publishError = useGitHub((s) => s.publishError)
  const dismissPublishError = useGitHub((s) => s.dismissPublishError)

  const [target, setTarget] = useState<PublishTarget>(defaults.target)
  const [repo, setRepo] = useState(defaults.repo ?? activeRepo ?? '')
  const [branch, setBranch] = useState(defaults.branch ?? activeBranch ?? '')
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [publicGist, setPublicGist] = useState(defaults.gistPublic)
  const [commitMessage, setCommitMessage] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [useNewBranch, setUseNewBranch] = useState(defaults.useNewBranch)
  const [issueTitle, setIssueTitle] = useState('')
  const [issueBody, setIssueBody] = useState('')
  const [prHead, setPrHead] = useState('')
  const [prDraft, setPrDraft] = useState(false)
  /** Which target the auto-generated body belongs to (issue vs PR differ). */
  const [bodyFor, setBodyFor] = useState<PublishTarget | null>(null)
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | undefined>()
  const [result, setResult] = useState<PublishResult | null>(null)
  const [copied, setCopied] = useState(false)

  // Reset the form whenever a different thing is being published.
  useEffect(() => {
    if (!source || !resolved) return
    setTarget(defaults.target)
    setRepo(defaults.repo ?? activeRepo ?? '')
    setBranch(defaults.branch ?? activeBranch ?? '')
    setName(resolved.name)
    setPath(
      resolved.artifact?.localPath ??
        resolved.artifact?.remote?.path ??
        suggestRepoPath(resolved.name, defaults.prefix),
    )
    setDescription('')
    setPublicGist(defaults.gistPublic)
    setCommitMessage(`Add ${resolved.name} (via Slade)`)
    setNewBranch(branchNameFor('slade', resolved.title))
    setUseNewBranch(defaults.useNewBranch)
    setPrHead(branchNameFor('slade', resolved.title))
    setPrDraft(false)
    setIssueTitle(resolved.artifact ? artifactIssueTitle(resolved.artifact) : resolved.title)
    setIssueBody('')
    setBodyFor(null)
    setResult(null)
    setLocalError(undefined)
  }, [source, resolved, defaults, activeRepo, activeBranch])

  // Auto-generate the issue / PR body from the resolved content. The two
  // bodies differ, so switching targets regenerates rather than reusing.
  useEffect(() => {
    if (!resolved || (target !== 'issue' && target !== 'pr') || bodyFor === target) return
    const provenance = { origin: resolved.origin, model: resolved.model }
    const body =
      target === 'issue'
        ? resolved.artifact
          ? artifactIssueBody(resolved.artifact, provenance)
          : messageIssueBody(resolved.text ?? '', provenance)
        : resolved.artifact
          ? artifactPullRequestBody(resolved.artifact, provenance)
          : messagePullRequestBody(resolved.text ?? '', provenance)
    setIssueBody(body)
    setBodyFor(target)
    if (target === 'pr') {
      setIssueTitle(resolved.artifact ? pullRequestTitleFor(resolved.artifact) : resolved.title)
    }
  }, [resolved, target, bodyFor])

  if (!source || !resolved) return null

  const connected = Boolean(token)
  const binary = resolved.binary
  const gistAllowed = !binary && canGist(scopes.length ? scopes : ['gist'])
  const issueAllowed = !binary

  const submit = async () => {
    setLocalError(undefined)
    if (!connected) {
      setLocalError('Connect GitHub first (GitHub settings → Client ID, or paste a token).')
      return
    }
    setBusy(true)
    try {
      let req: PublishRequest
      if (target === 'gist') {
        const payload =
          resolved.artifact && !binary
            ? artifactToGist(resolved.artifact, description || undefined)
            : messageToGist(resolved.text ?? '', resolved.title, description || undefined)
        req = {
          target: 'gist',
          name: payload.files[0]?.name ?? resolved.name,
          text: payload.files[0]?.content ?? '',
          description: payload.description,
          public: publicGist,
        }
      } else if (target === 'file') {
        let contentBase64: string
        if (resolved.artifact) {
          contentBase64 = (await artifactToFilePayload(resolved.artifact)).contentBase64
        } else {
          contentBase64 = utf8Base64(resolved.text ?? '')
        }
        req = {
          target: 'file',
          name: resolved.name,
          base64: contentBase64,
          repo,
          branch: branch || undefined,
          newBranch: useNewBranch ? newBranch.trim() || undefined : undefined,
          path: path || resolved.name,
          commitMessage,
        }
      } else if (target === 'pr') {
        req = {
          target: 'pr',
          name: resolved.name,
          repo,
          branch: branch || undefined,
          head: prHead.trim() || undefined,
          title: issueTitle,
          body: issueBody,
          draft: prDraft,
        }
      } else {
        req = {
          target: 'issue',
          name: resolved.name,
          repo,
          title: issueTitle,
          body: issueBody,
          labels: ['slade'],
        }
      }

      const out = await publish(req)
      if (out) {
        setResult(out)
        setPublishDefaults({
          target,
          repo: repo || undefined,
          branch: branch || undefined,
          gistPublic: publicGist,
          useNewBranch,
        })
        toast({ kind: 'success', title: `Published ${out.label}`, detail: out.detail })
      }
    } catch (err) {
      setLocalError(err instanceof PublishError ? err.message : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const message = localError ?? publishError

  return (
    <Modal open onClose={close} labelledBy="publish-title">
      <div className="publish-dialog">
        <header className="publish-head">
          <h2 id="publish-title">
            <IconGithub size={15} /> Publish to GitHub
          </h2>
          <p className="gh-muted">{resolved.label}</p>
        </header>

        {result ? (
          <div className="publish-result" role="status">
            <div className="publish-result-line">
              <IconCheck size={15} />
              <span>
                Published <strong>{result.label}</strong>
                {result.detail ? <em> — {result.detail}</em> : null}
              </span>
            </div>
            <div className="gh-row">
              <a className="btn primary small" href={result.url} target="_blank" rel="noreferrer">
                <IconExternal size={12} /> Open
              </a>
              <button
                className="btn ghost small"
                onClick={async () => {
                  const ok = await copyText(result.url)
                  setCopied(ok)
                }}
                type="button"
              >
                {copied ? <IconCheck size={12} /> : <IconCopy size={12} />} {copied ? 'Copied' : 'Copy link'}
              </button>
              <button className="btn ghost small" onClick={close} type="button">
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="publish-tabs" role="tablist" aria-label="Publish target">
              {TARGETS.map((t) => {
                const disabled = (t.id === 'gist' && !gistAllowed) || (t.id === 'issue' && !issueAllowed)
                return (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={target === t.id}
                    className={`gh-tab${target === t.id ? ' active' : ''}`}
                    onClick={() => !disabled && setTarget(t.id)}
                    disabled={disabled}
                    title={disabled ? 'Not available for binary artifacts' : t.hint}
                    type="button"
                  >
                    {t.label}
                  </button>
                )
              })}
            </div>
            <p className="gh-muted publish-hint">{TARGETS.find((t) => t.id === target)?.hint}</p>
            {binary && target === 'file' ? (
              <p className="gh-muted">
                <IconLock size={11} /> Binary artifact ({resolved.artifact?.mime}) — it is committed byte-for-byte.
              </p>
            ) : null}

            <div className="publish-body">
              {target === 'gist' ? (
                <>
                  <label className="gh-field">
                    <span>File name</span>
                    <input className="gh-input" value={name} onChange={(e) => setName(e.target.value)} />
                  </label>
                  <label className="gh-field">
                    <span>Description</span>
                    <input
                      className="gh-input"
                      value={description}
                      placeholder="Optional"
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </label>
                  <label className="gh-check">
                    <input type="checkbox" checked={publicGist} onChange={(e) => setPublicGist(e.target.checked)} />
                    <span>
                      Public gist <em className="gh-muted">(unchecked = secret: only people with the link)</em>
                    </span>
                  </label>
                </>
              ) : null}

              {target === 'file' ? (
                <>
                  <label className="gh-field">
                    <span>Repository</span>
                    <input
                      className="gh-input"
                      list="gh-repo-options"
                      value={repo}
                      placeholder="owner/repo"
                      onChange={(e) => setRepo(e.target.value)}
                    />
                    <datalist id="gh-repo-options">
                      {repos.map((r) => (
                        <option key={r.full_name} value={r.full_name} />
                      ))}
                      {activeRepo ? <option value={activeRepo} /> : null}
                    </datalist>
                  </label>
                  <div className="publish-grid">
                    <label className="gh-field">
                      <span>Branch</span>
                      <input
                        className="gh-input"
                        list="gh-branch-options"
                        value={branch}
                        placeholder="default branch"
                        onChange={(e) => setBranch(e.target.value)}
                      />
                      <datalist id="gh-branch-options">
                        {branches.map((b) => (
                          <option key={b.name} value={b.name} />
                        ))}
                      </datalist>
                    </label>
                    <label className="gh-field">
                      <span>Path</span>
                      <input className="gh-input" value={path} onChange={(e) => setPath(e.target.value)} />
                    </label>
                  </div>
                  <label className="gh-check">
                    <input type="checkbox" checked={useNewBranch} onChange={(e) => setUseNewBranch(e.target.checked)} />
                    <span>Commit onto a new branch instead</span>
                  </label>
                  {useNewBranch ? (
                    <label className="gh-field">
                      <span>New branch name</span>
                      <input className="gh-input" value={newBranch} onChange={(e) => setNewBranch(e.target.value)} />
                    </label>
                  ) : null}
                  <label className="gh-field">
                    <span>Commit message</span>
                    <input className="gh-input" value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} />
                  </label>
                  <p className="gh-muted">
                    {resolved.artifact?.remote ? 'Existing file detected upstream — Slade updates it with the current blob sha.' : 'Existing files are updated in place.'}
                  </p>
                </>
              ) : null}

              {target === 'issue' ? (
                <>
                  <label className="gh-field">
                    <span>Repository</span>
                    <input
                      className="gh-input"
                      list="gh-repo-options"
                      value={repo}
                      placeholder="owner/repo"
                      onChange={(e) => setRepo(e.target.value)}
                    />
                  </label>
                  <label className="gh-field">
                    <span>Title</span>
                    <input className="gh-input" value={issueTitle} onChange={(e) => setIssueTitle(e.target.value)} />
                  </label>
                  <label className="gh-field">
                    <span>Body (Markdown)</span>
                    <textarea className="gh-input mono" rows={10} value={issueBody} onChange={(e) => setIssueBody(e.target.value)} />
                  </label>
                </>
              ) : null}

              {target === 'pr' ? (
                <>
                  <label className="gh-field">
                    <span>Repository</span>
                    <input
                      className="gh-input"
                      list="gh-repo-options"
                      value={repo}
                      placeholder="owner/repo"
                      onChange={(e) => setRepo(e.target.value)}
                    />
                  </label>
                  <div className="publish-grid">
                    <label className="gh-field">
                      <span>Merge into (base)</span>
                      <input
                        className="gh-input"
                        list="gh-branch-options"
                        value={branch}
                        placeholder="default branch"
                        onChange={(e) => setBranch(e.target.value)}
                      />
                      <datalist id="gh-branch-options">
                        {branches.map((b) => (
                          <option key={b.name} value={b.name} />
                        ))}
                      </datalist>
                    </label>
                    <label className="gh-field">
                      <span>From branch (head)</span>
                      <input
                        className="gh-input"
                        list="gh-branch-options"
                        value={prHead}
                        placeholder="branch with the changes"
                        onChange={(e) => setPrHead(e.target.value)}
                      />
                    </label>
                  </div>
                  <label className="gh-field">
                    <span>Title</span>
                    <input className="gh-input" value={issueTitle} onChange={(e) => setIssueTitle(e.target.value)} />
                  </label>
                  <label className="gh-field">
                    <span>Body (Markdown)</span>
                    <textarea className="gh-input mono" rows={10} value={issueBody} onChange={(e) => setIssueBody(e.target.value)} />
                  </label>
                  <label className="gh-check">
                    <input type="checkbox" checked={prDraft} onChange={(e) => setPrDraft(e.target.checked)} />
                    <span>Open as a draft <em className="gh-muted">(not ready for review yet)</em></span>
                  </label>
                  <p className="gh-muted">
                    The head branch must already exist — commit onto it first with <strong>Repo file</strong> →{' '}
                    <em>Commit onto a new branch instead</em>.
                  </p>
                </>
              ) : null}
            </div>

            {message ? <GhError>{message}</GhError> : null}

            <footer className="publish-foot">
              {!connected ? (
                <span className="gh-muted">
                  Not connected — <button className="link-btn" onClick={() => useUI.getState().openSettings('github')} type="button">configure GitHub</button>
                </span>
              ) : (
                <span className="gh-muted">
                  as @{login}
                  {scopes.length ? ` · ${scopes.join(', ')}` : ''}
                </span>
              )}
              <div className="gh-row">
                <button className="btn ghost small" onClick={close} type="button">
                  Cancel
                </button>
                <button className="btn primary small" onClick={() => void submit()} disabled={busy || publishing || !connected} type="button">
                  {busy || publishing ? <Spinner label={publishStep ?? 'publishing…'} /> : <><IconUpload size={12} /> {target === 'gist' ? 'Create gist' : target === 'file' ? 'Commit file' : target === 'pr' ? 'Open pull request' : 'Open issue'}</>}
                </button>
              </div>
            </footer>
            {publishError ? (
              <button className="link-btn" onClick={dismissPublishError} type="button">
                Dismiss
              </button>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  )
}

function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(out)
}
