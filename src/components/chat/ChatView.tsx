import { useEffect, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { AnimatePresence, motion } from 'framer-motion'
import { useCurrentConversation, useChat } from '../../store/chat'
import { useSettings } from '../../store/settings'
import { useUI } from '../../store/ui'
import { currentAnnouncement, setAnnouncer } from '../../engine/send'
import { MessageBubble, TypingIndicator } from './MessageBubble'
import { IconArrowDown, IconStarburst, IconWifiOff } from '../icons'

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

  // A fresh conversation gets the centered "greeting + composer" layout: the
  // chat area steps aside and the composer renders its own greeting.
  const empty = messages.length === 0

  return (
    <div className={`chat-view${empty ? ' empty' : ''}`}>
      {!online && (
        <div className="offline-banner" role="alert">
          <IconWifiOff size={14} /> You're offline — sends will fail until the connection returns.
        </div>
      )}
      {messages.length === 0 ? null : (
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
