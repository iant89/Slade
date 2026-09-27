import { create } from 'zustand'
import type { FailureClass, ModelHealth, Usage } from '../types'
import { KEYS, loadRaw, saveJSON } from '../lib/storage'

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
    default:
      // bad_request, aborted, success: waiting cannot change the answer.
      return 0
  }
}

function hydrate(): Record<string, ModelHealth> {
  const byModel = loadRaw<Record<string, ModelHealth>>(KEYS.health, {})
  // Migration: older builds parked auth failures in a permanent `error` state
  // with no timer, so persisted records can still carry it. Revive those
  // models — the next failure re-classifies them onto a timed cooldown.
  for (const h of Object.values(byModel)) {
    if (h.state === 'error' && !(h.cooldownUntil && h.cooldownUntil > Date.now())) {
      h.state = 'available'
    }
  }
  return byModel
}

let persistTimer: ReturnType<typeof setTimeout> | null = null

export interface HealthState {
  byModel: Record<string, ModelHealth>
  /** Record a classified failure; returns cooldownUntil (0 = none). */
  recordFailure: (modelId: string, failure: FailureClass, message: string) => number
  recordSuccess: (modelId: string, latencyMs: number, usage?: Usage) => void
  /** Clear error/cooldown state (e.g. after a passing key test). */
  markHealthy: (modelId: string) => void
  removeModel: (modelId: string) => void
  resetUsage: () => void
}

export const useHealth = create<HealthState>((set, get) => {
  const persistSoon = () => {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      saveJSON(KEYS.health, get().byModel)
    }, 300)
  }

  const ensure = (byModel: Record<string, ModelHealth>, modelId: string): ModelHealth =>
    byModel[modelId] ?? {
      modelId,
      state: 'available',
      consecutiveFailures: 0,
      totalRequests: 0,
      totalFailures: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
    }

  return {
    byModel: hydrate(),

    recordFailure: (modelId, failure, message) => {
      const at = Date.now()
      let cooldownMs = 0
      let cooldownUntil = 0
      set((st) => {
        const byModel = { ...st.byModel }
        const h = ensure(byModel, modelId)
        const consecutive = h.consecutiveFailures + 1
        // Note: the cooldown is a function of the *class*, not of `retryable`.
        // A hard quota is not retryable within this turn but is still worth
        // benching for future ones; a bad request is neither.
        cooldownMs = cooldownMsFor(failure, consecutive)
        cooldownUntil = cooldownMs ? at + cooldownMs : 0
        byModel[modelId] = {
          ...h,
          consecutiveFailures: consecutive,
          totalFailures: h.totalFailures + 1,
          lastError: { at, failure, message },
          cooldownUntil: cooldownUntil || undefined,
          // Any failure with a cooldown benches the model *until the timer
          // expires* — never forever. The old code parked auth failures in a
          // permanent `error` state that nothing ever cleared, which silently
          // shrank the chain until a whole provider lineup disappeared from
          // failover with no explanation.
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
        const h = ensure(byModel, modelId)
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
        const h = ensure(byModel, modelId)
        byModel[modelId] = { ...h, state: 'available', cooldownUntil: undefined, consecutiveFailures: 0 }
        return { byModel }
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
