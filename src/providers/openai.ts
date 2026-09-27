import type { AttemptConfig, ProviderAdapter, KeyTestResult } from './base'
import { ProviderError, classifyNetworkError, errorFromResponse, sseData } from './base'
import type { ModelDef } from '../types'

interface ApiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[]
}

/** OpenAI-compatible servers can push an error object down an HTTP 200 stream. */
function frameError(error: { message?: string; type?: string; code?: string }): ProviderError {
  const message = error.message ?? 'The provider returned an error mid-stream.'
  if (error.code === 'insufficient_quota' || /quota|billing|credit/i.test(message)) {
    return new ProviderError('hard_quota', message, false)
  }
  if (error.code === 'invalid_api_key' || /api key/i.test(message)) {
    return new ProviderError('auth', message, false)
  }
  if (error.type === 'rate_limit_error' || error.code === 'rate_limit_exceeded') {
    return new ProviderError('soft_rate_limit', message, true)
  }
  if (error.type === 'server_error') {
    return new ProviderError('overloaded', message, true)
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
  id = 'openai' as const
  label = 'OpenAI'

  async run(cfg: AttemptConfig): Promise<void> {
    const base = (cfg.model.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
    const body: Record<string, unknown> = {
      model: cfg.model.apiModel,
      messages: buildMessages(cfg),
      temperature: cfg.temperature,
      top_p: cfg.topP,
      max_tokens: cfg.maxTokens,
      stream: cfg.stream,
    }
    if (cfg.stream) body.stream_options = { include_usage: true }

    let res: Response
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: cfg.signal,
      })
    } catch (err) {
      throw classifyNetworkError(err)
    }
    if (!res.ok) throw await errorFromResponse(res)

    if (!cfg.stream) {
      const data = (await res.json()) as {
        choices?: { message?: { content?: string; refusal?: string | null }; finish_reason?: string | null }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const choice = data.choices?.[0]
      const text = choice?.message?.content ?? ''
      if (text) cfg.onEvent({ type: 'delta', text })
      if (data.usage) {
        cfg.onEvent({ type: 'usage', promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens })
      }
      // A 200 with no text is a real failure with a real reason — say so
      // instead of letting the engine report "empty response".
      if (!text) {
        const refusal = choice?.message?.refusal
        if (refusal) throw new ProviderError('unknown', `The model refused to answer: ${refusal}`, false, res.status)
        if (choice?.finish_reason === 'content_filter') {
          throw new ProviderError('unknown', 'The answer was withheld by the provider’s content filter.', false, res.status)
        }
      }
      cfg.onEvent({ type: 'done' })
      return
    }

    try {
      for await (const data of sseData(res)) {
        if (data === '[DONE]') break
        let json: {
          choices?: { delta?: { content?: string }; finish_reason?: string | null }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null
          error?: { message?: string; type?: string; code?: string }
        }
        try {
          json = JSON.parse(data)
        } catch {
          continue
        }
        if (json.error) throw frameError(json.error)
        const delta = json.choices?.[0]?.delta?.content
        if (delta) cfg.onEvent({ type: 'delta', text: delta })
        if (json.usage) {
          cfg.onEvent({ type: 'usage', promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens })
        }
        const finish = json.choices?.[0]?.finish_reason
        if (finish && finish !== 'stop' && finish !== 'length') {
          if (finish === 'content_filter') {
            throw new ProviderError('unknown', 'The answer was withheld by the provider’s content filter.', false)
          }
          if (finish === 'tool_calls' || finish === 'function_call') {
            throw new ProviderError('unknown', 'The model asked for a tool call, which this provider has no transport for.', false)
          }
        }
      }
      cfg.onEvent({ type: 'done' })
    } catch (err) {
      throw classifyNetworkError(err)
    }
  }

  async testKey(apiKey: string, baseURL?: string, model?: ModelDef): Promise<KeyTestResult> {
    const base = (baseURL ?? model?.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
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
