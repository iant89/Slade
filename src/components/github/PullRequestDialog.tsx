import { useState } from 'react'
import { Modal } from '../common/Modal'
import { useGitHub } from '../../store/github'
import { useUI } from '../../store/ui'
import type { PublishResult } from '../../lib/github-publish'
import { IconBranch, IconCheck, IconExternal, IconRefresh, IconUpload } from '../icons'
import { GhError, Spinner } from './bits'

/**
 * Open a pull request from another branch into the one being browsed.
 *
 * The content of a PR lives in its commits, so this dialog only proposes the
 * merge: pick the head branch, give it a title (defaults to the branch name)
 * and an optional summary. Committing first happens via *Pull to Local Files*
 * + the commit action, or Publish → Repo file → *Commit onto a new branch*.
 */
export function PullRequestDialog({ onClose }: { onClose: () => void }) {
  const { activeRepo, activeBranch, branches, branchesLoading, publishing, publishError } = useGitHub()
  const publish = useGitHub((s) => s.publish)
  const refreshBranches = useGitHub((s) => s.refreshBranches)

  const [head, setHead] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  const [result, setResult] = useState<PublishResult | null>(null)

  const others = branches.filter((b) => b.name !== activeBranch)
  const source = head || others[0]?.name || ''
  const sourceSha = branches.find((b) => b.name === source)?.commit.sha

  const submit = async () => {
    if (!source) return
    const res = await publish({
      target: 'pr',
      // Unused for pull requests; kept for the request shape.
      name: source,
      repo: activeRepo,
      branch: activeBranch,
      head: source,
      title: title.trim() || source,
      body: body.trim() || undefined,
      draft,
    })
    if (res) {
      setResult(res)
      useUI.getState().toast({ kind: 'success', title: `Opened ${res.label}`, detail: res.detail })
    }
  }

  if (!activeRepo || !activeBranch) return null

  return (
    <Modal open onClose={onClose} labelledBy="pr-title">
      <div className="gh-dialog">
        <header className="gh-dialog-head">
          <h2 id="pr-title">
            <IconUpload size={15} /> Open a pull request
          </h2>
          <p className="gh-muted">{activeRepo}</p>
        </header>

        {result ? (
          <div className="publish-result" role="status">
            <div className="publish-result-line">
              <IconCheck size={15} />
              <span>
                Opened <strong>{result.label}</strong>
                {result.detail ? <em> — {result.detail}</em> : null}
              </span>
            </div>
            <div className="gh-row">
              <a className="btn primary small" href={result.url} target="_blank" rel="noreferrer">
                <IconExternal size={12} /> Open on GitHub
              </a>
              <button className="btn ghost small" onClick={onClose} type="button">
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="gh-dialog-body">
              <label className="gh-field">
                <span>Into</span>
                <input className="gh-input" value={activeBranch} readOnly title={`${activeBranch} (the branch you have open)`} />
              </label>
              <label className="gh-field">
                <span>From</span>
                {others.length > 0 ? (
                  <select
                    className="gh-select"
                    value={source}
                    aria-label="Branch with the changes"
                    onChange={(e) => setHead(e.target.value)}
                  >
                    {others.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="gh-muted">
                    No other branches yet — commit onto a new branch first, then come back to open the pull request.
                  </p>
                )}
              </label>
              {sourceSha ? (
                <p className="gh-muted gh-merge-sha">
                  <IconBranch size={11} /> {source} is at <code>{sourceSha.slice(0, 7)}</code>
                </p>
              ) : null}
              <label className="gh-field">
                <span>Title</span>
                <input
                  className="gh-input"
                  value={title}
                  placeholder={source || 'What does this branch change?'}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label className="gh-field">
                <span>
                  Body <em className="gh-muted">(optional, Markdown)</em>
                </span>
                <textarea
                  className="gh-input mono"
                  rows={6}
                  value={body}
                  placeholder="What changed, and why?"
                  onChange={(e) => setBody(e.target.value)}
                />
              </label>
              <label className="gh-check">
                <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
                <span>Open as a draft <em className="gh-muted">(not ready for review yet)</em></span>
              </label>
              {publishError ? <GhError>{publishError}</GhError> : null}
            </div>
            <footer className="gh-dialog-foot">
              {branchesLoading ? <Spinner /> : null}
              <button className="btn ghost small" onClick={() => void refreshBranches()} type="button">
                <IconRefresh size={12} /> Reload branches
              </button>
              <button className="btn ghost small" onClick={onClose} type="button">
                Cancel
              </button>
              <button
                className="btn primary small"
                onClick={() => void submit()}
                disabled={publishing || !source}
                type="button"
              >
                {publishing ? 'Opening…' : 'Open pull request'}
              </button>
            </footer>
          </>
        )}
      </div>
    </Modal>
  )
}
