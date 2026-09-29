import { useMemo, useState } from 'react'
import { useGitHub, repoShortName } from '../../store/github'
import { useUI } from '../../store/ui'
import { formatCount } from '../../lib/format'
import { CreateRepoDialog } from './CreateRepoDialog'
import { GhEmpty, GhError, Spinner } from './bits'
import { IconGithub, IconLock, IconPlus, IconRefresh, IconRepo, IconSearch, IconStar } from '../icons'

function updatedLabel(iso: string | null): string {
  if (!iso) return ''
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.round(days / 30)}mo ago`
  return `${Math.round(days / 365)}y ago`
}

/** Repos tab: pick the repository whose files become context. */
export function RepoBrowser() {
  const { repos, reposLoading, reposError, repoFilter, recentRepos, activeRepo, login, token } = useGitHub()
  const setRepoFilter = useGitHub((s) => s.setRepoFilter)
  const loadRepos = useGitHub((s) => s.loadRepos)
  const openRepo = useGitHub((s) => s.openRepo)
  const [manual, setManual] = useState('')
  const [creating, setCreating] = useState(false)

  const filtered = useMemo(() => {
    const q = repoFilter.trim().toLowerCase()
    const list = q
      ? repos.filter(
          (r) =>
            r.full_name.toLowerCase().includes(q) ||
            (r.description ?? '').toLowerCase().includes(q) ||
            (r.language ?? '').toLowerCase().includes(q),
        )
      : repos
    return [...list].sort((a, b) => Number(a.archived) - Number(b.archived))
  }, [repos, repoFilter])

  return (
    <div className="gh-tab-body">
      <label className="gh-field">
        <span>Open any repository</span>
        <div className="gh-row">
          <input
            className="gh-input"
            value={manual}
            placeholder="owner/repo or https://github.com/owner/repo"
            spellCheck={false}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && manual.trim()) {
                void openRepo(manual).then((ok) => {
                  if (ok) {
                    setManual('')
                    useUI.getState().setGithubTab('files')
                  }
                })
              }
            }}
          />
          <button
            className="btn primary small"
            disabled={!manual.trim()}
            onClick={async () => {
              const ok = await openRepo(manual)
              if (ok) {
                setManual('')
                useUI.getState().setGithubTab('files')
              }
            }}
            type="button"
          >
            Open
          </button>
        </div>
      </label>
      {!login ? (
        <p className="gh-muted">
          Public repositories open fine without signing in (GitHub allows 60 anonymous API calls an hour). Sign in to
          browse private repos and to publish.
        </p>
      ) : null}

      {recentRepos.length > 0 ? (
        <div className="gh-section">
          <h3>Recent</h3>
          <div className="gh-pills">
            {recentRepos.map((r) => (
              <button
                key={r}
                className={`gh-pill${activeRepo === r ? ' active' : ''}`}
                onClick={() => void openRepo(r).then((ok) => ok && useUI.getState().setGithubTab('files'))}
                type="button"
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {login ? (
        <div className="gh-section">
          <div className="gh-section-head">
            <h3>Your repositories</h3>
            <div className="gh-head-actions">
              <button
                className="icon-btn small"
                onClick={() => setCreating(true)}
                aria-label="Create a repository"
                title="New repository"
                type="button"
              >
                <IconPlus size={13} />
              </button>
              <button
                className="icon-btn small"
                onClick={() => void loadRepos({ force: true })}
                aria-label="Refresh repositories"
                title="Refresh"
                type="button"
              >
                <IconRefresh size={13} />
              </button>
            </div>
          </div>
          <div className="gh-search-inline">
            <IconSearch size={13} />
            <input
              className="gh-input"
              value={repoFilter}
              placeholder="Filter by name, language or description"
              aria-label="Filter repositories"
              onChange={(e) => setRepoFilter(e.target.value)}
            />
          </div>

          {reposLoading ? <Spinner label="Loading your repositories…" /> : null}
          {reposError ? <GhError onRetry={() => void loadRepos({ force: true })}>{reposError}</GhError> : null}

          {!reposLoading && !reposError && repos.length === 0 ? (
            <GhEmpty title="No repositories" detail="Nothing came back for this token — does it have the repo scope?" icon={<IconRepo size={20} />} />
          ) : null}

          <ul className="gh-repo-list">
            {filtered.slice(0, 200).map((r) => (
              <li key={r.full_name}>
                <button
                  className={`gh-repo${activeRepo === r.full_name ? ' active' : ''}`}
                  onClick={() => void openRepo(r.full_name).then((ok) => ok && useUI.getState().setGithubTab('files'))}
                  type="button"
                >
                  <span className="gh-repo-top">
                    <strong>{r.owner.login}/</strong>
                    <span className="gh-repo-name">{r.name}</span>
                    {r.private ? <IconLock size={11} /> : null}
                    {r.archived ? <em className="gh-tag">archived</em> : null}
                  </span>
                  <span className="gh-repo-sub">
                    {r.language ? <span>{r.language}</span> : null}
                    {r.stargazers_count > 0 ? (
                      <span>
                        <IconStar size={10} /> {formatCount(r.stargazers_count)}
                      </span>
                    ) : null}
                    {r.pushed_at ? <span>updated {updatedLabel(r.pushed_at)}</span> : null}
                    <span className="gh-muted">default: {r.default_branch}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {filtered.length > 200 ? <p className="gh-muted">Showing 200 of {filtered.length} — narrow the filter.</p> : null}
          {!reposLoading && repos.length > 0 && filtered.length === 0 ? (
            <GhEmpty title="No matches" detail={`Nothing in your repositories matches “${repoFilter}”.`} icon={<IconGithub size={18} />} />
          ) : null}
        </div>
      ) : null}
      {!login && token ? <p className="gh-muted">Using a stored token for {repoShortName(activeRepo)}.</p> : null}
      {creating ? <CreateRepoDialog onClose={() => setCreating(false)} /> : null}
    </div>
  )
}
