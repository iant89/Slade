import { useState } from 'react'
import { Modal } from '../common/Modal'
import { useGitHub } from '../../store/github'
import { IconBranch, IconCheck, IconExternal, IconGitMerge, IconRefresh } from '../icons'
import type { MergeResult } from '../../lib/github'
import { GhError, Spinner } from './bits'

/**
 * Merge one branch of the open repository into another.
 *
 * The target is the branch currently being browsed — merging into it is the
 * common "fold my work back in" move, and the file tree can be refreshed
 * right after because it follows the open branch.
 */
export function MergeBranchDialog({ onClose }: { onClose: () => void }) {
  const { activeRepo, activeBranch, branches, branchesLoading, merging, mergeError } = useGitHub()
  const mergeBranch = useGitHub((s) => s.mergeBranch)
  const refreshBranches = useGitHub((s) => s.refreshBranches)

  const [head, setHead] = useState('')
  const [message, setMessage] = useState('')
  const [result, setResult] = useState<MergeResult | null>(null)

  const others = branches.filter((b) => b.name !== activeBranch)
  const source = head || others[0]?.name || ''
  const sourceSha = branches.find((b) => b.name === source)?.commit.sha

  const submit = async () => {
    if (!source) return
    const res = await mergeBranch({ head: source, base: activeBranch, message })
    if (res) setResult(res)
  }

  if (!activeRepo || !activeBranch) return null

  return (
    <Modal open onClose={onClose} labelledBy="merge-title">
      <div className="gh-dialog">
        <header className="gh-dialog-head">
          <h2 id="merge-title">
            <IconGitMerge size={15} /> Merge branches
          </h2>
          <p className="gh-muted">{activeRepo}</p>
        </header>

        {result ? (
          <div className="publish-result" role="status">
            <div className="publish-result-line">
              <IconCheck size={15} />
              <span>
                {result.merged ? (
                  <>
                    Merged <strong>{source}</strong> into <strong>{activeBranch}</strong>
                  </>
                ) : (
                  <>{result.message}</>
                )}
              </span>
            </div>
            <div className="gh-row">
              <a className="btn primary small" href={result.htmlUrl} target="_blank" rel="noreferrer">
                <IconExternal size={12} /> {result.merged ? 'Open the merge commit' : 'Open the branch'}
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
                    aria-label="Branch to merge from"
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
                    No other branches to merge from. Create one with <strong>Commit onto a new branch</strong> when
                    publishing, or on GitHub.
                  </p>
                )}
              </label>
              {sourceSha ? (
                <p className="gh-muted gh-merge-sha">
                  <IconBranch size={11} /> {source} is at <code>{sourceSha.slice(0, 7)}</code>
                </p>
              ) : null}
              <label className="gh-field">
                <span>
                  Commit message <em className="gh-muted">(optional — GitHub proposes one)</em>
                </span>
                <input
                  className="gh-input"
                  value={message}
                  placeholder={`Merge ${source || 'branch'} into ${activeBranch}`}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </label>
              {mergeError ? <GhError>{mergeError}</GhError> : null}
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
                disabled={merging || !source}
                type="button"
              >
                {merging ? 'Merging…' : `Merge into ${activeBranch}`}
              </button>
            </footer>
          </>
        )}
      </div>
    </Modal>
  )
}
