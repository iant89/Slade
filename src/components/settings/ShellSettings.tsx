import { useState } from 'react'
import { checkShell, useShell } from '../../lib/shell'
import { SectionTitle } from '../common/controls'

export function ShellSettings() {
  const shell = useShell()
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <section>
      <SectionTitle>Automatic bash execution</SectionTitle>
      <p className="settings-intro-hint">
        Optional local backend. Connected agents execute commands without approval, with the host user’s full permissions—not a sandbox.
        Use a dedicated checkout or container. When connected, Files and agent edits use that checkout too. Existing browser files stay untouched; copy them with Files → Import browser files. Disconnect to return to browser storage.
        Connection credentials remain in memory and are cleared on reload. Use the chat Stop button to cancel a running command.
      </p>
      {shell.token ? (
        <div>
          <p role="status">Connected · {shell.root} · automatic execution enabled</p>
          <button className="btn" type="button" onClick={() => { if (window.confirm("Disconnect disk and bash? Unsaved disk editor drafts will be discarded. Use Stop first for any active command.")) shell.disconnect() }}>Disconnect disk & bash</button>
        </div>
      ) : (
        <form onSubmit={async (event) => {
          event.preventDefault()
          setBusy(true)
          setError('')
          try {
            const root = await checkShell(token)
            shell.connect(token, root)
            setToken('')
          } catch (cause) { setError(cause instanceof Error ? cause.message : 'Connection failed.') }
          finally { setBusy(false) }
        }}>
          <label htmlFor="shell-token">Shell backend token</label>
          <input id="shell-token" className="input" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="SLADE_SHELL_TOKEN" required minLength={32} disabled={busy} />
          <button className="btn" type="submit" disabled={busy || token.length < 32}>{busy ? 'Connecting…' : 'Connect & enable automatic execution'}</button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </section>
  )
}
