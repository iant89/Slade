import { useEffect } from 'react'
import { useGitHub, canGist, canWriteRepos } from '../../store/github'
import { useUI } from '../../store/ui'
import { formatCount } from '../../lib/format'
import { ConnectCard } from './ConnectCard'
import { RepoBrowser } from './RepoBrowser'
import { FileBrowser } from './FileBrowser'
import { CodeSearch } from './CodeSearch'
import { IconGithub, IconRepo, IconSearch, IconUpload, IconX } from '../icons'

function RateFooter() {
  const { rate } = useGitHub()
  const openSettings = useUI((s) => s.openSettings)
  if (!rate) {
    return (
      <p className="gh-foot-note">
        Slade talks straight to api.github.com ·{' '}
        <button className="link-btn" onClick={() => openSettings('github')} type="button">
          GitHub settings
        </button>
      </p>
    )
  }
  const resets = new Date(rate.resetAt)
  return (
    <p className="gh-foot-note">
      API budget {formatCount(rate.remaining)}/{formatCount(rate.limit)} · resets{' '}
      {resets.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ·{' '}
      <button className="link-btn" onClick={() => openSettings('github')} type="button">
        settings
      </button>
    </p>
  )
}

/**
 * The GitHub context workspace: browse repos, read and search files, attach
 * them to the next prompt, and publish answers back out as gists, commits or
 * issues.
 *
 * Deliberately a drawer rather than a modal: it can stay open while you type,
 * because attaching a file only queues it in the composer.
 */
export function GitHubPanel() {
  const open = useUI((s) => s.githubOpen)
  const tab = useUI((s) => s.githubTab)
  const close = useUI((s) => s.closeGithub)
  const closeAndFocus = () => {
    close()
    document.querySelector<HTMLButtonElement>('[data-panel-toggle="github"]')?.focus()
  }
  const setTab = useUI((s) => s.setGithubTab)
  const { login, avatarUrl, token, authStatus } = useGitHub()
  const connectWithToken = useGitHub((s) => s.connectWithToken)
  const scopes = useGitHub((s) => s.scopes)
  const publishDefaults = useGitHub((s) => s.publishDefaults)

  const connected = authStatus === 'authorized' && Boolean(login)

  // A token restored from storage without a profile gets verified once, so a
  // revoked token is caught here rather than mid-publish.
  useEffect(() => {
    if (open && token && !login && authStatus !== 'connecting') void connectWithToken(token)
  }, [open, token, login, authStatus, connectWithToken])

  if (!open) return null

  const tabs = [
    { id: 'repos' as const, label: 'Repos', icon: <IconRepo size={13} /> },
    { id: 'files' as const, label: 'Files', icon: <IconUpload size={13} /> },
    { id: 'search' as const, label: 'Search', icon: <IconSearch size={13} /> },
  ]

  return (
    <>
      <div className="gh-drawer-backdrop only-mobile" onClick={closeAndFocus} aria-hidden="true" />
      <aside className="github-drawer" aria-label="GitHub workspace">
        <header className="gh-head">
          <h2>
            <IconGithub size={14} /> GitHub
          </h2>
          {connected ? (
            <span className="gh-identity" title={`Connected to GitHub as @${login}`}>
              {avatarUrl ? <img src={avatarUrl} alt="" width={18} height={18} /> : null}
              <span>@{login}</span>
            </span>
          ) : null}
          <button className="icon-btn" onClick={closeAndFocus} aria-label="Close GitHub workspace" type="button">
            <IconX size={16} />
          </button>
        </header>

        <nav className="gh-tabs" role="tablist" aria-label="GitHub workspace sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`gh-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
              type="button"
            >
              {t.icon} {t.label}
            </button>
          ))}
        </nav>

        <div className="gh-tabpanel" role="tabpanel" aria-label={`${tab} panel`}>
          {tab === 'repos' ? (
            <>
              {!connected ? <ConnectCard /> : null}
              <RepoBrowser />
            </>
          ) : null}
          {tab === 'files' ? <FileBrowser /> : null}
          {tab === 'search' ? <CodeSearch /> : null}
        </div>

        <footer className="gh-foot">
          {connected && scopes.length > 0 && !canWriteRepos(scopes) ? (
            <p className="gh-warn">
              This token can&rsquo;t commit or open issues (missing <code>repo</code>) —{' '}
              <button className="link-btn" onClick={() => useUI.getState().openSettings('github')} type="button">
                reconnect with more scopes
              </button>
              .
            </p>
          ) : null}
          {connected && scopes.length > 0 && !canGist(scopes) ? (
            <p className="gh-warn">
              Gists are off — this token has no <code>gist</code> scope.
            </p>
          ) : null}
          {connected ? (
            <p className="gh-foot-note">
              Publish anything from the thread: use <strong>Publish to GitHub</strong> on an artifact card or a message.
              {publishDefaults.repo ? (
                <>
                  {' '}
                  Default target: <strong>{publishDefaults.repo}</strong>
                </>
              ) : null}
            </p>
          ) : null}
          <RateFooter />
        </footer>
      </aside>
    </>
  )
}
