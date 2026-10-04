import { create } from 'zustand'
import type {
  AgentSettings,
  ApiTokenDef,
  AppearanceSettings,
  ArtifactSettings,
  DefaultsSettings,
  ModelDef,
  ProviderDef,
  Settings,
} from '../types'
import { DEFAULT_MODELS, DEFAULT_PROVIDERS } from '../providers/registry'
import { validateSettings } from '../lib/schemas'
import { normalizeProviderDef, providerTokens } from '../lib/providerCatalog'
import { KEYS, loadRaw, saveJSON } from '../lib/storage'
import { uid } from '../lib/id'
import { useHealth } from './health'

export { providerTokens }

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  models: DEFAULT_MODELS,
  defaults: {
    temperature: 0.7,
    topP: 1,
    maxTokens: 4096,
    systemPrompt:
      'You are Slade, a dependable assistant routed across many models. Be accurate, concise, and format answers in Markdown.',
    stream: true,
    typingIndicator: true,
    showThoughts: true,
    autoScroll: 'smooth',
    failoverStrategy: 'priority',
    requestTimeoutMs: 60_000,
    firstTokenTimeoutMs: 120_000,
  },
  artifacts: {
    collapsedByDefault: false,
    autoExpandImages: true,
    maxPreviewHeight: 420,
  },
  appearance: {
    theme: 'dark',
    fontSize: 15,
    density: 'cozy',
    codeTheme: 'auto',
    reduceMotion: false,
    enterToSend: true,
  },
  agent: {
    orchestratorModelId: undefined,
    maxSteps: 4,
    maxParallel: 2,
    expandStepResults: true,
    // A step is a whole deliverable ("build the app"), and reasoning models
    // bill their thinking against the same cap — the chat default is too
    // small to finish one. A ceiling costs nothing unless the tokens are used.
    stepMaxTokens: 16_384,
    useLocalFs: true,
  },
  providers: DEFAULT_PROVIDERS,
  pinnedModelId: undefined,
  layout: {},
}/* ------------------------------------------------------------------ */
/* Provider lookups                                                    */
/* ------------------------------------------------------------------ */

/** Resolve a model's provider instance, or undefined when it was deleted. */
export function providerById(s: Settings, id: string): ProviderDef | undefined {
  return s.providers.find((p) => p.id === id)
}

/** Merge stored settings over defaults so new fields appear after upgrades. */
function hydrate(): Settings {
  const raw = loadRaw<Partial<Settings> | null>(KEYS.settings, null)
  if (!raw) return structuredClone(DEFAULT_SETTINGS)
  const validated = validateSettings(raw)
  if (validated) return validated
  // Partial / legacy: deep-merge what's there onto defaults.
  const merged: Settings = structuredClone(DEFAULT_SETTINGS)
  if (raw.defaults) merged.defaults = { ...merged.defaults, ...raw.defaults }
  if (raw.artifacts) merged.artifacts = { ...merged.artifacts, ...raw.artifacts }
  if (raw.appearance) merged.appearance = { ...merged.appearance, ...raw.appearance }
  if (raw.agent) merged.agent = { ...merged.agent, ...raw.agent }
  if (raw.layout) {
    // Sanitized rather than spread: this branch runs exactly when validation
    // failed, so raw values may be junk; a leaked "abc" here would re-persist
    // and keep every future load on the fallback path.
    const w = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 200 ? Math.round(v) : undefined)
    for (const key of ['sidebarW', 'railW', 'githubW', 'filesW'] as const) {
      const px = w(raw.layout[key])
      if (px !== undefined) merged.layout![key] = px
    }
  }
  if (raw.providers) {
    // Handles both shapes: the new provider-instance list and the legacy
    // record keyed by kind (migrated in place, ids = kinds, so existing
    // models keep pointing at the right entry). Typed `unknown` because the
    // raw blob predates validation — it may still be the old record shape.
    const rawProviders: unknown = raw.providers
    const migrated = Array.isArray(rawProviders)
      ? rawProviders.map((p) => normalizeProviderDef(p as Partial<ProviderDef> & { id: string }))
      : Object.entries(rawProviders as Record<string, Partial<ProviderDef>>).map(([id, cfg]) =>
          normalizeProviderDef({ id, ...cfg }),
        )
    merged.providers = migrated
  }
  merged.pinnedModelId = raw.pinnedModelId
  return merged
}

export interface SettingsState {
  s: Settings
  setModel: (id: string, patch: Partial<ModelDef>) => void
  reorderModels: (ids: string[]) => void
  addModel: (def: ModelDef) => void
  removeModel: (id: string) => void
  setDefaults: (patch: Partial<DefaultsSettings>) => void
  setArtifactsPrefs: (patch: Partial<ArtifactSettings>) => void
  setAgent: (patch: Partial<AgentSettings>) => void
  setAppearance: (patch: Partial<AppearanceSettings>) => void
  /** Commit (or reset, passing null) a panel's manually resized width. */
  setLayoutWidth: (key: 'sidebarW' | 'railW' | 'githubW' | 'filesW', width: number | null) => void
  /** Update an existing provider instance (key, base URL, label, apiKeys). */
  setProvider: (pid: string, patch: Partial<Omit<ProviderDef, 'id' | 'kind'>>) => void
  addProvider: (def: ProviderDef) => void
  /**
   * Delete a provider instance and cascade-delete every model on it.
   * Returns the ids of the removed models (for health cleanup).
   */
  removeProvider: (pid: string) => string[]
  /** Add a new API token to a provider connection's pool. */
  addProviderToken: (pid: string, token: { key: string; label?: string; enabled?: boolean }) => ApiTokenDef | undefined
  /** Remove an API token from a provider connection's pool. */
  removeProviderToken: (pid: string, tokenId: string) => void
  /** Toggle or update an API token in a provider connection's pool. */
  updateProviderToken: (pid: string, tokenId: string, patch: Partial<ApiTokenDef>) => void
  pin: (modelId: string | undefined) => void
  replaceAll: (s: Settings) => void
  resetSettings: () => void
}

function persist(s: Settings) {
  saveJSON(KEYS.settings, s)
}

export const useSettings = create<SettingsState>((set, get) => ({
  s: hydrate(),
  setModel: (id, patch) => {
    const s = get().s
    const models = s.models.map((m) => (m.id === id ? { ...m, ...patch } : m))
    const next = { ...s, models }
    persist(next)
    set({ s: next })
  },
  reorderModels: (ids) => {
    const s = get().s
    const byId = new Map(s.models.map((m) => [m.id, m]))
    const models = ids.map((id) => byId.get(id)).filter((m): m is ModelDef => !!m)
    // keep any models not present in the reorder list at the end
    for (const m of s.models) if (!ids.includes(m.id)) models.push(m)
    const next = { ...s, models }
    persist(next)
    set({ s: next })
  },
  addModel: (def) => {
    const s = get().s
    const next = { ...s, models: [...s.models, def] }
    persist(next)
    set({ s: next })
  },
  removeModel: (id) => {
    const s = get().s
    const next = {
      ...s,
      models: s.models.filter((m) => m.id !== id),
      pinnedModelId: s.pinnedModelId === id ? undefined : s.pinnedModelId,
    }
    persist(next)
    set({ s: next })
  },
  setDefaults: (patch) => {
    const next = { ...get().s, defaults: { ...get().s.defaults, ...patch } }
    persist(next)
    set({ s: next })
  },
  setArtifactsPrefs: (patch) => {
    const next = { ...get().s, artifacts: { ...get().s.artifacts, ...patch } }
    persist(next)
    set({ s: next })
  },
  setAgent: (patch) => {
    const next = { ...get().s, agent: { ...get().s.agent, ...patch } }
    persist(next)
    set({ s: next })
  },
  setAppearance: (patch) => {
    const next = { ...get().s, appearance: { ...get().s.appearance, ...patch } }
    persist(next)
    set({ s: next })
  },
  setLayoutWidth: (key, w) => {
    const layout = { ...get().s.layout }
    if (w === null) delete layout[key]
    else layout[key] = Math.round(w)
    const next = { ...get().s, layout }
    persist(next)
    set({ s: next })
  },
  setProvider: (pid, patch) => {
    const s = get().s
    // Only existing instances can be patched — adding one is addProvider's job.
    if (!s.providers.some((p) => p.id === pid)) return
    const providers = s.providers.map((p) => {
      if (p.id !== pid) return p
      const updated = { ...p, ...patch }
      // If patch specified apiKey directly (without apiKeys), sync apiKeys to use the new key
      if (patch.apiKey !== undefined && patch.apiKeys === undefined) {
        const keyChanged = p.apiKey !== patch.apiKey
        const tokId = keyChanged ? uid('tok') : p.apiKeys?.[0]?.id || `${pid}-primary`
        updated.apiKeys = patch.apiKey.trim()
          ? [{ id: tokId, key: patch.apiKey.trim(), label: 'Primary token', enabled: true }]
          : undefined
        useHealth.getState().markTokenHealthy(tokId)
      } else if (patch.apiKeys !== undefined && patch.apiKey === undefined) {
        updated.apiKey = patch.apiKeys[0]?.key || ''
      }
      return updated
    })
    const next = { ...s, providers }
    persist(next)
    set({ s: next })
  },
  addProviderToken: (pid, token) => {
    const s = get().s
    const provider = s.providers.find((p) => p.id === pid)
    if (!provider) return undefined
    const existing = providerTokens(provider)
    const newToken: ApiTokenDef = {
      id: uid('tok'),
      key: token.key.trim(),
      label: token.label?.trim() || `Token ${existing.length + 1}`,
      enabled: token.enabled !== false,
      createdAt: Date.now(),
    }
    const nextTokens = [...existing, newToken]
    const providers = s.providers.map((p) =>
      p.id === pid
        ? {
            ...p,
            apiKey: nextTokens[0]?.key || p.apiKey,
            apiKeys: nextTokens,
          }
        : p,
    )
    const next = { ...s, providers }
    persist(next)
    set({ s: next })
    return newToken
  },
  removeProviderToken: (pid, tokenId) => {
    const s = get().s
    const provider = s.providers.find((p) => p.id === pid)
    if (!provider) return
    const existing = providerTokens(provider)
    const nextTokens = existing.filter((t) => t.id !== tokenId)
    const providers = s.providers.map((p) =>
      p.id === pid
        ? {
            ...p,
            apiKey: nextTokens[0]?.key || '',
            apiKeys: nextTokens.length > 0 ? nextTokens : undefined,
          }
        : p,
    )
    const next = { ...s, providers }
    persist(next)
    set({ s: next })
  },
  updateProviderToken: (pid, tokenId, patch) => {
    const s = get().s
    const provider = s.providers.find((p) => p.id === pid)
    if (!provider) return
    const existing = providerTokens(provider)
    const nextTokens = existing.map((t) => (t.id === tokenId ? { ...t, ...patch } : t))
    const providers = s.providers.map((p) =>
      p.id === pid
        ? {
            ...p,
            apiKey: nextTokens[0]?.key || p.apiKey,
            apiKeys: nextTokens,
          }
        : p,
    )
    const next = { ...s, providers }
    persist(next)
    set({ s: next })
  },
  addProvider: (def) => {
    const s = get().s
    if (s.providers.some((p) => p.id === def.id)) return
    const next = { ...s, providers: [...s.providers, def] }
    persist(next)
    set({ s: next })
  },
  removeProvider: (pid) => {
    const s = get().s
    const provider = s.providers.find((p) => p.id === pid)
    if (!provider) return []
    // Cascade: models on this provider are meaningless without it.
    const removedModelIds = s.models.filter((m) => m.provider === pid).map((m) => m.id)
    const removedModelSet = new Set(removedModelIds)
    const next = {
      ...s,
      providers: s.providers.filter((p) => p.id !== pid),
      models: s.models.filter((m) => !removedModelSet.has(m.id)),
      pinnedModelId: s.pinnedModelId && removedModelSet.has(s.pinnedModelId) ? undefined : s.pinnedModelId,
    }
    persist(next)
    set({ s: next })
    return removedModelIds
  },
  pin: (modelId) => {
    const next = { ...get().s, pinnedModelId: modelId }
    persist(next)
    set({ s: next })
  },
  replaceAll: (s) => {
    persist(s)
    set({ s })
  },
  resetSettings: () => {
    const fresh = structuredClone(DEFAULT_SETTINGS)
    persist(fresh)
    set({ s: fresh })
  },
}))

/* ------------------------------------------------------------------ */
/* Derived helpers                                                     */
/* ------------------------------------------------------------------ */

export interface EffectiveParams {
  temperature: number
  topP: number
  maxTokens: number
  systemPrompt: string
}

export function effectiveParams(s: Settings, modelId?: string): EffectiveParams {
  const model = s.models.find((m) => m.id === modelId)
  return {
    temperature: model?.overrides?.temperature ?? s.defaults.temperature,
    maxTokens: model?.overrides?.maxTokens ?? s.defaults.maxTokens,
    topP: s.defaults.topP,
    systemPrompt: model?.overrides?.systemPrompt ?? s.defaults.systemPrompt,
  }
}

/** Whether thinking / reasoning should be rendered for this model. */
export function modelShowsThoughts(s: Settings, modelId?: string): boolean {
  if (!modelId) return s.defaults.showThoughts ?? true
  const model = s.models.find((m) => m.id === modelId)
  if (model?.showThoughts !== undefined) return model.showThoughts
  if (model?.overrides?.showThoughts !== undefined) return model.overrides.showThoughts
  return s.defaults.showThoughts ?? true
}

export function providerKey(s: Settings, model: ModelDef): string {
  return providerById(s, model.provider)?.apiKey ?? ''
}
