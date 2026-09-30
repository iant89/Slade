import { useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { AnimatePresence, motion } from 'framer-motion'
import { useCurrentConversation, useChat } from '../../store/chat'
import { useSettings } from '../../store/settings'
import { useUI } from '../../store/ui'
import { currentAnnouncement, setAnnouncer } from '../../engine/send'
import { MessageBubble, TypingIndicator } from './MessageBubble'
import { GitHubActionItem } from '../github/GitHubActivity'
import { buildPanelItems, useSessionGitHubActions } from './panel'
import { IconArrowDown, IconStarburst, IconWifiOff } from '../icons'

/**
 * The chat panel: everything the conversation holds, in one scroll area above
 * the composer. The messages come first; the GitHub Actions this session made
 * are appended to the end of the same list (`./panel.ts`), so they are part of
 * the log — they scroll with it, and they are never dropped between messages or
 * left outside the panel.
 */
export function ChatView() {
  const conv = useCurrentConversation()
  const messages = conv?.messages ?? []
  const actions = useSessionGitHubActions()
  const items = useMemo(() => buildPanelItems(messages, actions), [messages, actions])
  const autoScroll = useSettings((s) => s.s.defaults.autoScroll)
  const online = useUI((s) => s.online)
  const [atBottom, setAtBottom] = useState(true)
  const [announcement, setAnnouncement] = useState('')
  const virtuoso = useRef<VirtuosoHandle>(null)

  // ARIA live region: announce finalized responses + artifact insertions.
  useEffect(() => {
    setAnnouncer(() => setAnnouncement(currentAnnouncement()))
  }, [])

  // The panel is a conversation's log, so it always needs a conversation to
  // belong to. A first run with nothing stored — or a view whose last chat was
  // just deleted or archived — gets a fresh one, so messages and GitHub Actions
  // always have a panel to be appended to.
  useEffect(() => {
    if (!conv) useChat.getState().ensureConversation()
  }, [conv])

  const follow = autoScroll === 'off' ? false : autoScroll === 'instant'
  const pending = messages.some((m) => m.status === 'pending')

  if (!conv) {
    return <NoConversation />
  }

  // A panel with nothing in it steps aside so the composer can center itself
  // under the greeting; a panel holding GitHub Actions counts as content.
  const empty = items.length === 0

  return (
    <div className={`chat-view${empty ? ' empty' : ''}`}>
      {!online && (
        <div className="offline-banner" role="alert">
          <IconWifiOff size={14} /> You're offline — sends will fail until the connection returns.
        </div>
      )}
      {empty ? null : (
        <Virtuoso
          ref={virtuoso}
          className="msg-list"
          data={items}
          itemContent={(_, item) =>
            item.kind === 'message' ? (
              <MessageBubble message={item.message} />
            ) : (
              <GitHubActionItem entry={item.entry} />
            )
          }
          computeItemKey={(_, item) => item.id}
          followOutput={follow}
          initialTopMostItemIndex={Math.max(0, items.length - 1)}
          atBottomStateChange={setAtBottom}
          atBottomThreshold={80}
          increaseViewportBy={{ top: 300, bottom: 600 }}
          components={pending ? { Footer: PendingFooter } : undefined}
        />
      )}
      <AnimatePresence>
        {!empty && !atBottom && (
          <motion.button
            className="jump-latest"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            onClick={() => virtuoso.current?.scrollToIndex({ index: items.length - 1, behavior: 'smooth' })}
            type="button"
          >
            <IconArrowDown size={14} /> Jump to latest
          </motion.button>
        )}
      </AnimatePresence>
      <div className="sr-only" role="log" aria-live="polite">
        {announcement}
      </div>
    </div>
  )
}

function PendingFooter() {
  return (
    <div className="pending-footer" aria-hidden="true">
      <TypingIndicator label="" />
    </div>
  )
}

/** The frame before the effect above has created a conversation (or if it can't). */
function NoConversation() {
  const newChat = useChat((s) => s.newConversation)
  return (
    <div className="empty-state">
      <div className="empty-mark" aria-hidden="true">
        <IconStarburst size={34} />
      </div>
      <button className="btn primary" onClick={() => newChat()} type="button">
        New chat
      </button>
    </div>
  )
}
