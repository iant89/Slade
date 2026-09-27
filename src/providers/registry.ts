import type { ModelDef, ProviderId } from '../types'
import type { ProviderAdapter } from './base'
import { mockAdapter } from './mock'
import { openaiAdapter } from './openai'
import { anthropicAdapter } from './anthropic'
import { googleAdapter } from './google'

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  mock: mockAdapter,
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  google: googleAdapter,
  // OpenAI-compatible endpoints (Groq, OpenRouter, Together, Ollama…) speak
  // the same wire format as OpenAI, just with a different base URL.
  'openai-compatible': openaiAdapter,
}

export function adapterFor(provider: ProviderId): ProviderAdapter {
  return ADAPTERS[provider]
}

/* ------------------------------------------------------------------ */
/* Default model registry (first-run state)                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_MODELS: ModelDef[] = [
  {
    id: 'mock-pro',
    label: 'Simulacron Pro',
    provider: 'mock',
    apiModel: 'simulacron-pro',
    enabled: true,
    simulate: 'ok',
    costPer1kIn: 0,
    costPer1kOut: 0,
    contextWindow: 200_000,
  },
  {
    id: 'mock-lite',
    label: 'Simulacron Lite',
    provider: 'mock',
    apiModel: 'simulacron-lite',
    enabled: true,
    simulate: 'ok',
    costPer1kIn: 0,
    costPer1kOut: 0,
    contextWindow: 128_000,
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    provider: 'openai',
    apiModel: 'gpt-4o',
    enabled: false,
    costPer1kIn: 0.0025,
    costPer1kOut: 0.01,
    contextWindow: 128_000,
  },
  {
    id: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    apiModel: 'claude-sonnet-4-5',
    enabled: false,
    costPer1kIn: 0.003,
    costPer1kOut: 0.015,
    contextWindow: 200_000,
  },
  {
    id: 'gemini-2-5-flash',
    label: 'Gemini 2.5 Flash',
    provider: 'google',
    apiModel: 'gemini-2.5-flash',
    enabled: false,
    costPer1kIn: 0.0003,
    costPer1kOut: 0.0025,
    contextWindow: 1_000_000,
  },
  {
    id: 'llama-3-3-70b',
    label: 'Llama 3.3 70B',
    provider: 'openai-compatible',
    apiModel: 'llama-3.3-70b-versatile',
    baseURL: 'https://api.groq.com/openai/v1',
    enabled: false,
    costPer1kIn: 0.00059,
    costPer1kOut: 0.00079,
    contextWindow: 128_000,
  },
]
