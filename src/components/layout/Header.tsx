import { useState } from 'react'
import { useCurrentConversation, useChat } from '../../store/chat'
import { useSettings } from '../../store/settings'
import { useHealth } from '../../store/health'
import { useGitHub } from '../../store/github'
import { useFs } from '../../store/fs'
import { useUI } from '../../store/ui'
import { IconFolder, IconGear, IconGithub, IconPanelLeft, IconPanelRight } from '../icons'

/** Local file system workspace toggle — shows a dot when files are stored. */
function FilesButton() {
  const open = useUI((s) => s.filesOpen)
  const toggleFiles = useUI((s) => s.toggleFiles)
  const fileCount = useFs((s) => Object.keys(s.files).length)

  return (
    <button
      className={`icon-btn gh-toggle fs-toggle${open ? ' active' : ''}`}
      onClick={toggleFiles}
      aria-pressed={open}
      aria-label={open ? 'Close the local file system' : 'Open the local file system (Ctrl+E)'}
      title={
        fileCount > 0
          ? `Local file system (Ctrl+E) — ${fileCount} file${fileCount === 1 ? '' : 's'} stored`
          : 'Local file system (Ctrl+E)'
      }
      type="button"
    >
      <IconFolder size={16} />
      {fileCount > 0 ? <span className="gh-toggle-dot" aria-hidden="true" /> : null}
    </button>
  )
}

/** GitHub workspace toggle — the dot means "connected". */
function GitHubButton() {
  const open = useUI((s) => s.githubOpen)
  const toggleGithub = useUI((s) => s.toggleGithub)
  const authStatus = useGitHub((s) => s.authStatus)
  const repos = useGitHub((s) => s.repos.length)
  const connected = authStatus === 'authorized'

  return (
    <button
      className={`icon-btn gh-toggle${open ? ' active' : ''}`}
      onClick={toggleGithub}
      aria-pressed={open}
      aria-label={open ? 'Close the GitHub workspace' : 'Open the GitHub workspace (Ctrl+G)'}
      title={connected ? `GitHub workspace (Ctrl+G) — ${repos} repos` : 'GitHub workspace (Ctrl+G)'}
      type="button"
    >
      <IconGithub size={16} />
      {connected ? <span className="gh-toggle-dot" aria-hidden="true" /> : null}
    </button>
  )
}

/** Tiny per-model health dots shown in the header. */
function HealthStrip() {
  const settings = useSettings((s) => s.s)
  const health = useHealth((s) => s.byModel)
  const enabled = settings.models.filter((m) => m.enabled).slice(0, 8)
  if (enabled.length === 0) return null
  return (
    <div className="health-strip" aria-label="Model health">
      {enabled.map((m) => {
        const h = health[m.id]
        const cooling = h?.cooldownUntil && h.cooldownUntil > Date.now()
        const state = !h || h.state === 'available' ? 'available' : cooling ? 'cooldown' : h.state
        const title = `${m.label}: ${state}${h?.lastError ? ` — ${h.lastError.message}` : ''}`
        return <span key={m.id} className={`state-dot ${state}`} title={title} aria-label={title} role="img" />
      })}
    </div>
  )
}

export function Header() {
  const conv = useCurrentConversation()
  const openSettings = useUI((s) => s.openSettings)
  const toggleSidebar = useUI((s) => s.toggleSidebar)
  const toggleRail = useUI((s) => s.toggleRail)
  const [editing, setEditing] = useState(false)

  const commitTitle = (title: string) => {
    if (conv && title.trim()) useChat.getState().renameConversation(conv.id, title.trim())
    setEditing(false)
  }

  return (
    <header className="header">
      <div className="header-left">
        <button className="icon-btn only-mobile" onClick={toggleSidebar} aria-label="Toggle conversations" type="button">
          <IconPanelLeft size={17} />
        </button>
        {editing && conv ? (
          <input
            className="header-title-input"
            defaultValue={conv.title}
            autoFocus
            aria-label="Conversation title"
            onBlur={(e) => commitTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTitle(e.currentTarget.value)
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <span className="header-title" onDoubleClick={() => conv && setEditing(true)} title="Double-click to rename">
            {conv?.title ?? 'Slade'}
          </span>
        )}
      </div>
      <div className="header-right">
        <HealthStrip />
        <FilesButton />
        <GitHubButton />
        <button className="icon-btn only-mobile" onClick={toggleRail} aria-label="Toggle model chain panel" type="button">
          <IconPanelRight size={17} />
        </button>
        <button
          className="icon-btn"
          onClick={() => openSettings()}
          aria-label="Open settings (Ctrl+,)"
          title="Settings (Ctrl+,)"
          type="button"
        >
          <IconGear size={17} />
        </button>
      </div>
    </header>
  )
}
