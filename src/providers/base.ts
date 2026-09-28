import type { FailureClass, ModelDef, ProviderId, StreamEvent } from '../types'
import type { ChatTurn } from '../types'

export class ProviderError extends Error {
  failure: FailureClass
  retryable: boolean
  /** HTTP status when the failure came from a response. */
  status?: number
  constructor(failure: FailureClass, message: string, retryable = true, status?: number) {
    super(redactSecrets(message))
    this.name = 'ProviderError'
    this.failure = failure
    this.retryable = retryable
    this.status = status
  }
}

/**
 * Strip anything credential-shaped out of text we are about to show on screen
 * or persist. Google puts the key in the query string, so an echoed URL would
 * otherwise leak it into the transcript.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/([?&](?:key|api[_-]?key|access[_-]?token|token)=)[^&\s"'<>]+/gi, '$1<redacted>')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{10,})/g, '<redacted>')
    // GitHub credentials: classic PATs (ghp_/gho_/ghu_/ghs_/ghr_) and fine-grained PATs.
    .replace(/\bgh[pousr]_[A-Za-z0-9]{10,}\b/g, '<redacted>')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<redacted>')
}

/**
 * Pull the human-readable reason out of a provider error body.
 *
 * Handles the three shapes the major providers actually use — Google
 * `{"error":{"code","message","status"}}`, OpenAI `{"error":{"message","type"}}`
 * and Anthropic `{"type":"error","error":{"type","message"}}` — plus plain-text
 * bodies. Returns undefined when there is nothing useful to show, so callers
 * can fall back to their own wording instead of printing `{"error":…}`.
 */
export function extractApiErrorMessage(body: string): string | undefined {
  const trimmed = body.trim()
  if (!trimmed) return undefined

  try {
    const json = JSON.parse(trimmed) as {
      error?: { message?: unknown; status?: unknown; code?: unknown; type?: unknown }
      message?: unknown
    }
    const err = json?.error ?? undefined
    const raw = err?.message ?? json?.message
    if (typeof raw === 'string' && raw.trim()) {
      const status = typeof err?.status === 'string' ? err.status : typeof err?.code === 'number' ? `HTTP ${err.code}` : undefined
      const label = status && status !== 'UNKNOWN' ? ` (${status})` : ''
      return `${raw.trim()}${label}`
    }
  } catch {
    /* not JSON — fall through to the plain-text branch */
  }

  const text = trimmed
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // A bare `{…}`/`[…]` that failed to parse tells the reader nothing.
  if (!text || /^[[{]/.test(text)) return undefined
  return text.slice(0, 300)
}

export interface AttemptConfig {
  model: ModelDef
  turns: ChatTurn[]
  systemPrompt: string
  temperature: number
  maxTokens: number
  topP: number
  stream: boolean
  apiKey: string
  signal: AbortSignal
  onEvent: (ev: StreamEvent) => void
}

export interface KeyTestResult {
  ok: boolean
  message: string
  failure?: FailureClass
}

export interface ProviderAdapter {
  id: ProviderId
  label: string
  /** Streams a completion; throws ProviderError on any failure. */
  run(cfg: AttemptConfig): Promise<void>
  /**
   * Lightweight credential/connection test. `model` lets an adapter exercise
   * the exact model the user configured, which is the only way to catch a key
   * that lists models but cannot generate with them.
   */
  testKey(apiKey: string, baseURL?: string, model?: ModelDef): Promise<KeyTestResult>
}

/* ------------------------------------------------------------------ */
/* "The provider answered — but there is no answer in it"              */
/* ------------------------------------------------------------------ */

/**
 * Stop reasons that mean "the output cap ended this", not "the model
 * finished". Providers spell it differently; all of them are lowercase-folded
 * before the lookup.
 */
const TRUNCATING_FINISH = new Set(['length', 'max_tokens', 'max_output_tokens', 'token_limit_exceeded'])

export function isTruncatingFinish(finishReason: string | undefined | null): boolean {
  return Boolean(finishReason && TRUNCATING_FINISH.has(finishReason.toLowerCase()))
}

/** What an adapter observed when a completion came back with no answer text. */
export interface EmptyCompletion {
  /** The provider's own finish/stop reason, when it sent one. */
  finishReason?: string | null
  /** Characters of internal reasoning the model produced. */
  reasoningChars: number
  /** Reasoning tokens the provider billed, when it reported them. */
  reasoningTokens?: number
  /** The output cap the request was sent with. */
  maxTokens: number
  /** Upstream that actually served the request (routers: `openrouter/auto`). */
  routedModel?: string
}

/**
 * Explain an empty completion instead of shrugging at it.
 *
 * A 200 with no text has three genuinely different causes, and only one of
 * them is a mystery:
 *
 * 1. **The budget went to reasoning.** Reasoning models bill thinking against
 *    the same `max_tokens` as the answer, so a model that thinks for longer
 *    than the cap returns `finish_reason: "length"` with empty content — and,
 *    per OpenRouter's own docs, retrying it unchanged fails again. Classified
 *    `token_budget`: no cooldown (the model is fine), and the engine raises
 *    the cap and asks once more.
 * 2. **The budget was simply too small** — same remedy, different wording,
 *    because there is no reasoning to point at.
 * 3. **Nothing at all**, with a `stop` finish: the case the old generic
 *    "returned no text at all" message was written for. Kept verbatim so the
 *    one truly unexplained outcome still reads the way it always did.
 */
export function emptyCompletionError(e: EmptyCompletion): ProviderError {
  const route = e.routedModel ? ` Routed to ${e.routedModel}.` : ''
  const finish = e.finishReason ? ` The provider's stop reason was "${e.finishReason}".` : ''
  const reasoned = e.reasoningTokens
    ? `${e.reasoningTokens.toLocaleString('en-US')} reasoning tokens billed`
    : `${e.reasoningChars.toLocaleString('en-US')} characters of reasoning streamed`

  if (isTruncatingFinish(e.finishReason) && (e.reasoningTokens || e.reasoningChars > 0)) {
    return new ProviderError(
      'token_budget',
      `The model spent its whole ${e.maxTokens.toLocaleString('en-US')}-token output budget thinking and never reached an answer (${reasoned}).${route}${finish} Raise the output cap — retrying with the same budget will fail the same way.`,
      false,
    )
  }
  if (isTruncatingFinish(e.finishReason)) {
    return new ProviderError(
      'token_budget',
      `The model hit its ${e.maxTokens.toLocaleString('en-US')}-token output cap before writing any answer text.${route}${finish} Raise Max tokens in Settings → Defaults.`,
      false,
    )
  }
  return new ProviderError(
    'unknown',
    `The provider accepted the request but returned no text at all.${route}${finish}`,
    false,
  )
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Map an HTTP status + body snippet to a failure classification.
 *
 * The status code picks the *class* (which decides cooldown and whether the
 * chain should try the next model); the provider's own message is kept as the
 * *reason*, so the user sees why instead of "Unknown error".
 */
export function classifyHttp(status: number, bodySnippet: string): ProviderError {
  const body = bodySnippet.slice(0, 600).toLowerCase()
  const has = (...needles: string[]) => needles.some((n) => body.includes(n))
  const detail = extractApiErrorMessage(bodySnippet)
  const pe = (failure: FailureClass, head: string, retryable: boolean) =>
    new ProviderError(
      failure,
      detail && !head.includes(detail) ? `${head.replace(/\.\s*$/, '')}: ${detail}` : head,
      retryable,
      status,
    )

  switch (status) {
    case 401:
    case 403:
      return pe('auth', `Authentication failed (${status}) — check the API key for this provider.`, false)
    case 402:
      return pe('hard_quota', 'Payment required — the account is out of credit.', false)
    case 408:
    case 504:
      return pe('timeout', 'The provider timed out.', true)
    case 429:
      if (has('insufficient_quota', 'quota exceeded', 'billing', 'credit', 'resource_exhausted', 'depleted')) {
        return pe('hard_quota', 'Quota exhausted for this provider.', false)
      }
      return pe('soft_rate_limit', 'Rate limited — too many requests.', true)
    case 500:
    case 502:
    case 503:
    case 529:
      return pe('overloaded', 'Provider is overloaded or unavailable.', true)
    case 400:
      if (has('credit', 'balance', 'billing')) {
        return pe('hard_quota', 'Account balance exhausted.', false)
      }
      if (has('api key', 'api_key', 'unauthorized', 'invalid_key', 'permission_denied', 'api key not valid')) {
        return pe('auth', 'The provider rejected this API key.', false)
      }
      // The provider read the request and said no. Retrying it verbatim cannot
      // help, and cooling the model down would only hide the real message.
      return pe('bad_request', `The provider rejected the request (${status})`, false)
    default:
      if (status >= 500) return pe('overloaded', `Provider error (${status}).`, true)
      return pe('unknown', `Request failed (${status}).`, true)
  }
}

export function classifyNetworkError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new ProviderError('aborted', 'Cancelled.', false)
  }
  if (err instanceof TypeError) {
    return new ProviderError(
      'network',
      'Network error — the browser could not reach the provider (blocked by CORS, an ad blocker, or no route).',
      true,
    )
  }
  return new ProviderError('unknown', err instanceof Error ? err.message : String(err), true)
}

/** Parse a fetch Response as an SSE stream, yielding each `data:` payload. */
export async function* sseData(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new ProviderError('network', 'Empty response body.', true)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('data:')) yield line.slice(5).trim()
        // non-data lines (comments, event: ids) are ignored
      }
    }
    const tail = buffer.trim()
    if (tail.startsWith('data:')) yield tail.slice(5).trim()
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* noop */
    }
  }
}

/** Read an error Response body and turn it into a classified ProviderError. */
export async function errorFromResponse(res: Response): Promise<ProviderError> {
  let snippet = ''
  try {
    // Read enough to cover a verbose provider error object.
    snippet = (await res.text()).slice(0, 2000)
  } catch {
    /* noop — fall back to the status-only message */
  }
  return classifyHttp(res.status, snippet)
}

/** Strip a data URL down to raw base64 + mime. */
export function splitDataURL(dataURL: string): { mime: string; base64: string } {
  const match = /^data:([^;,]+)(;base64)?,/.exec(dataURL)
  if (!match) return { mime: 'application/octet-stream', base64: dataURL }
  return { mime: match[1] ?? 'application/octet-stream', base64: dataURL.slice(match[0].length) }
}
