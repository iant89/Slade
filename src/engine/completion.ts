/**
 * A single completion request with the full failover walk — the agent's
 * primitive.
 *
 * `send.ts` streams straight into the user-visible assistant message and needs
 * fine-grained control over mid-stream handoff dividers, so it keeps its own
 * chain walk. The orchestrator, by contrast, runs many *internal* requests
 * (plan, N workers, synthesis) whose output lands in structured step slots
 * rather than one text column. This module gives those requests the same
 * transport guarantees — classification, cooldowns, candidate walking,
 * first-token and stalled-stream timeouts, health bookkeeping — decoupled from
 * any particular message shape.
 */

import type { AttemptFailure, ChatTurn, FailureClass, ModelDef, ProviderDef, Settings, StreamEvent, Usage } from '../types'
import { useHealth } from '../store/health'
import { useUI } from '../store/ui'
import { adapterFor } from '../providers/registry'
import { ProviderError } from '../providers/base'
import { modelHasKey, routeCandidates } from './strategy'

export interface CompletionRequest {
  /** Human label for toasts/diagnostics, e.g. "worker step 2". */
  purpose: string
  turns: ChatTurn[]
  systemPrompt: string
  settings: Settings
  /** Ordered candidate chain for this request (already routed/filtered). */
  candidates: ModelDef[]
  /**
   * Output-token floor for this request. Internal calls that produce a whole
   * deliverable (an orchestrator step) need more room than a chat reply, and
   * reasoning models bill their thinking against the same cap.
   */
  maxTokensFloor?: number
  signal: AbortSignal
  /** Observe text as it arrives (used to stream the synthesis phase live). */
  onDelta?: (text: string) => void
  /** Suppress the failure toast (the agent UI surfaces step errors itself). */
  silent?: boolean
}

export interface CompletionResult {
  text: string
  /** The model that actually produced the output. */
  model: ModelDef
  /** Models that contributed (length 1 unless a mid-stream handoff happened). */
  chain: string[]
  /** Models that failed before producing output, in tried order. */
  failedChain: string[]
  attempts: AttemptFailure[]
  usage?: Usage
  /** True when the provider stopped at the output cap instead of finishing. */
  truncated?: boolean
}

/** One automatic retry with a raised output cap (see `escalateTokens`). */
export interface BudgetRetry {
  fromTokens: number
  toTokens: number
  /** The provider's own explanation of the attempt that ran out of budget. */
  message: string
  elapsedMs: number
}

/** Floor and ceiling for the single automatic budget retry. */
export const BUDGET_RETRY_FLOOR = 16_384
export const BUDGET_RETRY_CEILING = 64_000

/**
 * The next output cap to try after a model spent its whole budget thinking.
 *
 * Quadruples the cap but never below 16k (a cap that small cannot hold a
 * deliverable plus the reasoning that produced it) and never above 64k, or
 * half the model's context window when that is smaller. Returns the input
 * unchanged when there is no headroom left, which is how callers know a retry
 * would be pointless.
 */
export function escalateTokens(current: number, contextWindow?: number): number {
  const ceiling = contextWindow
    ? Math.min(BUDGET_RETRY_CEILING, Math.floor(contextWindow / 2))
    : BUDGET_RETRY_CEILING
  const target = Math.min(Math.max(current * 4, BUDGET_RETRY_FLOOR), ceiling)
  return target > current ? target : current
}

export class CompletionExhausted extends Error {
  attempts: AttemptFailure[]
  constructor(message: string, attempts: AttemptFailure[]) {
    super(message)
    this.name = 'CompletionExhausted'
    this.attempts = attempts
  }
}

export function modelLabel(models: ModelDef[], id: string | undefined): string {
  return models.find((m) => m.id === id)?.label ?? (id ?? 'unknown model')
}

export function shortFailure(failure: FailureClass): string {
  switch (failure) {
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

/**
 * The output cap for one request: the caller's floor (an orchestrator step),
 * the per-model override, or the global default — whichever is largest. A
 * per-model override is an explicit user choice, so it still wins when it is
 * the roomier of the two.
 */
export function requestMaxTokens(settings: Settings, model: ModelDef, floor?: number): number {
  const configured = model.overrides?.maxTokens ?? settings.defaults.maxTokens
  return Math.max(configured, floor ?? 0)
}

/** Ordered routable candidates, minus any excluded model ids (e.g. the orchestrator itself). */
export function workerCandidates(
  settings: Settings,
  excludeIds: ReadonlySet<string>,
  primaryModelId?: string,
): ModelDef[] {
  const health = useHealth.getState().byModel
  const all = routeCandidates(settings, health, primaryModelId)
  const kept = all.filter((m) => !excludeIds.has(m.id) && modelHasKey(settings, m))
  // If excluding left us with nothing (single-model setup), allow the excluded
  // model back in — a worker that is also the orchestrator beats no worker.
  if (kept.length === 0) return all.filter((m) => modelHasKey(settings, m))
  return kept
}

/**
 * Run one request down the candidate chain. Resolves with the first model that
 * streams to completion; rejects with `CompletionExhausted` when every
 * candidate failed. Health/cooldown bookkeeping matches the main chain walk.
 */
export async function runCompletion(req: CompletionRequest): Promise<CompletionResult> {
  const { candidates, settings, signal } = req
  const attempts: AttemptFailure[] = []
  let content = ''
  let chain: string[] = []
  const failedChain: string[] = []
  let usage: Usage | undefined

  if (candidates.length === 0) {
    throw new CompletionExhausted(`No eligible models for ${req.purpose}.`, attempts)
  }

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i]!
    if (signal.aborted) throw new ProviderError('aborted', 'Cancelled.', false)
    const startedAt = performance.now()

    // Per-attempt content: a mid-stream handoff re-issues the request, so the
    // next candidate starts from scratch; only models that *completed* keep
    // their text. Partial pre-handoff text is preserved in `attempts` only.
    let attemptContent = ''
    let truncated = false

    try {
      const driven = await driveAdapter({
        model,
        turns: req.turns,
        systemPrompt: req.systemPrompt,
        settings,
        signal,
        maxTokens: requestMaxTokens(settings, model, req.maxTokensFloor),
        onDelta: (t) => {
          attemptContent += t
          req.onDelta?.(t)
        },
        onUsage: (u) => {
          usage = mergeUsage(usage, u)
        },
        // A model that spent its whole cap thinking gets one retry with a
        // bigger cap before the chain walks on — the next candidate would hit
        // the same wall at the same budget.
        onBudgetRetry: (retry) => {
          attempts.push({
            modelId: model.id,
            label: modelLabel(settings.models, model.id),
            failure: 'token_budget',
            message: `${retry.message} Retrying with ${retry.toTokens.toLocaleString('en-US')} output tokens.`,
            elapsedMs: retry.elapsedMs,
            midStream: false,
          })
          if (!req.silent) {
            useUI.getState().toast({
              kind: 'warn',
              title: `${req.purpose}: ${modelLabel(settings.models, model.id)} ran out of output budget`,
              detail: `Retrying the same model with ${retry.toTokens.toLocaleString('en-US')} output tokens instead of ${retry.fromTokens.toLocaleString('en-US')}.`,
            })
          }
        },
      })
      truncated = driven.truncated
      content += attemptContent
      if (chain.length === 0) chain = [model.id]
      else chain.push(model.id)
      const result: CompletionResult = {
        text: content,
        model,
        chain,
        failedChain: [...failedChain],
        attempts: [...attempts],
        usage,
        truncated,
      }
      return result
    } catch (err) {
      const pe =
        err instanceof ProviderError
          ? err
          : new ProviderError('unknown', err instanceof Error ? err.message : String(err), true)

      if (pe.failure === 'aborted' && signal.aborted) throw pe

      const cooldownUntil = useHealth.getState().recordFailure(model.id, pe.failure, pe.message)
      attempts.push({
        modelId: model.id,
        label: modelLabel(settings.models, model.id),
        failure: pe.failure,
        message: pe.message,
        status: pe.status,
        elapsedMs: Math.round(performance.now() - startedAt),
        midStream: attemptContent.length > 0,
      })
      if (attemptContent.length === 0) failedChain.push(model.id)

      const isLast = i === candidates.length - 1
      if (!isLast && !req.silent) {
        useUI.getState().toast({
          kind: 'warn',
          title: `${req.purpose}: ${modelLabel(settings.models, model.id)} ${shortFailure(pe.failure)}`,
          detail: `Falling back to ${modelLabel(settings.models, candidates[i + 1]!.id)} — ${pe.message}${
            cooldownUntil ? ` · cooling down ~${Math.round(cooldownUntil / 1000)}s` : ''
          }`,
        })
      }
      if (isLast) {
        const last = attempts[attempts.length - 1]!
        throw new CompletionExhausted(
          `${req.purpose} failed on every candidate — last error from ${last.label}: ${last.message}`,
          attempts,
        )
      }
    }
  }
  throw new CompletionExhausted(`${req.purpose} walked the chain without a completed response.`, attempts)
}

/* ------------------------------------------------------------------ */
/* Adapter driving (timeouts + events + one budget retry)              */
/* ------------------------------------------------------------------ */

/** What one adapter run observed, readable by the caller even after a throw. */
interface ObservedAttempt {
  contentChars: number
  reasoningChars: number
  usage?: Usage
  truncated: boolean
  timedOut: 'first-token' | 'stalled' | null
}

/**
 * Drive one candidate, with a single automatic retry at a larger output cap.
 *
 * A `token_budget` failure means the provider answered and produced nothing
 * readable: a reasoning model spent the whole cap thinking. That is a property
 * of the *request*, not of the model — walking to the next candidate at the
 * same cap just repeats the failure (which is how one orchestrator step ended
 * up reporting "failed on every candidate"). So: raise the cap and ask the same
 * model once more, then fall through to the normal chain walk if that fails too.
 */
async function driveAdapter(args: {
  model: ModelDef
  turns: ChatTurn[]
  systemPrompt: string
  settings: Settings
  signal: AbortSignal
  maxTokens: number
  onDelta: (text: string) => void
  onUsage: (u: Usage) => void
  onBudgetRetry?: (retry: BudgetRetry) => void
}): Promise<{ truncated: boolean }> {
  const { model, settings, signal, onBudgetRetry } = args
  const provider = settings.providers.find((p) => p.id === model.provider)
  if (!provider) {
    throw new ProviderError('unknown', `Provider "${model.provider}" no longer exists — re-add it in Settings → Providers.`, false)
  }
  const apiKey = provider.apiKey
  if (provider.kind !== 'mock' && !apiKey.trim()) {
    throw new ProviderError('auth', `No API key configured for ${provider.label}.`, false)
  }

  let budget = args.maxTokens
  let escalated = false

  for (;;) {
    const startedAt = performance.now()
    const observed: ObservedAttempt = { contentChars: 0, reasoningChars: 0, truncated: false, timedOut: null }
    try {
      await driveOnce({ ...args, provider, maxTokens: budget, apiKey, observed })
      if (observed.usage) args.onUsage(observed.usage)
      useHealth.getState().recordSuccess(model.id, Math.round(performance.now() - startedAt), observed.usage)
      return { truncated: observed.truncated }
    } catch (err) {
      if (signal.aborted) throw new ProviderError('aborted', 'Cancelled.', false)
      const pe =
        err instanceof ProviderError
          ? err
          : new ProviderError('unknown', err instanceof Error ? err.message : String(err), true)

      // Nothing was streamed, so re-issuing cannot duplicate text or double-
      // bill an answer the user already has.
      if (!escalated && pe.failure === 'token_budget' && observed.contentChars === 0) {
        const next = escalateTokens(budget, model.contextWindow)
        if (next > budget) {
          escalated = true
          useHealth.getState().recordFailure(model.id, pe.failure, pe.message)
          onBudgetRetry?.({
            fromTokens: budget,
            toTokens: next,
            message: pe.message,
            elapsedMs: Math.round(performance.now() - startedAt),
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
 * `first-token` covers the wait for any sign of life; `stalled` covers a stream
 * that goes quiet. Reasoning deltas count as a sign of life — a model thinking
 * for two minutes is not a model that has hung — so they move the attempt onto
 * the idle budget instead of being cut off at the first-token limit.
 */
async function driveOnce(args: {
  model: ModelDef
  turns: ChatTurn[]
  systemPrompt: string
  settings: Settings
  signal: AbortSignal
  maxTokens: number
  provider: ProviderDef
  apiKey: string
  observed: ObservedAttempt
  onDelta: (text: string) => void
}): Promise<void> {
  const { model, turns, systemPrompt, settings, signal, maxTokens, provider, apiKey, observed, onDelta } = args
  const adapter = adapterFor(provider.kind)
  const modelOverride = model.overrides
  const attemptController = new AbortController()
  const onAbort = () => attemptController.abort()
  signal.addEventListener('abort', onAbort, { once: true })

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

  const onEvent = (ev: StreamEvent): void => {
    switch (ev.type) {
      case 'delta':
        if (observed.contentChars === 0) arm('stalled', settings.defaults.requestTimeoutMs)
        observed.contentChars += ev.text.length
        onDelta(ev.text)
        break
      case 'reasoning':
        observed.reasoningChars += ev.text.length
        arm('stalled', settings.defaults.requestTimeoutMs)
        break
      case 'usage':
        // Providers split usage across frames (Anthropic: prompt at
        // message_start, completion at message_delta), so keep whatever a
        // frame did not report rather than overwriting it with undefined.
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
      systemPrompt,
      temperature: modelOverride?.temperature ?? settings.defaults.temperature,
      maxTokens,
      topP: settings.defaults.topP,
      stream: settings.defaults.stream,
      apiKey,
      signal: attemptController.signal,
      onEvent,
    })
    if (observed.contentChars === 0) {
      // Backstop: adapters diagnose their own empty responses now, so reaching
      // this line means an adapter finished a stream without emitting anything
      // and without explaining why.
      throw new ProviderError('unknown', 'The provider accepted the request but returned no text at all.', false)
    }
  } catch (err) {
    if (signal.aborted) throw new ProviderError('aborted', 'Cancelled.', false)
    if (observed.timedOut === 'first-token') {
      const secs = Math.round(settings.defaults.firstTokenTimeoutMs / 1000)
      throw new ProviderError(
        'timeout',
        `No response after ${secs}s — the request never produced a first token.`,
        true,
      )
    }
    if (observed.timedOut === 'stalled') {
      const secs = Math.round(settings.defaults.requestTimeoutMs / 1000)
      throw new ProviderError(
        'timeout',
        observed.contentChars === 0 && observed.reasoningChars > 0
          ? `The model reasoned for ${secs}s+ and then went quiet without ever starting its answer.`
          : `The stream went quiet for ${secs}s after it had started.`,
        true,
      )
    }
    throw err
  } finally {
    disarm()
    signal.removeEventListener('abort', onAbort)
  }
}

export function mergeUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b
  if (!b) return a
  return {
    promptTokens: (a.promptTokens ?? 0) + (b.promptTokens ?? 0) || a.promptTokens,
    completionTokens: (a.completionTokens ?? 0) + (b.completionTokens ?? 0) || a.completionTokens,
  }
}
