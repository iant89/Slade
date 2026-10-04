import { useEffect, useMemo, useState } from 'react'
import { canWriteRepos, useGitHub } from '../../store/github'
import { Spinner } from './bits'
import { IconGitMerge } from '../icons'

/* ------------------------------------------------------------------ */
/* Open a pull request                                                 */
/*                                                                     */
/* A button that sits with the branch picker: the branch being         */
/* browsed is the head, the chosen branch is the base, and opening it  */
/* goes through the store — so the pull request lands in the chat as   */
/* its own card, which is where it is read and merged.                 */
/*                                                                     */
/* The form is inline rather than a dialog: it is one title, one       */
/* sentence and a target, and the drawer can stay open while it is     */
/* filled in.                                                          */
/* ------------------------------------------------------------------ */

export function OpenPullRequestButton() {
  const activeRepo = useGitHub((s) => s.activeRepo)
  const activeBranch = useGitHub((s) => s.activeBranch)
  const branches = useGitHub((s) => s.branches)
  const repos = useGitHub((s) => s.repos)
  const token = useGitHub((s) => s.token)
  const scopes = useGitHub((s) => s.scopes)
  const openPullRequest = useGitHub((s) => s.openPullRequest)

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [base, setBase] = useState('')

  const head = activeBranch ?? ''
  const defaultBranch = repos.find((r) => r.full_name === activeRepo)?.default_branch
  const writable = canWriteRepos(scopes)

  const branchNames = useMemo(() => {
    const names = branches.map((b) => b.name)
    // The branch being browsed is always in the list even before the branch
    // request lands, and the default branch goes first — it is the usual base.
    const all = [defaultBranch, ...names, head].filter((b): b is string => Boolean(b))
    return [...new Set(all)].sort((a, b) => Number(b === defaultBranch) - Number(a === defaultBranch) || a.localeCompare(b))
  }, [branches, defaultBranch, head])

  // The first time there is a default branch, it becomes the target.
  useEffect(() => {
    if (!base && defaultBranch) setBase(defaultBranch)
  }, [base, defaultBranch])

  // A pull request needs two different branches; on the base branch there is
  // nothing to merge yet, and saying so beats a failure from GitHub.
  const sameBranch = Boolean(head) && head === base
  const ready = Boolean(activeRepo) && Boolean(head) && Boolean(base) && !sameBranch
  const canSubmit = ready && Boolean(title.trim()) && !busy

  const start = () => {
    if (!title.trim()) setTitle(head ? `Slade: changes on ${head}` : '')
    setOpen(true)
  }

  const stop = () => {
    setOpen(false)
    setBody('')
  }

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    const res = await openPullRequest({
      repo: activeRepo,
      title: title.trim(),
      head,
      base,
      body: body.trim() || undefined,
    })
    setBusy(false)
    // The card in the chat is the confirmation; the form steps aside for it.
    if (res) stop()
  }

  // Nothing to offer to a browser without a token that can push.
  if (!token || scopes.length === 0) return null

  return (
    <div className="gh-pr-open-wrap">
      <button
        className="btn ghost small"
        onClick={open ? stop : start}
        disabled={!writable || !activeRepo || !head}
        aria-expanded={open}
        title={
          !writable
            ? 'This token cannot open pull requests (missing the repo scope)'
            : !activeRepo || !head
              ? 'Open a repository and a branch first'
              : `Open a pull request from ${head}`
        }
        type="button"
      >
        <IconGitMerge size={12} /> Open pull request
      </button>

      {open ? (
        <div className="gh-pr-form">
          <div className="gh-pr-form-head">
            <strong>Open a pull request</strong>
            <span className="gh-muted">
              {head || 'no branch'} → {base || 'no target'}
            </span>
          </div>

          <label className="gh-field">
            <span>Into (base branch)</span>
            <select className="gh-select" value={base} onChange={(e) => setBase(e.target.value)} aria-label="Base branch">
              {branchNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <label className="gh-field">
            <span>Title</span>
            <input
              className="gh-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What does this change?"
              spellCheck={false}
            />
          </label>

          <label className="gh-field">
            <span>Description (optional)</span>
            <textarea
              className="gh-input gh-textarea"
              value={body}
              rows={3}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Why the change, and anything a reviewer should know."
            />
          </label>

          {sameBranch ? (
            <p className="gh-muted">
              You are on <code>{base}</code> — switch to the branch carrying your changes, then open the pull request from there.
            </p>
          ) : null}

          <div className="gh-row">
            <button className="btn primary small" onClick={() => void submit()} disabled={!canSubmit} type="button">
              {busy ? <Spinner /> : <IconGitMerge size={12} />} Open pull request
            </button>
            <button className="btn ghost small" onClick={stop} type="button">
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
