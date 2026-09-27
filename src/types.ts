/**
 * Slade core domain types.
 *
 * Everything the app exchanges is modeled here with discriminated unions so
 * the compiler can prove exhaustive handling of provider events, failure
 * classes and artifact kinds.
 */

/* ------------------------------------------------------------------ */
/* Providers & models                                                  */
/* ------------------------------------------------------------------ */

export type ProviderId = 'mock' | 'openai' | 'anthropic' | 'google' | 'openrouter' | 'openai-compatible'

export type FailureClass =
  | 'success'
  | 'soft_rate_limit'
  | 'hard_quota'
  | 'auth'
  | 'timeout'
  | 'network'
  | 'overloaded'
  | 'aborted'
  /** The provider understood the request and refused it (HTTP 400 and friends). */
  | 'bad_request'
  | 'unknown'

/** What a mock model should do on its next request (failover demo control). */
export type MockSimulate = 'ok' | 'soft_rate_limit' | 'hard_quota' | 'timeout' | 'network' | 'auth' | 'bad_request'

export interface ModelOverrides {
  temperature?: number
  maxTokens?: number
  systemPrompt?: string
}

export interface ModelDef {
  id: string
  /** Human label shown in the UI, e.g. "Claude Sonnet 4.5". */
  label: string
  provider: ProviderId
  /** Model identifier passed to the provider API. */
  apiModel: string
  /** Base URL override (openai-compatible endpoints: Groq, OpenRouter, Ollama…). */
  baseURL?: string
  enabled: boolean
  /** USD per 1k tokens, used for cheapest-first routing and display. */
  costPer1kIn?: number
  costPer1kOut?: number
  contextWindow?: number
  overrides?: ModelOverrides
  /** Only meaningful for mock models. */
  simulate?: MockSimulate
}

export const FAILURE_LABEL: Record<FailureClass, string> = {
  success: 'Success',
  soft_rate_limit: 'Rate limited',
  hard_quota: 'Quota exhausted',
  auth: 'Auth failure',
  timeout: 'Timed out',
  network: 'Network error',
  overloaded: 'Provider overloaded',
  aborted: 'Cancelled',
  bad_request: 'Request rejected',
  unknown: 'Unknown error',
}

/* ------------------------------------------------------------------ */
/* Provider stream events                                              */
/* ------------------------------------------------------------------ */

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number }
  | { type: 'done' }
  | { type: 'error'; failure: FailureClass; message: string; retryable: boolean }

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  /** Images inlined for vision models; other files folded into text. */
  images?: { mime: string; dataURL: string; name: string }[]
  textFiles?: { name: string; content: string }[]
  binaryNotes?: string[]
}

/* ------------------------------------------------------------------ */
/* Artifacts                                                           */
/* ------------------------------------------------------------------ */

export type ArtifactKind =
  | 'image'
  | 'code'
  | 'doc'
  | 'sheet'
  | 'audio'
  | 'video'
  | 'archive'
  | 'unknown'

export type ArtifactSource = { origin: 'user' } | { origin: 'model'; modelId: string; modelLabel: string }

export interface Artifact {
  id: string
  name: string
  mime: string
  size: number
  kind: ArtifactKind
  createdAt: number
  provenance: ArtifactSource
  /** Small artifacts are persisted as data URLs; larger ones live in memory. */
  dataURL?: string
  /** Runtime object URL (never persisted; recreated from dataURL on load). */
  blobUrl?: string
  /** Text preview for code / docs / sheets. */
  text?: string
  /** Parsed CSV columns/rows for sheet preview. */
  columns?: string[]
  rows?: string[][]
  /** Media duration in seconds when known. */
  durationSec?: number
  /** True when the artifact exists only for this session (large files). */
  ephemeral?: boolean
}

/* ------------------------------------------------------------------ */
/* Messages & conversations                                            */
/* ------------------------------------------------------------------ */

export type Role = 'user' | 'assistant'
export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'error' | 'cancelled'

/**
 * One model that was tried for a turn, and what the provider actually said.
 * Persisted with the message so a failed turn can explain itself later.
 */
export interface AttemptFailure {
  modelId: string
  label: string
  failure: FailureClass
  /** Provider-supplied reason, already redacted and humanized. */
  message: string
  /** HTTP status when the failure came from a response, else 0. */
  status?: number
  /** Wall-clock ms spent on this attempt before it failed. */
  elapsedMs: number
  /** True when the model failed after it had already started streaming. */
  midStream: boolean
}

/** A mid-stream handoff from one model to another. */
export interface Handoff {
  fromModelId: string
  fromModelLabel: string
  toModelId: string
  /** Character offset in the final message content where the handoff happened. */
  atChar: number
  at: number
}

export interface Usage {
  promptTokens?: number
  completionTokens?: number
}

export interface Message {
  id: string
  role: Role
  conversationId: string
  content: string
  createdAt: number
  status: MessageStatus
  /** Model that produced (or last contributed to) this message. */
  modelId?: string
  /** Ordered chain of models that contributed output, primary first. */
  chain?: string[]
  /** Models that failed before any output started, in tried order. */
  failedChain?: string[]
  /** Mid-stream handoffs. */
  handoffs?: Handoff[]
  attachmentIds?: string[]
  usage?: Usage
  error?: string
  errorClass?: FailureClass
  /** Per-model detail for every attempt that failed during this turn. */
  attempts?: AttemptFailure[]
  editedAt?: number
  /** Latency to first token, ms. */
  ttftMs?: number
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
  /** Per-conversation primary model override. */
  modelId?: string
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

export type HealthState = 'available' | 'cooldown' | 'disabled' | 'error'

export interface ModelHealth {
  modelId: string
  state: HealthState
  cooldownUntil?: number
  consecutiveFailures: number
  lastError?: { at: number; failure: FailureClass; message: string }
  /** Exponential moving average of full-request latency, ms. */
  avgLatencyMs?: number
  totalRequests: number
  totalFailures: number
  totalTokensIn: number
  totalTokensOut: number
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export type FailoverStrategy = 'priority' | 'fastest' | 'cheapest'
export type ThemePref = 'light' | 'dark' | 'system'
export type Density = 'compact' | 'cozy' | 'roomy'

export interface DefaultsSettings {
  temperature: number
  topP: number
  maxTokens: number
  systemPrompt: string
  stream: boolean
  typingIndicator: boolean
  autoScroll: 'smooth' | 'instant' | 'off'
  failoverStrategy: FailoverStrategy
  /** Max gap between streamed chunks before the stream is declared stalled. */
  requestTimeoutMs: number
  /** How long to wait for the *first* token. Reasoning models need more. */
  firstTokenTimeoutMs: number
}

export interface ArtifactSettings {
  collapsedByDefault: boolean
  autoExpandImages: boolean
  maxPreviewHeight: number
}

export interface AppearanceSettings {
  theme: ThemePref
  fontSize: number
  density: Density
  codeTheme: 'auto' | 'light' | 'dark'
  reduceMotion: boolean
  enterToSend: boolean
}

export interface ProviderConfig {
  apiKey: string
  baseURL?: string
}

export interface Settings {
  version: 1
  models: ModelDef[]
  defaults: DefaultsSettings
  artifacts: ArtifactSettings
  appearance: AppearanceSettings
  providers: Record<string, ProviderConfig>
  pinnedModelId?: string
}

/* ------------------------------------------------------------------ */
/* Toasts & misc UI                                                    */
/* ------------------------------------------------------------------ */

export type ToastKind = 'info' | 'success' | 'warn' | 'error'

export interface Toast {
  id: string
  kind: ToastKind
  title: string
  detail?: string
}
