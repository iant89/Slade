import type { AttemptConfig, ProviderAdapter, KeyTestResult } from './base'
import { classifyNetworkError, errorFromResponse, sseData, splitDataURL } from './base'

interface Part {
  text?: string
  inlineData?: { mimeType: string; data: string }
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

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: cfg.temperature,
        topP: cfg.topP,
        maxOutputTokens: cfg.maxTokens,
      },
    }
    if (cfg.systemPrompt.trim()) {
      body.systemInstruction = { parts: [{ text: cfg.systemPrompt }] }
    }

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model.apiModel)}:streamGenerateContent?alt=sse` +
      (cfg.stream ? '' : '') +
      `&key=${encodeURIComponent(cfg.apiKey)}`

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: cfg.signal,
      })
    } catch (err) {
      throw classifyNetworkError(err)
    }
    if (!res.ok) throw await errorFromResponse(res)

    try {
      for await (const data of sseData(res)) {
        let json: {
          candidates?: { content?: { parts?: Part[] } }[]
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
        }
        try {
          json = JSON.parse(data)
        } catch {
          continue
        }
        const parts = json.candidates?.[0]?.content?.parts ?? []
        for (const part of parts) {
          if (part.text) cfg.onEvent({ type: 'delta', text: part.text })
        }
        if (json.usageMetadata) {
          cfg.onEvent({
            type: 'usage',
            promptTokens: json.usageMetadata.promptTokenCount,
            completionTokens: json.usageMetadata.candidatesTokenCount,
          })
        }
      }
      cfg.onEvent({ type: 'done' })
    } catch (err) {
      throw classifyNetworkError(err)
    }
  }

  async testKey(apiKey: string): Promise<KeyTestResult> {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      )
      if (res.ok) return { ok: true, message: 'Connected — key accepted.' }
      const err = await errorFromResponse(res)
      return { ok: false, message: err.message, failure: err.failure }
    } catch (err) {
      const e = classifyNetworkError(err)
      return { ok: false, message: e.message, failure: e.failure }
    }
  }
}

export const googleAdapter = new GoogleAdapter()
