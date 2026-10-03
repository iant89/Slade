import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { MAX_TITLE_LENGTH, useChat } from '../../store/chat'
import { useUI } from '../../store/ui'
import { formatDateTime } from '../../lib/format'
import type { MenuAnchor } from '../../lib/menuPlacement'
import type { Conversation } from '../../types'
import { RenameInput } from '../common/RenameInput'
import { ConversationMenu, type ConversationMenuState } from './ConversationMenu'
import { IconChevronRight, IconMoreHorizontal, IconPlus, IconStarburst, IconTrash, IconX } from '../icons'

interface RowProps {
  conv: Conversation
  active: boolean
  renaming: boolean
  menuOpen: boolean
  onSelect: (id: string) => void
  /** `at` is set for a right-click (menu at the pointer); otherwise the menu drops from the ⋯ button. */
  onMenu: (id: string, opener: HTMLElement, at?: { x: number; y: number }) => void
  /** `title` is null when the edit was cancelled. */
  onRenamed: (id: string, title: string | null) => void
  onDelete: (id: string) => void
}

/**
 * One conversation. The row is a plain container with sibling buttons (select, options,
 * delete) rather than a `role="button"` wrapping other buttons: assistive technology
 * treats a button's children as presentational, which would hide the options button.
 */
const ConversationRow = memo(function ConversationRow({
  conv,
  active,
  renaming,
  menuOpen,
  onSelect,
  onMenu,
  onRenamed,
  onDelete,
}: RowProps) {
  const mainRef = useRef<HTMLButtonElement>(null)
  const cls = `conv-item${active ? ' active' : ''}${conv.archived ? ' archived' : ''}${menuOpen ? ' menu-open' : ''}`

  return (
    <div
      className={cls}
      onContextMenu={(e) => {
        // Keep the browser's own menu (cut / copy / paste) inside the rename field.
        if (renaming || (e.target as HTMLElement).closest('input')) return
        e.preventDefault()
        onMenu(conv.id, mainRef.current ?? e.currentTarget, { x: e.clientX, y: e.clientY })
      }}
    >
      {renaming ? (
        <div className="conv-main conv-main-edit">
          <RenameInput
            className="conv-rename-input"
            initial={conv.title}
            label="Conversation name"
            maxLength={MAX_TITLE_LENGTH}
            onSubmit={(value) => onRenamed(conv.id, value)}
            onCancel={() => onRenamed(conv.id, null)}
          />
          <span className="conv-time">{formatDateTime(conv.updatedAt)}</span>
        </div>
      ) : (
        <button
          ref={mainRef}
          type="button"
          className="conv-main"
          aria-current={active ? 'true' : undefined}
          onClick={() => onSelect(conv.id)}
        >
          <span className="conv-title">{conv.title}</span>
          <span className="conv-time">{formatDateTime(conv.updatedAt)}</span>
        </button>
      )}
      {!renaming && (
        <div className="conv-actions">
          <button
            type="button"
            className="conv-menu-btn icon-btn small"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Options for ${conv.title}`}
            title="Rename or archive"
            onClick={(e) => onMenu(conv.id, e.currentTarget)}
          >
            <IconMoreHorizontal size={15} />
          </button>
          <button
            type="button"
            className="conv-delete icon-btn small"
            aria-label={`Delete conversation ${conv.title}`}
            title="Delete conversation"
            onClick={() => onDelete(conv.id)}
          >
            <IconTrash size={13} />
          </button>
        </div>
      )}
    </div>
  )
})

export function Sidebar() {
  const conversations = useChat((s) => s.conversations)
  const order = useChat((s) => s.order)
  const currentId = useChat((s) => s.currentId)
  const { newConversation } = useChat.getState()
  const sidebarOpen = useUI((s) => s.sidebarOpen)
  const toggleSidebar = useUI((s) => s.toggleSidebar)
  const closeMobileSidebar = () => {
    toggleSidebar()
    document.querySelector<HTMLButtonElement>('[data-panel-toggle="sidebar"]')?.focus()
  }
  const openSettings = useUI((s) => s.openSettings)
  const [query, setQuery] = useState('')
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [menu, setMenu] = useState<ConversationMenuState | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const listRef = useRef<HTMLElement>(null)

  const searching = query.trim().length > 0
  // While searching, matches inside Archived are shown rather than hidden behind the toggle.
  const showArchived = searching || archivedOpen

  const { active, archived } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches = (c: Conversation) =>
      !q || c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q))
    const active: Conversation[] = []
    const archived: Conversation[] = []
    for (const id of order) {
      const c = conversations[id]
      if (!c || !matches(c)) continue
      ;(c.archived ? archived : active).push(c)
    }
    return { active, archived }
  }, [order, conversations, query])

  // Stable callbacks, so a token streaming into one chat doesn't re-render every row.
  const onSelect = useCallback((id: string) => {
    useChat.getState().selectConversation(id)
    if (window.innerWidth < 900) useUI.getState().toggleSidebar()
  }, [])

  const onMenu = useCallback((id: string, opener: HTMLElement, at?: { x: number; y: number }) => {
    const anchor: MenuAnchor = at
      ? { kind: 'point', x: at.x, y: at.y }
      : { kind: 'rect', rect: opener.getBoundingClientRect(), align: 'end' }
    // The ⋯ button toggles its own menu.
    setMenu((cur) => (!at && cur?.convId === id && cur.anchor.kind === 'rect' ? null : { convId: id, anchor, opener }))
  }, [])

  const onRenamed = useCallback((id: string, title: string | null) => {
    if (title !== null) useChat.getState().renameConversation(id, title)
    setRenamingId((cur) => (cur === id ? null : cur))
  }, [])

  const onDelete = useCallback((id: string) => useChat.getState().deleteConversation(id), [])

  // After Esc or an archive, put focus back on the opener; a row that just left the
  // list can't hold it, so fall back to the list itself instead of dropping to <body>.
  const returnFocus = useCallback((opener: HTMLElement | null) => {
    if (opener?.isConnected) opener.focus()
    else listRef.current?.focus()
  }, [])

  const renderRow = (c: Conversation) => (
    <ConversationRow
      key={c.id}
      conv={c}
      active={c.id === currentId}
      renaming={c.id === renamingId}
      menuOpen={c.id === menu?.convId}
      onSelect={onSelect}
      onMenu={onMenu}
      onRenamed={onRenamed}
      onDelete={onDelete}
    />
  )

  return (
    <>
      {sidebarOpen && <div className="drawer-backdrop only-mobile" onClick={closeMobileSidebar} aria-hidden="true" />}
      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`} aria-label="Conversations" ref={(node) => { if (node) node.inert = !sidebarOpen }}>
        <div className="sidebar-head">
          <span className="logo" aria-hidden="true">
            <IconStarburst size={17} className="logo-mark" />
            <span className="logo-text">Slade</span>
          </span>
          <button className="icon-btn only-mobile" onClick={closeMobileSidebar} aria-label="Close sidebar" type="button">
            <IconX size={16} />
          </button>
        </div>

        <button
          className="new-chat-btn"
          onClick={() => {
            newConversation()
            if (window.innerWidth < 900) toggleSidebar()
          }}
          type="button"
        >
          <IconPlus size={15} /> New chat
        </button>

        <input
          className="sidebar-search"
          type="search"
          placeholder="Search conversations…"
          aria-label="Search conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <nav className="conv-list" aria-label="Conversation history" ref={listRef} tabIndex={-1}>
          {active.length === 0 && archived.length === 0 && (
            <div className="conv-empty">{query ? 'No matches.' : 'No conversations yet.'}</div>
          )}
          {active.length === 0 && archived.length > 0 && !searching && (
            <div className="conv-empty">Everything is archived.</div>
          )}
          {active.map(renderRow)}

          {archived.length > 0 && (
            <section className="conv-group" aria-label="Archived conversations">
              <button
                type="button"
                className="conv-group-head"
                aria-expanded={showArchived}
                aria-controls="conv-archived-list"
                aria-label={`Archived, ${archived.length} conversation${archived.length === 1 ? '' : 's'}`}
                disabled={searching}
                onClick={() => setArchivedOpen((o) => !o)}
              >
                <IconChevronRight size={12} />
                <span>Archived</span>
                <span className="conv-count">{archived.length}</span>
              </button>
              {showArchived && (
                <div id="conv-archived-list" className="conv-group-list">
                  {archived.map(renderRow)}
                </div>
              )}
            </section>
          )}
        </nav>

        <footer className="sidebar-foot">
          <button className="link-btn" onClick={() => openSettings()} type="button">
            Settings <kbd>Ctrl+,</kbd>
          </button>
          <span className="sidebar-version">v1.0 · never stalls</span>
        </footer>
      </aside>
      {menu && (
        <ConversationMenu
          state={menu}
          onRename={(id) => setRenamingId(id)}
          onClose={() => setMenu(null)}
          returnFocus={returnFocus}
        />
      )}
    </>
  )
}
