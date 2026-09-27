import type { AttemptConfig, ProviderAdapter, KeyTestResult } from './base'
import type { ModelDef } from '../types'
import { ProviderError, classifyNetworkError, errorFromResponse, sseData, splitDataURL } from './base'

interface Block {
  type: 'text' | 'image'
  text?: string
  source?: { type: 'base64'; media_type: string; data: string }
}

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1'

/** Anthropic reports stream failures as typed frames, not HTTP codes. */
function streamError(type: string, message: string): ProviderError {
  switch (type) {
    case 'overloaded_error':
      return new ProviderError('overloaded', message, true)
    case 'rate_limit_error':
      return new ProviderError('soft_rate_limit', message, true)
    case 'authentication_error':
    case 'permission_error':
      return new ProviderError('auth', message, false)
    case 'invalid_request_error':
      return new ProviderError('unknown', message, false)
    default:
      return new ProviderError('unknown', message, true)
  }
}

export class AnthropicAdapter implements ProviderAdapter {
  id = 'anthropic' as const
  label = 'Anthropic'

  async run(cfg: AttemptConfig): Promise<void> {
    const messages = cfg.turns.map((turn) => {
      const blocks: Block[] = [{ type: 'text', text: turn.text || '(empty)' }]
      for (const img of turn.images ?? []) {
        const { mime, base64 } = splitDataURL(img.dataURL)
        blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: base64 } })
      }
      return { role: turn.role, content: blocks }
    })

    const body = {
      model: cfg.model.apiModel,
      max_tokens: cfg.maxTokens,
      temperature: cfg.temperature,
      top_p: cfg.topP,
      stream: cfg.stream,
      ...(cfg.systemPrompt.trim() ? { system: cfg.systemPrompt } : {}),
      messages,
    }

    const base = (cfg.model.baseURL ?? ANTHROPIC_BASE).replace(/\/+$/, '')

    let res: Response
    try {
      res = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
          // Required to call the Anthropic API straight from a browser client.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
        signal: cfg.signal,
      })
    } catch (err) {
      throw classifyNetworkError(err)
    }
    if (!res.ok) throw await errorFromResponse(res)

    if (!cfg.stream) {
      const data = (await res.json()) as {
        content?: { type: string; text?: string }[]
        usage?: { input_tokens?: number; output_tokens?: number }
      }
      for (const block of data.content ?? []) {
        if (block.type === 'text' && block.text) cfg.onEvent({ type: 'delta', text: block.text })
      }
      if (data.usage) {
        cfg.onEvent({ type: 'usage', promptTokens: data.usage.input_tokens, completionTokens: data.usage.output_tokens })
      }
      cfg.onEvent({ type: 'done' })
      return
    }

    try {
      for await (const data of sseData(res)) {
        let json: {
          type?: string
          delta?: { text?: string }
          message?: { usage?: { input_tokens?: number; output_tokens?: number } }
          usage?: { input_tokens?: number; output_tokens?: number }
          error?: { message?: string; type?: string }
        }
        try {
          json = JSON.parse(data)
        } catch {
          continue
        }
        if (json.type === 'content_block_delta' && json.delta?.text) {
          cfg.onEvent({ type: 'delta', text: json.delta.text })
        } else if (json.type === 'message_start' && json.message?.usage) {
          cfg.onEvent({ type: 'usage', promptTokens: json.message.usage.input_tokens })
        } else if (json.type === 'message_delta' && json.usage) {
          cfg.onEvent({ type: 'usage', completionTokens: json.usage.output_tokens })
        } else if (json.type === 'error' && json.error) {
          throw streamError(json.error.type ?? '', json.error.message ?? 'Provider stream error.')
        }
      }
      cfg.onEvent({ type: 'done' })
    } catch (err) {
      throw classifyNetworkError(err)
    }
  }

  async testKey(apiKey: string, baseURL?: string, model?: ModelDef): Promise<KeyTestResult> {
    const base = (baseURL ?? model?.baseURL ?? ANTHROPIC_BASE).replace(/\/+$/, '')
    // Exercise the cheapest configured model — a real messages call, because
    // "the key is accepted" and "the key can actually answer" are different
    // claims and only the second one matters here.
    const apiModel = model?.apiModel ?? 'claude-3-5-haiku-latest'
    try {
      const res = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model: apiModel, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
      })
      if (res.ok) return { ok: true, message: `Connected — key accepted, and ${apiModel} answers.` }
      const err = await errorFromResponse(res)
      return { ok: false, message: err.message, failure: err.failure }
    } catch (err) {
      const e = classifyNetworkError(err)
      return { ok: false, message: e.message, failure: e.failure }
    }
  }
}

export const anthropicAdapter = new AnthropicAdapter()
