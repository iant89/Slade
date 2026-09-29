import { useEffect, useRef, useState } from 'react'
import type { Message } from '../../types'
import { FAILURE_LABEL } from '../../types'
import { useChat } from '../../store/chat'
import { useSettings, modelShowsThoughts } from '../../store/settings'
import { useUI } from '../../store/ui'
import { copyText } from '../../lib/clipboard'
import { formatCount, formatTime } from '../../lib/format'
import { regenerateFromUserMessage, retryAssistant } from '../../engine/send'
import { ArtifactCard } from '../artifacts/ArtifactCard'
import { Markdown } from './Markdown'
import { AgentPlanCard } from './AgentPlanCard'
import {
  IconBranch,
  IconBrain,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconGithub,
  IconLoader,
  IconPencil,
  IconRefresh,
  IconTrash,
  IconAlert,
  IconBot,
  IconSparkles,
} from '../icons'

/* ------------------------------------------------------------------ */
/* Expandable thinking & reasoning block                               */
/* ------------------------------------------------------------------ */

export function ThinkingBlock({
  reasoning,
  streaming = false,
  label = 'Thought process',
}: {
  reasoning?: string
  streaming?: boolean
  label?: string
}) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const isExpanded = userToggled !== null ? userToggled : (streaming ? true : false)

  if (!reasoning?.trim() && !streaming) return null

  const trimmed = reasoning?.trim() ?? ''
  const wordCount = trimmed ? trimmed.split(/\s+/).length : 0

  return (
    <div className={`thought-block${streaming ? ' streaming' : ''}${isExpanded ? ' open' : ' closed'}`}>
      <button
        type="button"
        className="thought-head"
        onClick={() => setUserToggled(!isExpanded)}
        aria-expanded={isExpanded}
        title={isExpanded ? 'Collapse thinking process' : 'Expand thinking process'}
      >
        <span className="thought-icon" aria-hidden="true">
          {streaming ? <IconLoader size={12} className="spin" /> : <IconBrain size={12} />}
        </span>
        <span className="thought-title">
          {streaming && !trimmed ? 'Thinking…' : streaming ? 'Thinking…' : label}
        </span>
        {trimmed && !streaming && (
          <span className="thought-meta">
            {wordCount} {wordCount === 1 ? 'word' : 'words'}
          </span>
        )}
        <span className="thought-chevron" aria-hidden="true">
          {isExpanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </span>
      </button>
      {isExpanded && (
        <div className="thought-body">
          <div className="thought-text">
            {trimmed || (streaming ? 'Thinking in progress…' : '')}
            {streaming && <StreamCursor />}
          </div>
        </div>
      )}
    </div>
  )
}

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
        <div className={`msg-avatar${message.agent ? ' agent' : ''}`} aria-hidden="true">
          {message.agent ? <IconBot size={14} /> : <IconSparkles size={14} />}
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
  // Orchestrated replies get their own attribution; the plan card below the
  // message carries the per-step detail.
  if (message.agent) {
    return (
      <span className="msg-model agent-attribution">
        <span className="msg-model-name">Orchestrator · {labelOf(message.agent.orchestratorModelId) || 'agent'}</span>
        {message.agent.steps.length > 0 && (
          <span className="msg-agent-steps">
            {message.agent.steps.filter((s) => s.status === 'complete').length}/{message.agent.steps.length} steps delegated
          </span>
        )}
      </span>
    )
  }
  const final = labelOf(message.modelId ?? message.chain?.[message.chain.length - 1])
  const fellBackFrom = message.failedChain && message.failedChain.length > 0
  // Pair each failed model with the provider's own reason, when we kept one.
  const reasonByModel = new Map((message.attempts ?? []).map((a) => [a.modelId, a.message]))
  const failedDetail = (message.failedChain ?? [])
    .map((id) => {
      const reason = reasonByModel.get(id)
      return reason ? `${labelOf(id)} — ${reason}` : labelOf(id)
    })
    .join('; ')
  return (
    <span className="msg-model">
      <span className="msg-model-name">{final || 'Assistant'}</span>
      {fellBackFrom ? (
        <span className="msg-fallback" title={failedDetail ? `Failed before answering: ${failedDetail}` : undefined}>
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
  const settings = useSettings((s) => s.s)
  const streaming = message.status === 'streaming'
  const pending = message.status === 'pending'
  const typingOn = settings.defaults.typingIndicator
  const showThoughts = modelShowsThoughts(settings, message.modelId ?? message.chain?.[0])
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
      {message.agent && <AgentPlanCard run={message.agent} labelOf={labelOf} />}
      {message.agent && !message.content.trim() && (pending || streaming) && message.agent.steps.length === 0 && (
        <TypingIndicator label={typingOn ? 'The orchestrator is working…' : ''} />
      )}
      {showThoughts && (message.reasoning || (streaming && !message.content.trim())) ? (
        <ThinkingBlock
          reasoning={message.reasoning}
          streaming={streaming && !message.content.trim()}
          label="Thought process"
        />
      ) : null}
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
      {message.truncated && !error && !cancelled ? (
        <div className="msg-truncated">
          Cut off at the output token cap — raise <strong>Max output tokens</strong> in Settings → Defaults and retry for the rest.
        </div>
      ) : null}
    </div>
  )
}

function ErrorBanner({ message }: { message: Message }) {
  const toast = useUI((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const attempts = message.attempts ?? []

  const diagnostics = () =>
    [
      `Slade — failed turn diagnostics`,
      ...attempts.map(
        (a, i) =>
          `${i + 1}. ${a.label} [${FAILURE_LABEL[a.failure]}${a.status ? ` · HTTP ${a.status}` : ''}] after ${a.elapsedMs}ms${
            a.midStream ? ' (dropped mid-stream)' : ''
          }\n   ${a.message}`,
      ),
      `Summary: ${message.error ?? 'none'}`,
    ].join('\n')

  return (
    <div className="msg-error" role="alert">
      <span className="msg-error-icon">
        <IconAlert size={14} />
      </span>
      <div className="msg-error-body">
        <span className="msg-error-text">{message.error ?? 'The turn failed without a reason.'}</span>
        {attempts.length > 0 && (
          <>
            <button className="link-inline" type="button" onClick={() => setShowDetail((v) => !v)}>
              {showDetail ? 'Hide' : 'Show'} what each provider said
            </button>
            {showDetail && (
              <ul className="msg-error-attempts">
                {attempts.map((a, i) => (
                  <li key={`${a.modelId}-${i}`}>
                    <span className={`err-chip err-${a.failure}`}>{FAILURE_LABEL[a.failure]}</span>
                    <span className="err-model">{a.label}</span>
                    <span className="err-meta">
                      {a.status ? `HTTP ${a.status} · ` : ''}
                      {formatMs(a.elapsedMs)}
                      {a.midStream ? ' · dropped mid-stream' : ''}
                    </span>
                    <span className="err-msg">{a.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <div className="msg-error-actions">
        {attempts.length > 0 && (
          <button
            className="btn small ghost"
            type="button"
            onClick={async () => {
              await copyText(diagnostics())
              toast({ kind: 'info', title: 'Diagnostics copied to the clipboard.' })
            }}
          >
            <IconCopy size={12} /> Copy
          </button>
        )}
        <button
          className="btn small primary"
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            // Retry gets a clean slate: clear cooldowns so the chain can walk.
            // Every enabled model is revived, not just the ones in failedChain —
            // models benched by an earlier auth error never appear in the failed
            // chain, and leaving them out is what made retries hit the same wall.
            const { useHealth } = await import('../../store/health')
            const { useSettings } = await import('../../store/settings')
            for (const m of useSettings.getState().s.models) {
              if (m.enabled) useHealth.getState().markHealthy(m.id)
            }
            await retryAssistant(message.id)
            toast({ kind: 'info', title: 'Retrying with cooldowns cleared…' })
          }}
        >
          <IconRefresh size={12} /> Retry
        </button>
      </div>
    </div>
  )
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
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

      {message.content.trim() ? (
        <ActionButton
          label="Publish to GitHub"
          onClick={() => useUI.getState().openPublish({ kind: 'message', messageId: message.id })}
        >
          <IconGithub size={13} />
        </ActionButton>
      ) : null}

      <ActionButton label="Delete message" onClick={() => useChat.getState().deleteMessage(message.id)}>
        <IconTrash size={13} />
      </ActionButton>

      {isLast ? null : null}
    </div>
  )
}
