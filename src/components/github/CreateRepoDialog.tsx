import { useState } from 'react'
import { Modal } from '../common/Modal'
import { useGitHub } from '../../store/github'
import { useUI } from '../../store/ui'
import { IconCheck, IconExternal, IconGithub, IconLock, IconRepo } from '../icons'
import { GhError } from './bits'

/**
 * Create a repository under the signed-in account.
 *
 * "Initialize with a README" is on by default: a repository with no commits
 * has no tree to browse, so the Files tab would open empty.
 */
export function CreateRepoDialog({ onClose }: { onClose: () => void }) {
  const login = useGitHub((s) => s.login)
  const createRepo = useGitHub((s) => s.createRepo)
  const creating = useGitHub((s) => s.creatingRepo)
  const error = useGitHub((s) => s.createRepoError)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isPrivate, setIsPrivate] = useState(true)
  const [autoInit, setAutoInit] = useState(true)
  const [created, setCreated] = useState<string | null>(null)

  const submit = async () => {
    const repo = await createRepo({ name, description, private: isPrivate, autoInit })
    if (repo) setCreated(repo.full_name || repo.name)
  }

  const browse = async () => {
    if (!created) return
    const ok = await useGitHub.getState().openRepo(created)
    if (ok) useUI.getState().setGithubTab('files')
    onClose()
  }

  return (
    <Modal open onClose={onClose} labelledBy="create-repo-title">
      <div className="gh-dialog">
        <header className="gh-dialog-head">
          <h2 id="create-repo-title">
            <IconRepo size={15} /> New repository
          </h2>
          <p className="gh-muted">{login ? `Created under @${login}` : 'Sign in to create a repository'}</p>
        </header>

        {created ? (
          <div className="publish-result" role="status">
            <div className="publish-result-line">
              <IconCheck size={15} />
              <span>
                Created <strong>{created}</strong>
              </span>
            </div>
            <div className="gh-row">
              <a className="btn primary small" href={`https://github.com/${created}`} target="_blank" rel="noreferrer">
                <IconExternal size={12} /> Open on GitHub
              </a>
              <button className="btn ghost small" onClick={() => void browse()} type="button">
                <IconGithub size={12} /> Browse its files
              </button>
              <button className="btn ghost small" onClick={onClose} type="button">
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="gh-dialog-body">
              <label className="gh-field">
                <span>Name</span>
                <input
                  className="gh-input"
                  value={name}
                  placeholder="my-project"
                  spellCheck={false}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && name.trim() && !creating) void submit()
                  }}
                />
              </label>
              <label className="gh-field">
                <span>
                  Description <em className="gh-muted">(optional)</em>
                </span>
                <input className="gh-input" value={description} onChange={(e) => setDescription(e.target.value)} />
              </label>
              <label className="gh-check">
                <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
                <span>
                  <IconLock size={11} /> Private <em className="gh-muted">(unchecked = anyone on GitHub can see it)</em>
                </span>
              </label>
              <label className="gh-check">
                <input type="checkbox" checked={autoInit} onChange={(e) => setAutoInit(e.target.checked)} />
                <span>
                  Initialize with a README <em className="gh-muted">(an empty repository has no files to browse yet)</em>
                </span>
              </label>
              {error ? <GhError>{error}</GhError> : null}
            </div>
            <footer className="gh-dialog-foot">
              <button className="btn ghost small" onClick={onClose} type="button">
                Cancel
              </button>
              <button
                className="btn primary small"
                onClick={() => void submit()}
                disabled={creating || !name.trim()}
                type="button"
              >
                {creating ? 'Creating…' : 'Create repository'}
              </button>
            </footer>
          </>
        )}
      </div>
    </Modal>
  )
}
