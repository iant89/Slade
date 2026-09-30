import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { useCurrentConversation, useChat, MAX_TITLE_LENGTH } from '../../store/chat'
import { useSettings } from '../../store/settings'
import { useHealth } from '../../store/health'
import { useGitHub } from '../../store/github'
import { useFs } from '../../store/fs'
import { useUI } from '../../store/ui'
import type { MenuAnchor } from '../../lib/menuPlacement'
import { RenameInput } from '../common/RenameInput'
import { ConversationMenu, type ConversationMenuState } from './ConversationMenu'
import { IconChevronDown, IconFolder, IconGear, IconGithub, IconPanelLeft, IconPanelRight, IconPlus } from '../icons'

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
  const sidebarOpen = useUI((s) => s.sidebarOpen)
  const toggleSidebar = useUI((s) => s.toggleSidebar)
  const toggleRail = useUI((s) => s.toggleRail)
  const railOpen = useUI((s) => s.railOpen)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [menu, setMenu] = useState<ConversationMenuState | null>(null)
  const titleRef = useRef<HTMLButtonElement>(null)
  const convId = conv?.id
  // A rename belongs to the conversation it started on. Deriving this from the id (rather
  // than a plain flag) ends the edit in the very render that switches chats, so the field
  // is never on screen carrying the next chat's handlers.
  const editing = editingId !== null && editingId === convId

  // Nothing half-done follows you to another conversation, or waits for you to come back.
  useEffect(() => {
    setMenu(null)
    setEditingId(null)
  }, [convId])

  const commitTitle = (id: string, title: string) => {
    // Blank or unchanged text is ignored by the store.
    useChat.getState().renameConversation(id, title)
    setEditingId((cur) => (cur === id ? null : cur))
  }

  const openMenu = (anchor: MenuAnchor) => {
    if (conv && titleRef.current) setMenu({ convId: conv.id, anchor, opener: titleRef.current })
  }

  // A click on the name toggles the menu (it hangs off the button, below it).
  const toggleMenu = () => {
    if (menu) return setMenu(null)
    const btn = titleRef.current
    if (btn) openMenu({ kind: 'rect', rect: btn.getBoundingClientRect(), align: 'start' })
  }

  // Right-click gives the same menu, at the pointer.
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    openMenu({ kind: 'point', x: e.clientX, y: e.clientY })
  }

  return (
    <header className="header">
      <div className="header-left">
        <button className="icon-btn" onClick={toggleSidebar} aria-label="Toggle conversations" aria-pressed={sidebarOpen} title="Toggle conversations (Ctrl+J)" type="button">
          <IconPanelLeft size={17} />
        </button>
        {/* Floating new-chat button for when the sidebar is collapsed. */}
        <button
          className="icon-btn header-new-chat"
          onClick={() => useChat.getState().newConversation()}
          aria-label="Start a new chat"
          title="New chat"
          type="button"
        >
          <IconPlus size={17} />
        </button>
        {editing && conv ? (
          <RenameInput
            className="header-title-input"
            initial={conv.title}
            label="Conversation title"
            maxLength={MAX_TITLE_LENGTH}
            onSubmit={(value) => commitTitle(conv.id, value)}
            onCancel={() => setEditingId(null)}
          />
        ) : conv ? (
          <button
            ref={titleRef}
            type="button"
            className={`header-title-btn${menu ? ' open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={Boolean(menu)}
            aria-label={`Conversation options: ${conv.title}`}
            title="Rename or archive · double-click to rename"
            onClick={toggleMenu}
            // Two clicks toggle the menu open and shut again; the double-click then renames.
            onDoubleClick={() => {
              setMenu(null)
              setEditingId(conv.id)
            }}
            onContextMenu={onContextMenu}
          >
            <span className="header-title">{conv.title}</span>
            {conv.archived ? <span className="header-badge">Archived</span> : null}
            <IconChevronDown size={13} className="header-title-caret" />
          </button>
        ) : (
          <span className="header-title">Slade</span>
        )}
      </div>
      <div className="header-right">
        <HealthStrip />
        <FilesButton />
        <GitHubButton />
        <button
          className="icon-btn"
          onClick={toggleRail}
          aria-label="Toggle model chain panel"
          aria-pressed={railOpen}
          title="Model chain panel"
          type="button"
        >
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
      {menu && <ConversationMenu state={menu} onRename={setEditingId} onClose={() => setMenu(null)} />}
    </header>
  )
}
