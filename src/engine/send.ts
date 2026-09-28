import type { AttemptFailure, FailureClass, Handoff, ModelDef, ProviderDef, Settings, StreamEvent, Usage } from '../types'
import { useChat, titleFromPrompt } from '../store/chat'
import { useSettings, effectiveParams } from '../store/settings'
import { useHealth } from '../store/health'
import { useUI } from '../store/ui'
import { adapterFor } from '../providers/registry'
import { ProviderError } from '../providers/base'
import { buildTurns } from './turns'
import { failureSummary, handoff, mergeUsage, newAssistantPlaceholder, routeCandidates, skippedModels } from './strategy'
import { escalateTokens } from './completion'
import { finishRun, getRun, registerRun, stopGeneration, isGenerating, type ActiveRun } from './active'
import { runAgentTurn } from './agent'
import { uid } from '../lib/id'
import { announceResponse, currentAnnouncement, setAnnouncer } from './announce'

export { stopGeneration, isGenerating, setAnnouncer, announceResponse, currentAnnouncement }

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

  await dispatchTurn(convId, userMessage.id, assistant.id)
}

/** Re-run the chain for the user message that precedes an assistant message. */
export async function retryAssistant(assistantMessageId: string): Promise<void> {
  const chat = useChat.getState()
  let target: { convId: string; userId: string; agent: boolean } | null = null
  for (const conv of Object.values(chat.conversations)) {
    const idx = conv.messages.findIndex((m) => m.id === assistantMessageId)
    if (idx > 0) {
      const prev = conv.messages[idx - 1]
      if (prev && prev.role === 'user') target = { convId: conv.id, userId: prev.id, agent: Boolean(conv.agentEnabled) }
      break
    }
  }
  if (!target) return
  useChat.getState().deleteMessage(assistantMessageId)
  const assistant = newAssistantPlaceholder(target.convId)
  useChat.getState().appendMessage(assistant)
  await dispatchTurn(target.convId, target.userId, assistant.id)
}

/** (Re)generate an assistant reply for an existing user message. */
export async function regenerateFromUserMessage(
  conversationId: string,
  userMessageId: string,
): Promise<void> {
  const assistant = newAssistantPlaceholder(conversationId)
  useChat.getState().appendMessage(assistant)
  await dispatchTurn(conversationId, userMessageId, assistant.id)
}

/** Agent mode talks to the orchestrator; everything else walks the plain chain. */
function dispatchTurn(
  conversationId: string,
  userMessageId: string,
  assistantMessageId: string,
): Promise<void> {
  const conv = useChat.getState().conversations[conversationId]
  if (conv?.agentEnabled) return runAgentTurn(conversationId, userMessageId, assistantMessageId)
  return runChain(conversationId, userMessageId, assistantMessageId)
}

interface ChainState {
  content: string
  chain: string[]
  failedChain: string[]
  handoffs: Handoff[]
  usage?: Usage
}

class ChainExhausted extends Error {
  summary: string
  constructor(summary: string) {
    super(summary)
    this.summary = summary
  }
}

/* ------------------------------------------------------------------ */
/* The failover chain walk                                             */
/* ------------------------------------------------------------------ */

async function runChain(
  conversationId: string,
  userMessageId: string,
  assistantMessageId: string,
): Promise<void> {
  if (getRun(conversationId)) {
    // A completion is already running here; refuse to double-charge.
    useUI.getState().toast({ kind: 'warn', title: 'A response is already streaming in this chat.' })
    return
  }

  const settings = useSettings.getState().s
  const conv = useChat.getState().conversations[conversationId]
  if (!conv) return

  const primaryModelId = conv.modelId ?? settings.pinnedModelId
  const healthByModel = useHealth.getState().byModel
  const candidates = routeCandidates(settings, healthByModel, primaryModelId)
  // Captured at chain start: if the chain dies, the summary must also say why
  // enabled models never got a turn — otherwise a one-model attempt reads as
  // "the failover engine is broken" instead of "these models are benched".
  const skipped = skippedModels(settings, healthByModel)
  const turns = await buildTurns(conv, { upToMessageId: userMessageId })

  const controller = new AbortController()
  const attempt = registerRun(conversationId, controller)

  const state: ChainState = {
    content: '',
    chain: [],
    failedChain: [],
    handoffs: [],
    usage: undefined,
  }
  const failureRows: AttemptFailure[] = []

  const persistAttempt = () => updateAttemptFields(assistantMessageId, state)

  try {
    if (candidates.length === 0) {
      const detail = skipped.length
        ? skipped.map((s) => `${s.label}: ${s.reason}`).join('; ')
        : 'every model is disabled. Enable a model in Settings → Models.'
      throw new ChainExhausted(`No eligible models right now — ${detail}. Clear cooldowns or enable a model in Settings → Models.`)
    }

    for (let i = 0; i < candidates.length; i++) {
      const model = candidates[i]!
      if (controller.signal.aborted) break
      const startedAt = performance.now()
      try {
        const outcome = await attemptModel({ model, turns, settings, controller, state, assistantMessageId, attempt })
        if (outcome.truncated) {
          useUI.getState().toast({
            kind: 'warn',
            title: `${modelLabel(settings.models, model.id)} stopped at the output cap`,
            detail: `The answer was cut off at ${outcome.maxTokensUsed.toLocaleString('en-US')} tokens — raise Max output tokens in Settings → Defaults for the rest of it.`,
          })
        }
        finalize(assistantMessageId, {
          status: 'complete',
          modelId: lastOf(state.chain),
          chain: [...state.chain],
          failedChain: [...state.failedChain],
          handoffs: [...state.handoffs],
          usage: state.usage,
          truncated: outcome.truncated || undefined,
          error: undefined,
          errorClass: undefined,
          // The turn succeeded, but the failures that forced the failover are
          // part of its story — persist them so the "fell back from" chip can
          // say *why*, not just *who*.
          attempts: [...failureRows],
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
        const row: AttemptFailure = {
          modelId: model.id,
          label,
          failure: pe.failure,
          message: pe.message,
          status: pe.status,
          elapsedMs: Math.round(performance.now() - startedAt),
          midStream: state.content.length > 0,
        }
        failureRows.push(row)
        const isLast = i === candidates.length - 1

        if (state.content.length === 0) {
          // Pre-stream failure: clean handoff to the next candidate.
          state.failedChain.push(model.id)
          persistAttempt()
          if (isLast) throw new ChainExhausted(failureSummary(failureRows, remainingSkipped(failureRows, skipped)))
          useUI.getState().toast({
            kind: 'warn',
            title: `${label}: ${shortFailure(pe)}`,
            // The provider's own reason, not a generic one — this is the line
            // that tells the user what to actually go and fix.
            detail: `${pe.message}${cooldownUntil ? ` · cooling down ~${Math.round(cooldownUntil / 1000)}s` : ''}`,
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
              detail: `Handing off to ${modelLabel(settings.models, nextModel.id)} — ${pe.message}`,
            })
          } else {
            persistAttempt()
            throw new ChainExhausted(failureSummary(failureRows, remainingSkipped(failureRows, skipped)))
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
        // Keep the real class of the last failure. Hardcoding 'unknown' here
        // is what made every failure read as "Unknown error" in the UI.
        errorClass: lastOf(failureRows)?.failure ?? 'unknown',
        attempts: [...failureRows],
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
    finishRun(conversationId)
  }
}

function lastOf<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1]
}

/** A model already accounted for in `failureRows` would be double-reported. */
function remainingSkipped(
  failureRows: { modelId: string }[],
  skipped: ReturnType<typeof skippedModels>,
): ReturnType<typeof skippedModels> {
  const attempted = new Set(failureRows.map((r) => r.modelId))
  return skipped.filter((s) => !attempted.has(s.modelId))
}

function shortFailure(pe: ProviderError): string {
  switch (pe.failure) {
    case 'soft_rate_limit': return 'rate limited'
    case 'hard_quota': return 'quota exhausted'
    case 'auth': return 'auth failure'
    case 'timeout': return 'timed out'
    case 'network': return 'network error'
    case 'overloaded': return 'overloaded'
    case 'bad_request': return 'request rejected'
    case 'token_budget': return 'ran out of output budget'
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
    truncated?: boolean
    error?: string
    errorClass?: FailureClass | undefined
    attempts?: AttemptFailure[]
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

/** What one adapter run observed, readable by the caller even after a throw. */
interface ObservedTurn {
  contentChars: number
  reasoningChars: number
  usage?: Usage
  truncated: boolean
  timedOut: 'first-token' | 'stalled' | null
}

/**
 * Run one model for this turn, with a single automatic retry at a larger
 * output cap.
 *
 * A `token_budget` failure is the provider saying "I answered, but the cap ran
 * out before any answer text" — what a reasoning model does when its thinking
 * costs more than `max_tokens` allows. The model is fine and the next candidate
 * in the chain would hit the identical wall at the identical cap, so the cap is
 * raised and the same model is asked once more before failover walks on.
 */
async function attemptModel(args: {
  model: ModelDef
  turns: Awaited<ReturnType<typeof buildTurns>>
  settings: Settings
  controller: AbortController
  state: ChainState
  assistantMessageId: string
  attempt: ActiveRun
}): Promise<{ truncated: boolean; maxTokensUsed: number }> {
  const { model, settings, controller, state, attempt } = args
  const provider = settings.providers.find((p) => p.id === model.provider)
  if (!provider) {
    throw new ProviderError('unknown', `Provider "${model.provider}" no longer exists — re-add it in Settings → Providers.`, false)
  }
  const apiKey = provider.apiKey
  if (provider.kind !== 'mock' && !apiKey) {
    throw new ProviderError('auth', `No API key configured for ${provider.label}.`, false)
  }

  const params = effectiveParams(settings, model.id)
  let budget = params.maxTokens
  let escalated = false

  for (;;) {
    const startedAt = performance.now()
    const observed: ObservedTurn = { contentChars: 0, reasoningChars: 0, truncated: false, timedOut: null }
    const contentBefore = state.content.length
    try {
      await attemptOnce({ ...args, provider, maxTokens: budget, apiKey, observed })
      if (observed.usage) state.usage = mergeUsage(state.usage, observed.usage)
      useHealth.getState().recordSuccess(model.id, Math.round(performance.now() - startedAt), observed.usage)
      announce(`Response from ${model.label}.`)
      return { truncated: observed.truncated, maxTokensUsed: budget }
    } catch (err) {
      if (attempt.userAborted || controller.signal.aborted) {
        throw new ProviderError('aborted', 'Cancelled.', false)
      }
      const pe =
        err instanceof ProviderError ? err : new ProviderError('unknown', err instanceof Error ? err.message : String(err), true)

      // Nothing was streamed, so re-issuing cannot duplicate text.
      if (!escalated && pe.failure === 'token_budget' && state.content.length === contentBefore) {
        const next = escalateTokens(budget, model.contextWindow)
        if (next > budget) {
          escalated = true
          useHealth.getState().recordFailure(model.id, pe.failure, pe.message)
          useUI.getState().toast({
            kind: 'warn',
            title: `${model.label} ran out of output budget`,
            detail: `${pe.message} Retrying the same model with ${next.toLocaleString('en-US')} output tokens.`,
          })
          budget = next
          continue
        }
      }
      throw pe
    }
  }
}

/**
 * One adapter run with both timeout budgets armed around it.
 *
 * Two separate budgets, because "no first token yet" and "the stream went
 * quiet" are different problems with different fixes. Reasoning models
 * (Gemini 2.5, o-series, extended thinking) routinely take longer than the
 * idle budget to produce their first *answer* token; their reasoning deltas
 * count as liveness, so they are not cut off mid-thought and benched for it.
 */
async function attemptOnce(args: {
  model: ModelDef
  turns: Awaited<ReturnType<typeof buildTurns>>
  settings: Settings
  controller: AbortController
  state: ChainState
  assistantMessageId: string
  attempt: ActiveRun
  maxTokens: number
  provider: ProviderDef
  apiKey: string
  observed: ObservedTurn
}): Promise<void> {
  const { model, turns, settings, controller, state, assistantMessageId, maxTokens, provider, apiKey, observed } = args
  const adapter = adapterFor(provider.kind)
  const params = effectiveParams(settings, model.id)
  const attemptController = new AbortController()
  const onAbort = () => attemptController.abort()
  controller.signal.addEventListener('abort', onAbort, { once: true })

  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = (kind: 'first-token' | 'stalled', ms: number) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      observed.timedOut = kind
      attemptController.abort()
    }, ms)
  }
  const disarm = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const startedAt = performance.now()

  const onEvent = (ev: StreamEvent): void => {
    switch (ev.type) {
      case 'delta': {
        if (observed.contentChars === 0) {
          state.chain.push(model.id)
          useChat.getState().mutateMessage(assistantMessageId, (m) => ({
            ...m,
            status: 'streaming',
            ttftMs: Math.round(performance.now() - startedAt),
            modelId: model.id,
            chain: [...state.chain],
          }))
          arm('stalled', settings.defaults.requestTimeoutMs)
        }
        observed.contentChars += ev.text.length
        state.content += ev.text
        useChat.getState().mutateMessage(assistantMessageId, (m) => ({ ...m, content: state.content }))
        break
      }
      case 'reasoning':
        // Thinking is not answer text and never reaches the transcript, but it
        // is proof the model is alive: swap the first-token budget for the
        // idle budget so a long thought is not mistaken for a dead stream.
        observed.reasoningChars += ev.text.length
        arm('stalled', settings.defaults.requestTimeoutMs)
        break
      case 'usage':
        // Providers split usage across frames; keep what a frame omitted.
        observed.usage = {
          promptTokens: ev.promptTokens ?? observed.usage?.promptTokens,
          completionTokens: ev.completionTokens ?? observed.usage?.completionTokens,
          reasoningTokens: ev.reasoningTokens ?? observed.usage?.reasoningTokens,
        }
        break
      case 'done':
        observed.truncated = Boolean(ev.truncated)
        break
      case 'error':
        throw new ProviderError(ev.failure, ev.message, ev.retryable)
    }
  }

  arm('first-token', settings.defaults.firstTokenTimeoutMs)
  try {
    await adapter.run({
      model,
      turns,
      systemPrompt: params.systemPrompt,
      temperature: params.temperature,
      maxTokens,
      topP: params.topP,
      stream: settings.defaults.stream,
      apiKey,
      signal: attemptController.signal,
      onEvent,
    })
    if (observed.contentChars === 0) {
      // Backstop: adapters diagnose their own empty responses, so this only
      // fires when one finished a stream emitting nothing and said nothing.
      throw new ProviderError('unknown', 'The provider accepted the request but returned no text at all.', false)
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ProviderError('aborted', 'Cancelled.', false)
    }
    if (observed.timedOut === 'first-token') {
      const secs = Math.round(settings.defaults.firstTokenTimeoutMs / 1000)
      throw new ProviderError(
        'timeout',
        `No response after ${secs}s — the request never produced a first token. The key is accepted but the model did not answer (network path, proxy, or an overloaded provider).`,
        true,
      )
    }
    if (observed.timedOut === 'stalled') {
      const secs = Math.round(settings.defaults.requestTimeoutMs / 1000)
      throw new ProviderError(
        'timeout',
        observed.contentChars === 0 && observed.reasoningChars > 0
          ? `The model reasoned for ${secs}s+ and then went quiet without ever starting its answer.`
          : `The stream went quiet for ${secs}s after it had started and was cut off.`,
        true,
      )
    }
    throw err
  } finally {
    disarm()
    controller.signal.removeEventListener('abort', onAbort)
  }
}

/* ------------------------------------------------------------------ */
/* ARIA live announcements (see ./announce.ts)                         */
/* ------------------------------------------------------------------ */

function announce(text: string): void {
  announceResponse(text)
}
