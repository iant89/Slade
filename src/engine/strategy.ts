import type { FailoverStrategy, FailureClass, Handoff, Message, ModelDef, Settings, Usage } from '../types'
import { FAILURE_LABEL } from '../types'
import type { ModelHealth } from '../types'
import { isRoutable } from '../store/health'

/**
 * Build the ordered candidate chain for a completion.
 *
 * An explicit override (per-message or per-conversation) always goes first;
 * the rest follow the configured strategy: strict priority, fastest-first
 * (by measured latency EMA), or cheapest-first (by listed $/1k tokens).
 */
export function routeCandidates(
  settings: Settings,
  healthByModel: Record<string, ModelHealth>,
  primaryModelId?: string,
): ModelDef[] {
  const enabled = settings.models.filter((m) => m.enabled)
  const orderIndex = new Map(settings.models.map((m, i) => [m.id, i]))

  const strategy: FailoverStrategy = settings.defaults.failoverStrategy
  const cost = (m: ModelDef) => (m.costPer1kIn ?? 0) + (m.costPer1kOut ?? 0)
  const latency = (m: ModelDef) => healthByModel[m.id]?.avgLatencyMs ?? Number.POSITIVE_INFINITY

  const sorted = [...enabled].sort((a, b) => {
    switch (strategy) {
      case 'fastest': {
        const la = latency(a)
        const lb = latency(b)
        if (la !== lb) return la - lb
        return (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0)
      }
      case 'cheapest': {
        const ca = cost(a)
        const cb = cost(b)
        if (ca !== cb) return ca - cb
        return (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0)
      }
      default:
        return (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0)
    }
  })

  const primary = primaryModelId ? enabled.find((m) => m.id === primaryModelId) : undefined
  if (!primary) return sorted.filter((m) => isRoutable(healthByModel[m.id], true))
  return [
    primary, // a manual override is honored even while cooling down — the user asked for it
    ...sorted.filter((m) => m.id !== primary.id && isRoutable(healthByModel[m.id], true)),
  ]
}

/**
 * One-line recap of a dead chain. Deliberately keeps the provider's own wording
 * for the last failure — "Unknown error" is the single most useless thing this
 * app can say when a key, a quota or a payload is the real problem.
 */
export function failureSummary(rows: { label: string; failure: FailureClass; message: string }[]): string {
  if (rows.length === 0) return 'No eligible models were available.'
  const parts = rows.map(
    (r) => `${r.label} (${r.failure === 'auth' ? FAILURE_LABEL.auth.toLowerCase() : FAILURE_LABEL[r.failure].toLowerCase()})`,
  )
  const last = rows[rows.length - 1]!
  return `Every model in the chain failed — tried ${parts.join(', ')}. Last error: ${last.message}`
}

export function newAssistantPlaceholder(conversationId: string): Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 14)}`,
    role: 'assistant',
    conversationId,
    content: '',
    createdAt: Date.now(),
    status: 'pending',
    chain: [],
    failedChain: [],
    handoffs: [],
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

export function handoff(from: ModelDef, to: ModelDef, atChar: number): Handoff {
  return { fromModelId: from.id, fromModelLabel: from.label, toModelId: to.id, atChar, at: Date.now() }
}
