import type { FailureClass, Handoff, ModelDef, Settings, StreamEvent, Usage } from '../types'
import { useChat, titleFromPrompt } from '../store/chat'
import { useSettings, effectiveParams, providerKey } from '../store/settings'
import { useHealth } from '../store/health'
import { useUI } from '../store/ui'
import { adapterFor } from '../providers/registry'
import { ProviderError } from '../providers/base'
import { buildTurns } from './turns'
import { failureSummary, handoff, mergeUsage, newAssistantPlaceholder, routeCandidates } from './strategy'
import { uid } from '../lib/id'

/* ------------------------------------------------------------------ */
/* In-flight generation registry (one per conversation)                */
/* ------------------------------------------------------------------ */

interface ActiveAttempt {
  controller: AbortController
  userAborted: boolean
}
const active = new Map<string, ActiveAttempt>()

export function stopGeneration(conversationId: string): void {
  const a = active.get(conversationId)
  if (a) {
    a.userAborted = true
    a.controller.abort()
  }
}

export function isGenerating(conversationId: string): boolean {
  return active.has(conversationId)
}

/* ------------------------------------------------------------------ */
/* Chain state                                                         */
/* ------------------------------------------------------------------ */

interface ChainState {
  content: string
  chain: string[]
  failedChain: string[]
  handoffs: Handoff[]
  usage?: Usage
}

interface FailureRow {
  label: string
  failure: FailureClass
  message: string
}

class ChainExhausted extends Error {
  summary: string
  constructor(summary: string) {
    super(summary)
    this.summary = summary
  }
}

/* ------------------------------------------------------------------ */
/* Public entry points                                                 */
/* ------------------------------------------------------------------ */

/** Append a user message and dispatch a completion for it. */
export async function sendUserMessage(text: string, attachmentIds: string[]): Promise<void> {
  const chat = useChat.getState()
  let convId = chat.currentId
  if (!convId || !chat.conversations[convId]) convId = chat.newConversation()

  const conv = useChat.getState().conversations[convId]
  if (!conv) return
  const isFirst = conv.messages.length === 0

  const userMessage = {
    id: uid('msg'),
    role: 'user' as const,
    conversationId: convId,
    content: text,
    createdAt: Date.now(),
    status: 'complete' as const,
    attachmentIds: attachmentIds.length ? attachmentIds : undefined,
  }
  useChat.getState().appendMessage(userMessage)
  if (isFirst) useChat.getState().renameConversation(convId, titleFromPrompt(text))

  const assistant = newAssistantPlaceholder(convId)
  useChat.getState().appendMessage(assistant)

  await runChain(convId, userMessage.id, assistant.id)
}

/** Re-run the chain for the user message that precedes an assistant message. */
export async function retryAssistant(assistantMessageId: string): Promise<void> {
  const chat = useChat.getState()
  let target: { convId: string; userId: string } | null = null
  for (const conv of Object.values(chat.conversations)) {
    const idx = conv.messages.findIndex((m) => m.id === assistantMessageId)
    if (idx > 0) {
      const prev = conv.messages[idx - 1]
      if (prev && prev.role === 'user') target = { convId: conv.id, userId: prev.id }
      break
    }
  }
  if (!target) return
  useChat.getState().deleteMessage(assistantMessageId)
  const assistant = newAssistantPlaceholder(target.convId)
  useChat.getState().appendMessage(assistant)
  await runChain(target.convId, target.userId, assistant.id)
}

/** (Re)generate an assistant reply for an existing user message. */
export async function regenerateFromUserMessage(
  conversationId: string,
  userMessageId: string,
): Promise<void> {
  const assistant = newAssistantPlaceholder(conversationId)
  useChat.getState().appendMessage(assistant)
  await runChain(conversationId, userMessageId, assistant.id)
}

/* ------------------------------------------------------------------ */
/* The failover chain walk                                             */
/* ------------------------------------------------------------------ */

async function runChain(
  conversationId: string,
  userMessageId: string,
  assistantMessageId: string,
): Promise<void> {
  if (active.has(conversationId)) {
    // A completion is already running here; refuse to double-charge.
    useUI.getState().toast({ kind: 'warn', title: 'A response is already streaming in this chat.' })
    return
  }

  const settings = useSettings.getState().s
  const conv = useChat.getState().conversations[conversationId]
  if (!conv) return

  const primaryModelId = conv.modelId ?? settings.pinnedModelId
  const candidates = routeCandidates(settings, useHealth.getState().byModel, primaryModelId)
  const turns = await buildTurns(conv, { upToMessageId: userMessageId })

  const controller = new AbortController()
  const attempt: ActiveAttempt = { controller, userAborted: false }
  active.set(conversationId, attempt)

  const state: ChainState = {
    content: '',
    chain: [],
    failedChain: [],
    handoffs: [],
    usage: undefined,
  }
  const failureRows: FailureRow[] = []

  const persistAttempt = () => updateAttemptFields(assistantMessageId, state)

  try {
    if (candidates.length === 0) {
      throw new ChainExhausted(
        'No eligible models right now — every model is disabled, cooling down, or missing an API key. Clear cooldowns or enable a model in Settings → Models.',
      )
    }

    for (let i = 0; i < candidates.length; i++) {
      const model = candidates[i]!
      if (controller.signal.aborted) break
      try {
        await attemptModel({ model, turns, settings, controller, state, assistantMessageId, attempt })
        finalize(assistantMessageId, {
          status: 'complete',
          modelId: lastOf(state.chain),
          chain: [...state.chain],
          failedChain: [...state.failedChain],
          handoffs: [...state.handoffs],
          usage: state.usage,
          error: undefined,
          errorClass: undefined,
        })
        return
      } catch (err) {
        const pe =
          err instanceof ProviderError ? err : new ProviderError('unknown', err instanceof Error ? err.message : String(err), true)
        if (pe.failure === 'aborted' && attempt.userAborted) {
          finalizeCancelled(assistantMessageId, state, state.content.trim().length > 0)
          return
        }

        // Classify, apply cooldown policy, then walk the chain.
        const cooldownUntil = useHealth.getState().recordFailure(model.id, pe.failure, pe.message)
        const label = modelLabel(settings.models, model.id)
        const row: FailureRow = { label, failure: pe.failure, message: pe.message }
        failureRows.push(row)
        const isLast = i === candidates.length - 1

        if (state.content.length === 0) {
          // Pre-stream failure: clean handoff to the next candidate.
          state.failedChain.push(model.id)
          persistAttempt()
          if (isLast) throw new ChainExhausted(failureSummary(failureRows))
          useUI.getState().toast({
            kind: 'warn',
            title: `${label}: ${shortFailure(pe)}`,
            detail: cooldownUntil
              ? `Cooling down ~${Math.round(cooldownUntil / 1000)}s — failing over…`
              : 'Failing over to the next model…',
          })
        } else {
          // Mid-stream failure: keep partial output, mark the handoff, continue.
          const nextModel = candidates[i + 1]
          if (nextModel) {
            state.handoffs.push(handoff(model, nextModel, state.content.length))
            persistAttempt()
            useUI.getState().toast({
              kind: 'warn',
              title: `${label} dropped mid-stream (${shortFailure(pe)})`,
              detail: `Handing off to ${modelLabel(settings.models, nextModel.id)} — your text so far is preserved.`,
            })
          } else {
            persistAttempt()
            throw new ChainExhausted(failureSummary(failureRows))
          }
        }
      }
    }
    throw new ChainExhausted('The chain walked to the end without a completed response.')
  } catch (err) {
    if (err instanceof ChainExhausted && attempt.userAborted) {
      finalizeCancelled(assistantMessageId, state, state.content.trim().length > 0)
    } else if (err instanceof ChainExhausted) {
      finalize(assistantMessageId, {
        status: 'error',
        modelId: lastOf(state.chain),
        chain: [...state.chain],
        failedChain: [...state.failedChain],
        handoffs: [...state.handoffs],
        usage: state.usage,
        error: err.summary,
        errorClass: 'unknown',
      })
      useUI.getState().toast({ kind: 'error', title: 'Every model in the chain failed', detail: err.summary })
    } else {
      const message = err instanceof Error ? err.message : String(err)
      finalize(assistantMessageId, {
        status: 'error',
        chain: [...state.chain],
        failedChain: [...state.failedChain],
        handoffs: [...state.handoffs],
        error: message,
        errorClass: 'unknown',
      })
      useUI.getState().toast({ kind: 'error', title: 'Unexpected failure', detail: message })
    }
  } finally {
    active.delete(conversationId)
  }
}

function lastOf<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1]
}

function shortFailure(pe: ProviderError): string {
  switch (pe.failure) {
    case 'soft_rate_limit': return 'rate limited'
    case 'hard_quota': return 'quota exhausted'
    case 'auth': return 'auth failure'
    case 'timeout': return 'timed out'
    case 'network': return 'network error'
    case 'overloaded': return 'overloaded'
    default: return 'error'
  }
}

function modelLabel(models: ModelDef[], id: string | undefined): string {
  return models.find((m) => m.id === id)?.label ?? (id ?? 'unknown model')
}

function updateAttemptFields(assistantMessageId: string, state: ChainState): void {
  useChat.getState().mutateMessage(assistantMessageId, (m) => ({
    ...m,
    content: state.content,
    chain: [...state.chain],
    failedChain: [...state.failedChain],
    handoffs: [...state.handoffs],
  }))
}

function finalize(
  assistantMessageId: string,
  patch: {
    status: 'complete' | 'error' | 'cancelled'
    modelId?: string
    chain?: string[]
    failedChain?: string[]
    handoffs?: Handoff[]
    usage?: Usage
    error?: string
    errorClass?: FailureClass | undefined
  },
): void {
  useChat.getState().mutateMessage(assistantMessageId, (m) => ({ ...m, ...patch }))
}

function finalizeCancelled(assistantMessageId: string, state: ChainState, keep: boolean): void {
  if (!keep) {
    useChat.getState().deleteMessage(assistantMessageId)
    return
  }
  finalize(assistantMessageId, {
    status: 'cancelled',
    modelId: lastOf(state.chain),
    chain: [...state.chain],
    failedChain: [...state.failedChain],
    handoffs: [...state.handoffs],
    usage: state.usage,
  })
}

/* ------------------------------------------------------------------ */
/* Single model attempt                                                */
/* ------------------------------------------------------------------ */

async function attemptModel(args: {
  model: ModelDef
  turns: Awaited<ReturnType<typeof buildTurns>>
  settings: Settings
  controller: AbortController
  state: ChainState
  assistantMessageId: string
  attempt: ActiveAttempt
}): Promise<void> {
  const { model, turns, settings, controller, state, assistantMessageId, attempt } = args
  const adapter = adapterFor(model.provider)
  const apiKey = providerKey(settings, model)
  if (model.provider !== 'mock' && !apiKey) {
    throw new ProviderError('auth', `No API key configured for ${model.provider}.`, false)
  }

  const params = effectiveParams(settings, model.id)
  const attemptController = new AbortController()
  const onAbort = () => attemptController.abort()
  controller.signal.addEventListener('abort', onAbort, { once: true })

  // Idle timeout: armed at start, reset on every delta. A stalled stream is
  // classified as a timeout and the chain moves on.
  let timedOut = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      timedOut = true
      attemptController.abort()
    }, settings.defaults.requestTimeoutMs)
  }
  const disarmIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }

  const startedAt = performance.now()
  let gotFirstDelta = false
  let usagePiece: Usage | undefined

  const onEvent = (ev: StreamEvent): void => {
    switch (ev.type) {
      case 'delta': {
        if (!gotFirstDelta) {
          gotFirstDelta = true
          state.chain.push(model.id)
          useChat.getState().mutateMessage(assistantMessageId, (m) => ({
            ...m,
            status: 'streaming',
            ttftMs: Math.round(performance.now() - startedAt),
            modelId: model.id,
            chain: [...state.chain],
          }))
        }
        state.content += ev.text
        useChat.getState().mutateMessage(assistantMessageId, (m) => ({ ...m, content: state.content }))
        armIdle()
        break
      }
      case 'usage':
        usagePiece = { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens }
        break
      case 'done':
        break
      case 'error':
        throw new ProviderError(ev.failure, ev.message, ev.retryable)
    }
  }

  armIdle()
  try {
    await adapter.run({
      model,
      turns,
      systemPrompt: params.systemPrompt,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      topP: params.topP,
      stream: settings.defaults.stream,
      apiKey,
      signal: attemptController.signal,
      onEvent,
    })
    if (!gotFirstDelta) {
      throw new ProviderError('unknown', 'Provider returned an empty response.', true)
    }
    const latencyMs = Math.round(performance.now() - startedAt)
    state.usage = mergeUsage(state.usage, usagePiece)
    useHealth.getState().recordSuccess(model.id, latencyMs, usagePiece)
    announce(`Response from ${model.label}.`)
  } catch (err) {
    if (attempt.userAborted) {
      throw new ProviderError('aborted', 'Cancelled.', false)
    }
    if (timedOut) {
      throw new ProviderError('timeout', 'The stream stalled and timed out.', true)
    }
    throw err
  } finally {
    disarmIdle()
    controller.signal.removeEventListener('abort', onAbort)
  }
}

/* ------------------------------------------------------------------ */
/* ARIA live announcements                                             */
/* ------------------------------------------------------------------ */

let announceHandler: (() => void) | null = null
let announcement = ''
export function setAnnouncer(fn: () => void): void {
  announceHandler = fn
}
export function announceResponse(text: string): void {
  announcement = text
  announceHandler?.()
}
function announce(text: string): void {
  announceResponse(text)
}
export function currentAnnouncement(): string {
  return announcement
}
