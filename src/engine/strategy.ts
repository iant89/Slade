import type { FailoverStrategy, FailureClass, Handoff, Message, ModelDef, Settings, Usage } from '../types'
import { FAILURE_LABEL } from '../types'
import type { ModelHealth } from '../types'
import { isRoutable } from '../store/health'
import { providerTokens } from '../lib/providerCatalog'

/** One enabled model that routing skipped, and why. */
export interface SkippedModel {
  modelId: string
  label: string
  reason: string
}

/**
 * A model whose provider has no API key can only ever answer with an auth
 * failure. Filtering such models out of routing (and naming them in the
 * skipped list) beats burning a chain slot on a request guaranteed to fail.
 * A model whose provider was deleted is skipped the same way.
 */
export function modelHasKey(settings: Settings, m: ModelDef): boolean {
  const provider = settings.providers.find((p) => p.id === m.provider)
  if (!provider) return false
  if (provider.kind === 'mock') return true
  const tokens = providerTokens(provider).filter((t) => t.enabled !== false && t.key.trim())
  return tokens.length > 0
}

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
  if (!primary) return sorted.filter((m) => modelHasKey(settings, m) && isRoutable(healthByModel[m.id], true))
  return [
    // A manual override is honored even while cooling down or missing a key —
    // the user asked for this model, so its failure message should say why.
    primary,
    ...sorted.filter((m) => m.id !== primary.id && modelHasKey(settings, m) && isRoutable(healthByModel[m.id], true)),
  ]
}

/**
 * One-line recap of a dead chain. Deliberately keeps the provider's own wording
 * for the last failure — "Unknown error" is the single most useless thing this
 * app can say when a key, a quota or a payload is the real problem.
 *
 * When enabled models were *skipped* by routing (cooling down, benched with an
 * auth error), they are named too — a summary that only says "tried GPT-4o"
 * while three other models silently sat out is how users end up believing the
 * chain is broken when it is actually just hiding.
 */
export function failureSummary(
  rows: { label: string; failure: FailureClass; message: string }[],
  skipped: SkippedModel[] = [],
): string {
  if (rows.length === 0) return 'No eligible models were available.'
  const parts = rows.map(
    (r) => `${r.label} (${r.failure === 'auth' ? FAILURE_LABEL.auth.toLowerCase() : FAILURE_LABEL[r.failure].toLowerCase()})`,
  )
  const last = rows[rows.length - 1]!
  const skippedNote = skipped.length
    ? ` Also skipped: ${skipped.map((s) => `${s.label} (${s.reason})`).join(', ')}.`
    : ''
  return `Every model in the chain failed — tried ${parts.join(', ')}. Last error: ${last.message}${skippedNote}`
}

/**
 * Enabled models that routing filtered out, with a human reason for each.
 * Used to explain why a chain was shorter than the user's model list.
 */
export function skippedModels(settings: Settings, healthByModel: Record<string, ModelHealth>): SkippedModel[] {
  const now = Date.now()
  const out: SkippedModel[] = []
  for (const m of settings.models) {
    if (!m.enabled) continue
    const h = healthByModel[m.id]
    const keyed = modelHasKey(settings, m)
    if (keyed && isRoutable(h, true)) continue
    let reason: string
    if (!keyed) {
      const provider = settings.providers.find((p) => p.id === m.provider)
      reason = `no API key configured for ${provider?.label ?? m.provider} — add one in Settings`
    } else if (h?.state === 'error') {
      reason = h.lastError
        ? `${FAILURE_LABEL[h.lastError.failure].toLowerCase()} — fix the key in Settings, then retry`
        : 'auth failure — retest its key in Settings'
    } else if (h?.cooldownUntil && h.cooldownUntil > now) {
      const secs = Math.max(1, Math.round((h.cooldownUntil - now) / 1000))
      const cause = h.lastError ? ` after ${FAILURE_LABEL[h.lastError.failure].toLowerCase()}` : ''
      reason = `cooling down, ~${secs}s left${cause}`
    } else {
      reason = 'not routable'
    }
    out.push({ modelId: m.id, label: m.label, reason })
  }
  return out
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
