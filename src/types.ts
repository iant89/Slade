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
  /**
   * The provider answered, but the output budget ran out before any *answer*
   * text arrived — typically a reasoning model that spent every token
   * thinking. Not a sick model: a too-small `max_tokens`. Waiting cannot fix
   * it (so no cooldown); raising the budget can, and the engine does exactly
   * that once before walking the chain.
   */
  | 'token_budget'
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
  token_budget: 'Token budget',
  unknown: 'Unknown error',
}

/* ------------------------------------------------------------------ */
/* Provider stream events                                              */
/* ------------------------------------------------------------------ */

export type StreamEvent =
  | { type: 'delta'; text: string }
  /**
   * Internal reasoning ("thinking") text. It is provenance for the answer,
   * never the answer itself — the engine uses it as liveness (a model that is
   * still thinking has not stalled) and as evidence when a turn comes back
   * with no content at all.
   */
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number; reasoningTokens?: number }
  /**
   * `finishReason` is the provider's own stop reason; `truncated` is true when
   * that reason was the token cap rather than the model finishing its answer.
   */
  | { type: 'done'; finishReason?: string; truncated?: boolean }
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

/** Where a file came from when it was not uploaded from disk (GitHub repos). */
export interface RemoteSource {
  kind: 'github'
  /** `owner/name`. */
  repo: string
  /** Branch, tag or commit sha the file was read at. */
  ref: string
  path: string
  /** Canonical permalink on github.com. */
  url: string
  sha?: string
}

export interface Artifact {
  id: string
  name: string
  mime: string
  size: number
  kind: ArtifactKind
  createdAt: number
  provenance: ArtifactSource
  /** Set when the artifact was pulled from a repository rather than uploaded. */
  remote?: RemoteSource
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
/* Orchestrator agent (agent mode)                                     */
/* ------------------------------------------------------------------ */

export type AgentPhase = 'planning' | 'executing' | 'synthesizing' | 'complete' | 'error'

export type AgentStepStatus = 'pending' | 'running' | 'complete' | 'error' | 'skipped'

/**
 * One subtask the orchestrator delegated to a worker model. Persisted with
 * the message so the whole run stays inspectable after a reload.
 */
export interface AgentStep {
  id: string
  title: string
  /** Full self-contained prompt the worker received. */
  prompt: string
  modelId: string
  /** Resolved at plan time; kept separately so a renamed model still renders. */
  modelLabel: string
  status: AgentStepStatus
  /** The worker's full output. */
  result?: string
  error?: string
  /** Failures inside this step's own failover walk, tried order. */
  attempts: AttemptFailure[]
  /** Worker model ids that failed before this step produced output. */
  failedChain: string[]
  elapsedMs?: number
  /** True when the worker's output was cut off by the token cap. */
  truncated?: boolean
}

export interface AgentRun {
  phase: AgentPhase
  /** The user's goal this run is executing. */
  goal: string
  orchestratorModelId: string
  steps: AgentStep[]
  /** Orchestrator's one-line strategy note from the planning call. */
  strategy?: string
  /** Set when planning had to fall back (unparseable plan → single step). */
  note?: string
  error?: string
  startedAt: number
  finishedAt?: number
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
  /**
   * Tokens billed for internal reasoning. Always a subset of
   * `completionTokens` — when the two are close and the answer is empty, the
   * budget was consumed by thinking rather than by output.
   */
  reasoningTokens?: number
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
  /** True when the answer stopped at the output token cap instead of finishing. */
  truncated?: boolean
  /** Present when this reply was produced by the orchestrator agent. */
  agent?: AgentRun
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
  /** Per-conversation primary model override. */
  modelId?: string
  /** When true, sends go through the orchestrator agent instead of the plain chain. */
  agentEnabled?: boolean
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

/** Orchestrator agent configuration (Settings → Agent). */
export interface AgentSettings {
  /** Model that plans, delegates and synthesizes. Undefined = top of the chain. */
  orchestratorModelId?: string
  /** Upper bound on subtasks per run. */
  maxSteps: number
  /** How many workers may run at once (1 = strictly sequential). */
  maxParallel: number
  /** When false the plan card collapses worker outputs to one line each. */
  expandStepResults: boolean
  /**
   * Output token ceiling for the orchestrator's own calls (plan, each worker
   * step, synthesis). Deliberately well above the chat default: a step is a
   * whole deliverable ("build the app"), and reasoning models bill their
   * thinking against the same cap — a 4k ceiling is how a step comes back
   * empty. Raising a ceiling costs nothing unless the tokens are used.
   */
  stepMaxTokens: number
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
  agent: AgentSettings
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
