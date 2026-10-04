import type { AttemptFailure, FailureClass, Handoff, ModelDef, ProviderDef, Settings, StreamEvent, Usage } from '../types'
import { workspaceSession, type WorkspaceSession } from '../store/diskFs'
import { useChat, titleFromPrompt } from '../store/chat'
import { useSettings, effectiveParams } from '../store/settings'
import { useHealth, getEligibleTokens, isTokenRoutable } from '../store/health'
import { useUI } from '../store/ui'
import { adapterFor } from '../providers/registry'
import { ProviderError } from '../providers/base'
import { buildTurns } from './turns'
import { failureSummary, handoff, mergeUsage, newAssistantPlaceholder, routeCandidates, skippedModels } from './strategy'
import { escalateTokens } from './completion'
import { finishRun, getRun, registerRun, stopGeneration, isGenerating, type ActiveRun } from './active'
import { applyAgentOutputWithGit, expirePendingAgentQuestions, prepareAgentWorkspaceContext, runAgentTurn } from './agent'
import { uid } from '../lib/id'
import { announceResponse, currentAnnouncement, setAnnouncer } from './announce'
import { providerTokens } from '../lib/providerCatalog'

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
  // A new turn supersedes any question the agent was still waiting on, so its
  // card stops offering a choice that would resume a run nobody wants anymore.
  // (Answering a question resumes that run directly and never comes through here.)
  expirePendingAgentQuestions(conversationId)
  const conv = useChat.getState().conversations[conversationId]
  if (conv?.agentEnabled) return runAgentTurn(conversationId, userMessageId, assistantMessageId)
  return runChain(conversationId, userMessageId, assistantMessageId)
}

interface ChainState {
  workspaceSession: WorkspaceSession
  content: string
  reasoning?: string
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
    workspaceSession: workspaceSession(),
    content: '',
    reasoning: '',
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
        const outcome = await attemptModel({ model, turns, settings, controller, state, assistantMessageId, attempt, conversationId })
        if (outcome.truncated) {
          useUI.getState().toast({
            kind: 'warn',
            title: `${modelLabel(settings.models, model.id)} stopped at the output cap`,
            detail: `The answer was cut off at ${outcome.maxTokensUsed.toLocaleString('en-US')} tokens — raise Max output tokens in Settings → Defaults for the rest of it.`,
          })
        }
        const finalModelId = lastOf(state.chain)
        if ((settings.agent.useLocalFs ?? true) && finalModelId && state.content) {
          try { await applyAgentOutputWithGit(state.content, {
            source: {
              origin: 'model',
              modelId: finalModelId,
              modelLabel: modelLabel(settings.models, finalModelId),
            },
            conversationId,
            messageId: assistantMessageId,
            workspaceSession: state.workspaceSession,
            signal: controller.signal,
          }) } catch (error) {
            if (controller.signal.aborted) { finalizeCancelled(assistantMessageId, state, Boolean(state.content.trim())); return }
            // Filesystem errors must not trigger a model failover that replays
            // partially applied file operations.
            finalize(assistantMessageId, { status: 'error', modelId: finalModelId,
              error: `File changes were not fully applied: ${error instanceof Error ? error.message : String(error)}`, errorClass: 'unknown' })
            return
          }
        }
        finalize(assistantMessageId, {
          status: 'complete',
          modelId: finalModelId,
          chain: [...state.chain],
          failedChain: [...state.failedChain],
          handoffs: [...state.handoffs],
          usage: state.usage,
          reasoning: state.reasoning || undefined,
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
    reasoning?: string
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
    reasoning: state.reasoning || undefined,
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
  conversationId: string
}): Promise<{ truncated: boolean; maxTokensUsed: number }> {
  const { model, settings, controller, state, attempt } = args
  const provider = settings.providers.find((p) => p.id === model.provider)
  if (!provider) {
    throw new ProviderError('unknown', `Provider "${model.provider}" no longer exists — re-add it in Settings → Providers.`, false)
  }

  const allTokens = provider.kind === 'mock'
    ? [{ id: `${provider.id}-mock`, key: '', label: 'Built-in', enabled: true }]
    : providerTokens(provider).filter((t) => t.enabled !== false && t.key.trim())

  if (allTokens.length === 0) {
    throw new ProviderError('auth', `No API key configured for ${provider.label}.`, false)
  }

  const params = effectiveParams(settings, model.id)
  let budget = params.maxTokens
  let escalated = false

  const healthByToken = useHealth.getState().byToken
  const eligibleTokens = provider.kind === 'mock' ? allTokens : getEligibleTokens(provider, healthByToken)
  const tokensToTry = eligibleTokens.length > 0 ? eligibleTokens : allTokens

  // Check if all configured tokens are actively cooling down
  if (provider.kind !== 'mock' && allTokens.length > 0 && allTokens.every((t) => !isTokenRoutable(t, healthByToken[t.id]))) {
    const minCooldown = Math.min(...allTokens.map((t) => healthByToken[t.id]?.cooldownUntil ?? 0))
    const waitSecs = Math.max(1, Math.round((minCooldown - Date.now()) / 1000))
    throw new ProviderError(
      'soft_rate_limit',
      `All ${allTokens.length} API keys for ${provider.label} are cooling down — next key ready in ~${waitSecs}s.`,
      true,
    )
  }

  let lastError: ProviderError | null = null

  for (let tIdx = 0; tIdx < tokensToTry.length; tIdx++) {
    const token = tokensToTry[tIdx]!
    const isLastToken = tIdx === tokensToTry.length - 1

    for (;;) {
      const startedAt = performance.now()
      const observed: ObservedTurn = { contentChars: 0, reasoningChars: 0, truncated: false, timedOut: null }
      const contentBefore = state.content.length
      try {
        await attemptOnce({ ...args, provider, maxTokens: budget, apiKey: token.key, observed })
        if (observed.usage) state.usage = mergeUsage(state.usage, observed.usage)
        useHealth.getState().recordSuccess(model.id, Math.round(performance.now() - startedAt), observed.usage)
        if (token.id) useHealth.getState().recordTokenSuccess(token.id)
        announce(`Response from ${model.label}.`)
        return { truncated: observed.truncated, maxTokensUsed: budget }
      } catch (err) {
        if (attempt.userAborted || controller.signal.aborted) {
          throw new ProviderError('aborted', 'Cancelled.', false)
        }
        const pe =
          err instanceof ProviderError ? err : new ProviderError('unknown', err instanceof Error ? err.message : String(err), true)

        lastError = pe
        if (token.id && provider.kind !== 'mock') {
          useHealth.getState().recordTokenFailure(token.id, pe.failure, pe.message)
        }

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

        // If this token failed before generating content and another token is available in the pool,
        // rotate to the next token on the same model.
        if (!isLastToken && state.content.length === contentBefore && pe.failure !== 'bad_request') {
          const nextTok = tokensToTry[tIdx + 1]!
          useUI.getState().toast({
            kind: 'info',
            title: `${provider.label} token rotated`,
            detail: `Key "${token.label || token.id}" hit ${shortFailure(pe)}. Rotating to "${nextTok.label || nextTok.id}"...`,
          })
          break
        }

        throw pe
      }
    }
  }

  throw lastError ?? new ProviderError('unknown', 'All tokens for provider failed.', true)
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
  conversationId: string
  maxTokens: number
  provider: ProviderDef
  apiKey: string
  observed: ObservedTurn
}): Promise<void> {
  const { model, turns, settings, controller, state, assistantMessageId, conversationId, maxTokens, provider, apiKey, observed } = args
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
        // Thinking is streamed live into message.reasoning so users can observe
        // reasoning inline as it is generated. It also counts as proof of liveness.
        observed.reasoningChars += ev.text.length
        state.reasoning = (state.reasoning ?? '') + ev.text
        useChat.getState().mutateMessage(assistantMessageId, (m) => ({
          ...m,
          status: 'streaming',
          modelId: model.id,
          reasoning: state.reasoning,
        }))
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
  const useLocalFs = settings.agent.useLocalFs ?? true
  const lastUserText = [...turns].reverse().find((t) => t.role === 'user')?.text ?? ''
  const fsBlock = await prepareAgentWorkspaceContext(lastUserText, conversationId, useLocalFs, state.workspaceSession)
  const fileInstruction = useLocalFs
    ? "To create or update files in Slade's local file system, emit fenced blocks tagged with the target path (```lang:path/to/file.ext)."
    : ''
  const systemPrompt = [params.systemPrompt, fileInstruction, fsBlock].filter(Boolean).join('\n\n')
  try {
    await adapter.run({
      model,
      turns,
      systemPrompt,
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
