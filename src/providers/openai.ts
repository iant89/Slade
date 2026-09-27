import type { AttemptConfig, ProviderAdapter, KeyTestResult } from './base'
import { classifyNetworkError, errorFromResponse, sseData } from './base'

interface ApiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[]
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
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const text = data.choices?.[0]?.message?.content ?? ''
      if (text) cfg.onEvent({ type: 'delta', text })
      if (data.usage) {
        cfg.onEvent({ type: 'usage', promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens })
      }
      cfg.onEvent({ type: 'done' })
      return
    }

    try {
      for await (const data of sseData(res)) {
        if (data === '[DONE]') break
        let json: {
          choices?: { delta?: { content?: string } }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null
        }
        try {
          json = JSON.parse(data)
        } catch {
          continue
        }
        const delta = json.choices?.[0]?.delta?.content
        if (delta) cfg.onEvent({ type: 'delta', text: delta })
        if (json.usage) {
          cfg.onEvent({ type: 'usage', promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens })
        }
      }
      cfg.onEvent({ type: 'done' })
    } catch (err) {
      throw classifyNetworkError(err)
    }
  }

  async testKey(apiKey: string, baseURL?: string): Promise<KeyTestResult> {
    const base = (baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
    try {
      const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${apiKey}` } })
      if (res.ok) return { ok: true, message: `Connected — ${res.status} OK.` }
      const err = await errorFromResponse(res)
      return { ok: false, message: err.message, failure: err.failure }
    } catch (err) {
      const e = classifyNetworkError(err)
      return { ok: false, message: e.message, failure: e.failure }
    }
  }
}

export const openaiAdapter = new OpenAIAdapter()
