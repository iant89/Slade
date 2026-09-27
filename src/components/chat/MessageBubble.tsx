import { useEffect, useRef, useState } from 'react'
import type { Message } from '../../types'
import { useChat } from '../../store/chat'
import { useSettings } from '../../store/settings'
import { useUI } from '../../store/ui'
import { copyText } from '../../lib/clipboard'
import { formatCount, formatTime } from '../../lib/format'
import { regenerateFromUserMessage, retryAssistant } from '../../engine/send'
import { ArtifactCard } from '../artifacts/ArtifactCard'
import { Markdown } from './Markdown'
import { IconBranch, IconCheck, IconCopy, IconPencil, IconRefresh, IconTrash, IconAlert, IconSparkles } from '../icons'

/* ------------------------------------------------------------------ */
/* Typing indicator                                                    */
/* ------------------------------------------------------------------ */

export function TypingIndicator({ label }: { label?: string }) {
  return (
    <div className="typing" role="status" aria-label={label || 'Assistant is typing'}>
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
      {label ? <span className="typing-label">{label}</span> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Streaming cursor                                                    */
/* ------------------------------------------------------------------ */

export function StreamCursor() {
  return <span className="stream-cursor" aria-hidden="true" />
}

/* ------------------------------------------------------------------ */
/* Small pieces                                                        */
/* ------------------------------------------------------------------ */

function ActionButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className="msg-action" onClick={onClick} aria-label={label} title={label} type="button">
      {children}
    </button>
  )
}

function HandoffDivider({ fromLabel, toLabel }: { fromLabel: string; toLabel: string }) {
  return (
    <div className="handoff-divider" role="note">
      <span className="handoff-line" />
      <span className="handoff-text">
        <IconRefresh size={11} /> handed off from {fromLabel} → {toLabel}
      </span>
      <span className="handoff-line" />
    </div>
  )
}

function Attachments({ ids }: { ids?: string[] }) {
  if (!ids?.length) return null
  return (
    <div className="msg-attachments">
      {ids.map((id) => (
        <ArtifactCard key={id} artifactId={id} />
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Message bubble                                                      */
/* ------------------------------------------------------------------ */

export function MessageBubble({ message }: { message: Message }) {
  const settings = useSettings((s) => s.s)
  const [editing, setEditing] = useState(false)
  const labelOf = (id: string | undefined) => settings.models.find((m) => m.id === id)?.label ?? id ?? ''
  const isUser = message.role === 'user'

  return (
    <article
      className={`msg ${isUser ? 'msg-user' : 'msg-assistant'} status-${message.status}`}
      aria-label={isUser ? 'Your message' : 'Assistant message'}
    >
      {!isUser && (
        <div className="msg-avatar" aria-hidden="true">
          <IconSparkles size={14} />
        </div>
      )}
      <div className="msg-main">
        <header className="msg-head">
          {isUser ? <span className="msg-author">You</span> : <ModelAttribution message={message} labelOf={labelOf} />}
          <span className="msg-time">
            {formatTime(message.createdAt)}
            {message.editedAt ? ' · edited' : ''}
          </span>
        </header>

        <Attachments ids={message.attachmentIds} />

        {isUser ? (
          <UserBody message={message} editing={editing} onDone={() => setEditing(false)} />
        ) : (
          <AssistantBody message={message} labelOf={labelOf} />
        )}

        <footer className="msg-foot">
          <MessageActions message={message} onEdit={() => setEditing(true)} />
          {!isUser && message.usage && (message.usage.completionTokens || message.usage.promptTokens) ? (
            <span className="msg-usage">
              {message.usage.promptTokens ? `${formatCount(message.usage.promptTokens)} in` : ''}
              {message.usage.promptTokens && message.usage.completionTokens ? ' · ' : ''}
              {message.usage.completionTokens ? `${formatCount(message.usage.completionTokens)} out` : ''}
            </span>
          ) : null}
        </footer>
      </div>
    </article>
  )
}

function ModelAttribution({
  message,
  labelOf,
}: {
  message: Message
  labelOf: (id: string | undefined) => string
}) {
  const final = labelOf(message.modelId ?? message.chain?.[message.chain.length - 1])
  const fellBackFrom = message.failedChain && message.failedChain.length > 0
  return (
    <span className="msg-model">
      <span className="msg-model-name">{final || 'Assistant'}</span>
      {fellBackFrom ? (
        <span
          className="msg-fallback"
          title={`Failed before answering: ${message.failedChain!.map(labelOf).join(', ')}`}
        >
          ← fell back from {message.failedChain!.map(labelOf).filter(Boolean).join(', ')}
        </span>
      ) : null}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* User body (with inline edit)                                        */
/* ------------------------------------------------------------------ */

function UserBody({
  message,
  editing,
  onDone,
}: {
  message: Message
  editing: boolean
  onDone: () => void
}) {
  const [draft, setDraft] = useState(message.content)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!editing) return
    setDraft(message.content)
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (ta) {
        ta.focus()
        ta.selectionStart = ta.value.length
        ta.style.height = 'auto'
        ta.style.height = `${Math.min(320, ta.scrollHeight)}px`
      }
    })
  }, [editing, message.content])

  if (!editing) {
    return <div className="msg-bubble user-bubble">{message.content}</div>
  }

  const save = () => {
    const text = draft.trim()
    onDone()
    if (!text || text === message.content) return
    const chat = useChat.getState()
    chat.mutateMessage(message.id, (m) => ({ ...m, content: text, editedAt: Date.now() }))
    chat.truncateAfter(message.conversationId, message.id)
    void regenerateFromUserMessage(message.conversationId, message.id)
  }

  return (
    <div className="msg-edit">
      <textarea
        ref={taRef}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          e.target.style.height = 'auto'
          e.target.style.height = `${Math.min(320, e.target.scrollHeight)}px`
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            save()
          }
          if (e.key === 'Escape') onDone()
        }}
        aria-label="Edit your message"
      />
      <div className="msg-edit-actions">
        <button className="btn ghost" onClick={onDone} type="button">
          Cancel
        </button>
        <button className="btn primary" onClick={save} type="button">
          <IconCheck size={13} /> Save &amp; resend
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Assistant body                                                      */
/* ------------------------------------------------------------------ */

function AssistantBody({
  message,
  labelOf,
}: {
  message: Message
  labelOf: (id: string | undefined) => string
}) {
  const streaming = message.status === 'streaming'
  const pending = message.status === 'pending'
  const typingOn = useSettings((s) => s.s.defaults.typingIndicator)
  const error = message.status === 'error'
  const cancelled = message.status === 'cancelled'

  // Split content at handoff offsets so dividers sit exactly where the
  // mid-stream switch happened.
  const segments: { text: string; handoffTo?: string; fromLabel?: string }[] = []
  if (message.handoffs && message.handoffs.length > 0) {
    let cursor = 0
    for (const h of message.handoffs) {
      const at = Math.min(h.atChar, message.content.length)
      segments.push({ text: message.content.slice(cursor, at) })
      segments.push({ text: '', handoffTo: h.toModelId, fromLabel: h.fromModelLabel })
      cursor = at
    }
    segments.push({ text: message.content.slice(cursor) })
  } else {
    segments.push({ text: message.content })
  }

  const provenance =
    message.modelId && message.status !== 'pending'
      ? { origin: 'model' as const, modelId: message.modelId, modelLabel: labelOf(message.modelId) }
      : undefined

  return (
    <div className="msg-bubble assistant-bubble">
      {pending && <TypingIndicator label={typingOn ? undefined : ''} />}
      {segments.map((seg, i) => (
        <div key={i}>
          {seg.handoffTo ? (
            <HandoffDivider fromLabel={seg.fromLabel ?? ''} toLabel={labelOf(seg.handoffTo)} />
          ) : seg.text ? (
            <>
              <Markdown text={seg.text} provenance={provenance} messageId={message.id} />
              {streaming && i === segments.length - 1 ? <StreamCursor /> : null}
            </>
          ) : null}
        </div>
      ))}
      {pending ? <span className="sr-only">Assistant is thinking…</span> : null}
      {error ? <ErrorBanner message={message} /> : null}
      {cancelled ? <div className="msg-cancelled">Generation stopped — the partial answer above is kept.</div> : null}
    </div>
  )
}

function ErrorBanner({ message }: { message: Message }) {
  const toast = useUI((s) => s.toast)
  const [busy, setBusy] = useState(false)
  return (
    <div className="msg-error" role="alert">
      <span className="msg-error-icon">
        <IconAlert size={14} />
      </span>
      <span className="msg-error-text">{message.error ?? 'Unknown error'}</span>
      <button
        className="btn small primary"
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          // Retry gets a clean slate: clear cooldowns so the chain can walk.
          const { useHealth } = await import('../../store/health')
          for (const id of message.failedChain ?? []) useHealth.getState().markHealthy(id)
          await retryAssistant(message.id)
          toast({ kind: 'info', title: 'Retrying with cooldowns cleared…' })
        }}
      >
        <IconRefresh size={12} /> Retry
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function MessageActions({ message, onEdit }: { message: Message; onEdit: () => void }) {
  const toast = useUI((s) => s.toast)
  const isUser = message.role === 'user'
  const conv = useChat((s) => s.conversations[message.conversationId])
  const isLast = conv ? conv.messages[conv.messages.length - 1]?.id === message.id : false

  return (
    <div className="msg-actions">
      <ActionButton
        label="Copy message"
        onClick={async () => {
          const ok = await copyText(message.content)
          toast({ kind: ok ? 'success' : 'error', title: ok ? 'Copied to clipboard' : 'Copy failed' })
        }}
      >
        <IconCopy size={13} />
      </ActionButton>

      {!isUser ? (
        <ActionButton
          label="Regenerate response"
          onClick={() => {
            const chat = useChat.getState()
            const c = chat.conversations[message.conversationId]
            const idx = c?.messages.findIndex((m) => m.id === message.id) ?? -1
            if (!c || idx <= 0) return
            const prev = c.messages[idx - 1]
            if (prev?.role !== 'user') return
            chat.deleteMessage(message.id)
            void regenerateFromUserMessage(c.id, prev.id)
          }}
        >
          <IconRefresh size={13} />
        </ActionButton>
      ) : (
        <ActionButton label="Edit and resend" onClick={onEdit}>
          <IconPencil size={13} />
        </ActionButton>
      )}

      <ActionButton
        label="Branch conversation from here"
        onClick={() => {
          const chat = useChat.getState()
          const newId = chat.branchFrom(message.conversationId, message.id)
          if (newId)
            toast({
              kind: 'success',
              title: 'Branched into a new chat',
              detail: 'History up to this message was copied.',
            })
        }}
      >
        <IconBranch size={13} />
      </ActionButton>

      <ActionButton label="Delete message" onClick={() => useChat.getState().deleteMessage(message.id)}>
        <IconTrash size={13} />
      </ActionButton>

      {isLast ? null : null}
    </div>
  )
}
