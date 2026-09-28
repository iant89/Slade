import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { ModelDef } from '../../types'
import { useChat, useCurrentConversation } from '../../store/chat'
import { useSettings } from '../../store/settings'
import { useHealth, isRoutable } from '../../store/health'
import { useArtifacts, artifactFromFile } from '../../store/artifacts'
import { useUI } from '../../store/ui'
import { sendUserMessage, stopGeneration, regenerateFromUserMessage } from '../../engine/send'
import { estimateTokens } from '../../lib/format'
import { ArtifactCard } from '../artifacts/ArtifactCard'
import { IconGear, IconGithub, IconPaperclip, IconSend, IconStop, IconChevronDown, IconFile, IconLayers, IconSliders, IconPlus, IconX } from '../icons'

/* ------------------------------------------------------------------ */
/* Model chip + quick switch                                           */
/* ------------------------------------------------------------------ */

export function currentPrimaryModel(settings: ReturnType<typeof useSettings.getState>['s'], convModelId?: string): ModelDef | undefined {
  const byId = (id?: string) => settings.models.find((m) => m.id === id && m.enabled)
  return byId(convModelId) ?? byId(settings.pinnedModelId) ?? settings.models.find((m) => m.enabled)
}

function ModelChip() {
  const conv = useCurrentConversation()
  const settings = useSettings((s) => s.s)
  const health = useHealth((s) => s.byModel)
  const setConversationModel = useChat((s) => s.setConversationModel)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const primary = currentPrimaryModel(settings, conv?.modelId)
  const enabled = settings.models.filter((m) => m.enabled)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const stateOf = (m: ModelDef) => {
    const h = health[m.id]
    if (!isRoutable(h, true)) {
      if (h?.state === 'error') return 'error'
      if (h?.cooldownUntil && h.cooldownUntil > Date.now()) return 'cooldown'
      return 'disabled'
    }
    return 'available'
  }

  return (
    <div className="model-chip-wrap" ref={ref}>
      <button
        className="model-chip"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Primary model — Slade fails over down the rest of your priority chain"
        type="button"
      >
        <span className={`state-dot ${stateOf(primary ?? ({} as ModelDef))}`} aria-hidden="true" />
        <span className="model-chip-label">{primary?.label ?? 'No model enabled'}</span>
        <IconChevronDown size={12} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="model-menu"
            role="listbox"
            aria-label="Choose primary model"
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 500, damping: 34 }}
          >
            <button
              className={`model-menu-item${!conv?.modelId ? ' selected' : ''}`}
              role="option"
              aria-selected={!conv?.modelId}
              onClick={() => {
                setConversationModel(conv!.id, undefined)
                setOpen(false)
              }}
              type="button"
            >
              <IconLayers size={13} />
              <span>
                Chain default <small>(strict priority)</small>
              </span>
            </button>
            {enabled.map((m) => {
              const st = stateOf(m)
              return (
                <button
                  key={m.id}
                  className={`model-menu-item${conv?.modelId === m.id ? ' selected' : ''}`}
                  role="option"
                  aria-selected={conv?.modelId === m.id}
                  onClick={() => {
                    setConversationModel(conv!.id, m.id)
                    setOpen(false)
                  }}
                  type="button"
                >
                  <span className={`state-dot ${st}`} aria-hidden="true" />
                  <span className="model-menu-label">{m.label}</span>
                  <span className="model-menu-state">{st === 'cooldown' ? 'cooling' : st}</span>
                </button>
              )
            })}
            {enabled.length === 0 && (
              <div className="model-menu-empty">No models enabled — open Settings → Models.</div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Slash command menu                                                  */
/* ------------------------------------------------------------------ */

const COMMANDS = [
  { cmd: '/system', label: '/system', hint: 'Edit the default system prompt', icon: <IconSliders size={13} /> },
  { cmd: '/model', label: '/model', hint: 'Quick-switch the primary model', icon: <IconLayers size={13} /> },
  { cmd: '/github', label: '/github', hint: 'Browse a repo and attach files as context', icon: <IconGithub size={13} /> },
  { cmd: '/sample', label: '/sample', hint: 'Attach sample files (CSV, code, image…)', icon: <IconFile size={13} /> },
  { cmd: '/new', label: '/new', hint: 'Start a new conversation', icon: <IconPlus size={13} /> },
] as const

/* ------------------------------------------------------------------ */
/* Sample attachments                                                  */
/* ------------------------------------------------------------------ */

const SAMPLES: { file: string; label: string }[] = [
  { file: 'sales_q3.csv', label: 'sales_q3.csv' },
  { file: 'failover.ts', label: 'failover.ts' },
  { file: 'field-notes.md', label: 'field-notes.md' },
  { file: 'canyon.jpg', label: 'canyon.jpg' },
  { file: 'chime.wav', label: 'chime.wav' },
]

async function attachSample(name: string): Promise<void> {
  const { addPendingAttachment } = useUI.getState()
  const { add } = useArtifacts.getState()
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}samples/${name}`)
    if (!res.ok) throw new Error(String(res.status))
    const blob = await res.blob()
    const file = new File([blob], name, { type: blob.type })
    const artifact = await artifactFromFile(file)
    add(artifact)
    addPendingAttachment(artifact.id)
  } catch {
    useUI.getState().toast({ kind: 'error', title: `Couldn't load sample ${name}` })
  }
}

/* ------------------------------------------------------------------ */
/* Composer                                                            */
/* ------------------------------------------------------------------ */

export function Composer() {
  const conv = useCurrentConversation()
  const enterToSend = useSettings((s) => s.s.appearance.enterToSend)
  const pendingIds = useUI((s) => s.pendingAttachmentIds)
  const removePending = useUI((s) => s.removePendingAttachment)
  const clearPending = useUI((s) => s.clearPendingAttachments)
  const toast = useUI((s) => s.toast)
  const openSettings = useUI((s) => s.openSettings)

  const [text, setText] = useState('')
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const generating = useGenerating(conv?.id)
  const canSend = text.trim().length > 0 && !generating && !!conv

  const grow = useCallback(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(220, ta.scrollHeight)}px`
  }, [])

  useEffect(grow, [text, grow])

  // "Send back to model" bridge from artifact cards.
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<string>).detail
      if (typeof id === 'string') useUI.getState().addPendingAttachment(id)
    }
    window.addEventListener('slade:attach-artifact', handler)
    return () => window.removeEventListener('slade:attach-artifact', handler)
  }, [])

  const ingestFiles = useCallback(
    async (files: FileList | File[]) => {
      const { add } = useArtifacts.getState()
      const { addPendingAttachment } = useUI.getState()
      for (const file of Array.from(files)) {
        try {
          const artifact = await artifactFromFile(file)
          add(artifact)
          addPendingAttachment(artifact.id)
        } catch {
          toast({ kind: 'error', title: `Couldn't attach ${file.name}` })
        }
      }
    },
    [toast],
  )

  // Paste-to-attach.
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files)
    if (files.length > 0) {
      e.preventDefault()
      void ingestFiles(files)
    }
  }

  // Window-level drag & drop.
  useEffect(() => {
    let depth = 0
    const onEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      depth++
      useUI.getState().setDragActive(true)
    }
    const onLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) useUI.getState().setDragActive(false)
    }
    const onOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      depth = 0
      useUI.getState().setDragActive(false)
      if (!e.dataTransfer?.files?.length) return
      e.preventDefault()
      void ingestFiles(e.dataTransfer.files)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [ingestFiles])

  const send = () => {
    if (!conv) return
    if (generating) {
      stopGeneration(conv.id)
      return
    }
    const trimmed = text.trim()
    if (!trimmed) return
    setText('')
    setSlashOpen(false)
    const ids = [...pendingIds]
    clearPending()
    void sendUserMessage(trimmed, ids).then(() => {
      taRef.current?.focus()
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % COMMANDS.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + COMMANDS.length) % COMMANDS.length)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        runCommand(COMMANDS[slashIndex]!.cmd)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashOpen(false)
        return
      }
    }
    const sendKey = e.key === 'Enter' && !e.shiftKey
    if (sendKey && enterToSend && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  const runCommand = (cmd: (typeof COMMANDS)[number]['cmd']) => {
    setSlashOpen(false)
    setText((t) => t.replace(/^\/\S*\s?/, ''))
    taRef.current?.focus()
    if (cmd === '/system') openSettings('defaults')
    if (cmd === '/model') document.querySelector<HTMLButtonElement>('.model-chip')?.click()
    if (cmd === '/new') useChat.getState().newConversation()
    if (cmd === '/github') useUI.getState().openGithub('files')
    if (cmd === '/sample') {
      void attachSample(SAMPLES[0]!.file)
      toast({ kind: 'info', title: 'Sample attached', detail: `Added ${SAMPLES[0]!.label} to the composer.` })
    }
  }

  const slashMatches = useMemo(() => {
    if (!slashOpen) return []
    const q = text.slice(1).toLowerCase()
    return COMMANDS.filter((c) => c.cmd.slice(1).startsWith(q))
  }, [slashOpen, text])

  const onTextChange = (v: string) => {
    setText(v)
    const isSlash = v === '/' || (v.startsWith('/') && !v.includes('\n') && !v.includes(' '))
    setSlashOpen(isSlash)
    if (isSlash) setSlashIndex(0)
  }

  const tokens = estimateTokens(text + pendingIds.length * 500)

  return (
    <div className="composer-wrap">
      {pendingIds.length > 0 && (
        <div className="pending-row" aria-label="Attachments queued for next message">
          {pendingIds.map((id) => (
            <div key={id} className="pending-chip">
              <ArtifactCard artifactId={id} />
              <button className="pending-remove icon-btn" onClick={() => removePending(id)} aria-label="Remove attachment" type="button">
                <IconX size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="composer">
        <AnimatePresence>
          {slashOpen && slashMatches.length > 0 && (
            <motion.div
              className="slash-menu"
              role="listbox"
              aria-label="Composer commands"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ type: 'spring', stiffness: 520, damping: 34 }}
            >
              {slashMatches.map((c, i) => (
                <button
                  key={c.cmd}
                  role="option"
                  aria-selected={i === slashIndex}
                  className={`slash-item${i === slashIndex ? ' active' : ''}`}
                  onMouseEnter={() => setSlashIndex(i)}
                  onClick={() => runCommand(c.cmd)}
                  type="button"
                >
                  {c.icon}
                  <span className="slash-cmd">{c.label}</span>
                  <span className="slash-hint">{c.hint}</span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <textarea
          ref={taRef}
          className="composer-input"
          value={text}
          rows={1}
          placeholder={conv ? 'Message Slade…  ( / for shortcuts )' : 'New chat…'}
          aria-label="Message composer"
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />

        <div className="composer-bar">
          <div className="composer-left">
            <button
              className="icon-btn"
              onClick={() => fileInput.current?.click()}
              aria-label="Attach files"
              title="Attach files (or drag & drop / paste)"
              type="button"
            >
              <IconPaperclip size={16} />
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void ingestFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <ModelChip />
          </div>

          <div className="composer-right">
            <span className="composer-count" aria-label={`${text.length} characters, about ${tokens} tokens`}>
              {text.length > 0 ? `${text.length} chars · ~${tokens} tok` : ''}
            </span>
            {generating ? (
              <button className="send-btn stop" onClick={() => conv && stopGeneration(conv.id)} aria-label="Stop generating" type="button">
                <IconStop size={14} />
              </button>
            ) : (
              <button className="send-btn" onClick={send} disabled={!canSend} aria-label="Send message" type="button">
                <IconSend size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="composer-foot">
        <span>
          <strong>Enter</strong> to send · <strong>Shift+Enter</strong> for newline
        </span>
        <button className="link-btn" onClick={() => openSettings('providers')} type="button">
          <IconGear size={11} /> providers & keys
        </button>
      </div>
    </div>
  )
}

/* Track in-flight generation reactively via chat store message status. */
function useGenerating(conversationId?: string): boolean {
  const conv = useChat((s) => (conversationId ? s.conversations[conversationId] : undefined))
  if (!conv) return false
  return conv.messages.some((m) => m.status === 'streaming' || m.status === 'pending')
}

/** Allow other modules to re-dispatch without prop drilling. */
export { regenerateFromUserMessage }
