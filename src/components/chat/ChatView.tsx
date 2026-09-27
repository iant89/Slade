import { useEffect, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { AnimatePresence, motion } from 'framer-motion'
import { useCurrentConversation, useChat } from '../../store/chat'
import { useSettings } from '../../store/settings'
import { useUI } from '../../store/ui'
import { currentAnnouncement, setAnnouncer } from '../../engine/send'
import { MessageBubble, TypingIndicator } from './MessageBubble'
import { IconArrowDown, IconSparkles, IconWifiOff } from '../icons'

export function ChatView() {
  const conv = useCurrentConversation()
  const messages = conv?.messages ?? []
  const autoScroll = useSettings((s) => s.s.defaults.autoScroll)
  const online = useUI((s) => s.online)
  const [atBottom, setAtBottom] = useState(true)
  const [announcement, setAnnouncement] = useState('')
  const virtuoso = useRef<VirtuosoHandle>(null)
  const prevCount = useRef(0)

  // ARIA live region: announce finalized responses + artifact insertions.
  useEffect(() => {
    setAnnouncer(() => setAnnouncement(currentAnnouncement()))
  }, [])

  const follow = autoScroll === 'off' ? false : autoScroll === 'instant'

  useEffect(() => {
    prevCount.current = messages.length
  }, [messages.length])

  if (!conv) {
    return <NoConversation />
  }

  return (
    <div className="chat-view">
      {!online && (
        <div className="offline-banner" role="alert">
          <IconWifiOff size={14} /> You're offline — sends will fail until the connection returns.
        </div>
      )}
      {messages.length === 0 ? (
        <EmptyState />
      ) : (
        <Virtuoso
          ref={virtuoso}
          className="msg-list"
          data={messages}
          itemContent={(_, m) => <MessageBubble message={m} />}
          computeItemKey={(_, m) => m.id}
          followOutput={follow}
          initialTopMostItemIndex={Math.max(0, messages.length - 1)}
          atBottomStateChange={setAtBottom}
          atBottomThreshold={80}
          increaseViewportBy={{ top: 300, bottom: 600 }}
          components={{ Footer: messages.some((m) => m.status === 'pending') ? PendingFooter : undefined }}
        />
      )}
      <AnimatePresence>
        {!atBottom && messages.length > 0 && (
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

export function EmptyState() {
  const openSettings = useUI((s) => s.openSettings)
  const newChat = useChat((s) => s.newConversation)
  return (
    <div className="empty-state">
      <div className="empty-mark" aria-hidden="true">
        <span className="empty-logo">SLADE</span>
        <span className="empty-tagline">one chat window · every model · never stalls</span>
      </div>
      <div className="empty-cards">
        <button className="empty-card" type="button" onClick={() => newChat()}>
          <IconSparkles size={16} />
          <strong>Start a chat</strong>
          <span>Send a prompt — it streams in token by token.</span>
        </button>
        <button className="empty-card" type="button" onClick={() => openSettings('models')}>
          <strong>Wire up failover</strong>
          <span>
            Settings → Models: set <em>Simulacron Pro</em> to simulate a failure, then send a message and watch the
            handoff.
          </span>
        </button>
        <button className="empty-card" type="button" onClick={() => openSettings('providers')}>
          <strong>Bring your keys</strong>
          <span>Add OpenAI, Anthropic or Gemini keys to route to real models with the same failover engine.</span>
        </button>
      </div>
      <div className="empty-hint">Tip: ask to “generate a CSV of Q3 sales” to see an artifact card.</div>
    </div>
  )
}

function NoConversation() {
  const newChat = useChat((s) => s.newConversation)
  return (
    <div className="empty-state">
      <div className="empty-mark" aria-hidden="true">
        <span className="empty-logo">SLADE</span>
      </div>
      <button className="btn primary" onClick={() => newChat()} type="button">
        New chat
      </button>
    </div>
  )
}
