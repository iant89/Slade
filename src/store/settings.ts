import { create } from 'zustand'
import type {
  AgentSettings,
  AppearanceSettings,
  ArtifactSettings,
  DefaultsSettings,
  ModelDef,
  ProviderConfig,
  ProviderId,
  Settings,
} from '../types'
import { DEFAULT_MODELS } from '../providers/registry'
import { validateSettings } from '../lib/schemas'
import { KEYS, loadRaw, saveJSON } from '../lib/storage'

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
  },
  providers: {
    mock: { apiKey: '' },
    openai: { apiKey: '' },
    anthropic: { apiKey: '' },
    google: { apiKey: '' },
    openrouter: { apiKey: '' },
    'openai-compatible': { apiKey: '' },
  },
  pinnedModelId: undefined,
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
  if (raw.providers) {
    for (const [k, v] of Object.entries(raw.providers)) {
      merged.providers[k] = { ...(merged.providers[k] ?? { apiKey: '' }), ...v }
    }
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
  setProvider: (pid: ProviderId | string, patch: Partial<ProviderConfig>) => void
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
  setProvider: (pid, patch) => {
    const s = get().s
    const next = {
      ...s,
      providers: { ...s.providers, [pid]: { ...(s.providers[pid] ?? { apiKey: '' }), ...patch } },
    }
    persist(next)
    set({ s: next })
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

export function providerKey(s: Settings, model: ModelDef): string {
  return s.providers[model.provider]?.apiKey ?? ''
}
