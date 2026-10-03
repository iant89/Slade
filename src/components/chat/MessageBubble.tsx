import { useEffect, useRef, useState } from 'react'
import type { AgentRun, Message } from '../../types'
import { FAILURE_LABEL } from '../../types'
import { useChat } from '../../store/chat'
import { useFs } from '../../store/fs'
import { useSettings, modelShowsThoughts } from '../../store/settings'
import { useUI } from '../../store/ui'
import { copyText } from '../../lib/clipboard'
import { formatCount, formatTime } from '../../lib/format'
import { regenerateFromUserMessage, retryAssistant } from '../../engine/send'
import { ArtifactCard } from '../artifacts/ArtifactCard'
import { GitHubActionCard } from '../github/GitHubActivity'
import { Markdown } from './Markdown'
import { AgentPlanCard } from './AgentPlanCard'
import { AgentQuestions } from './AgentQuestions'
import { RoadmapTimeline } from './RoadmapTimeline'
import {
  IconBranch,
  IconBrain,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconGithub,
  IconPencil,
  IconRefresh,
  IconStarburst,
  IconTrash,
  IconAlert,
  IconBot,
  IconSparkles,
} from '../icons'

/* ------------------------------------------------------------------ */
/* Expandable "Thoughts" card                                          */
/* ------------------------------------------------------------------ */

/** The card is always called "Thoughts" — and always wears the brain icon. */
export const THOUGHTS_LABEL = 'Thoughts'

/**
 * Whether a thought card draws anything at all: it needs text to show, or to be
 * mid-stream. `ThinkingBlock` renders nothing otherwise, and the run timeline
 * uses the same answer to decide whether a thought separates two GitHub cards.
 */
function thoughtDraws(reasoning: string | undefined, streaming: boolean): boolean {
  return Boolean(reasoning?.trim()) || streaming
}

export function ThinkingBlock({
  reasoning,
  streaming = false,
}: {
  reasoning?: string
  streaming?: boolean
}) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const isExpanded = userToggled !== null ? userToggled : (streaming ? true : false)

  if (!thoughtDraws(reasoning, streaming)) return null

  const trimmed = reasoning?.trim() ?? ''
  const wordCount = trimmed ? trimmed.split(/\s+/).length : 0

  return (
    <div className={`thought-block${streaming ? ' streaming' : ''}${isExpanded ? ' open' : ' closed'}`}>
      <button
        type="button"
        className="thought-head"
        onClick={() => setUserToggled(!isExpanded)}
        aria-expanded={isExpanded}
        title={isExpanded ? 'Collapse thoughts' : 'Expand thoughts'}
      >
        <span className="thought-icon" aria-hidden="true">
          <IconBrain size={12} />
        </span>
        <span className="thought-title">{THOUGHTS_LABEL}</span>
        {trimmed || streaming ? (
          <span className="thought-meta">
            {streaming ? 'thinking…' : `${wordCount} ${wordCount === 1 ? 'word' : 'words'}`}
          </span>
        ) : null}
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

/**
 * Render the agent's thoughts and GitHub cards in the order they happened.
 * Every card is a row of its own — nothing folds, nothing expands — so a call
 * always sits between the thoughts it actually happened between. A thought that
 * is switched off (or has nothing to show) simply draws nothing.
 */
function AgentActivityTimeline({ run, status }: { run: AgentRun; status: Message['status'] }) {
  const settings = useSettings((s) => s.s)
  const items = run.timeline ?? []
  if (items.length === 0) return null

  const shown = items.filter(
    (item) =>
      item.type === 'github' ||
      (modelShowsThoughts(settings, item.modelId) &&
        thoughtDraws(item.text, status === 'streaming' && Boolean(item.streaming))),
  )

  return (
    <div className="agent-activity-timeline" aria-label="Agent activity">
      {shown.map((item) =>
        item.type === 'thought' ? (
          <ThinkingBlock
            key={item.id}
            reasoning={item.text}
            streaming={status === 'streaming' && Boolean(item.streaming)}
          />
        ) : (
          <GitHubActionCard key={item.id} entry={item.card} />
        ),
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
      <span className="typing-mark" aria-hidden="true">
        <IconStarburst size={16} />
      </span>
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

function Attachments({ ids, conversationId }: { ids?: string[]; conversationId: string }) {
  if (!ids?.length) return null
  return (
    <div className="msg-attachments">
      {ids.map((id) => (
        <ArtifactCard key={id} artifactId={id} conversationId={conversationId} />
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* GitHub action message                                               */
/* ------------------------------------------------------------------ */

/**
 * A call to `api.github.com` logged as a conversation message. The card is the
 * whole message: no author line, no body, no copy/retry/branch row — one call
 * reads as one line that scrolls and is saved with the chat.
 */
function GitHubActionMessage({ message }: { message: Message }) {
  const entry = message.githubAction!
  return (
    <article className="msg msg-assistant msg-gh-action" aria-label={entry.title}>
      <div className="msg-main">
        <GitHubActionCard entry={entry} />
      </div>
    </article>
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

  if (message.githubAction) return <GitHubActionMessage message={message} />

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
        {!isUser && !message.agent && message.failedChain?.length ? (
          <FailoverNote message={message} labelOf={labelOf} />
        ) : null}

        <Attachments ids={message.attachmentIds} conversationId={message.conversationId} />

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
  return <span className="msg-model"><span className="msg-model-name">{final || 'Assistant'}</span></span>
}

/** Keep the reason visible without making long provider errors dominate the transcript. */
function FailoverNote({ message, labelOf }: { message: Message; labelOf: (id: string | undefined) => string }) {
  const failed = message.failedChain ?? []
  const destination = labelOf(message.modelId ?? message.chain?.[message.chain.length - 1]) || 'another model'
  return (
    <details className="msg-failover">
      <summary><IconRefresh size={12} aria-hidden="true" /> Switched to {destination} after {failed.map(labelOf).join(', ')} failed · Why?</summary>
      <ul>
        {failed.map((id, i) => {
          const attempt = (message.attempts ?? []).find((a) => a.modelId === id)
          return <li key={`${id}-${i}`}><strong>{labelOf(id)}</strong>: {attempt?.message || 'No failure reason was recorded.'}</li>
        })}
      </ul>
    </details>
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
  const agentTimeline = message.agent?.timeline ?? []
  const synthesisThoughtInTimeline = agentTimeline.some((item) => item.type === 'thought' && item.sourceId === 'synthesis')
  const reasoningIsPlanning = Boolean(message.agent?.planningReasoning && message.reasoning === message.agent.planningReasoning)
  const showFallbackThought = showThoughts &&
    (message.agent
      ? Boolean(
          (message.reasoning && !synthesisThoughtInTimeline && !reasoningIsPlanning) ||
            (agentTimeline.length === 0 && streaming && !message.content.trim()),
        )
      : Boolean(message.reasoning || (streaming && !message.content.trim())))
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
      {message.agent && (
        <AgentPlanCard run={message.agent} labelOf={labelOf} conversationId={message.conversationId} />
      )}
      {/* Questions the run asked, and the answers it got — above the answer they shaped. */}
      {message.agent?.questions?.length ? (
        <AgentQuestions run={message.agent} messageId={message.id} />
      ) : null}
      {message.agent && !message.content.trim() && (pending || streaming) && message.agent.steps.length === 0 && (
        <TypingIndicator label={typingOn ? 'The orchestrator is working…' : ''} />
      )}
      {message.agent ? <AgentActivityTimeline run={message.agent} status={message.status} /> : null}
      {showFallbackThought ? (
        <ThinkingBlock
          reasoning={message.reasoning}
          streaming={streaming && !message.content.trim()}
        />
      ) : null}
      {segments.map((seg, i) => (
        <div key={i}>
          {seg.handoffTo ? (
            <HandoffDivider fromLabel={seg.fromLabel ?? ''} toLabel={labelOf(seg.handoffTo)} />
          ) : seg.text ? (
            <>
              <Markdown text={seg.text} provenance={provenance} messageId={message.id} conversationId={message.conversationId} />
              {streaming && i === segments.length - 1 ? <StreamCursor /> : null}
            </>
          ) : null}
        </div>
      ))}
      {/* Completion footer: where the roadmap stands once the run is done. */}
      {message.agent?.roadmap && message.agent.phase === 'complete' && message.status === 'complete' ? (
        <RoadmapTimeline report={message.agent.roadmap} conversationId={message.conversationId} />
      ) : null}
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

      {message.content.trim() ? (
        <ActionButton label="Remember this message" onClick={() => useUI.getState().openMemory(message.content)}>
          <IconBrain size={13} />
        </ActionButton>
      ) : null}

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
          if (newId) {
            useFs.getState().forkWorkspace(message.conversationId, newId)
            toast({
              kind: 'success',
              title: 'Branched into a new chat',
              detail: 'History and the current file workspace were copied into an isolated chat.',
            })
          }
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
