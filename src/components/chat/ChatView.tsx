import { useEffect, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { AnimatePresence, motion } from 'framer-motion'
import { useCurrentConversation, useChat } from '../../store/chat'
import { useSettings } from '../../store/settings'
import { useUI } from '../../store/ui'
import { currentAnnouncement, setAnnouncer } from '../../engine/send'
import { MessageBubble, TypingIndicator } from './MessageBubble'
import { IconArrowDown, IconStarburst, IconWifiOff } from '../icons'

/**
 * Virtuoso is generated from a `system()` definition, and its prop setter takes
 * every prop it finds with `'components' in props`. Passing `undefined`
 * explicitly therefore counts as "present" and overwrites its internal
 * component registry with nothing — the next render throws reading it
 * ("Cannot read properties of undefined"). An empty registry says the same
 * thing safely: keep the built-in components.
 */
const NO_COMPONENT_OVERRIDES = {}

/**
 * The chat panel: the conversation's messages, in one scroll area above the
 * composer. GitHub actions are messages here too — a standalone call is its own
 * card message, and a run's calls are interleaved into that assistant
 * message's timeline (see `../github/GitHubActivity`). Everything scrolls with
 * the log.
 */
export function ChatView() {
  const conv = useCurrentConversation()
  const messages = conv?.messages ?? []
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
  // just deleted or archived — gets a fresh one, so messages and the GitHub
  // action cards logged as messages always have a panel to be appended to.
  useEffect(() => {
    if (!conv) useChat.getState().ensureConversation()
  }, [conv])

  const follow = autoScroll === 'off' ? false : autoScroll === 'instant'
  const pending = messages.some((m) => m.status === 'pending')

  if (!conv) {
    return <NoConversation />
  }

  // A panel with nothing in it steps aside so the composer can center itself
  // under the greeting.
  const empty = messages.length === 0

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
          data={messages}
          itemContent={(_, message) => <MessageBubble message={message} />}
          computeItemKey={(_, message) => message.id}
          followOutput={follow}
          initialTopMostItemIndex={Math.max(0, messages.length - 1)}
          atBottomStateChange={setAtBottom}
          atBottomThreshold={80}
          increaseViewportBy={{ top: 300, bottom: 600 }}
          components={pending ? { Footer: PendingFooter } : NO_COMPONENT_OVERRIDES}
        />
      )}
      <AnimatePresence>
        {!empty && !atBottom && (
          <motion.button
            className="jump-latest"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            onClick={() => virtuoso.current?.scrollToIndex({ index: messages.length - 1, behavior: 'smooth' })}
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
