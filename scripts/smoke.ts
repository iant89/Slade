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
import { useHealth } from '../src/store/health'
import { sendUserMessage, stopGeneration } from '../src/engine/send'
import { classifyHttp } from '../src/providers/base'
import { mockAdapter } from '../src/providers/mock'

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

async function main() {
  testClassify()
  await testMockStream()
  await testFailover()
  await testStop()
  console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} SMOKE TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
