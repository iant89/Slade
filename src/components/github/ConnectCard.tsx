import { useEffect, useRef, useState } from 'react'
import { useGitHub } from '../../store/github'
import { useUI } from '../../store/ui'
import { copyText } from '../../lib/clipboard'
import { SCOPES_HELP, DEFAULT_SCOPE } from '../../lib/github-auth'
import { GhError, ScopeChip, Spinner } from './bits'
import { IconCheck, IconExternal, IconGithub, IconKey, IconLock } from '../icons'

/**
 * Connect GitHub.
 *
 * Primary path is the OAuth **device flow**: Slade asks GitHub for a short code,
 * you type it on github.com, and the token comes back — no client secret, no
 * redirect URI, nothing secret in the browser. github.com does not allow those
 * two calls cross-origin, so they go through the bundled relay (or your own
 * deployed one — see Settings → GitHub).
 *
 * A pasted personal access token is offered as an explicit fallback for people
 * who would rather not run a relay at all.
 */
export function ConnectCard() {
  const { clientId, device, authStatus, authError, login, avatarUrl, scopes, scope, setClientId } = useGitHub()
  const startSignIn = useGitHub((s) => s.startSignIn)
  const cancelSignIn = useGitHub((s) => s.cancelSignIn)
  const connectWithToken = useGitHub((s) => s.connectWithToken)
  const signOut = useGitHub((s) => s.signOut)
  const toast = useUI((s) => s.toast)
  const openSettings = useUI((s) => s.openSettings)

  const [draftClientId, setDraftClientId] = useState(clientId)
  const [tokenDraft, setTokenDraft] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [, tick] = useState(0)
  const codeRef = useRef<HTMLButtonElement>(null)

  // Keep the countdown/status line fresh while the user is authorizing.
  useEffect(() => {
    if (!device) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [device])

  useEffect(() => {
    setDraftClientId(clientId)
  }, [clientId])

  if (authStatus === 'authorized' && login) {
    return (
      <div className="gh-account">
        <div className="gh-account-main">
          {avatarUrl ? <img className="gh-avatar" src={avatarUrl} alt="" width={40} height={40} /> : <IconGithub size={28} />}
          <div className="gh-account-text">
            <strong>@{login}</strong>
            <span className="gh-muted">Connected · token stays in this browser</span>
          </div>
        </div>
        <div className="gh-scopes">
          {SCOPES_HELP.map((s) => (
            <ScopeChip key={s.scope} scope={s.scope} missing={scopes.length > 0 && !scopes.includes(s.scope)} />
          ))}
        </div>
        <div className="gh-row">
          <button className="btn ghost small" onClick={() => openSettings('github')} type="button">
            <IconKey size={12} /> GitHub settings
          </button>
          <button className="btn ghost small" onClick={() => signOut()} type="button">
            Sign out
          </button>
        </div>
      </div>
    )
  }

  if (device) {
    const secondsLeft = Math.max(0, Math.round((device.startedAt + device.expiresInSec * 1000 - Date.now()) / 1000))
    return (
      <div className="gh-device">
        <p className="gh-muted">
          Enter this code on GitHub to authorize Slade. It expires in {Math.floor(secondsLeft / 60)}:
          {String(secondsLeft % 60).padStart(2, '0')}.
        </p>
        <button
          ref={codeRef}
          className="gh-usercode"
          onClick={async () => {
            const ok = await copyText(device.userCode)
            toast({
              kind: ok ? 'success' : 'info',
              title: ok ? 'Code copied' : `Code: ${device.userCode}`,
              detail: 'Paste it on the GitHub page that just opened.',
            })
          }}
          title="Copy code"
          type="button"
        >
          {device.userCode}
        </button>
        <div className="gh-row">
          <a
            className="btn primary small"
            href={device.verificationUriComplete ?? device.verificationUri}
            target="_blank"
            rel="noreferrer"
          >
            <IconExternal size={12} /> Open github.com/login/device
          </a>
          <button className="btn ghost small" onClick={() => cancelSignIn()} type="button">
            Cancel
          </button>
        </div>
        <div className="gh-status">
          <Spinner label={device.status === 'slow_down' ? 'Slowing down to respect GitHub\u2019s poll limit…' : 'Waiting for you to approve…'} />
        </div>
      </div>
    )
  }

  return (
    <div className="gh-connect">
      {authError ? <GhError>{authError}</GhError> : null}

      {!clientId ? (
        <>
          <p className="gh-muted">
            Slade signs in with GitHub&rsquo;s <strong>device flow</strong> — no client secret, no callback URL, nothing
            secret in the browser. That needs one Client ID from an OAuth app you own:
          </p>
          <ol className="gh-steps">
            <li>
              <a href="https://github.com/settings/applications/new" target="_blank" rel="noreferrer">
                Create an OAuth app <IconExternal size={11} />
              </a>{' '}
              (name it anything; the callback URL is unused by device flow).
            </li>
            <li>
              Tick <strong>Enable Device Flow</strong> and save.
            </li>
            <li>Copy the <strong>Client ID</strong> — not the secret — and paste it below.</li>
          </ol>
          <div className="gh-row">
            <input
              className="gh-input mono"
              value={draftClientId}
              placeholder="Iv1.0123abcd… or Ov23li…"
              aria-label="GitHub OAuth app Client ID"
              spellCheck={false}
              onChange={(e) => setDraftClientId(e.target.value)}
            />
            <button
              className="btn primary small"
              disabled={!draftClientId.trim()}
              onClick={() => {
                setClientId(draftClientId)
                toast({ kind: 'success', title: 'Client ID saved', detail: 'Now sign in with GitHub.' })
              }}
              type="button"
            >
              Save
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="gh-row">
            <button className="btn primary" onClick={() => void startSignIn()} disabled={authStatus === 'connecting'} type="button">
              <IconGithub size={14} /> Sign in with GitHub
            </button>
            <button className="btn ghost small" onClick={() => openSettings('github')} type="button">
              Configure
            </button>
          </div>
          <p className="gh-muted">
            Requested scopes: <code>{scope || DEFAULT_SCOPE}</code>
          </p>
          {authStatus === 'connecting' ? <Spinner label="Asking GitHub for a code…" /> : null}
        </>
      )}

      <details className="gh-fallback" open={showToken}>
        <summary onClick={() => setShowToken((v) => !v)}>
          <IconLock size={12} /> Or paste a personal access token instead
        </summary>
        <p className="gh-muted">
          Works without any relay: create a token with the <code>repo</code>, <code>gist</code> and <code>read:user</code>{' '}
          scopes, paste it here, and it is stored in this browser only (never logged, never exported).
        </p>
        <div className="gh-row">
          <input
            className="gh-input mono"
            type="password"
            value={tokenDraft}
            placeholder="github_pat_… or ghp_…"
            aria-label="GitHub personal access token"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTokenDraft(e.target.value)}
          />
          <button
            className="btn ghost small"
            disabled={!tokenDraft.trim()}
            onClick={async () => {
              const ok = await connectWithToken(tokenDraft)
              if (ok) {
                setTokenDraft('')
                setShowToken(false)
              }
            }}
            type="button"
          >
            <IconCheck size={12} /> Connect
          </button>
        </div>
      </details>
    </div>
  )
}
