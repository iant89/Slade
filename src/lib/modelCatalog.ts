import type { ProviderId } from '../types'

/**
 * Curated model catalogue for the "Add model" picker.
 *
 * Entries are deliberately limited to models with high context windows that
 * excel at programming, problem solving, math and agentic work — the jobs a
 * failover chain like Slade's actually needs. It is a snapshot (see
 * CATALOG_AS_OF), not a live query: providers rename or retire IDs over time,
 * so the Model ID field always stays editable.
 */

export type AddableProvider = Exclude<ProviderId, 'mock'>

/** When the snapshot below was last verified against provider docs. */
export const CATALOG_AS_OF = 'September 2026'

export type Strength = 'coding' | 'reasoning' | 'math' | 'agents' | 'longContext' | 'value'

export const STRENGTH_LABEL: Record<Strength, string> = {
  coding: 'Coding',
  reasoning: 'Problem solving',
  math: 'Math',
  agents: 'Agentic',
  longContext: 'Long context',
  value: 'Value',
}

export interface CatalogModel {
  provider: AddableProvider
  /** Identifier sent to the provider API. */
  apiModel: string
  /** Human name shown in the table. */
  label: string
  contextWindow: number
  /** USD per 1k input tokens (approximate). */
  costPer1kIn?: number
  /** USD per 1k output tokens (approximate). */
  costPer1kOut?: number
  strengths: Strength[]
  note: string
  /** Suggested endpoint for openai-compatible providers (prefilled on pick). */
  baseURL?: string
}

const M = 1_000_000

export const MODEL_CATALOG: CatalogModel[] = [
  /* ---------------- OpenAI ---------------- */
  {
    provider: 'openai',
    apiModel: 'gpt-5.5',
    label: 'GPT-5.5',
    contextWindow: 1 * M,
    costPer1kIn: 0.005,
    costPer1kOut: 0.03,
    strengths: ['coding', 'reasoning', 'agents', 'math'],
    note: 'Strongest GPT tier — tops SWE-bench Verified (~89%) and the AA coding index.',
  },
  {
    provider: 'openai',
    apiModel: 'gpt-5.4',
    label: 'GPT-5.4',
    contextWindow: 1 * M,
    costPer1kIn: 0.0025,
    costPer1kOut: 0.015,
    strengths: ['coding', 'reasoning', 'agents'],
    note: 'Flagship all-rounder; ~80% SWE-bench Verified with native tool use.',
  },
  {
    provider: 'openai',
    apiModel: 'gpt-5.4-mini',
    label: 'GPT-5.4 mini',
    contextWindow: 400_000,
    costPer1kIn: 0.00075,
    costPer1kOut: 0.0045,
    strengths: ['coding', 'value'],
    note: 'Cheap 400K-context everyday coder; good default for high-volume chains.',
  },

  /* ---------------- Anthropic ---------------- */
  {
    provider: 'anthropic',
    apiModel: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    contextWindow: 1 * M,
    costPer1kIn: 0.005,
    costPer1kOut: 0.025,
    strengths: ['coding', 'reasoning', 'agents', 'math'],
    note: 'Strongest Claude — the daily driver for long-horizon coding and agents.',
  },
  {
    provider: 'anthropic',
    apiModel: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    contextWindow: 1 * M,
    costPer1kIn: 0.005,
    costPer1kOut: 0.025,
    strengths: ['coding', 'reasoning', 'agents'],
    note: '87.6% SWE-bench Verified; a notch behind 4.8 on the hardest tasks.',
  },
  {
    provider: 'anthropic',
    apiModel: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    contextWindow: 1 * M,
    costPer1kIn: 0.003,
    costPer1kOut: 0.015,
    strengths: ['coding', 'reasoning', 'value'],
    note: '85% SWE-bench Verified at 60% of Opus pricing — best quality-per-dollar Claude.',
  },
  {
    provider: 'anthropic',
    apiModel: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    contextWindow: 1 * M,
    costPer1kIn: 0.003,
    costPer1kOut: 0.015,
    strengths: ['coding', 'reasoning', 'value'],
    note: 'Proven production workhorse; 79.6% SWE-bench Verified.',
  },

  /* ---------------- Google Gemini ---------------- */
  {
    provider: 'google',
    apiModel: 'gemini-3.1-pro',
    label: 'Gemini 3.1 Pro',
    contextWindow: 1 * M,
    costPer1kIn: 0.002,
    costPer1kOut: 0.012,
    strengths: ['coding', 'reasoning', 'math', 'longContext'],
    note: '1M-token repo-wide reasoning; 80.6% SWE-bench Verified.',
  },
  {
    provider: 'google',
    apiModel: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    contextWindow: 1_048_576,
    costPer1kIn: 0.0015,
    costPer1kOut: 0.0075,
    strengths: ['coding', 'longContext', 'value'],
    note: 'Newest Flash: fast and cheap while keeping the full ~1M context.',
  },
  {
    provider: 'google',
    apiModel: 'gemini-3-flash',
    label: 'Gemini 3 Flash',
    contextWindow: 1 * M,
    costPer1kIn: 0.0005,
    costPer1kOut: 0.003,
    strengths: ['coding', 'longContext', 'value'],
    note: '78% SWE-bench Verified at a fraction of Pro pricing — outstanding value.',
  },

  /* ---------------- OpenRouter ---------------- */
  {
    provider: 'openrouter',
    apiModel: 'openrouter/auto',
    label: 'Auto Router',
    contextWindow: 2 * M,
    strengths: ['agents', 'reasoning', 'value'],
    note: 'OpenRouter picks the model per prompt and bills that model’s rate. It routes to reasoning models often, so keep the output token cap roomy — thinking is billed against it.',
  },
  {
    provider: 'openrouter',
    apiModel: 'deepseek/deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    contextWindow: 1_048_576,
    costPer1kIn: 0.000435,
    costPer1kOut: 0.00087,
    strengths: ['coding', 'reasoning', 'math', 'value'],
    note: 'Best price-to-capability among open-weight coders; 1.6T-param MoE.',
  },
  {
    provider: 'openrouter',
    apiModel: 'z-ai/glm-5.2',
    label: 'GLM 5.2',
    contextWindow: 1 * M,
    costPer1kIn: 0.00094,
    costPer1kOut: 0.003,
    strengths: ['coding', 'agents', 'value'],
    note: 'The most-recommended open GLM coding backend on OpenRouter.',
  },
  {
    provider: 'openrouter',
    apiModel: 'moonshotai/kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    contextWindow: 262_144,
    costPer1kIn: 0.00074,
    costPer1kOut: 0.0035,
    strengths: ['coding', 'agents'],
    note: 'Kimi variant tuned for agentic coding loops and tool use.',
  },
  {
    provider: 'openrouter',
    apiModel: 'qwen/qwen3.6-plus',
    label: 'Qwen3.6 Plus',
    contextWindow: 1 * M,
    costPer1kIn: 0.0005,
    costPer1kOut: 0.003,
    strengths: ['coding', 'longContext', 'value'],
    note: 'Alibaba flagship MoE; 1M context at commodity prices.',
  },

  /* ---------------- OpenAI-compatible endpoints ---------------- */
  {
    provider: 'openai-compatible',
    apiModel: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    contextWindow: 1 * M,
    costPer1kIn: 0.00174,
    costPer1kOut: 0.00348,
    strengths: ['coding', 'reasoning', 'math', 'value'],
    note: 'MIT-licensed frontier coder on the DeepSeek API (also Fireworks/Together).',
    baseURL: 'https://api.deepseek.com',
  },
  {
    provider: 'openai-compatible',
    apiModel: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    contextWindow: 1 * M,
    costPer1kIn: 0.00014,
    costPer1kOut: 0.00028,
    strengths: ['coding', 'longContext', 'value'],
    note: 'Cheapest serious 1M-context option; hybrid attention for long prompts.',
    baseURL: 'https://api.deepseek.com',
  },
  {
    provider: 'openai-compatible',
    apiModel: 'kimi-k2.6',
    label: 'Kimi K2.6',
    contextWindow: 262_144,
    costPer1kIn: 0.00095,
    costPer1kOut: 0.004,
    strengths: ['coding', 'agents'],
    note: '1T-param MoE coder served on the Moonshot API.',
    baseURL: 'https://api.moonshot.ai/v1',
  },
  {
    provider: 'openai-compatible',
    apiModel: 'glm-5.1',
    label: 'GLM 5.1',
    contextWindow: 200_000,
    costPer1kIn: 0.0014,
    costPer1kOut: 0.0044,
    strengths: ['coding', 'value'],
    note: 'Zhipu’s open coder on the Z.ai OpenAI-compatible endpoint.',
    baseURL: 'https://api.z.ai/api/paas/v4',
  },
  {
    provider: 'openai-compatible',
    apiModel: 'qwen3.6-plus',
    label: 'Qwen3.6 Plus',
    contextWindow: 1_048_576,
    costPer1kIn: 0.0005,
    costPer1kOut: 0.003,
    strengths: ['coding', 'longContext', 'value'],
    note: 'Alibaba flagship via DashScope’s compatible mode.',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  },
]

export function catalogFor(provider: AddableProvider): CatalogModel[] {
  return MODEL_CATALOG.filter((m) => m.provider === provider)
}

/** Compact context size for table cells: 1048576 → "1M", 262144 → "262K". */
export function formatCtx(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

/** "$2.50" style price for a per-1k-token figure; em-dash when unknown. */
export function formatPrice(per1k?: number): string {
  if (per1k == null) return '—'
  return `$${per1k < 0.01 ? per1k.toFixed(4) : per1k.toFixed(2).replace(/\.00$/, '')}`
}
