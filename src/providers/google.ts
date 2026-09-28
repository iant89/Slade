import type { FailureClass, ModelDef } from '../types'
import type { AttemptConfig, ProviderAdapter, KeyTestResult } from './base'
import {
  ProviderError,
  classifyNetworkError,
  emptyCompletionError,
  errorFromResponse,
  extractApiErrorMessage,
  isTruncatingFinish,
  sseData,
  splitDataURL,
} from './base'

interface Part {
  text?: string
  /** Gemini 2.5+ marks internal reasoning this way; it is not answer text. */
  thought?: boolean
  inlineData?: { mimeType: string; data: string }
}

interface Candidate {
  content?: { parts?: Part[] }
  finishReason?: string
}

interface GenerateResponse {
  candidates?: Candidate[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
  promptFeedback?: { blockReason?: string; blockMessage?: string }
  error?: { message?: string; status?: string; code?: number }
}

const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta'

function baseFor(model: ModelDef): string {
  return (model.baseURL ?? GOOGLE_BASE).replace(/\/+$/, '')
}

/** Finish reasons that mean "we stopped early", not "try again in a minute". */
const TERMINAL_FINISH: Record<string, string> = {
  SAFETY: 'blocked by the provider’s safety filter',
  RECITATION: 'stopped — the answer looked like recitation of source material',
  PROHIBITED_CONTENT: 'stopped — prohibited content',
  BLOCKLIST: 'stopped — blocked list',
  SPII: 'stopped — sensitive personally identifying information',
  IMAGE_SAFETY: 'stopped — image safety policy',
  MALFORMED_FUNCTION_CALL: 'stopped — the model emitted a malformed function call',
  UNEXPECTED_TOOL_CALL: 'stopped — unexpected tool call',
}

/**
 * Turn a 200-with-no-content response into an accurate, non-retryable error.
 *
 * `answeredChars` is what the stream already delivered. A `MAX_TOKENS` finish
 * after real output is a truncation, not a failure — the engine reports it as
 * such, and throwing here instead would discard a good partial answer and
 * trigger a needless failover.
 */
function noContentError(
  candidates: Candidate[],
  promptFeedback: { blockReason?: string; blockMessage?: string } | undefined,
  info: { answeredChars: number; thinkingChars: number; thoughtsTokens?: number; maxTokens: number },
): ProviderError | null {
  const block = promptFeedback?.blockReason
  if (block) {
    const why = block === 'OTHER' ? 'blocked for safety or terms-of-service reasons' : `blocked (${block})`
    return new ProviderError('unknown', `The provider ${why}${promptFeedback?.blockMessage ? `: ${promptFeedback.blockMessage}` : '.'}`, false)
  }
  if (info.answeredChars > 0) return null
  const finish = candidates[0]?.finishReason
  // Gemini 2.5 thinking models bill thoughts against maxOutputTokens: a budget
  // that only fits the thinking produces MAX_TOKENS and no answer at all.
  if (isTruncatingFinish(finish)) {
    return emptyCompletionError({
      finishReason: finish,
      reasoningChars: info.thinkingChars,
      reasoningTokens: info.thoughtsTokens,
      maxTokens: info.maxTokens,
    })
  }
  if (finish && finish !== 'STOP') {
    const why = TERMINAL_FINISH[finish] ?? `stopped early (${finish})`
    return new ProviderError('unknown', `The provider ${why} and returned no answer text.`, false)
  }
  return null
}

/** A 200 response can still carry a structured error object mid-stream. */
function errorFromFrame(json: GenerateResponse): ProviderError | null {
  if (!json.error) return null
  const message = extractApiErrorMessage(JSON.stringify(json))
  return new ProviderError(classifyStatusFor(json.error.code), message ?? 'The provider returned an error.', true, json.error.code)
}

function classifyStatusFor(code: number | undefined): FailureClass {
  if (code === 429) return 'soft_rate_limit'
  if (code === 403 || code === 401) return 'auth'
  if (code === 500 || code === 503) return 'overloaded'
  return 'unknown'
}

function generationConfig(cfg: AttemptConfig): Record<string, unknown> {
  return {
    temperature: cfg.temperature,
    topP: cfg.topP,
    maxOutputTokens: cfg.maxTokens,
  }
}

export class GoogleAdapter implements ProviderAdapter {
  id = 'google' as const
  label = 'Google Gemini'

  async run(cfg: AttemptConfig): Promise<void> {
    const contents = cfg.turns.map((turn) => {
      const parts: Part[] = [{ text: turn.text || '(empty)' }]
      for (const img of turn.images ?? []) {
        const { mime, base64 } = splitDataURL(img.dataURL)
        parts.push({ inlineData: { mimeType: mime, data: base64 } })
      }
      return { role: turn.role === 'assistant' ? 'model' : 'user', parts }
    })

    const body: Record<string, unknown> = { contents, generationConfig: generationConfig(cfg) }
    if (cfg.systemPrompt.trim()) {
      body.systemInstruction = { parts: [{ text: cfg.systemPrompt }] }
    }

    // Non-streaming turns must use :generateContent — the old build always hit
    // the SSE endpoint, so "turn streaming off" silently did nothing.
    const method = cfg.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
    const url = `${baseFor(cfg.model)}/models/${encodeURIComponent(cfg.model.apiModel)}:${method}`

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Header, not ?key= — a key in the query string leaks into logs,
          // proxies and the Referer of any redirect.
          'x-goog-api-key': cfg.apiKey,
        },
        body: JSON.stringify(body),
        signal: cfg.signal,
      })
    } catch (err) {
      throw classifyNetworkError(err)
    }
    if (!res.ok) throw await errorFromResponse(res)

    // What the stream has carried so far — the evidence for explaining an
    // empty answer, and the reason a MAX_TOKENS finish is not always a failure.
    let answeredChars = 0
    let thinkingChars = 0
    let thoughtsTokens: number | undefined
    let finishReason: string | undefined

    const emit = (json: GenerateResponse) => {
      for (const candidate of json.candidates ?? []) {
        if (candidate.finishReason) finishReason = candidate.finishReason
        for (const part of candidate.content?.parts ?? []) {
          if (!part.text) continue
          // Gemini 2.5 streams its reasoning as `thought` parts. Those are
          // internal; rendering them would dump scratchpad into the answer —
          // but they are proof the model is working, so they are reported as
          // reasoning rather than dropped.
          if (part.thought) {
            thinkingChars += part.text.length
            cfg.onEvent({ type: 'reasoning', text: part.text })
          } else {
            answeredChars += part.text.length
            cfg.onEvent({ type: 'delta', text: part.text })
          }
        }
      }
      if (json.usageMetadata) {
        thoughtsTokens = json.usageMetadata.thoughtsTokenCount ?? thoughtsTokens
        cfg.onEvent({
          type: 'usage',
          promptTokens: json.usageMetadata.promptTokenCount,
          completionTokens: json.usageMetadata.candidatesTokenCount,
          reasoningTokens: json.usageMetadata.thoughtsTokenCount,
        })
      }
    }

    const emptyInfo = () => ({
      answeredChars,
      thinkingChars,
      thoughtsTokens,
      maxTokens: cfg.maxTokens,
    })

    if (!cfg.stream) {
      let json: GenerateResponse
      try {
        json = (await res.json()) as GenerateResponse
      } catch (err) {
        throw classifyNetworkError(err)
      }
      const frameError = errorFromFrame(json)
      if (frameError) throw frameError
      emit(json)
      const blocked = noContentError(json.candidates ?? [], json.promptFeedback, emptyInfo())
      if (blocked) throw blocked
      cfg.onEvent({ type: 'done', finishReason, truncated: isTruncatingFinish(finishReason) })
      return
    }

    try {
      for await (const data of sseData(res)) {
        if (data === '[DONE]') break
        let json: GenerateResponse
        try {
          json = JSON.parse(data)
        } catch {
          continue
        }
        const frameError = errorFromFrame(json)
        if (frameError) throw frameError
        emit(json)
        // After emit: a frame can carry the finish reason together with the
        // last of the answer text, and text already delivered counts.
        const blocked = noContentError(json.candidates ?? [], json.promptFeedback, emptyInfo())
        if (blocked) throw blocked
      }
      if (answeredChars === 0) {
        throw emptyCompletionError({ finishReason, reasoningChars: thinkingChars, reasoningTokens: thoughtsTokens, maxTokens: cfg.maxTokens })
      }
      cfg.onEvent({ type: 'done', finishReason, truncated: isTruncatingFinish(finishReason) })
    } catch (err) {
      throw classifyNetworkError(err)
    }
  }

  /**
   * Liveness test that mirrors the failing path instead of guessing at it.
   *
   * `GET /models` only proves the key can list models — it happily returns 200
   * for keys that are blocked from generateContent, out of credit, or lack
   * access to the model you actually configured. This sends the same request
   * shape the chat turn sends, at a token cap, so a green light here means a
   * green light in the thread.
   */
  async testKey(apiKey: string, baseURL?: string, model?: ModelDef): Promise<KeyTestResult> {
    const modelDef: ModelDef = model ?? { id: 'gemini-2-5-flash', label: 'Gemini 2.5 Flash', provider: 'google', apiModel: 'gemini-2.5-flash', enabled: true }
    const base = (baseURL ?? modelDef.baseURL ?? GOOGLE_BASE).replace(/\/+$/, '')
    const url = `${base}/models/${encodeURIComponent(modelDef.apiModel)}:generateContent`
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 1024 },
        }),
      })
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as {
          candidates?: Candidate[]
          promptFeedback?: { blockReason?: string }
        } | null
        const blocked = data
          ? noContentError(data.candidates ?? [], data.promptFeedback, {
              answeredChars: 0,
              thinkingChars: 0,
              maxTokens: 1024,
            })
          : null
        if (blocked) return { ok: false, message: blocked.message, failure: blocked.failure }
        // A 200 with nothing in it is not a pass. This is the false green
        // light that made the old key test useless.
        const answered = (data?.candidates ?? []).some((c) => (c.content?.parts ?? []).some((p) => p.text))
        if (!answered) {
          return {
            ok: false,
            message: `The key was accepted but ${modelDef.apiModel} returned no candidates — it cannot answer with this key.`,
            failure: 'unknown',
          }
        }
        return { ok: true, message: `Connected — key accepted, and ${modelDef.apiModel} answers generateContent.` }
      }
      const err = await errorFromResponse(res)
      return { ok: false, message: err.message, failure: err.failure }
    } catch (err) {
      const e = classifyNetworkError(err)
      return { ok: false, message: e.message, failure: e.failure }
    }
  }
}

export const googleAdapter = new GoogleAdapter()
