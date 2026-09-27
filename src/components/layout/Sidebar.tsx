import { useMemo, useState } from 'react'
import { useChat } from '../../store/chat'
import { useUI } from '../../store/ui'
import { formatDateTime } from '../../lib/format'
import { IconPlus, IconTrash, IconX } from '../icons'

export function Sidebar() {
  const conversations = useChat((s) => s.conversations)
  const order = useChat((s) => s.order)
  const currentId = useChat((s) => s.currentId)
  const { selectConversation, newConversation, deleteConversation } = useChat.getState()
  const sidebarOpen = useUI((s) => s.sidebarOpen)
  const toggleSidebar = useUI((s) => s.toggleSidebar)
  const openSettings = useUI((s) => s.openSettings)
  const [query, setQuery] = useState('')

  const list = useMemo(() => {
    const arr = order
      .map((id) => conversations[id])
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
    if (!query.trim()) return arr
    const q = query.toLowerCase()
    return arr.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.messages.some((m) => m.content.toLowerCase().includes(q)),
    )
  }, [order, conversations, query])

  return (
    <>
      {sidebarOpen && <div className="drawer-backdrop only-mobile" onClick={toggleSidebar} aria-hidden="true" />}
      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`} aria-label="Conversations">
        <div className="sidebar-head">
          <span className="logo" aria-hidden="true">
            SLADE
          </span>
          <button className="icon-btn only-mobile" onClick={toggleSidebar} aria-label="Close sidebar" type="button">
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

        <nav className="conv-list" aria-label="Conversation history">
          {list.length === 0 && <div className="conv-empty">{query ? 'No matches.' : 'No conversations yet.'}</div>}
          {list.map((c) => (
            <div
              key={c.id}
              className={`conv-item${c.id === currentId ? ' active' : ''}`}
              role="button"
              tabIndex={0}
              aria-current={c.id === currentId}
              onClick={() => {
                selectConversation(c.id)
                if (window.innerWidth < 900) toggleSidebar()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  selectConversation(c.id)
                  if (window.innerWidth < 900) toggleSidebar()
                }
              }}
            >
              <span className="conv-title">{c.title}</span>
              <span className="conv-time">{formatDateTime(c.updatedAt)}</span>
              <button
                className="conv-delete icon-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  deleteConversation(c.id)
                }}
                aria-label={`Delete conversation ${c.title}`}
                title="Delete conversation"
                type="button"
              >
                <IconTrash size={13} />
              </button>
            </div>
          ))}
        </nav>

        <footer className="sidebar-foot">
          <button className="link-btn" onClick={() => openSettings()} type="button">
            Settings <kbd>Ctrl+,</kbd>
          </button>
          <span className="sidebar-version">v1.0 · never stalls</span>
        </footer>
      </aside>
    </>
  )
}
