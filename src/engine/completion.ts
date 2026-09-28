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

import type { AttemptFailure, ChatTurn, FailureClass, ModelDef, Settings, StreamEvent, Usage } from '../types'
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
    default: return 'error'
  }
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

    try {
      await driveAdapter({
        model,
        turns: req.turns,
        systemPrompt: req.systemPrompt,
        settings,
        signal,
        onDelta: (t) => {
          attemptContent += t
          req.onDelta?.(t)
        },
        onUsage: (u) => {
          usage = mergeUsage(usage, u)
        },
      })
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
/* Adapter driving (timeouts + events)                                 */
/* ------------------------------------------------------------------ */

async function driveAdapter(args: {
  model: ModelDef
  turns: ChatTurn[]
  systemPrompt: string
  settings: Settings
  signal: AbortSignal
  onDelta: (text: string) => void
  onUsage: (u: Usage) => void
}): Promise<void> {
  const { model, turns, systemPrompt, settings, signal, onDelta, onUsage } = args
  const adapter = adapterFor(model.provider)
  const apiKey = settings.providers[model.provider]?.apiKey ?? ''
  if (model.provider !== 'mock' && !apiKey.trim()) {
    throw new ProviderError('auth', `No API key configured for ${model.provider}.`, false)
  }

  const modelOverride = model.overrides
  const attemptController = new AbortController()
  const onAbort = () => attemptController.abort()
  signal.addEventListener('abort', onAbort, { once: true })

  // Same two budgets as the main chain: reasoning models legally take longer
  // to first token, and a stream that goes quiet is a different failure.
  let timedOut: 'first-token' | 'stalled' | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = (kind: 'first-token' | 'stalled', ms: number) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = kind
      attemptController.abort()
    }, ms)
  }
  const disarm = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const startedAt = performance.now()
  let gotFirstDelta = false
  let usagePiece: Usage | undefined

  const onEvent = (ev: StreamEvent): void => {
    switch (ev.type) {
      case 'delta':
        if (!gotFirstDelta) {
          gotFirstDelta = true
          arm('stalled', settings.defaults.requestTimeoutMs)
        }
        onDelta(ev.text)
        break
      case 'usage':
        usagePiece = { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens }
        break
      case 'done':
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
      maxTokens: modelOverride?.maxTokens ?? settings.defaults.maxTokens,
      topP: settings.defaults.topP,
      stream: settings.defaults.stream,
      apiKey,
      signal: attemptController.signal,
      onEvent,
    })
    if (!gotFirstDelta) {
      throw new ProviderError('unknown', 'The provider accepted the request but returned no text at all.', false)
    }
    if (usagePiece) onUsage(usagePiece)
    useHealth.getState().recordSuccess(model.id, Math.round(performance.now() - startedAt), usagePiece)
  } catch (err) {
    if (signal.aborted) throw new ProviderError('aborted', 'Cancelled.', false)
    if (timedOut === 'first-token') {
      const secs = Math.round(settings.defaults.firstTokenTimeoutMs / 1000)
      throw new ProviderError(
        'timeout',
        `No response after ${secs}s — the request never produced a first token.`,
        true,
      )
    }
    if (timedOut === 'stalled') {
      const secs = Math.round(settings.defaults.requestTimeoutMs / 1000)
      throw new ProviderError('timeout', `The stream went quiet for ${secs}s after it had started.`, true)
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
