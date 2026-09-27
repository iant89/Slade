/**
 * Headless smoke test for Slade's failover engine.
 *
 * Runs the real stores, routing strategy, mock provider and orchestrator in
 * Node (with a tiny localStorage shim) — no browser needed.
 *
 *   npx esbuild scripts/smoke.ts --bundle --platform=node --format=esm --outfile=/tmp/smoke.mjs && node /tmp/smoke.mjs
 */

/* Minimal browser shims */
const store = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
}
;(globalThis as Record<string, unknown>).performance ??= { now: () => Date.now() }

import { useSettings } from '../src/store/settings'
import { useChat } from '../src/store/chat'
import { cooldownMsFor, useHealth } from '../src/store/health'
import { sendUserMessage, stopGeneration } from '../src/engine/send'
import { classifyHttp } from '../src/providers/base'
import type { ProviderError } from '../src/providers/base'
import { mockAdapter } from '../src/providers/mock'
import { googleAdapter } from '../src/providers/google'
import type { ModelDef } from '../src/types'
import { createServer } from 'node:http'

let failures = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const lastAssistant = () => {
  const chat = useChat.getState()
  const conv = chat.conversations[chat.currentId]!
  return conv.messages.find((m) => m.role === 'assistant')!
}

function testClassify() {
  console.log('classifyHttp:')
  check('429 generic → soft rate limit', classifyHttp(429, 'too many requests').failure === 'soft_rate_limit')
  check('429 insufficient_quota → hard quota', classifyHttp(429, '{"error":"insufficient_quota"}').failure === 'hard_quota')
  check('401 → auth', classifyHttp(401, 'unauthorized').failure === 'auth')
  check('402 → hard quota', classifyHttp(402, 'payment required').failure === 'hard_quota')
  check('504 → timeout', classifyHttp(504, 'gateway timeout').failure === 'timeout')
  check('503 → overloaded', classifyHttp(503, 'unavailable').failure === 'overloaded')
}

/**
 * The bug this file exists for: a failing turn used to be summarised as
 * "Unknown error", because the provider's own explanation was thrown away and
 * the class was hardcoded. These assertions pin the real reason to the surface.
 */
function testErrorDetail() {
  console.log('error detail:')
  const gemini400 = classifyHttp(
    400,
    JSON.stringify({
      error: {
        code: 400,
        message: 'GenerateContentRequest.generation_config: max_output_tokens must be greater than the thinking budget.',
        status: 'INVALID_ARGUMENT',
      },
    }),
  )
  check('400 keeps the provider sentence', gemini400.message.includes('thinking budget'), gemini400.message)
  check('400 keeps the provider status', gemini400.message.includes('INVALID_ARGUMENT'), gemini400.message)
  check('400 is not retried into a tight loop', gemini400.retryable === false)
  check('400 carries the HTTP status', gemini400.status === 400)
  check('400 classifies as a rejected request, not unknown', gemini400.failure === 'bad_request', gemini400.failure)

  const blockedKey = classifyHttp(
    403,
    JSON.stringify({ error: { code: 403, message: 'Requests to this API method are blocked.', status: 'PERMISSION_DENIED' } }),
  )
  check('blocked key → auth, not unknown', blockedKey.failure === 'auth', blockedKey.failure)
  check('blocked key keeps its reason', blockedKey.message.includes('PERMISSION_DENIED'), blockedKey.message)

  const depleted = classifyHttp(429, JSON.stringify({ error: { code: 429, message: 'Your prepayment credits are depleted.', status: 'RESOURCE_EXHAUSTED' } }))
  check('depleted credits → hard quota', depleted.failure === 'hard_quota', depleted.failure)
  check('depleted credits is not retried', depleted.retryable === false)

  const anthropicShape = classifyHttp(401, JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
  check('anthropic error shape parses', anthropicShape.message.includes('invalid x-api-key'), anthropicShape.message)

  const redacted = classifyHttp(400, 'Request failed for https://x/models?key=AIzaSyTOPSECRETVALUE12345')
  check('API keys are redacted from surfaced text', !redacted.message.includes('AIzaSyTOPSECRET'), redacted.message)
}

async function testMockStream() {
  console.log('mock adapter:')
  const deltas: string[] = []
  const controller = new AbortController()
  await mockAdapter.run({
    model: { id: 'mock-pro', label: 'Simulacron Pro', provider: 'mock', apiModel: 'simulacron-pro', enabled: true },
    turns: [{ role: 'user', text: 'show me some code please' }],
    systemPrompt: '',
    temperature: 0.7,
    maxTokens: 4096,
    topP: 1,
    stream: true,
    apiKey: '',
    signal: controller.signal,
    onEvent: (ev) => {
      if (ev.type === 'delta') deltas.push(ev.text)
    },
  })
  const text = deltas.join('')
  check('streamed non-empty reply', text.length > 50)
  check('reply contains markdown fence', text.includes('```'))
}

async function testFailover() {
  console.log('failover chain walk:')

  // Scenario 1: Pro fails hard quota pre-stream; Lite takes over cleanly.
  useSettings.getState().setModel('mock-pro', { simulate: 'hard_quota' })
  useSettings.getState().setModel('mock-lite', { simulate: 'ok' })
  useChat.getState().newConversation()
  await sendUserMessage('hello there', [])
  const a1 = lastAssistant()
  check('assistant message completed', a1.status === 'complete', a1.status)
  check('served by Simulacron Lite', a1.modelId === 'mock-lite', String(a1.modelId))
  check(
    'failedChain records Simulacron Pro',
    JSON.stringify(a1.failedChain) === JSON.stringify(['mock-pro']),
    JSON.stringify(a1.failedChain),
  )
  check('content non-empty', a1.content.length > 20)
  check(
    'health: pro is cooling down',
    (useHealth.getState().byModel['mock-pro']?.cooldownUntil ?? 0) > Date.now(),
  )
  check('health: lite available after success', useHealth.getState().byModel['mock-lite']?.state === 'available')

  // Scenario 2: both models fail → chain exhausts into a clear error.
  useHealth.getState().markHealthy('mock-pro')
  useSettings.getState().setModel('mock-lite', { simulate: 'soft_rate_limit' })
  useChat.getState().newConversation()
  await sendUserMessage('again', [])
  const a2 = lastAssistant()
  check('exhausted chain → error status', a2.status === 'error', a2.status)
  check(
    'error summary names both models',
    (a2.error ?? '').includes('Simulacron Pro') && (a2.error ?? '').includes('Simulacron Lite'),
    a2.error,
  )
  check('exhausted chain records an attempt per model', (a2.attempts?.length ?? 0) === 2, JSON.stringify(a2.attempts))
  check(
    'each attempt keeps its own reason',
    (a2.attempts ?? []).every((a) => a.message.length > 0),
    JSON.stringify(a2.attempts?.map((a) => a.message)),
  )
  check(
    'summary quotes the last provider reason, not "unknown error"',
    (a2.error ?? '').includes('Simulated: 429 rate limit reached') && !/unknown error/i.test(a2.error ?? ''),
    a2.error,
  )

  // Scenario 3: Pro is still cooling down → the chain skips it entirely.
  useSettings.getState().setModel('mock-lite', { simulate: 'ok' })
  useHealth.getState().markHealthy('mock-lite')
  useChat.getState().newConversation()
  await sendUserMessage('skip the cooling model', [])
  const a3 = lastAssistant()
  check(
    'cooling model is skipped',
    a3.modelId === 'mock-lite' && (a3.failedChain?.length ?? 0) === 0,
    JSON.stringify({ modelId: a3.modelId, failedChain: a3.failedChain }),
  )

  // Scenario 4: Pro streams a little, then times out → mid-stream handoff.
  useHealth.getState().markHealthy('mock-pro')
  useHealth.getState().markHealthy('mock-lite')
  useSettings.getState().setModel('mock-pro', { simulate: 'timeout' })
  useChat.getState().newConversation()
  await sendUserMessage('mid stream check', [])
  const a4 = lastAssistant()
  check('mid-stream handoff completes', a4.status === 'complete', `${a4.status}: ${a4.error ?? ''}`)
  check('one handoff recorded', (a4.handoffs?.length ?? 0) === 1, JSON.stringify(a4.handoffs))
  check(
    'handoff from pro → lite',
    a4.handoffs?.[0]?.fromModelId === 'mock-pro' && a4.handoffs?.[0]?.toModelId === 'mock-lite',
  )
  check('content survives handoff', a4.content.length > 100)
  check(
    'pro re-entered cooldown after mid-stream drop',
    (useHealth.getState().byModel['mock-pro']?.cooldownUntil ?? 0) > Date.now(),
  )
}

/**
 * The reported symptom that drove this test: "Every model in the chain failed
 * — tried GPT-4o (quota exhausted)", with nothing else attempted. The other
 * models had been benched by an earlier auth failure — permanently, and
 * silently, so the summary gave no hint they ever existed.
 *
 * Contracts pinned here:
 *  1. An auth failure benches a model with a *timer*, never forever.
 *  2. When the chain dies, the summary names the models that sat out, and why.
 *  3. Real models with no API key are skipped up front (never burn a turn on a
 *     guaranteed auth failure) and the reason is actionable.
 *  4. Once the bench expires, the model quietly rejoins the chain.
 */
async function testChainVisibility() {
  console.log('chain visibility (no silent benches):')

  check('auth failures get a bounded cooldown', cooldownMsFor('auth', 1) > 0, String(cooldownMsFor('auth', 1)))
  check('auth backoff caps out instead of banning forever', cooldownMsFor('auth', 99) <= 30 * 60_000, String(cooldownMsFor('auth', 99)))

  useHealth.getState().markHealthy('mock-pro')
  useHealth.getState().markHealthy('mock-lite')
  useSettings.getState().setModel('mock-pro', { simulate: 'auth' })
  useSettings.getState().setModel('mock-lite', { simulate: 'ok' })
  useChat.getState().newConversation()
  await sendUserMessage('auth bench check', [])
  const a = lastAssistant()
  check('chain survives an auth failure', a.status === 'complete' && a.modelId === 'mock-lite', `${a.status}/${String(a.modelId)}`)
  const proHealth = useHealth.getState().byModel['mock-pro']
  check('auth bench is a cooldown, not a permanent error', proHealth?.state === 'cooldown', proHealth?.state)
  check('auth bench expires on a timer', (proHealth?.cooldownUntil ?? 0) > Date.now(), String(proHealth?.cooldownUntil))

  // Chain dies on one model; the benched one must be named in the summary.
  useSettings.getState().setModel('mock-lite', { simulate: 'hard_quota' })
  useChat.getState().newConversation()
  await sendUserMessage('why did only one model try', [])
  const dead = lastAssistant()
  check('exhausted chain still errors', dead.status === 'error', dead.status)
  check('summary names the model that sat out', (dead.error ?? '').includes('Simulacron Pro'), dead.error)
  check('summary says why it sat out', /cooling down/i.test(dead.error ?? ''), dead.error)

  // A real model with no API key is skipped up front and explained.
  const s = useSettings.getState()
  s.setModel('mock-pro', { simulate: 'hard_quota' })
  s.setModel('gpt-4o', { enabled: true })
  useHealth.getState().markHealthy('mock-lite')
  useChat.getState().newConversation()
  await sendUserMessage('keyless skip check', [])
  const dead2 = lastAssistant()
  check(
    'keyless model is never attempted',
    !(dead2.attempts ?? []).some((t) => t.modelId === 'gpt-4o'),
    JSON.stringify(dead2.attempts?.map((t) => t.modelId)),
  )
  check('summary explains the missing key', (dead2.error ?? '').includes('GPT-4o') && /no api key/i.test(dead2.error ?? ''), dead2.error)
  s.setModel('gpt-4o', { enabled: false })

  // Bench expires (simulated) → the model quietly rejoins the chain.
  useHealth.getState().markHealthy('mock-pro')
  useSettings.getState().setModel('mock-pro', { simulate: 'ok' })
  useChat.getState().newConversation()
  await sendUserMessage('welcome back', [])
  const back = lastAssistant()
  check('recovered model serves again', back.status === 'complete' && back.modelId === 'mock-pro', `${back.status}/${String(back.modelId)}`)

  useSettings.getState().setModel('mock-lite', { simulate: 'ok' })
}

async function testStop() {
  console.log('stop generation:')
  useHealth.getState().markHealthy('mock-pro')
  useHealth.getState().markHealthy('mock-lite')
  useSettings.getState().setModel('mock-pro', { simulate: 'ok' })
  useChat.getState().newConversation()
  const p = sendUserMessage('write me something long', [])
  await new Promise((r) => setTimeout(r, 400))
  const convId = useChat.getState().currentId
  stopGeneration(convId)
  await p
  const msgs = useChat.getState().conversations[convId]!.messages
  const assistant = msgs.find((m) => m.role === 'assistant')
  check('no message left streaming', !msgs.some((m) => m.status === 'streaming' || m.status === 'pending'))
  if (assistant) {
    check(
      'stopped message kept as cancelled/complete',
      ['cancelled', 'complete', 'error'].includes(assistant.status),
      assistant.status,
    )
  }
}

/* ------------------------------------------------------------------ */
/* A stand-in Gemini endpoint                                          */
/* ------------------------------------------------------------------ */

/**
 * The GoogleAdapter used to hardcode its host, which made it impossible to
 * test (and impossible for users to route through a proxy). It now honours
 * `model.baseURL`, so the whole failing path can be exercised offline.
 */
type FakeRoute = (body: Record<string, unknown>) => { status: number; json?: unknown; sse?: string[] }

async function startFakeProvider(routes: Record<string, FakeRoute>) {
  const seen: { url: string; headers: Record<string, unknown> }[] = []
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    seen.push({ url, headers: { ...req.headers } })
    // Longest prefix wins, so "/models" never swallows
    // "/models/gemini-2.5-flash:generateContent".
    const match = Object.entries(routes)
      .sort(([a], [b]) => b.length - a.length)
      .find(([path]) => url.startsWith(path))
    if (!match) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 404, message: `no route for ${url}` } }))
      return
    }
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(raw || '{}')
      } catch {
        /* leave empty */
      }
      const out = match[1](parsed)
      if (out.sse) {
        res.writeHead(out.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        for (const chunk of out.sse) res.write(`data: ${chunk}\n\n`)
        res.end()
        return
      }
      res.writeHead(out.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out.json ?? {}))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { base: `http://127.0.0.1:${port}/v1beta`, seen, close: () => server.close() }
}

function geminiModel(base: string): ModelDef {
  return {
    id: 'gemini-test',
    label: 'Gemini Test',
    provider: 'google',
    apiModel: 'gemini-2.5-flash',
    baseURL: base,
    enabled: true,
  }
}

async function testGoogleAgainstFakeProvider() {
  console.log('google adapter (fake provider):')
  const fake = await startFakeProvider({
    '/v1beta/models/gemini-2.5-flash:streamGenerateContent': () => ({
      status: 200,
      sse: [
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'internal ', thought: true }, { text: 'Hello' }] } }] }),
        JSON.stringify({ candidates: [{ content: { parts: [{ text: ' there.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 } }),
      ],
    }),
    '/v1beta/models/gemini-2.5-flash:generateContent': () => ({ status: 200, json: { candidates: [{ content: { parts: [{ text: 'pong' }] } }] } }),
  })

  try {
    const cfg: Parameters<typeof googleAdapter.run>[0] = {
      model: geminiModel(fake.base),
      turns: [{ role: 'user', text: 'hi' }],
      systemPrompt: '',
      temperature: 0.7,
      maxTokens: 1024,
      topP: 1,
      stream: true,
      apiKey: 'AIzaFakeKeyForTests',
      signal: new AbortController().signal,
      onEvent: () => {},
    }
    const deltas: string[] = []
    const usage: number[] = []
    await googleAdapter.run({ ...cfg, onEvent: (ev) => {
      if (ev.type === 'delta') deltas.push(ev.text)
      if (ev.type === 'usage' && ev.completionTokens) usage.push(ev.completionTokens)
    } })
    check('streams the answer', deltas.join('') === 'Hello there.', deltas.join('|'))
    check('drops Gemini "thought" parts from the answer', !deltas.join('').includes('internal'))
    check('reports token usage', usage[0] === 5, String(usage))

    // The key must travel in a header, never in the query string.
    const streamed = fake.seen.find((r) => r.url.includes('streamGenerateContent'))
    check('key is sent as x-goog-api-key', streamed?.headers['x-goog-api-key'] === 'AIzaFakeKeyForTests', JSON.stringify(streamed?.headers))
    check('key is not in the URL', !streamed?.url.includes('key='), streamed?.url)

    // Non-streaming turns must use :generateContent, not the SSE endpoint.
    const oneShot: string[] = []
    await googleAdapter.run({ ...cfg, stream: false, onEvent: (ev) => { if (ev.type === 'delta') oneShot.push(ev.text) } })
    check('stream:false uses :generateContent', fake.seen.some((r) => r.url.includes(':generateContent')))
    check('stream:false still yields text', oneShot.join('') === 'pong', oneShot.join('|'))

    // A 200 that answers with nothing used to become "empty response".
    const blocked = await startFakeProvider({
      '/v1beta/models/gemini-2.5-flash:streamGenerateContent': () => ({ status: 200, sse: [JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })] }),
    })
    try {
      let caught: ProviderError | null = null
      try {
        await googleAdapter.run({ ...cfg, model: geminiModel(blocked.base), onEvent: () => {} })
      } catch (err) {
        caught = err as ProviderError
      }
      check('a blocked 200 raises instead of "empty response"', caught !== null)
      check('blocked 200 names the reason', /safety/i.test(caught?.message ?? ''), caught?.message)
      check('blocked 200 is not retryable', caught?.retryable === false)
    } finally {
      blocked.close()
    }

    // A 200 that says nothing is not a working key.
    const hollow = await startFakeProvider({
      '/v1beta/models/gemini-2.5-flash:generateContent': () => ({ status: 200, json: { models: [] } }),
    })
    try {
      const probe = await googleAdapter.testKey('AIzaFakeKeyForTests', undefined, geminiModel(hollow.base))
      check('a 200 with no candidates is not a green light', probe.ok === false, probe.message)
    } finally {
      hollow.close()
    }
  } finally {
    fake.close()
  }
}

/**
 * The reported symptom, end to end: a valid key, a green light from the
 * settings test, and then a turn that dies with "unknown error".
 */
async function testFailedTurnExplainsItself() {
  console.log('failed turn diagnostics:')
  const fake = await startFakeProvider({
    // The key is fine — GET /models returns 200 — but generateContent is
    // refused. This is the exact trap the old key test fell into.
    '/v1beta/models': () => ({ status: 200, json: { models: [{ name: 'models/gemini-2.5-flash' }] } }),
    '/v1beta/models/gemini-2.5-flash:generateContent': () => ({
      status: 400,
      json: {
        error: {
          code: 400,
          message: 'GenerateContentRequest.generation_config: max_output_tokens must be greater than the thinking budget.',
          status: 'INVALID_ARGUMENT',
        },
      },
    }),
    '/v1beta/models/gemini-2.5-flash:streamGenerateContent': () => ({
      status: 400,
      json: {
        error: {
          code: 400,
          message: 'GenerateContentRequest.generation_config: max_output_tokens must be greater than the thinking budget.',
          status: 'INVALID_ARGUMENT',
        },
      },
    }),
  })

  const settings = useSettings.getState()
  settings.setProvider('google', { apiKey: 'AIzaFakeKeyForTests' })
  settings.addModel(geminiModel(fake.base))
  settings.setModel('mock-pro', { enabled: false })
  settings.setModel('mock-lite', { enabled: false })

  try {
    // 1. The key test must catch this, not green-light it.
    const probe = await googleAdapter.testKey('AIzaFakeKeyForTests', undefined, geminiModel(fake.base))
    check('key test fails when generateContent fails', probe.ok === false, probe.message)
    check('key test reports the real reason', probe.message.includes('thinking budget'), probe.message)

    // 2. The turn must explain itself instead of saying "unknown error".
    useHealth.getState().markHealthy('gemini-test')
    useChat.getState().newConversation()
    await sendUserMessage('why is this failing', [])
    const msg = lastAssistant()

    check('turn reports an error', msg.status === 'error', msg.status)
    check('error text is the provider sentence', (msg.error ?? '').includes('thinking budget'), msg.error)
    check('error text is no longer a bare "unknown error"', !/^unknown error$/i.test(msg.error ?? ''), msg.error)
    check('error class is not hardcoded unknown', msg.errorClass === 'bad_request', String(msg.errorClass))
    check('per-model attempts are recorded', (msg.attempts?.length ?? 0) === 1, JSON.stringify(msg.attempts))
    check('attempt names the model', msg.attempts?.[0]?.label === 'Gemini Test', msg.attempts?.[0]?.label)
    check('attempt keeps the HTTP status', msg.attempts?.[0]?.status === 400, String(msg.attempts?.[0]?.status))
    check('attempt records elapsed time', (msg.attempts?.[0]?.elapsedMs ?? -1) >= 0)
    check('attempt is not flagged mid-stream', msg.attempts?.[0]?.midStream === false)

    // 3. A payload the provider refuses is not the model's fault, so it must
    //    not sit in cooldown making the whole chain look dead.
    const health = useHealth.getState().byModel['gemini-test']
    check('a non-retryable failure does not trigger a cooldown', !health.cooldownUntil, JSON.stringify(health))

    useSettings.getState().setModel('mock-pro', { enabled: true })
    useSettings.getState().setModel('mock-lite', { enabled: true })
    useSettings.getState().removeModel('gemini-test')
  } finally {
    fake.close()
  }
}

async function main() {
  testClassify()
  testErrorDetail()
  await testMockStream()
  await testGoogleAgainstFakeProvider()
  await testFailedTurnExplainsItself()
  await testFailover()
  await testChainVisibility()
  await testStop()
  console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} SMOKE TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
