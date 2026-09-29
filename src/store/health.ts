import { create } from 'zustand'
import type { ApiTokenDef, FailureClass, ModelHealth, ProviderDef, TokenHealth, Usage } from '../types'
import { KEYS, loadRaw, saveJSON } from '../lib/storage'
import { providerTokens } from '../lib/providerCatalog'

/* ------------------------------------------------------------------ */
/* Cooldown policy — each failure class gets its own backoff curve     */
/* ------------------------------------------------------------------ */

const CAP_MS = 30 * 60_000

export function cooldownMsFor(failure: FailureClass, consecutiveFailures: number): number {
  const n = Math.max(1, consecutiveFailures)
  const backoff = (baseMs: number, capMs: number) => Math.min(capMs, baseMs * 2 ** (n - 1))
  switch (failure) {
    case 'soft_rate_limit':
      return backoff(30_000, 10 * 60_000)
    case 'hard_quota':
      return backoff(5 * 60_000, CAP_MS)
    case 'timeout':
      return backoff(10_000, 5 * 60_000)
    case 'network':
      return backoff(5_000, 5 * 60_000)
    case 'overloaded':
      return backoff(15_000, 5 * 60_000)
    case 'unknown':
      return backoff(20_000, 5 * 60_000)
    case 'auth':
      // A rejected key is usually sticky — but not always (rotated keys,
      // flaky proxies, a provider hiccup that returns 400 instead of 429).
      // The design rule is "never permanent bans", so auth gets the longest
      // backoff instead of a silent, eternal bench. Skipping it for the rest
      // of *this* turn is still right — the same key will fail again in
      // milliseconds — but future turns must get another shot.
      return backoff(5 * 60_000, CAP_MS)
    case 'token_budget':
      // The model is healthy — the *request* was too small for it. Benching it
      // would hide a working model behind a configuration problem, and the
      // engine already retries it once with a raised cap in the same turn.
      return 0
    default:
      // bad_request, aborted, success: waiting cannot change the answer.
      return 0
  }
}

function hydrate(): { byModel: Record<string, ModelHealth>; byToken: Record<string, TokenHealth> } {
  const raw = loadRaw<Record<string, unknown>>(KEYS.health, {})
  const byModel: Record<string, ModelHealth> =
    raw && typeof raw === 'object' && 'models' in raw && raw.models && typeof raw.models === 'object'
      ? (raw.models as Record<string, ModelHealth>)
      : (raw as Record<string, ModelHealth>)
  const byToken: Record<string, TokenHealth> =
    raw && typeof raw === 'object' && 'tokens' in raw && raw.tokens && typeof raw.tokens === 'object'
      ? (raw.tokens as Record<string, TokenHealth>)
      : {}

  // Migration: older builds parked auth failures in a permanent `error` state
  // with no timer, so persisted records can still carry it. Revive those
  // models & tokens — the next failure re-classifies them onto a timed cooldown.
  for (const h of Object.values(byModel)) {
    if (h && h.state === 'error' && !(h.cooldownUntil && h.cooldownUntil > Date.now())) {
      h.state = 'available'
    }
  }
  for (const t of Object.values(byToken)) {
    if (t && t.state === 'error' && !(t.cooldownUntil && t.cooldownUntil > Date.now())) {
      t.state = 'available'
    }
  }
  return { byModel, byToken }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null

export interface HealthState {
  byModel: Record<string, ModelHealth>
  byToken: Record<string, TokenHealth>
  /** Record a classified failure for a model; returns cooldownUntil (0 = none). */
  recordFailure: (modelId: string, failure: FailureClass, message: string) => number
  recordSuccess: (modelId: string, latencyMs: number, usage?: Usage) => void
  /** Clear error/cooldown state (e.g. after a passing key test). */
  markHealthy: (modelId: string) => void
  removeModel: (modelId: string) => void
  resetUsage: () => void

  /** Record a classified failure for an individual API token; returns cooldownUntil (0 = none). */
  recordTokenFailure: (tokenId: string, failure: FailureClass, message: string) => number
  recordTokenSuccess: (tokenId: string) => void
  markTokenHealthy: (tokenId: string) => void
  removeToken: (tokenId: string) => void
}

export const useHealth = create<HealthState>((set, get) => {
  const persistSoon = () => {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      saveJSON(KEYS.health, { models: get().byModel, tokens: get().byToken })
    }, 300)
  }

  const ensureModel = (byModel: Record<string, ModelHealth>, modelId: string): ModelHealth =>
    byModel[modelId] ?? {
      modelId,
      state: 'available',
      consecutiveFailures: 0,
      totalRequests: 0,
      totalFailures: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
    }

  const ensureToken = (byToken: Record<string, TokenHealth>, tokenId: string): TokenHealth =>
    byToken[tokenId] ?? {
      tokenId,
      state: 'available',
      consecutiveFailures: 0,
      totalRequests: 0,
      totalFailures: 0,
    }

  const hydrated = hydrate()

  return {
    byModel: hydrated.byModel,
    byToken: hydrated.byToken,

    recordFailure: (modelId, failure, message) => {
      const at = Date.now()
      let cooldownMs = 0
      let cooldownUntil = 0
      set((st) => {
        const byModel = { ...st.byModel }
        const h = ensureModel(byModel, modelId)
        const consecutive = h.consecutiveFailures + 1
        cooldownMs = cooldownMsFor(failure, consecutive)
        cooldownUntil = cooldownMs ? at + cooldownMs : 0
        byModel[modelId] = {
          ...h,
          consecutiveFailures: consecutive,
          totalFailures: h.totalFailures + 1,
          lastError: { at, failure, message },
          cooldownUntil: cooldownUntil || undefined,
          state: cooldownUntil ? 'cooldown' : h.state,
        }
        return { byModel }
      })
      persistSoon()
      return cooldownUntil
    },

    recordSuccess: (modelId, latencyMs, usage) => {
      set((st) => {
        const byModel = { ...st.byModel }
        const h = ensureModel(byModel, modelId)
        const ema = h.avgLatencyMs == null ? latencyMs : h.avgLatencyMs * 0.7 + latencyMs * 0.3
        byModel[modelId] = {
          ...h,
          state: 'available',
          cooldownUntil: undefined,
          consecutiveFailures: 0,
          avgLatencyMs: Math.round(ema),
          totalRequests: h.totalRequests + 1,
          totalTokensIn: h.totalTokensIn + (usage?.promptTokens ?? 0),
          totalTokensOut: h.totalTokensOut + (usage?.completionTokens ?? 0),
        }
        return { byModel }
      })
      persistSoon()
    },

    markHealthy: (modelId) => {
      set((st) => {
        const byModel = { ...st.byModel }
        const h = ensureModel(byModel, modelId)
        byModel[modelId] = { ...h, state: 'available', cooldownUntil: undefined, consecutiveFailures: 0 }
        const byToken = { ...st.byToken }
        for (const [tId, tVal] of Object.entries(byToken)) {
          if (
            tId.startsWith(modelId) ||
            (modelId.includes('openrouter') && tId.includes('openrouter')) ||
            (modelId.includes('gemini') && (tId.includes('google') || tId.includes('gemini'))) ||
            (modelId.includes('mock') && tId.includes('mock'))
          ) {
            byToken[tId] = { ...tVal, state: 'available', cooldownUntil: undefined, consecutiveFailures: 0 }
          }
        }
        return { byModel, byToken }
      })
      persistSoon()
    },

    removeModel: (modelId) => {
      set((st) => {
        const byModel = { ...st.byModel }
        delete byModel[modelId]
        return { byModel }
      })
      persistSoon()
    },

    resetUsage: () => {
      set((st) => {
        const byModel: Record<string, ModelHealth> = {}
        for (const [k, h] of Object.entries(st.byModel)) {
          byModel[k] = { ...h, totalRequests: 0, totalFailures: 0, totalTokensIn: 0, totalTokensOut: 0 }
        }
        return { byModel }
      })
      persistSoon()
    },

    recordTokenFailure: (tokenId, failure, message) => {
      const at = Date.now()
      let cooldownMs = 0
      let cooldownUntil = 0
      set((st) => {
        const byToken = { ...st.byToken }
        const h = ensureToken(byToken, tokenId)
        const consecutive = h.consecutiveFailures + 1
        cooldownMs = cooldownMsFor(failure, consecutive)
        cooldownUntil = cooldownMs ? at + cooldownMs : 0
        byToken[tokenId] = {
          ...h,
          consecutiveFailures: consecutive,
          totalFailures: h.totalFailures + 1,
          lastError: { at, failure, message },
          cooldownUntil: cooldownUntil || undefined,
          state: cooldownUntil ? 'cooldown' : h.state,
        }
        return { byToken }
      })
      persistSoon()
      return cooldownUntil
    },

    recordTokenSuccess: (tokenId) => {
      set((st) => {
        const byToken = { ...st.byToken }
        const h = ensureToken(byToken, tokenId)
        byToken[tokenId] = {
          ...h,
          state: 'available',
          cooldownUntil: undefined,
          consecutiveFailures: 0,
          totalRequests: h.totalRequests + 1,
        }
        return { byToken }
      })
      persistSoon()
    },

    markTokenHealthy: (tokenId) => {
      set((st) => {
        const byToken = { ...st.byToken }
        const h = ensureToken(byToken, tokenId)
        byToken[tokenId] = { ...h, state: 'available', cooldownUntil: undefined, consecutiveFailures: 0 }
        return { byToken }
      })
      persistSoon()
    },

    removeToken: (tokenId) => {
      set((st) => {
        const byToken = { ...st.byToken }
        delete byToken[tokenId]
        return { byToken }
      })
      persistSoon()
    },
  }
})

/** A model is routable when enabled, not in auth-error, and not cooling down. */
export function isRoutable(h: ModelHealth | undefined, enabled: boolean): boolean {
  if (!enabled) return false
  if (!h) return true
  if (h.state === 'error') return false
  if (h.cooldownUntil && h.cooldownUntil > Date.now()) return false
  return true
}

/** A token is routable when enabled and not actively cooling down. */
export function isTokenRoutable(token: ApiTokenDef, h: TokenHealth | undefined): boolean {
  if (token.enabled === false) return false
  if (!h) return true
  if (h.state === 'error') return false
  if (h.cooldownUntil && h.cooldownUntil > Date.now()) return false
  return true
}

/** Get eligible tokens for a provider, prioritizing non-cooling tokens first. */
export function getEligibleTokens(provider: ProviderDef, byToken: Record<string, TokenHealth>): ApiTokenDef[] {
  const all = providerTokens(provider).filter((t) => t.enabled !== false && t.key.trim())
  if (all.length === 0) return []
  const available: ApiTokenDef[] = []
  const cooling: ApiTokenDef[] = []
  for (const t of all) {
    if (isTokenRoutable(t, byToken[t.id])) {
      available.push(t)
    } else {
      cooling.push(t)
    }
  }
  return [...available, ...cooling]
}
