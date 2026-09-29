import type { ApiTokenDef, ProviderDef, ProviderId } from '../types'

/**
 * The set of provider kinds Slade can talk to, with everything the UI needs
 * to present them: the "Add a provider" dialog renders this list, the first
 * run derives one provider instance per entry from it, and settings migration
 * uses the labels.
 *
 * Kept free of imports (besides types) so both the zod schemas and the
 * provider registry can depend on it without cycles.
 */

export interface SupportedProvider {
  kind: ProviderId
  label: string
  hint: string
  /** Where to create an API key, shown as "Get a key ↗". */
  keyUrl?: string
  /** True when the kind needs no API key (the built-in simulator). */
  noKey?: boolean
  /** True when a default base URL field makes sense for this kind. */
  supportsBaseURL?: boolean
}

export const SUPPORTED_PROVIDERS: SupportedProvider[] = [
  {
    kind: 'openai',
    label: 'OpenAI',
    hint: 'GPT-5.x flagships',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    kind: 'anthropic',
    label: 'Anthropic',
    hint: 'Claude Opus & Sonnet',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    kind: 'google',
    label: 'Google Gemini',
    hint: 'Gemini 3 family',
    keyUrl: 'https://aistudio.google.com/app/apikey',
  },
  {
    kind: 'openrouter',
    label: 'OpenRouter',
    hint: 'One key, hundreds of models',
    keyUrl: 'https://openrouter.ai/settings/keys',
  },
  {
    kind: 'openai-compatible',
    label: 'OpenAI-compatible',
    hint: 'DeepSeek, Moonshot, Z.ai, Groq, Ollama… custom URL',
    supportsBaseURL: true,
  },
  {
    kind: 'mock',
    label: 'Built-in simulator',
    hint: 'No key needed — powers the demo models',
    noKey: true,
  },
]

export function supportedProvider(kind: ProviderId): SupportedProvider | undefined {
  return SUPPORTED_PROVIDERS.find((p) => p.kind === kind)
}

/** Providers the "Add a provider" dialog offers. All of them — the simulator included. */
export function addableProviders(): SupportedProvider[] {
  return SUPPORTED_PROVIDERS
}

export function isProviderId(value: string): value is ProviderId {
  return SUPPORTED_PROVIDERS.some((p) => p.kind === value)
}

/**
 * Extract all active and available API tokens for a provider.
 * Supports legacy single `apiKey` as well as multi-token `apiKeys` pool.
 */
export function providerTokens(provider: ProviderDef): ApiTokenDef[] {
  if (provider.apiKeys && provider.apiKeys.length > 0) {
    return provider.apiKeys
  }
  if (provider.apiKey && provider.apiKey.trim()) {
    return [
      {
        id: `${provider.id}-primary`,
        key: provider.apiKey.trim(),
        label: 'Primary token',
        enabled: true,
      },
    ]
  }
  return []
}

/**
 * Fill in the derived fields of a persisted provider entry. Entries saved
 * before providers became user-managed carry only `apiKey`/`baseURL` (they
 * were a record keyed by kind): their kind is the record key itself.
 */
export function normalizeProviderDef(raw: {
  id: string
  kind?: ProviderId
  label?: string
  apiKey?: string
  apiKeys?: ApiTokenDef[]
  baseURL?: string
}): ProviderDef {
  const kind: ProviderId = raw.kind ?? (isProviderId(raw.id) ? raw.id : 'openai-compatible')
  const apiKeys = (raw.apiKeys ?? []).filter((k) => k && typeof k.key === 'string' && k.key.trim())
  const apiKey = raw.apiKey?.trim() || (apiKeys.length > 0 ? apiKeys[0]!.key : '')
  const normalizedTokens: ApiTokenDef[] =
    apiKeys.length > 0
      ? apiKeys.map((k, i) => ({
          id: k.id || `${raw.id}-token-${i + 1}`,
          key: k.key.trim(),
          label: k.label?.trim() || (i === 0 ? 'Primary token' : `Token ${i + 1}`),
          enabled: k.enabled !== false,
          createdAt: k.createdAt || Date.now(),
        }))
      : apiKey
      ? [
          {
            id: `${raw.id}-primary`,
            key: apiKey,
            label: 'Primary token',
            enabled: true,
            createdAt: Date.now(),
          },
        ]
      : []

  return {
    id: raw.id,
    kind,
    label: raw.label?.trim() || supportedProvider(kind)?.label || raw.id,
    apiKey,
    apiKeys: normalizedTokens.length > 0 ? normalizedTokens : undefined,
    baseURL: raw.baseURL,
  }
}

/**
 * A display name for a newly added instance: the kind's label, deduplicated
 * ("OpenAI-compatible", "OpenAI-compatible 2", …) so two Groq connections
 * don't render identically.
 */
export function nextProviderLabel(kind: ProviderId, existing: ProviderDef[]): string {
  const base = supportedProvider(kind)?.label ?? kind
  const taken = new Set(existing.map((p) => p.label))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!taken.has(candidate)) return candidate
  }
}
