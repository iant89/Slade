import type { AttemptConfig, ProviderAdapter, KeyTestResult } from './base'
import type { ProviderId } from '../types'
import {
  ProviderError,
  classifyHttp,
  classifyNetworkError,
  emptyCompletionError,
  errorFromResponse,
  isTruncatingFinish,
  sseData,
} from './base'
import type { ModelDef } from '../types'

interface ApiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[]
}

/* ------------------------------------------------------------------ */
/* Wire shapes                                                         */
/* ------------------------------------------------------------------ */

/** One entry of OpenRouter's `reasoning_details` array. */
interface ReasoningDetail {
  type?: string
  text?: string
  summary?: string
  /** Encrypted reasoning; opaque by design, never rendered. */
  data?: string
}

/**
 * A streamed delta or a non-streamed message. Reasoning models put their
 * thinking in a *separate channel* from the answer, and OpenAI-compatible
 * servers disagree about the channel's name: OpenRouter normalises to
 * `reasoning` (+ `reasoning_details`), DeepSeek and friends emit
 * `reasoning_content`.
 */
interface WireMessage {
  content?: string | null
  reasoning?: string | null
  reasoning_content?: string | null
  reasoning_details?: ReasoningDetail[] | null
  refusal?: string | null
}

interface WireChoice {
  delta?: WireMessage | null
  message?: WireMessage | null
  finish_reason?: string | null
  native_finish_reason?: string | null
}

interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  /** Reasoning tokens are billed inside `completion_tokens`, not on top. */
  completion_tokens_details?: { reasoning_tokens?: number } | null
}

interface WireFrame {
  choices?: WireChoice[]
  /** On a router (`openrouter/auto`) this is the model actually selected. */
  model?: string
  usage?: WireUsage | null
  error?: {
    message?: string
    type?: string
    /** OpenAI: a string code. OpenRouter mid-stream: the HTTP status, numeric. */
    code?: string | number
    metadata?: { error_type?: string; provider_code?: string }
  }
}

/** Readable reasoning text out of whichever channel this server used. */
function reasoningText(msg: WireMessage | null | undefined): string {
  if (!msg) return ''
  let out = ''
  if (typeof msg.reasoning === 'string') out += msg.reasoning
  if (typeof msg.reasoning_content === 'string') out += msg.reasoning_content
  for (const part of msg.reasoning_details ?? []) {
    // Only plain-text parts are readable; `summary`/`encrypted` parts would
    // dump scratchpad metadata or base64 into the transcript.
    if (part?.type === 'text' && typeof part.text === 'string') out += part.text
  }
  return out
}

/**
 * Some OpenRouter reasoning models write the *deliverable* into the reasoning
 * channel and leave `content` null behind a clean `stop` — the answer exists,
 * it is just mislabelled. When the model finished normally and reasoning is
 * the only text it produced, hand that text back rather than failing the turn.
 *
 * Never applied to a truncated stream: there the reasoning is a half-finished
 * thought, not a deliverable, and pretending otherwise would show the user
 * scratchpad.
 */
function answerInsideReasoning(reasoning: string, finishReason?: string | null): string | undefined {
  const text = reasoning.trim()
  if (!text || isTruncatingFinish(finishReason)) return undefined
  return text
}

function emitUsage(cfg: AttemptConfig, usage: WireUsage): void {
  cfg.onEvent({
    type: 'usage',
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
  })
}

/** OpenAI-compatible servers can push an error object down an HTTP 200 stream. */
function frameError(error: NonNullable<WireFrame['error']>): ProviderError {
  const message = error.message ?? 'The provider returned an error mid-stream.'
  const kind = error.metadata?.error_type ?? (typeof error.code === 'string' ? error.code : undefined) ?? error.type
  if (kind === 'insufficient_quota' || /quota|billing|credit/i.test(message)) {
    return new ProviderError('hard_quota', message, false)
  }
  if (kind === 'invalid_api_key' || /api key/i.test(message)) {
    return new ProviderError('auth', message, false)
  }
  if (error.type === 'rate_limit_error' || kind === 'rate_limit_exceeded') {
    return new ProviderError('soft_rate_limit', message, true)
  }
  if (error.type === 'server_error') {
    return new ProviderError('overloaded', message, true)
  }
  // OpenRouter reports an upstream failure mid-stream as
  // `error: { code: <HTTP status>, message, metadata: { error_type } }`.
  // Classify by that status so a 429 in frame 40 is a rate limit (30s
  // cooldown) and not an "unknown error" (20s), and a 402 is quota.
  if (typeof error.code === 'number') {
    return classifyHttp(error.code, JSON.stringify({ error: { message, code: kind } }))
  }
  return new ProviderError('unknown', message, true)
}

function buildMessages(cfg: AttemptConfig): ApiMessage[] {
  const msgs: ApiMessage[] = []
  if (cfg.systemPrompt.trim()) msgs.push({ role: 'system', content: cfg.systemPrompt })
  for (const turn of cfg.turns) {
    const parts: Exclude<ApiMessage['content'], string> = [{ type: 'text', text: turn.text || '(empty)' }]
    for (const img of turn.images ?? []) {
      parts.push({ type: 'image_url', image_url: { url: img.dataURL } })
    }
    msgs.push({
      role: turn.role,
      content: parts.length === 1 ? (parts[0] as { type: 'text'; text: string }).text : parts,
    })
  }
  return msgs
}

export class OpenAIAdapter implements ProviderAdapter {
  id: ProviderId = 'openai'
  label = 'OpenAI'

  /** Where requests go unless the model (or a key test) says otherwise. */
  protected get defaultBaseURL(): string {
    return 'https://api.openai.com/v1'
  }

  protected resolveBase(baseURL?: string, model?: ModelDef): string {
    return (baseURL ?? model?.baseURL ?? this.defaultBaseURL).replace(/\/+$/, '')
  }

  /** Extra request headers; provider flavours (OpenRouter) add their own. */
  protected extraHeaders(_cfg: AttemptConfig): Record<string, string> {
    return {}
  }

  /** Last chance for a provider flavour to amend the request body. */
  protected amendBody(_body: Record<string, unknown>, _cfg: AttemptConfig): void {
    /* plain OpenAI wants nothing extra */
  }

  async run(cfg: AttemptConfig): Promise<void> {
    const base = this.resolveBase(undefined, cfg.model)
    const body: Record<string, unknown> = {
      model: cfg.model.apiModel,
      messages: buildMessages(cfg),
      temperature: cfg.temperature,
      top_p: cfg.topP,
      max_tokens: cfg.maxTokens,
      stream: cfg.stream,
    }
    if (cfg.stream) body.stream_options = { include_usage: true }
    this.amendBody(body, cfg)

    let res: Response
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}`, ...this.extraHeaders(cfg) },
        body: JSON.stringify(body),
        signal: cfg.signal,
      })
    } catch (err) {
      throw classifyNetworkError(err)
    }
    if (!res.ok) throw await errorFromResponse(res)

    if (!cfg.stream) {
      const data = (await res.json()) as WireFrame
      const choice = data.choices?.[0]
      const msg = choice?.message
      const finish = choice?.finish_reason ?? choice?.native_finish_reason
      const text = typeof msg?.content === 'string' ? msg.content : ''
      if (text) cfg.onEvent({ type: 'delta', text })
      if (data.usage) emitUsage(cfg, data.usage)

      if (!text.trim()) {
        // A 200 with no text is a real failure with a real reason — say so
        // instead of letting the engine report "empty response".
        if (msg?.refusal) throw new ProviderError('unknown', `The model refused to answer: ${msg.refusal}`, false, res.status)
        if (finish === 'content_filter') {
          throw new ProviderError('unknown', 'The answer was withheld by the provider’s content filter.', false, res.status)
        }
        const reasoning = reasoningText(msg)
        const recovered = answerInsideReasoning(reasoning, finish)
        if (recovered) {
          cfg.onEvent({ type: 'delta', text: recovered })
        } else {
          throw emptyCompletionError({
            finishReason: finish,
            reasoningChars: reasoning.length,
            reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
            maxTokens: cfg.maxTokens,
            routedModel: data.model !== cfg.model.apiModel ? data.model : undefined,
          })
        }
      }
      cfg.onEvent({ type: 'done', finishReason: finish ?? undefined, truncated: isTruncatingFinish(finish) })
      return
    }

    // What the stream actually carried. Reasoning and content are counted
    // separately because "no answer" has a different meaning depending on
    // which one the model spent its tokens on.
    let contentChars = 0
    let reasoningChars = 0
    let reasoningBuffer = ''
    let finishReason: string | null | undefined
    let routedModel: string | undefined
    let reasoningTokens: number | undefined

    try {
      for await (const data of sseData(res)) {
        if (data === '[DONE]') break
        let json: WireFrame
        try {
          json = JSON.parse(data)
        } catch {
          continue
        }
        if (json.error) throw frameError(json.error)
        if (json.model) routedModel = json.model
        const choice = json.choices?.[0]
        const delta = choice?.delta?.content
        if (delta) {
          contentChars += delta.length
          cfg.onEvent({ type: 'delta', text: delta })
        }
        // Reasoning deltas are not answer text, but they are not nothing
        // either: they keep a thinking model alive on the first-token budget
        // and they are the evidence when the answer never arrives.
        const thought = reasoningText(choice?.delta)
        if (thought) {
          reasoningChars += thought.length
          reasoningBuffer += thought
          cfg.onEvent({ type: 'reasoning', text: thought })
        }
        if (json.usage) {
          emitUsage(cfg, json.usage)
          reasoningTokens = json.usage.completion_tokens_details?.reasoning_tokens ?? reasoningTokens
        }
        const finish = choice?.finish_reason ?? choice?.native_finish_reason
        if (finish) finishReason = finish
        if (finish && finish !== 'stop' && !isTruncatingFinish(finish)) {
          if (finish === 'content_filter') {
            throw new ProviderError('unknown', 'The answer was withheld by the provider’s content filter.', false)
          }
          if (finish === 'tool_calls' || finish === 'function_call') {
            throw new ProviderError('unknown', 'The model asked for a tool call, which this provider has no transport for.', false)
          }
          if (finish === 'error') {
            throw new ProviderError('overloaded', 'The provider reported an error part-way through the stream.', true)
          }
        }
      }

      if (contentChars === 0) {
        const recovered = answerInsideReasoning(reasoningBuffer, finishReason)
        if (recovered) {
          contentChars = recovered.length
          cfg.onEvent({ type: 'delta', text: recovered })
        } else {
          throw emptyCompletionError({
            finishReason,
            reasoningChars,
            reasoningTokens,
            maxTokens: cfg.maxTokens,
            routedModel: routedModel !== cfg.model.apiModel ? routedModel : undefined,
          })
        }
      }
      cfg.onEvent({ type: 'done', finishReason: finishReason ?? undefined, truncated: isTruncatingFinish(finishReason) })
    } catch (err) {
      throw classifyNetworkError(err)
    }
  }

  async testKey(apiKey: string, baseURL?: string, model?: ModelDef): Promise<KeyTestResult> {
    const base = this.resolveBase(baseURL, model)
    try {
      const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${apiKey}` } })
      if (!res.ok) {
        const err = await errorFromResponse(res)
        return { ok: false, message: err.message, failure: err.failure }
      }
      // Listing models proves the key is well-formed, not that it can answer.
      // When a concrete model is configured, spend one cheap token to find out.
      if (model) {
        const probe = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: model.apiModel,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        })
        if (probe.ok) return { ok: true, message: `Connected — key accepted, and ${model.apiModel} answers.` }
        const err = await errorFromResponse(probe)
        return { ok: false, message: err.message, failure: err.failure }
      }
      return { ok: true, message: `Connected — ${res.status} OK.` }
    } catch (err) {
      const e = classifyNetworkError(err)
      return { ok: false, message: e.message, failure: e.failure }
    }
  }
}

export const openaiAdapter = new OpenAIAdapter()

/* ------------------------------------------------------------------ */
/* OpenRouter                                                          */
/*                                                                     */
/* OpenRouter speaks OpenAI's wire format, so it rides on the same     */
/* adapter with three differences: its own default endpoint, the       */
/* attribution headers OpenRouter's rankings use, and OpenRouter's     */
/* documented `usage: { include: true }` flag so streamed turns still  */
/* report token counts (stream_options alone is not honoured by every  */
/* upstream model).                                                    */
/* ------------------------------------------------------------------ */

export class OpenRouterAdapter extends OpenAIAdapter {
  override id: ProviderId = 'openrouter'
  override label = 'OpenRouter'

  protected override get defaultBaseURL(): string {
    return 'https://openrouter.ai/api/v1'
  }

  protected override extraHeaders(): Record<string, string> {
    return {
      'HTTP-Referer': 'https://github.com/iant89/Slade',
      'X-Title': 'Slade',
    }
  }

  protected override amendBody(body: Record<string, unknown>, cfg: AttemptConfig): void {
    if (cfg.stream) body.usage = { include: true }
  }
}

export const openrouterAdapter = new OpenRouterAdapter()
