import { z } from 'zod'
import type { Settings } from '../types'

/* ------------------------------------------------------------------ */
/* Zod-validated configuration                                         */
/* ------------------------------------------------------------------ */

export const providerIdSchema = z.enum(['mock', 'openai', 'anthropic', 'google', 'openrouter', 'openai-compatible'])
export const mockSimulateSchema = z.enum(['ok', 'soft_rate_limit', 'hard_quota', 'timeout', 'network', 'auth', 'bad_request'])

export const modelDefSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  provider: providerIdSchema,
  apiModel: z.string().min(1),
  baseURL: z.string().optional(),
  enabled: z.boolean(),
  costPer1kIn: z.number().nonnegative().optional(),
  costPer1kOut: z.number().nonnegative().optional(),
  contextWindow: z.number().positive().optional(),
  overrides: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().positive().optional(),
      systemPrompt: z.string().optional(),
    })
    .optional(),
  simulate: mockSimulateSchema.optional(),
})

export const settingsSchema = z.object({
  version: z.literal(1),
  models: z.array(modelDefSchema),
  defaults: z.object({
    temperature: z.number().min(0).max(2),
    topP: z.number().min(0).max(1),
    maxTokens: z.number().int().min(16).max(200_000),
    systemPrompt: z.string(),
    stream: z.boolean(),
    typingIndicator: z.boolean(),
    autoScroll: z.enum(['smooth', 'instant', 'off']),
    failoverStrategy: z.enum(['priority', 'fastest', 'cheapest']),
    requestTimeoutMs: z.number().int().min(5_000).max(600_000),
    // Added after the first release: defaulted so older saved settings keep
    // validating and upgrade in place.
    firstTokenTimeoutMs: z.number().int().min(5_000).max(600_000).default(120_000),
  }),
  artifacts: z.object({
    collapsedByDefault: z.boolean(),
    autoExpandImages: z.boolean(),
    maxPreviewHeight: z.number().int().min(120).max(1200),
  }),
  appearance: z.object({
    theme: z.enum(['light', 'dark', 'system']),
    fontSize: z.number().min(12).max(20),
    density: z.enum(['compact', 'cozy', 'roomy']),
    codeTheme: z.enum(['auto', 'light', 'dark']),
    reduceMotion: z.boolean(),
    enterToSend: z.boolean(),
  }),
  // Added after the first release: defaults keep older saved settings valid
  // and upgrade in place.
  agent: z
    .object({
      orchestratorModelId: z.string().optional(),
      maxSteps: z.number().int().min(1).max(8).default(4),
      maxParallel: z.number().int().min(1).max(4).default(2),
      expandStepResults: z.boolean().default(true),
    })
    .default({ maxSteps: 4, maxParallel: 2, expandStepResults: true }),
  providers: z.record(z.string(), z.object({ apiKey: z.string(), baseURL: z.string().optional() })),
  pinnedModelId: z.string().optional(),
})

export const attemptFailureSchema = z.object({
  modelId: z.string(),
  label: z.string(),
  failure: z.enum([
    'success',
    'soft_rate_limit',
    'hard_quota',
    'auth',
    'timeout',
    'network',
    'overloaded',
    'aborted',
    'bad_request',
    'unknown',
  ]),
  message: z.string(),
  status: z.number().int().optional(),
  elapsedMs: z.number().int().nonnegative(),
  midStream: z.boolean(),
})

export const agentStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  modelId: z.string(),
  modelLabel: z.string(),
  status: z.enum(['pending', 'running', 'complete', 'error', 'skipped']),
  result: z.string().optional(),
  error: z.string().optional(),
  attempts: z.array(attemptFailureSchema),
  failedChain: z.array(z.string()),
  elapsedMs: z.number().optional(),
})

export const agentRunSchema = z.object({
  phase: z.enum(['planning', 'executing', 'synthesizing', 'complete', 'error']),
  goal: z.string(),
  orchestratorModelId: z.string(),
  steps: z.array(agentStepSchema),
  strategy: z.string().optional(),
  note: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
})

export const messageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  conversationId: z.string(),
  content: z.string(),
  createdAt: z.number(),
  status: z.enum(['pending', 'streaming', 'complete', 'error', 'cancelled']),
  modelId: z.string().optional(),
  chain: z.array(z.string()).optional(),
  failedChain: z.array(z.string()).optional(),
  handoffs: z
    .array(
      z.object({
        fromModelId: z.string(),
        fromModelLabel: z.string(),
        toModelId: z.string(),
        atChar: z.number().int().nonnegative(),
        at: z.number(),
      }),
    )
    .optional(),
  attachmentIds: z.array(z.string()).optional(),
  usage: z
    .object({ promptTokens: z.number().optional(), completionTokens: z.number().optional() })
    .optional(),
  error: z.string().optional(),
  errorClass: z
    .enum([
      'success',
      'soft_rate_limit',
      'hard_quota',
      'auth',
      'timeout',
      'network',
      'overloaded',
      'aborted',
      'bad_request',
      'unknown',
    ])
    .optional(),
  attempts: z.array(attemptFailureSchema).optional(),
  editedAt: z.number().optional(),
  ttftMs: z.number().optional(),
  agent: agentRunSchema.optional(),
})

export const artifactSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  kind: z.enum(['image', 'code', 'doc', 'sheet', 'audio', 'video', 'archive', 'unknown']),
  createdAt: z.number(),
  provenance: z.union([
    z.object({ origin: z.literal('user') }),
    z.object({ origin: z.literal('model'), modelId: z.string(), modelLabel: z.string() }),
  ]),
  remote: z
    .object({
      kind: z.literal('github'),
      repo: z.string(),
      ref: z.string(),
      path: z.string(),
      url: z.string(),
      sha: z.string().optional(),
    })
    .optional(),
  dataURL: z.string().optional(),
  text: z.string().optional(),
  columns: z.array(z.string()).optional(),
  rows: z.array(z.array(z.string())).optional(),
  durationSec: z.number().optional(),
  ephemeral: z.boolean().optional(),
})

export const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  modelId: z.string().optional(),
  agentEnabled: z.boolean().optional(),
  messages: z.array(messageSchema),
})

/* ------------------------------------------------------------------ */
/* GitHub connection (own storage key; the token never enters a backup) */
/* ------------------------------------------------------------------ */

export const githubPersistedSchema = z.object({
  token: z.string(),
  clientId: z.string(),
  relayUrl: z.string(),
  scope: z.string(),
  login: z.string().optional(),
  avatarUrl: z.string().optional(),
  scopes: z.array(z.string()),
  recentRepos: z.array(z.string()),
  activeRepo: z.string().optional(),
  activeBranch: z.string().optional(),
  publish: z.object({
    target: z.enum(['gist', 'file', 'issue']),
    repo: z.string().optional(),
    branch: z.string().optional(),
    prefix: z.string(),
    gistPublic: z.boolean(),
    useNewBranch: z.boolean(),
  }),
})

export const exportBundleSchema = z.object({
  app: z.literal('slade'),
  version: z.number(),
  exportedAt: z.number(),
  settings: settingsSchema.optional(),
  conversations: z.array(conversationSchema).optional(),
  artifacts: z.array(artifactSchema).optional(),
})

export type ExportBundle = z.infer<typeof exportBundleSchema>

export function validateSettings(raw: unknown): Settings | null {
  const res = settingsSchema.safeParse(raw)
  return res.success ? (res.data as Settings) : null
}
