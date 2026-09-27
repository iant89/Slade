import type { FailureClass, ModelDef, ProviderId, StreamEvent } from '../types'
import type { ChatTurn } from '../types'

export class ProviderError extends Error {
  failure: FailureClass
  retryable: boolean
  constructor(failure: FailureClass, message: string, retryable = true) {
    super(message)
    this.name = 'ProviderError'
    this.failure = failure
    this.retryable = retryable
  }
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
  /** Lightweight credential/connection test. */
  testKey(apiKey: string, baseURL?: string): Promise<KeyTestResult>
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Map an HTTP status + body snippet to a failure classification. */
export function classifyHttp(status: number, bodySnippet: string): ProviderError {
  const body = bodySnippet.slice(0, 600).toLowerCase()
  const has = (...needles: string[]) => needles.some((n) => body.includes(n))

  switch (status) {
    case 401:
    case 403:
      return new ProviderError('auth', 'Authentication failed — check the API key for this provider.', false)
    case 402:
      return new ProviderError('hard_quota', 'Payment required — the account is out of credit.', false)
    case 408:
    case 504:
      return new ProviderError('timeout', 'The provider timed out.', true)
    case 429:
      if (has('insufficient_quota', 'quota exceeded', 'billing', 'credit', 'resource_exhausted')) {
        return new ProviderError('hard_quota', 'Quota exhausted for this provider.', false)
      }
      return new ProviderError('soft_rate_limit', 'Rate limited — too many requests.', true)
    case 500:
    case 502:
    case 503:
    case 529:
      return new ProviderError('overloaded', 'Provider is overloaded or unavailable.', true)
    case 400:
      if (has('credit', 'balance', 'billing')) {
        return new ProviderError('hard_quota', 'Account balance exhausted.', false)
      }
      if (has('api key', 'api_key', 'unauthorized', 'invalid_key')) {
        return new ProviderError('auth', 'Invalid API key.', false)
      }
      return new ProviderError('unknown', `Bad request (${status}).`, true)
    default:
      if (status >= 500) return new ProviderError('overloaded', `Provider error (${status}).`, true)
      return new ProviderError('unknown', `Request failed (${status}).`, true)
  }
}

export function classifyNetworkError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new ProviderError('aborted', 'Cancelled.', false)
  }
  if (err instanceof TypeError) {
    return new ProviderError('network', 'Network error — could not reach the provider.', true)
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
    snippet = (await res.text()).slice(0, 800)
  } catch {
    /* noop */
  }
  return classifyHttp(res.status, snippet)
}

/** Strip a data URL down to raw base64 + mime. */
export function splitDataURL(dataURL: string): { mime: string; base64: string } {
  const match = /^data:([^;,]+)(;base64)?,/.exec(dataURL)
  if (!match) return { mime: 'application/octet-stream', base64: dataURL }
  return { mime: match[1] ?? 'application/octet-stream', base64: dataURL.slice(match[0].length) }
}
