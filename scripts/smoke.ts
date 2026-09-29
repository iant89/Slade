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
// Object-URL + FileReader shims: the artifact pipeline touches both, and Node
// only needs them to not explode (binary previews are a browser nicety).
if (typeof URL.createObjectURL !== 'function') {
  ;(URL as unknown as Record<string, unknown>).createObjectURL = () => 'blob:smoke-test'
  ;(URL as unknown as Record<string, unknown>).revokeObjectURL = () => {}
}

import { useSettings } from '../src/store/settings'
import { useChat } from '../src/store/chat'
import { cooldownMsFor, useHealth } from '../src/store/health'
import { sendUserMessage, stopGeneration } from '../src/engine/send'
import { classifyHttp } from '../src/providers/base'
import type { ProviderError } from '../src/providers/base'
import { mockAdapter } from '../src/providers/mock'
import {
  createBranch,
  createGist,
  createIssue,
  encodePath,
  extOf as ghExtOf,
  fileSha,
  getBranchSha,
  getRepo,
  getTree,
  getUser,
  GitHubError,
  GITHUB_API_VERSION,
  githubErrorMessage,
  guessLanguage,
  isGitHubError,
  isTextualPath,
  joinPath,
  lastRateInfo,
  listBranches,
  listRepos,
  mimeForPath,
  parseRepoInput,
  readFile,
  searchCode,
  utf8ToBase64,
  writeFile,
} from '../src/lib/github'
import {
  DEFAULT_SCOPE,
  DeviceFlowError,
  looksLikeToken,
  pollOnce,
  requestDeviceCode,
  runDeviceFlow,
} from '../src/lib/github-auth'
import { filterParams, handleRelayRequest } from '../scripts/github-oauth-relay'
import { redactSecrets } from '../src/providers/base'
import {
  artifactIssueBody,
  artifactIssueTitle,
  artifactToFilePayload,
  artifactToGist,
  branchNameFor,
  commitMessageFor,
  fenced,
  fenceFor,
  gistNameFor,
  isBinaryArtifact,
  messageIssueBody,
  PublishError,
  slugify,
  suggestRepoPath,
  titleFromText,
} from '../src/lib/github-payload'
import { executePublish, PublishPreflightError, publishErrorMessage } from '../src/lib/github-publish'
import { artifactFromRemote, useArtifacts } from '../src/store/artifacts'
import { useGitHub } from '../src/store/github'
import { useFs, fsArtifactId } from '../src/store/fs'
import {
  buildFsTree,
  extractFsActions,
  formatFsContextForAgent,
  formatFsManifest,
  formatFsOpSummary,
  fsBaseName,
  fsDirName,
  fsExt,
  isFsError,
  normalizeFsPath,
  tryNormalizeFsPath,
} from '../src/lib/fs'
import { buildTurns } from '../src/engine/turns'
import { parsePlannerReply, resolveWorkerModel } from '../src/engine/agent'
import { CODING_AGENT_ORCHESTRATOR_PROMPT } from '../src/engine/orchestratorPrompt'
import { z } from 'zod'
import { conversationSchema, exportBundleSchema } from '../src/lib/schemas'
import type { Artifact, FsFile } from '../src/types'
// The browser build of react-dom/server avoids the `stream` require that the
// node build does, which esbuild cannot bundled for ESM.
import { renderToString } from 'react-dom/server.browser'
import { createElement } from 'react'
import { GitHubPanel } from '../src/components/github/GitHubPanel'
import { FilesPanel } from '../src/components/fs/FilesPanel'
import { ArtifactCard } from '../src/components/artifacts/ArtifactCard'
import { MessageBubble } from '../src/components/chat/MessageBubble'
import { AddModelForm, ProviderTokenManager } from '../src/components/settings/SettingsModal'
import { ModelPickerTable } from '../src/components/settings/ModelPickerModal'
import { ProviderPickerList } from '../src/components/settings/AddProviderModal'
import { DEFAULT_PROVIDERS } from '../src/providers/registry'
import { SUPPORTED_PROVIDERS, nextProviderLabel, supportedProvider } from '../src/lib/providerCatalog'
import { validateSettings } from '../src/lib/schemas'
import { DEFAULT_SETTINGS } from '../src/store/settings'
import { MODEL_CATALOG, catalogFor, formatCtx, formatPrice } from '../src/lib/modelCatalog'
import { useUI } from '../src/store/ui'
import { googleAdapter } from '../src/providers/google'
import { openrouterAdapter } from '../src/providers/openai'
import { escalateTokens, requestMaxTokens } from '../src/engine/completion'
import type { ModelDef, StreamEvent } from '../src/types'
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
/* The orchestrator (agent mode)                                       */
/* ------------------------------------------------------------------ */

async function waitFor(cond: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return cond()
}

function freshAgentConversation(): string {
  const convId = useChat.getState().newConversation()
  useChat.getState().setConversationAgent(convId, true)
  return convId
}

function testOrchestratorPrompt() {
  console.log('coding-agent orchestrator prompt:')
  check('uses the requested lead-engineer role', CODING_AGENT_ORCHESTRATOR_PROMPT.includes('lead software-engineering orchestrator'))
  check('includes the full development lifecycle', CODING_AGENT_ORCHESTRATOR_PROMPT.includes('UNDERSTAND\n↓\nINSPECT\n↓\nPLAN\n↓\nDECOMPOSE'))
  check('includes the no-false-completion quality gate', CODING_AGENT_ORCHESTRATOR_PROMPT.includes('DO NOT MARK COMPLETE.'))
  check('includes the required final-report sections', ['IMPLEMENTED', 'FILES CHANGED', 'TESTING', 'ARCHITECTURE', 'DOCUMENTATION', 'REMAINING', 'STATUS'].every((section) => CODING_AGENT_ORCHESTRATOR_PROMPT.includes(section)))
  check('includes the final orchestrator responsibility', CODING_AGENT_ORCHESTRATOR_PROMPT.includes('The work is verified and complete.'))
}

function testPlannerParsing() {
  console.log('planner reply parsing:')
  const plan = parsePlannerReply(
    'Sure — here is my plan:\n```json\n{"mode":"plan","reply":"split it","subtasks":[{"title":"a","prompt":"p"}]}\n```',
  )
  check('fenced, prose-wrapped JSON parses', plan?.mode === 'plan')
  check('plan keeps its subtask', plan?.mode === 'plan' && plan.subtasks.length === 1)

  const answer = parsePlannerReply('{"mode":"answer","answer":"Howdy — you are talking to Slade."}')
  check('answer mode parses', answer?.mode === 'answer')

  const braceInString = parsePlannerReply(
    'prefix {"mode":"plan","reply":"has } and { inside","subtasks":[{"title":"t","prompt":"p"}]} suffix',
  )
  check('braces inside strings survive the balanced scan', braceInString?.mode === 'plan')

  check('prose without JSON → undefined', parsePlannerReply('I would start by researching the topic.') === undefined)
  check('wrong shape → undefined', parsePlannerReply('{"mode":"surprise"}') === undefined)
  check('empty subtasks → undefined', parsePlannerReply('{"mode":"plan","subtasks":[]}') === undefined)
}

function testWorkerResolution() {
  console.log('worker model resolution:')
  const settings = useSettings.getState().s
  const byLabel = resolveWorkerModel('simulacron lite', settings, new Set(['mock-pro']))
  check('label hint resolves case-insensitively', byLabel?.id === 'mock-lite', String(byLabel?.id))
  const noHint = resolveWorkerModel(undefined, settings, new Set(['mock-pro']))
  check('no hint → chain order minus the orchestrator', noHint?.id === 'mock-lite', String(noHint?.id))
  const disabled = resolveWorkerModel('GPT-4o', settings, new Set())
  check('unroutable hint falls back to the chain', disabled?.provider === 'mock', String(disabled?.id))
}

async function testAgentMode() {
  console.log('agent mode (orchestrator):')

  // Clean slate: both simulators healthy and honest.
  useHealth.getState().markHealthy('mock-pro')
  useHealth.getState().markHealthy('mock-lite')
  useSettings.getState().setModel('mock-pro', { simulate: 'ok' })
  useSettings.getState().setModel('mock-lite', { simulate: 'ok' })

  /* --- full delegated run ------------------------------------------ */

  freshAgentConversation()
  await sendUserMessage('prepare a Q3 sales report with a CSV dataset', [])
  const run = lastAssistant()
  check('run completed', run.status === 'complete', `${run.status}: ${run.error ?? ''}`)
  check('agent run recorded on the message', Boolean(run.agent))
  check('phase is complete', run.agent?.phase === 'complete', String(run.agent?.phase))
  check('planned multiple steps', (run.agent?.steps.length ?? 0) >= 2, String(run.agent?.steps.length))
  check(
    'every step completed',
    (run.agent?.steps ?? []).every((s) => s.status === 'complete'),
    JSON.stringify(run.agent?.steps.map((s) => s.status)),
  )
  check(
    'steps carry worker output',
    (run.agent?.steps ?? []).every((s) => (s.result ?? '').length > 20),
    JSON.stringify(run.agent?.steps.map((s) => s.result?.length)),
  )
  check(
    'step results are the workers\', not the plan JSON',
    (run.agent?.steps ?? []).every((s) => !(s.result ?? '').includes('"mode":"plan"')),
  )
  check('final answer synthesized on top of the steps', run.content.length > 50)
  check('message chain names the orchestrator first', run.chain?.[0] === 'mock-pro', JSON.stringify(run.chain))
  check('usage aggregated across all calls', (run.usage?.completionTokens ?? 0) > 0)
  check('no error left behind', !run.error, run.error)

  // Render the finished run like the app does: the plan card must render,
  // and the worker CSV inside the expanded step becomes an artifact card.
  const html = renderToString(createElement(MessageBubble, { message: run }))
  check('plan card renders into the message', html.includes('agent-plan'), 'no .agent-plan markup')
  const csvArtifact = Object.values(useArtifacts.getState().byId).find((a) => a.mime === 'text/csv')
  check('worker CSV became an artifact card', Boolean(csvArtifact), 'no text/csv artifact found')

  /* --- worker-level failover --------------------------------------- */

  // Lite fails before streaming → each step falls back to Pro, and the step
  // records who it fell back from (the same contract as the plain chain).
  useSettings.getState().setModel('mock-lite', { simulate: 'hard_quota' })
  useHealth.getState().markHealthy('mock-lite')
  useHealth.getState().markHealthy('mock-pro')
  freshAgentConversation()
  await sendUserMessage('write a haiku about failover and review it', [])
  const fo = lastAssistant()
  check('run with failing worker completed', fo.status === 'complete', `${fo.status}: ${fo.error ?? ''}`)
  check(
    'failed-over steps ran on Simulacron Pro',
    (fo.agent?.steps ?? []).every((s) => s.modelId === 'mock-pro'),
    JSON.stringify(fo.agent?.steps.map((s) => s.modelId)),
  )
  check(
    'step recorded the fallback',
    (fo.agent?.steps ?? []).some((s) => s.failedChain.includes('mock-lite')),
    JSON.stringify(fo.agent?.steps.map((s) => s.failedChain)),
  )
  check(
    'fallback step kept the failure reason',
    (fo.agent?.steps ?? []).some((s) => s.attempts.some((a) => a.modelId === 'mock-lite' && a.message.includes('quota'))),
    JSON.stringify(fo.agent?.steps.flatMap((s) => s.attempts)),
  )

  /* --- direct-answer path (no delegation needed) ------------------- */

  useSettings.getState().setModel('mock-lite', { simulate: 'ok' })
  useHealth.getState().markHealthy('mock-lite')
  useHealth.getState().markHealthy('mock-pro')
  freshAgentConversation()
  await sendUserMessage('hello', [])
  const greet = lastAssistant()
  check('greeting run completed', greet.status === 'complete', `${greet.status}: ${greet.error ?? ''}`)
  check('greeting did not spawn steps', (greet.agent?.steps.length ?? 1) === 0, String(greet.agent?.steps.length))
  check('greeting still answered', greet.content.includes('Slade'), greet.content.slice(0, 80))

  /* --- stopping mid-run -------------------------------------------- */

  const stopConv = freshAgentConversation()
  const stopPromise = sendUserMessage('prepare a long Q3 sales report with a CSV dataset', [])
  const appeared = await waitFor(() => {
    const conv = useChat.getState().conversations[stopConv]
    return Boolean(conv?.messages.some((m) => m.agent && m.agent.steps.length > 0))
  })
  check('plan card appeared before stop', appeared)
  stopGeneration(stopConv)
  await stopPromise
  const stopped = useChat.getState().conversations[stopConv]!.messages.find((m) => m.role === 'assistant')
  check('stopped run is not left streaming', stopped?.status !== 'streaming' && stopped?.status !== 'pending', String(stopped?.status))
  check(
    'stopped run kept its partial plan',
    Boolean(stopped?.agent) && ['cancelled', 'complete', 'error'].includes(stopped!.status),
    `${stopped?.status} / phase ${stopped?.agent?.phase}`,
  )

  /* --- persistence --------------------------------------------------- */

  // The 350ms persist debounce should have flushed by now; the stored JSON
  // must still validate, agent runs and all.
  await new Promise((r) => setTimeout(r, 600))
  const raw = JSON.parse(localStorage.getItem('slade.conversations.v1') ?? '[]') as unknown
  const parsed = z.array(conversationSchema).safeParse(raw)
  check('persisted conversations still validate with agent runs', parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3)))

  // Restore the plain-chain defaults for later tests.
  useSettings.getState().setModel('mock-pro', { simulate: 'ok' })
  useSettings.getState().setModel('mock-lite', { simulate: 'ok' })
}

/* ------------------------------------------------------------------ */
/* A stand-in Gemini endpoint                                          */
/* ------------------------------------------------------------------ */

/**
 * The GoogleAdapter used to hardcode its host, which made it impossible to
 * test (and impossible for users to route through a proxy). It now honours
 * `model.baseURL`, so the whole failing path can be exercised offline.
 */
type FakeRoute = (body: Record<string, unknown>, req: import('node:http').IncomingMessage) => { status: number; json?: unknown; sse?: string[] }

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
      const out = match[1](parsed, req)
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

const OR_STREAM_OK = [
  JSON.stringify({ choices: [{ delta: { content: 'Routed ' } }] }),
  JSON.stringify({ choices: [{ delta: { content: 'through OpenRouter.' }, finish_reason: 'STOP' }] }),
  JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
  '[DONE]',
]

function openrouterModel(base: string): ModelDef {
  return {
    id: 'openrouter-test',
    label: 'OpenRouter Test',
    provider: 'openrouter',
    apiModel: 'openrouter/auto',
    baseURL: base,
    enabled: true,
  }
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

/**
 * First-class OpenRouter support: same wire format as OpenAI, but its own
 * key slot, default endpoint, attribution headers and streaming-usage flag.
 */
async function testOpenRouter() {
  console.log('openrouter adapter (fake provider):')
  const bodies: Record<string, unknown>[] = []
  const fake = await startFakeProvider({
    '/v1beta/chat/completions': (body) => {
      bodies.push(body)
      return { status: 200, sse: OR_STREAM_OK }
    },
    // The key test lists models first, then spends one cheap token.
    '/v1beta/models': () => ({ status: 200, json: { data: [{ id: 'openrouter/auto' }] } }),
  })

  try {
    const cfg: Parameters<typeof openrouterAdapter.run>[0] = {
      model: openrouterModel(fake.base),
      turns: [{ role: 'user', text: 'hi' }],
      systemPrompt: '',
      temperature: 0.7,
      maxTokens: 1024,
      topP: 1,
      stream: true,
      apiKey: 'sk-or-fake-key',
      signal: new AbortController().signal,
      onEvent: () => {},
    }

    const deltas: string[] = []
    const usage: number[] = []
    await openrouterAdapter.run({
      ...cfg,
      onEvent: (ev) => {
        if (ev.type === 'delta') deltas.push(ev.text)
        if (ev.type === 'usage' && ev.completionTokens) usage.push(ev.completionTokens)
      },
    })
    check('streams the answer', deltas.join('') === 'Routed through OpenRouter.', deltas.join('|'))
    check('reports streamed usage', usage[0] === 3, String(usage))

    const seen = fake.seen.find((r) => r.url.includes('chat/completions'))
    check('key rides the bearer header', seen?.headers['authorization'] === 'Bearer sk-or-fake-key', JSON.stringify(seen?.headers))
    check('sends the X-Title attribution header', seen?.headers['x-title'] === 'Slade', JSON.stringify(seen?.headers))
    check('sends the HTTP-Referer attribution header', typeof seen?.headers['http-referer'] === 'string', JSON.stringify(seen?.headers))
    check('asks for usage in streamed turns', JSON.stringify(bodies[0]?.usage) === JSON.stringify({ include: true }), JSON.stringify(bodies[0]))

    // Default endpoint is OpenRouter's own, not api.openai.com. The resolver
    // is protected, so peek at it through the prototype chain.
    const resolveBase = (openrouterAdapter as unknown as { resolveBase: (b?: string, m?: ModelDef) => string }).resolveBase.bind(openrouterAdapter)
    check('defaults to openrouter.ai when no baseURL is set', resolveBase() === 'https://openrouter.ai/api/v1', resolveBase())
    check('model baseURL still wins', resolveBase(undefined, openrouterModel(fake.base)) === fake.base.replace(/\/+$/, ''))

    // Key test spends one cheap token, like the OpenAI flavour does.
    const probe = await openrouterAdapter.testKey('sk-or-fake-key', fake.base, openrouterModel(fake.base))
    check('key test passes against a live endpoint', probe.ok === true, probe.message)
  } finally {
    fake.close()
  }
}

/**
 * OpenRouter quota walls (HTTP 402) must classify as hard_quota, bench the
 * model on a timed cooldown, and hand the turn to the next model — the same
 * engine behaviour every other provider gets.
 */
async function testOpenRouterFailover() {
  console.log('openrouter failover:')
  const fake = await startFakeProvider({
    '/v1beta/chat/completions': () => ({
      status: 402,
      json: { error: { code: 402, message: 'Your account balance is insufficient.', status: 'PAYMENT_REQUIRED' } },
    }),
  })

  const settings = useSettings.getState()
  settings.setProvider('openrouter', { apiKey: 'sk-or-fake-key' })
  settings.addModel(openrouterModel(fake.base))
  settings.setModel('mock-pro', { enabled: true, simulate: 'ok' })
  settings.setModel('mock-lite', { enabled: true, simulate: 'ok' })
  // Pin it primary: the model under test is appended last in priority order,
  // and the mocks would otherwise serve the turn before it ever runs.
  settings.pin('openrouter-test')

  try {
    useHealth.getState().markHealthy('openrouter-test')
    useChat.getState().newConversation()
    await sendUserMessage('quota wall check', [])
    const a = lastAssistant()
    check('turn completes via failover', a.status === 'complete', `${a.status}: ${a.error ?? ''}`)
    check(
      'failed chain records the OpenRouter attempt',
      JSON.stringify(a.failedChain) === JSON.stringify(['openrouter-test']),
      JSON.stringify(a.failedChain),
    )
    // The turn succeeded via failover, but the failed primary's diagnostics
    // must survive on the message so the "fell back from" chip can explain why.
    check('402 classifies as hard quota', a.attempts?.[0]?.failure === 'hard_quota', JSON.stringify(a.attempts))
    check(
      'quota reason survives to the transcript',
      (a.attempts?.[0]?.message ?? '').includes('insufficient'),
      JSON.stringify(a.attempts?.map((t) => t.message)),
    )
    check('serving model recorded', a.modelId === 'mock-pro', String(a.modelId))
    const h = useHealth.getState().byModel['openrouter-test']
    check('quota wall benches on a timed cooldown', h?.state === 'cooldown' && (h?.cooldownUntil ?? 0) > Date.now(), h?.state)
  } finally {
    settings.removeModel('openrouter-test')
    fake.close()
  }
}

async function testMultiTokenRotationAndCooldowns() {
  console.log('multi-token rotation & per-token cooldowns:')
  const keysReceived: string[] = []
  const fake = await startFakeProvider({
    '/v1beta/chat/completions': (_body, req) => {
      const auth = (req.headers.authorization as string | undefined) ?? ''
      const key = auth.replace(/^Bearer\s+/i, '').trim()
      keysReceived.push(key)

      // Token 1 returns 429 Rate Limit
      if (key === 'sk-token-1') {
        return {
          status: 429,
          json: { error: { message: 'Rate limit exceeded for token 1', type: 'rate_limit' } },
        }
      }
      // Token 2 succeeds
      if (key === 'sk-token-2') {
        return {
          status: 200,
          sse: orTextStream('Response from token 2!'),
        }
      }
      // Token 3 backup
      return {
        status: 200,
        sse: orTextStream('Response from token 3!'),
      }
    },
  })

  const settings = useSettings.getState()
  settings.setProvider('openrouter', {
    apiKey: 'sk-token-1',
    apiKeys: [
      { id: 'tok-1', key: 'sk-token-1', label: 'Primary Key', enabled: true },
      { id: 'tok-2', key: 'sk-token-2', label: 'Secondary Key', enabled: true },
      { id: 'tok-3', key: 'sk-token-3', label: 'Backup Key', enabled: true },
    ],
  })
  settings.addModel(openrouterModel(fake.base))
  settings.setModel('mock-pro', { enabled: true, simulate: 'ok' })
  settings.setModel('mock-lite', { enabled: true, simulate: 'ok' })
  settings.pin('openrouter-test')

  try {
    useHealth.getState().markHealthy('openrouter-test')
    useHealth.getState().markTokenHealthy('tok-1')
    useHealth.getState().markTokenHealthy('tok-2')
    useHealth.getState().markTokenHealthy('tok-3')

    // Turn 1: Tok 1 fails with 429, engine immediately rotates to Tok 2 on same model
    useChat.getState().newConversation()
    await sendUserMessage('test multi token failover', [])
    const a1 = lastAssistant()
    check('turn 1 completes with openrouter-test model', a1.status === 'complete' && a1.modelId === 'openrouter-test', `${a1.status} / ${a1.modelId}`)
    check('turn 1 tried token 1 then token 2', keysReceived.length === 2 && keysReceived[0] === 'sk-token-1' && keysReceived[1] === 'sk-token-2', JSON.stringify(keysReceived))
    check('turn 1 received expected content', a1.content.includes('Response from token 2!'), a1.content)

    const tok1Health = useHealth.getState().byToken['tok-1']
    const tok2Health = useHealth.getState().byToken['tok-2']
    check('token 1 is on cooldown', tok1Health?.state === 'cooldown' && (tok1Health?.cooldownUntil ?? 0) > Date.now(), JSON.stringify(tok1Health))
    check('token 2 is healthy', tok2Health?.state === 'available', JSON.stringify(tok2Health))

    // Turn 2: Token 1 is on cooldown, so engine skips it and goes straight to Token 2
    useChat.getState().newConversation()
    keysReceived.length = 0
    await sendUserMessage('second message', [])
    const a2 = lastAssistant()
    check('turn 2 completes with openrouter-test model', a2.status === 'complete' && a2.modelId === 'openrouter-test', `${a2.status} / ${a2.modelId}`)
    check('turn 2 went straight to token 2 without attempting token 1', keysReceived.length === 1 && keysReceived[0] === 'sk-token-2', JSON.stringify(keysReceived))

    // Turn 3: When all tokens for openrouter fail/cooldown, model-level failover kicks in
    useHealth.getState().recordTokenFailure('tok-2', 'hard_quota', 'Token 2 quota exhausted')
    useHealth.getState().recordTokenFailure('tok-3', 'hard_quota', 'Token 3 quota exhausted')

    useChat.getState().newConversation()
    keysReceived.length = 0
    await sendUserMessage('all tokens down test', [])
    const a3 = lastAssistant()
    check('turn 3 fell back to next model in chain when all tokens cooling', a3.status === 'complete' && a3.modelId === 'mock-pro', `${a3.status} / ${a3.modelId}`)
    check('turn 3 recorded openrouter-test in failedChain', (a3.failedChain ?? []).includes('openrouter-test'), JSON.stringify(a3.failedChain))
  } finally {
    settings.removeModel('openrouter-test')
    settings.setProvider('openrouter', { apiKey: '', apiKeys: undefined })
    settings.pin(undefined)
    settings.setModel('mock-pro', { enabled: true, simulate: 'ok' })
    settings.setModel('mock-lite', { enabled: true, simulate: 'ok' })
    fake.close()
  }
}

/* ------------------------------------------------------------------ */
/* Reasoning models: the "returned no text at all" family              */
/* ------------------------------------------------------------------ */

/**
 * The stream shapes OpenRouter documents for reasoning models: thinking
 * arrives on `delta.reasoning` / `reasoning_content` / `reasoning_details`,
 * and a budget consumed entirely by thinking ends with `finish_reason:
 * "length"` and *zero* content. `openrouter/auto` routes to reasoning models
 * routinely, which is how an orchestrator step used to come back with nothing
 * but "the provider accepted the request but returned no text at all".
 */
function orReasoningOnlyStream(billedTokens: number): string[] {
  return [
    JSON.stringify({
      model: 'deepseek/deepseek-r1',
      choices: [{ index: 0, delta: { role: 'assistant', reasoning: 'A single-file React/TS vault needs a store first. ' } }],
    }),
    JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'Filtering, tags, import/export…' } }] }),
    JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            reasoning_details: [
              { type: 'text', text: 'Sketch the component tree before writing code.' },
              { type: 'encrypted', data: 'ZZ9vcmFuZ2U=' },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 900,
        completion_tokens: billedTokens,
        completion_tokens_details: { reasoning_tokens: billedTokens },
      },
    }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length', native_finish_reason: 'length' }] }),
    '[DONE]',
  ]
}

function orTextStream(text: string, finishReason = 'stop'): string[] {
  return [
    JSON.stringify({ model: 'deepseek/deepseek-r1', choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 12, completion_tokens: 40 } }),
    '[DONE]',
  ]
}

/** The answer written into the reasoning channel, content left null. */
function orAnswerInReasoningStream(answer: string): string[] {
  return [
    JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', reasoning: answer } }] }),
    JSON.stringify({
      choices: [{ index: 0, delta: { content: null }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 40, completion_tokens: 26, completion_tokens_details: { reasoning_tokens: 25 } },
    }),
    '[DONE]',
  ]
}

/** OpenRouter mid-stream error frame: HTTP status in `error.code`. */
function orMidStreamError(code: number, message: string, errorType: string): string[] {
  return [
    JSON.stringify({ choices: [{ index: 0, delta: { content: 'Partial ' } }] }),
    JSON.stringify({
      id: 'gen-1',
      object: 'chat.completion.chunk',
      model: 'deepseek/deepseek-r1',
      provider: 'DeepSeek',
      error: { code, message, metadata: { error_type: errorType, provider_code: 'rate_limited' } },
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
    }),
    '[DONE]',
  ]
}

/** The stream the reasoning fake provider serves next (set by `runOpenRouter`). */
let orServing: string[] = []

async function runOpenRouter(model: ModelDef, sse: string[], opts?: { stream?: boolean; maxTokens?: number }) {
  orServing = sse
  const events: StreamEvent[] = []
  let error: { failure?: string; message?: string } | undefined
  try {
    await openrouterAdapter.run({
      model,
      turns: [{ role: 'user', text: 'Build the single-file React/TS prompt vault app' }],
      systemPrompt: 'You are a specialist worker model in Slade.',
      temperature: 0.7,
      maxTokens: opts?.maxTokens ?? 4096,
      topP: 1,
      stream: opts?.stream ?? true,
      apiKey: 'sk-or-fake-key',
      signal: new AbortController().signal,
      onEvent: (ev) => events.push(ev),
    })
  } catch (err) {
    error = err as { failure?: string; message?: string }
  }
  const text = (type: string) => events.filter((e) => e.type === type).map((e) => (e as { text: string }).text).join('')
  return { events, error, content: text('delta'), reasoning: text('reasoning') }
}

async function testReasoningStreams() {
  console.log('reasoning-model streams (fake OpenRouter):')
  const bodies: Record<string, unknown>[] = []
  const fake = await startFakeProvider({
    '/v1beta/chat/completions': (body) => {
      bodies.push(body)
      return { status: 200, sse: orServing }
    },
  })
  const model = openrouterModel(fake.base)

  try {
    /* --- the reported failure: thinking ate the whole budget ------------- */
    const r = await runOpenRouter(model, orReasoningOnlyStream(4096))
    check('reasoning-only stream is not a silent success', Boolean(r.error), JSON.stringify(r.events))
    check('it classifies as token_budget, not unknown', r.error?.failure === 'token_budget', String(r.error?.failure))
    check('the message names the budget that was consumed', /4,096-token output budget/.test(r.error?.message ?? ''), r.error?.message)
    check('the message says the tokens went to reasoning', /reasoning tokens billed/.test(r.error?.message ?? ''), r.error?.message)
    check('the message names the model the router picked', (r.error?.message ?? '').includes('deepseek/deepseek-r1'), r.error?.message)
    check('the message says what to do instead of retrying', /raise the output cap/i.test(r.error?.message ?? ''), r.error?.message)
    check('the old generic message is gone', !(r.error?.message ?? '').includes('returned no text at all'), r.error?.message)

    /* --- reasoning is liveness, not answer text -------------------------- */
    const ok = await runOpenRouter(model, [
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning: 'Thinking about the vault schema…' } }] }),
      ...orTextStream('Here is the prompt vault app.'),
    ])
    check('reasoning arrives on its own channel', ok.reasoning.includes('Thinking about the vault schema'), ok.reasoning)
    check('reasoning never leaks into the answer', !ok.content.includes('Thinking about'), ok.content)
    check('the answer still streams', ok.content === 'Here is the prompt vault app.', ok.content)
    check('a completed stream is not marked truncated', ok.events.some((e) => e.type === 'done' && !e.truncated))

    /* --- truncation is reported, not swallowed --------------------------- */
    const cut = await runOpenRouter(model, orTextStream('export default function PromptVault() {', 'length'))
    check('partial answer survives a token-cap stop', cut.content.length > 10, cut.content)
    check('the stop is flagged as truncation', cut.events.some((e) => e.type === 'done' && e.truncated === true), JSON.stringify(cut.events.at(-1)))

    /* --- answer mislabelled as reasoning is recovered -------------------- */
    const recovered = await runOpenRouter(model, orAnswerInReasoningStream('{"mode":"answer","answer":"hi"}'))
    check('an answer written into the reasoning channel is recovered', recovered.content === '{"mode":"answer","answer":"hi"}', recovered.content)
    check('recovery is not an error', !recovered.error, recovered.error?.message)

    /* --- mid-stream error frames keep their HTTP classification ---------- */
    const rateLimited = await runOpenRouter(model, orMidStreamError(429, 'Rate limit exceeded', 'rate_limit_exceeded'))
    check('mid-stream 429 classifies as a rate limit', rateLimited.error?.failure === 'soft_rate_limit', String(rateLimited.error?.failure))
    const quota = await runOpenRouter(model, orMidStreamError(402, 'Your account balance is insufficient.', 'insufficient_balance'))
    check('mid-stream 402 classifies as hard quota', quota.error?.failure === 'hard_quota', String(quota.error?.failure))
    check('every request carried the cap the diagnosis quotes', bodies.every((b) => typeof b.max_tokens === 'number'), JSON.stringify(bodies.map((b) => b.max_tokens)))
  } finally {
    fake.close()
  }

  /* --- non-streaming, against its own fake ------------------------------- */
  const nonStreamFake = await startFakeProvider({
    '/v1beta/chat/completions': () => ({
      status: 200,
      json: {
        model: 'openai/o3',
        choices: [{ message: { role: 'assistant', content: null, reasoning: 'Let me consider the vault schema…' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 800, completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 4096 } },
      },
    }),
  })
  try {
    const r = await runOpenRouter(openrouterModel(nonStreamFake.base), [], { stream: false, maxTokens: 4096 })
    check('non-streaming reasoning-only is diagnosed too', r.error?.failure === 'token_budget', String(r.error?.failure))
    check('non-streaming message names the reasoning tokens', /4,096 reasoning tokens/.test(r.error?.message ?? ''), r.error?.message)
  } finally {
    nonStreamFake.close()
  }
}

/**
 * The engine's response to a budget failure: the *same* model is asked again
 * with a bigger cap before the chain walks on, because the next candidate
 * would hit the identical wall at the identical budget.
 */
async function testReasoningBudgetRetry() {
  console.log('token-budget retry (plain chain):')
  check('escalation quadruples a small cap', escalateTokens(4096) === 16_384, String(escalateTokens(4096)))
  check('escalation never lands below 16k', escalateTokens(512) === 16_384, String(escalateTokens(512)))
  check('escalation is capped at 64k', escalateTokens(32_000) === 64_000, String(escalateTokens(32_000)))
  check('escalation respects the context window', escalateTokens(4096, 24_000) === 12_000, String(escalateTokens(4096, 24_000)))
  check('escalation gives up when there is no headroom', escalateTokens(64_000) === 64_000, String(escalateTokens(64_000)))

  const settings = useSettings.getState()
  const stepFloor = settings.s.agent.stepMaxTokens
  check('agent steps get a roomier cap than chat', stepFloor > settings.s.defaults.maxTokens, `${stepFloor} vs ${settings.s.defaults.maxTokens}`)
  check(
    'a request floor lifts the cap',
    requestMaxTokens(settings.s, { ...openrouterModel('http://x/v1beta'), overrides: { maxTokens: 1024 } }, stepFloor) === stepFloor,
  )
  check(
    'a roomier per-model override still wins',
    requestMaxTokens(settings.s, { ...openrouterModel('http://x/v1beta'), overrides: { maxTokens: 32_000 } }, stepFloor) === 32_000,
  )

  /* --- one wasted attempt, then the same model answers ------------------- */
  const bodies: Record<string, unknown>[] = []
  let calls = 0
  const fake = await startFakeProvider({
    '/v1beta/chat/completions': (body) => {
      bodies.push(body)
      calls++
      if (calls === 1) return { status: 200, sse: orReasoningOnlyStream(Number(body.max_tokens ?? 4096)) }
      return { status: 200, sse: orTextStream('```tsx:PromptVault.tsx\nexport default function PromptVault() {}\n```') }
    },
  })

  settings.setProvider('openrouter', { apiKey: 'sk-or-fake-key' })
  settings.addModel(openrouterModel(fake.base))
  settings.setModel('mock-pro', { enabled: false })
  settings.setModel('mock-lite', { enabled: false })
  settings.setDefaults({ maxTokens: 4096 })
  settings.pin('openrouter-test')

  try {
    useHealth.getState().markHealthy('openrouter-test')
    useChat.getState().newConversation()
    await sendUserMessage('Build a prompt vault SFA using React/TypeScript', [])
    const a = lastAssistant()
    check('the turn completed after the budget retry', a.status === 'complete', `${a.status}: ${a.error ?? ''}`)
    check('the same model was retried instead of failing over', calls === 2, `${calls} calls`)
    check('the retry raised max_tokens', Number(bodies[1]?.max_tokens) > Number(bodies[0]?.max_tokens), `${bodies[0]?.max_tokens} → ${bodies[1]?.max_tokens}`)
    check('the retry landed on the 16k floor', Number(bodies[1]?.max_tokens) === 16_384, String(bodies[1]?.max_tokens))
    check('no failover was recorded', (a.failedChain ?? []).length === 0, JSON.stringify(a.failedChain))
    check('reasoning tokens are reported in usage', (a.usage?.reasoningTokens ?? 0) > 0 || (a.usage?.completionTokens ?? 0) > 0, JSON.stringify(a.usage))
    const h = useHealth.getState().byModel['openrouter-test']
    check('a budget failure does not bench a healthy model', h?.state !== 'cooldown', String(h?.state))
  } finally {
    settings.removeModel('openrouter-test')
    settings.pin(undefined)
    settings.setModel('mock-pro', { enabled: true })
    settings.setModel('mock-lite', { enabled: true })
    fake.close()
  }

  /* --- every attempt runs out: fail loudly, with the real reason --------- */
  const deadBodies: number[] = []
  const deadFake2 = await startFakeProvider({
    '/v1beta/chat/completions': (body) => {
      deadBodies.push(Number(body.max_tokens ?? 0))
      return { status: 200, sse: orReasoningOnlyStream(Number(body.max_tokens ?? 4096)) }
    },
  })
  settings.setProvider('openrouter', { apiKey: 'sk-or-fake-key' })
  settings.addModel(openrouterModel(deadFake2.base))
  settings.setModel('mock-pro', { enabled: false })
  settings.setModel('mock-lite', { enabled: false })
  settings.pin('openrouter-test')
  try {
    useHealth.getState().markHealthy('openrouter-test')
    useChat.getState().newConversation()
    await sendUserMessage('Build a prompt vault SFA using React/TypeScript', [])
    const a = lastAssistant()
    check('an unanswerable budget fails the turn', a.status === 'error', a.status)
    check('the error is classified token_budget', a.errorClass === 'token_budget', String(a.errorClass))
    check('the error explains the reasoning burn', /budget thinking/.test(a.error ?? ''), a.error)
    check('the engine retried exactly once', deadBodies.length === 2, JSON.stringify(deadBodies))
    check('the retry used a bigger cap', deadBodies[1]! > deadBodies[0]!, JSON.stringify(deadBodies))
    const h = useHealth.getState().byModel['openrouter-test']
    check('still no cooldown — the model is not sick', h?.state !== 'cooldown', String(h?.state))
  } finally {
    settings.removeModel('openrouter-test')
    settings.pin(undefined)
    settings.setModel('mock-pro', { enabled: true })
    settings.setModel('mock-lite', { enabled: true })
    deadFake2.close()
  }

  /* --- a truncated answer says so --------------------------------------- */
  const cutFake = await startFakeProvider({
    '/v1beta/chat/completions': () => ({ status: 200, sse: orTextStream('export default function PromptVault() {', 'length') }),
  })
  settings.setProvider('openrouter', { apiKey: 'sk-or-fake-key' })
  settings.addModel(openrouterModel(cutFake.base))
  settings.setModel('mock-pro', { enabled: false })
  settings.setModel('mock-lite', { enabled: false })
  settings.pin('openrouter-test')
  try {
    useHealth.getState().markHealthy('openrouter-test')
    useChat.getState().newConversation()
    await sendUserMessage('Build a prompt vault SFA using React/TypeScript', [])
    const a = lastAssistant()
    check('a truncated answer still completes', a.status === 'complete', `${a.status}: ${a.error ?? ''}`)
    check('the message is flagged as cut off', a.truncated === true, String(a.truncated))
    const html = renderToString(createElement(MessageBubble, { message: a }))
    check('the bubble tells the user it was cut off', html.includes('Cut off at the output token cap'), html.slice(-400))
  } finally {
    settings.removeModel('openrouter-test')
    settings.pin(undefined)
    settings.setModel('mock-pro', { enabled: true })
    settings.setModel('mock-lite', { enabled: true })
    cutFake.close()
  }
}

/**
 * The reported bug, end to end: agent mode, `openrouter/auto` as the whole
 * roster, and a worker step whose first attempt spends its budget thinking.
 */
async function testAgentReasoningBudget() {
  console.log('orchestrator step that ran out of budget (regression):')
  const bodies: Record<string, unknown>[] = []
  let calls = 0
  const fake = await startFakeProvider({
    '/v1beta/chat/completions': (body) => {
      bodies.push(body)
      calls++
      if (calls === 1) {
        // Planning.
        return {
          status: 200,
          sse: orTextStream(
            JSON.stringify({
              mode: 'plan',
              reply: 'One build step, then a review.',
              subtasks: [
                {
                  title: 'Build the single-file React/TS prompt vault app',
                  model: '',
                  prompt: 'Build a single-file React/TypeScript prompt vault app with tagging, search and JSON import/export.',
                },
              ],
            }),
          ),
        }
      }
      if (calls === 2) {
        // The worker's first attempt: all budget, no answer.
        return { status: 200, sse: orReasoningOnlyStream(Number(body.max_tokens ?? 0)) }
      }
      if (calls === 3) {
        // The worker's escalated retry.
        return {
          status: 200,
          sse: orTextStream('```tsx:PromptVault.tsx\nexport default function PromptVault() {\n  return <main>vault</main>\n}\n```'),
        }
      }
      return { status: 200, sse: orTextStream('Done — the prompt vault app is below.\n\n```tsx:PromptVault.tsx\nexport default function PromptVault() {}\n```') }
    },
  })

  const settings = useSettings.getState()
  const stepFloor = settings.s.agent.stepMaxTokens
  settings.setProvider('openrouter', { apiKey: 'sk-or-fake-key' })
  settings.addModel(openrouterModel(fake.base))
  settings.setModel('mock-pro', { enabled: false })
  settings.setModel('mock-lite', { enabled: false })
  settings.pin('openrouter-test')

  try {
    useHealth.getState().markHealthy('openrouter-test')
    freshAgentConversation()
    await sendUserMessage('Build a prompt vault SFA using React/TypeScript', [])
    const run = lastAssistant()
    const step = run.agent?.steps[0]

    check('the run completed', run.status === 'complete', `${run.status}: ${run.error ?? ''}`)
    check('the step did not fail', step?.status === 'complete', `${step?.status}: ${step?.error ?? ''}`)
    check('the step error the user saw is gone', !(step?.error ?? '').includes('returned no text at all'), step?.error)
    check('the step kept the worker deliverable', (step?.result ?? '').includes('PromptVault.tsx'), step?.result?.slice(0, 80))
    check(
      'the wasted attempt is explained on the step',
      (step?.attempts ?? []).some((a) => a.failure === 'token_budget' && /Retrying with/.test(a.message)),
      JSON.stringify(step?.attempts),
    )
    check('orchestrator calls use the step budget', Number(bodies[0]?.max_tokens) === stepFloor, String(bodies[0]?.max_tokens))
    check('the worker step used the step budget', Number(bodies[1]?.max_tokens) === stepFloor, String(bodies[1]?.max_tokens))
    check('the in-step retry raised the cap', Number(bodies[2]?.max_tokens) > stepFloor, `${bodies[2]?.max_tokens} vs ${stepFloor}`)
    check('the final answer was synthesized', run.content.includes('prompt vault'), run.content.slice(0, 80))

    const html = renderToString(createElement(MessageBubble, { message: run }))
    check('the plan card still renders', html.includes('agent-plan'), 'no plan card markup')
  } finally {
    settings.removeModel('openrouter-test')
    settings.pin(undefined)
    settings.setModel('mock-pro', { enabled: true, simulate: 'ok' })
    settings.setModel('mock-lite', { enabled: true, simulate: 'ok' })
    useHealth.getState().markHealthy('mock-pro')
    useHealth.getState().markHealthy('mock-lite')
    fake.close()
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


/* ================================================================== */
/* GitHub integration                                                  */
/* ================================================================== */

type FakeGhResult = {
  status: number
  json?: unknown
  text?: string
  headers?: Record<string, string>
}
type FakeGhRoute = (
  body: Record<string, unknown>,
  meta: { method: string; url: string; headers: Record<string, unknown> },
) => FakeGhResult

/** A local stand-in for api.github.com (same idea as startFakeProvider). */
async function startFakeGitHub(routes: Record<string, FakeGhRoute>) {
  const seen: { method: string; url: string; headers: Record<string, unknown>; body: Record<string, unknown> }[] = []
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(raw || '{}')
      } catch {
        /* keep {} */
      }
      const meta = { method: req.method ?? 'GET', url, headers: { ...req.headers } as Record<string, unknown> }
      seen.push({ ...meta, body: parsed })
      const match = Object.entries(routes)
        .sort(([a], [b]) => b.length - a.length)
        .find(([path]) => url.startsWith(path))
      if (!match) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'Not Found' }))
        return
      }
      const out = match[1](parsed, meta)
      res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) })
      res.end(out.text ?? JSON.stringify(out.json ?? {}))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { base: `http://127.0.0.1:${port}`, seen, close: () => server.close() }
}

function testRepoIdentifiers() {
  console.log('github repo identifiers:')
  check('owner/repo parses', parseRepoInput('octo/demo')?.fullName === 'octo/demo')
  check('https URL parses', parseRepoInput('https://github.com/octo/demo')?.fullName === 'octo/demo')
  check('.git and trailing slash are stripped', parseRepoInput('https://github.com/octo/demo.git/')?.fullName === 'octo/demo')
  check('ssh remote parses', parseRepoInput('git@github.com:octo/demo.git')?.fullName === 'octo/demo')
  check('bare name uses the signed-in owner', parseRepoInput('demo', 'octo')?.fullName === 'octo/demo')
  check('bare name without an owner is rejected', parseRepoInput('demo') === null)
  check('garbage is rejected', parseRepoInput('not a repo!!') === null)
  check('nested paths keep owner + repo only', parseRepoInput('https://github.com/octo/demo/tree/main/src')?.fullName === 'octo/demo')
  check('path segments are encoded per segment', encodePath('src/lib/my file.ts') === 'src/lib/my%20file.ts')
  check('joinPath collapses slashes', joinPath('/artifacts/', '/x.csv') === 'artifacts/x.csv')
  check('mime comes from the extension', mimeForPath('src/a.ts') === 'text/typescript')
  check('images are not treated as text', isTextualPath('logo.png') === false)
  check('markdown is text', isTextualPath('README.md') === true)
  check('language hint is derived', guessLanguage('src/main.rs') === 'rust')
}

/** Every REST call Slade makes, against a fake api.github.com. */
async function testGitHubClient() {
  console.log('github REST client:')
  const tree = {
    truncated: false,
    tree: [
      { path: 'src', mode: '040000', type: 'tree', sha: 't1' },
      { path: 'src/lib/util.ts', mode: '100644', type: 'blob', sha: 'b1', size: 42 },
      { path: 'vendor/lib', mode: '160000', type: 'commit', sha: 'c1' },
      { path: 'logo.png', mode: '100644', type: 'blob', sha: 'b2', size: 9 },
    ],
  }
  const utilText = 'export const answer = 42\n'
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')

  const fake = await startFakeGitHub({
    '/user': () => ({
      status: 200,
      json: { id: 7, login: 'octo', name: 'Octo', avatar_url: 'https://avatars.example/octo.png', html_url: 'https://github.com/octo' },
      headers: { 'x-oauth-scopes': 'repo, gist, read:user', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4993', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) },
    }),
    '/user/repos': () => ({
      status: 200,
      json: [
        { id: 1, name: 'demo', full_name: 'octo/demo', owner: { login: 'octo', avatar_url: '' }, private: true, fork: false, archived: false, description: 'demo repo', default_branch: 'main', html_url: 'https://github.com/octo/demo', pushed_at: new Date().toISOString(), updated_at: new Date().toISOString(), language: 'TypeScript', stargazers_count: 3, permissions: { admin: true, push: true, pull: true } },
      ],
    }),
    '/repos/octo/demo/git/trees/main': () => ({ status: 200, json: tree }),
    '/repos/octo/demo/contents/src/lib/util.ts': () => ({
      status: 200,
      json: { type: 'file', name: 'util.ts', path: 'src/lib/util.ts', sha: 'b1', size: utilText.length, encoding: 'base64', content: Buffer.from(utilText).toString('base64') },
    }),
    // The contents API gives up on files over ~1MB: encoding "none", empty content.
    '/repos/octo/demo/contents/big.txt': () => ({
      status: 200,
      json: { type: 'file', name: 'big.txt', path: 'big.txt', sha: 'big1', size: 1_500_000, encoding: 'none', content: '' },
    }),
    '/repos/octo/demo/contents/huge.bin': () => ({
      status: 200,
      json: { type: 'file', name: 'huge.bin', path: 'huge.bin', sha: 'huge1', size: 9_000_000, encoding: 'none', content: '' },
    }),
    '/repos/octo/demo/git/blobs/big1': () => ({ status: 200, json: { sha: 'big1', size: 1_500_000, encoding: 'base64', content: Buffer.from('x'.repeat(64)).toString('base64') } }),
    '/repos/octo/demo/contents/logo.png': () => ({
      status: 200,
      json: { type: 'file', name: 'logo.png', path: 'logo.png', sha: 'b2', size: 8, encoding: 'base64', content: png },
    }),
    '/repos/octo/demo/contents/README.md': () => ({ status: 404, json: { message: 'Not Found' } }),
    '/repos/octo/demo/contents/new.md': (body) => ({ status: 201, json: { content: { path: body.path, sha: 'n1', html_url: 'https://github.com/octo/demo/blob/main/new.md' }, commit: { sha: 'c0ffee', html_url: 'https://github.com/octo/demo/commit/c0ffee' } } }),
    '/repos/octo/demo/git/ref/heads/main': () => ({ status: 200, json: { object: { sha: 'base-sha' } } }),
    '/repos/octo/demo/git/refs': () => ({ status: 201, json: { ref: 'refs/heads/slade/x' } }),
    '/repos/octo/demo/branches': () => ({ status: 200, json: [{ name: 'main', commit: { sha: 'base-sha' } }, { name: 'dev', commit: { sha: 'dev-sha' } }] }),
    '/repos/octo/demo/issues': () => ({ status: 201, json: { number: 12, html_url: 'https://github.com/octo/demo/issues/12' } }),
    '/gists': () => ({ status: 201, json: { id: 'abcdef1234567890', html_url: 'https://gist.github.com/abcdef1234567890', public: false } }),
    '/search/code': () => ({ status: 200, json: { items: [{ path: 'src/lib/util.ts', name: 'util.ts', sha: 'b1', html_url: 'https://github.com/octo/demo/blob/main/src/lib/util.ts', text_matches: [{ fragment: 'const answer = 42' }] }] } }),
    '/repos/octo/demo': () => ({
      status: 200,
      json: { id: 1, name: 'demo', full_name: 'octo/demo', owner: { login: 'octo', avatar_url: '' }, private: true, fork: false, archived: false, description: 'demo repo', default_branch: 'main', html_url: 'https://github.com/octo/demo', pushed_at: null, updated_at: null, language: 'TypeScript', stargazers_count: 0 },
    }),
  })

  try {
    const token = 'ghp_' + 'a'.repeat(24)
    const api = { token, baseUrl: fake.base }

    const user = await getUser(api)
    check('GET /user returns the account', user.login === 'octo', user.login)
    check('scopes are read from the response headers', (lastRateInfo().scopes ?? []).join(',') === 'repo,gist,read:user', JSON.stringify(lastRateInfo().scopes))
    check('rate budget is tracked', lastRateInfo().rate?.remaining === 4993, JSON.stringify(lastRateInfo().rate))
    const userCall = fake.seen.find((r) => r.url === '/user')
    check('the token rides the Authorization header', userCall?.headers['authorization'] === `Bearer ${token}`, String(userCall?.headers['authorization']))
    check('the API version header is pinned', userCall?.headers['x-github-api-version'] === GITHUB_API_VERSION)

    const repos = await listRepos(api)
    check('repo listing works', repos[0]?.full_name === 'octo/demo', JSON.stringify(repos[0]?.full_name))
    const listCall = fake.seen.find((r) => r.url.startsWith('/user/repos'))
    check('repo listing asks for owners, collaborators and orgs', decodeURIComponent(listCall?.url ?? '').includes('owner,collaborator,organization_member'), listCall?.url)

    const t = await getTree('octo/demo', 'main', api)
    check('tree keeps blobs and trees', t.entries.length === 3, JSON.stringify(t.entries.map((e) => e.path)))
    check('submodules are dropped', !t.entries.some((e) => e.type === 'commit'))

    const util = await readFile('octo/demo', 'src/lib/util.ts', 'main', api)
    check('text file decodes to its contents', util.text === utilText, JSON.stringify(util.text))
    check('text file reports no binary payload', util.base64 === undefined)
    check('text file mime comes from the path', util.mime === 'text/typescript', util.mime)

    const pngFile = await readFile('octo/demo', 'logo.png', 'main', api)
    check('binary file stays base64', pngFile.base64 === png && pngFile.text === undefined)
    check('binary file mime is the image type', pngFile.mime === 'image/png', pngFile.mime)

    const big = await readFile('octo/demo', 'big.txt', 'main', api)
    check('files over 1MB fall back to the blobs API', big.text === 'x'.repeat(64) && big.size === 1_500_000, `${String(big.text).slice(0, 8)}/${big.size}`)
    check('the blob fallback is exercised', fake.seen.some((r) => r.url.startsWith('/repos/octo/demo/git/blobs/big1')))
    check('the contents call is tried first', fake.seen.findIndex((r) => r.url.startsWith('/repos/octo/demo/contents/big.txt')) < fake.seen.findIndex((r) => r.url.startsWith('/repos/octo/demo/git/blobs/big1')))

    let oversize: unknown = null
    try {
      await readFile('octo/demo', 'huge.bin', 'main', api)
    } catch (err) {
      oversize = err
    }
    check('oversized files are refused with an explanation', isGitHubError(oversize) && /too large/i.test(oversize.message), String(oversize))

    const sha = await fileSha('octo/demo', 'src/lib/util.ts', 'main', api)
    check('fileSha returns the blob sha', sha === 'b1', String(sha))
    check('fileSha is undefined for a missing path', (await fileSha('octo/demo', 'README.md', 'main', api)) === undefined)

    const created = await writeFile('octo/demo', 'new.md', { ...api, message: 'Add new.md', contentBase64: utf8ToBase64('hello') })
    check('creating a file reports created', created.created === true && created.sha === 'n1', JSON.stringify(created))
    const putCall = fake.seen.filter((r) => r.method === 'PUT').pop()
    check('create sends a PUT without a sha', putCall?.body.sha === undefined, JSON.stringify(putCall?.body))
    check('create sends base64 content', putCall?.body.content === utf8ToBase64('hello'), String(putCall?.body.content))

    const updated = await writeFile('octo/demo', 'new.md', { ...api, message: 'Update', contentBase64: utf8ToBase64('again'), sha: 'n1' })
    check('updating a file reports update', updated.created === false, JSON.stringify(updated))

    const baseSha = await getBranchSha('octo/demo', 'main', api)
    check('branch head sha is read', baseSha === 'base-sha', baseSha)
    await createBranch('octo/demo', 'slade/x', baseSha, api)
    const refCall = fake.seen.find((r) => r.url === '/repos/octo/demo/git/refs')
    check('branch creation points at refs/heads', refCall?.body.ref === 'refs/heads/slade/x', JSON.stringify(refCall?.body))

    const branches = await listBranches('octo/demo', api)
    check('branches list', branches.map((b) => b.name).join(',') === 'main,dev', JSON.stringify(branches.map((b) => b.name)))

    const gist = await createGist({ ...api, files: [{ name: 'a.md', content: '# hi' }], description: 'desc', public: false })
    check('gist creation returns its url', gist.htmlUrl.includes('gist.github.com'), gist.htmlUrl)
    const gistCall = fake.seen.find((r) => r.url === '/gists')
    check('gist sends the file map', JSON.stringify(gistCall?.body.files) === JSON.stringify({ 'a.md': { content: '# hi' } }), JSON.stringify(gistCall?.body))
    check('gist visibility is explicit', gistCall?.body.public === false)

    const issue = await createIssue('octo/demo', { ...api, title: 'T', body: 'B', labels: ['slade'] })
    check('issue creation returns its number', issue.number === 12 && issue.htmlUrl.endsWith('/12'), JSON.stringify(issue))
    const issueCall = fake.seen.find((r) => r.url === '/repos/octo/demo/issues')
    check('issue carries title, body and labels', issueCall?.body.title === 'T' && issueCall?.body.body === 'B' && JSON.stringify(issueCall?.body.labels) === '["slade"]', JSON.stringify(issueCall?.body))

    const hits = await searchCode('octo/demo', 'answer', api)
    check('code search returns hits', hits[0]?.path === 'src/lib/util.ts', JSON.stringify(hits[0]?.path))
    const searchCall = fake.seen.find((r) => r.url.startsWith('/search/code'))
    const searchQuery = decodeURIComponent(searchCall?.url ?? '').replace(/\+/g, ' ')
    check('search is scoped to the repo', searchQuery.includes('q=answer repo:octo/demo'), searchCall?.url)
    check('search asks for text fragments', searchCall?.headers['accept'] === 'application/vnd.github.text-match+json', String(searchCall?.headers['accept']))

    const repo = await getRepo('octo/demo', api)
    check('repo metadata reads the default branch', repo.default_branch === 'main', repo.default_branch)
  } finally {
    fake.close()
  }
}

/** Failure paths: every status must land on a class the UI can act on. */
async function testGitHubErrors() {
  console.log('github error classification:')
  const token = 'ghp_' + 'b'.repeat(24)
  const fake = await startFakeGitHub({
    '/repos/octo/denied': () => ({ status: 403, json: { message: 'Resource not accessible by personal access token' } }),
    '/repos/octo/throttled': () => ({
      status: 403,
      json: { message: 'API rate limit exceeded for user ID 1.' },
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 900) },
    }),
    '/repos/octo/expired': () => ({ status: 401, json: { message: 'Bad credentials' } }),
    '/repos/octo/invalid': () => ({ status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'Commit', field: 'sha', code: 'missing' }] } }),
    '/repos/octo/flaky': () => ({ status: 502, json: { message: 'Server Error' } }),
  })

  const catchKind = async (path: string) => {
    try {
      await getRepo(path, { token, baseUrl: fake.base })
      return { kind: 'none', message: '' }
    } catch (err) {
      return { kind: isGitHubError(err) ? err.kind : 'not-a-github-error', message: githubErrorMessage(err), resetAt: isGitHubError(err) ? err.resetAt : undefined }
    }
  }

  try {
    const denied = await catchKind('octo/denied')
    check('403 → forbidden', denied.kind === 'forbidden', denied.kind)
    check('403 keeps the API wording', /not accessible/i.test(denied.message), denied.message)

    const throttled = await catchKind('octo/throttled')
    check('403 with no budget left → rate_limit', throttled.kind === 'rate_limit', throttled.kind)
    check('rate limit carries the reset time', (throttled.resetAt ?? 0) > Date.now(), String(throttled.resetAt))
    check('rate limit message says when it resets', /resets/i.test(throttled.message), throttled.message)

    const expired = await catchKind('octo/expired')
    check('401 → auth', expired.kind === 'auth', expired.kind)
    check('auth message tells you to sign in again', /sign in again/i.test(expired.message), expired.message)

    const invalid = await catchKind('octo/invalid')
    check('422 → validation', invalid.kind === 'validation', invalid.kind)
    check('validation surfaces the offending field', invalid.message.includes('sha'), invalid.message)

    const flaky = await catchKind('octo/flaky')
    check('5xx → server', flaky.kind === 'server', flaky.kind)

    const missing = await catchKind('octo/nope')
    check('404 → not_found', missing.kind === 'not_found', missing.kind)

    // A token must never reach a rendered message, even if it is in the body.
    let leaked = ''
    try {
      await getRepo(`octo/leak?token=${token}`, { token, baseUrl: fake.base })
    } catch (err) {
      leaked = githubErrorMessage(err)
    }
    check('a token in an error body is redacted', !leaked.includes(token), leaked)
    check('redactSecrets covers classic PATs', redactSecrets(`x ${token} y`) === 'x <redacted> y')
    check('redactSecrets covers fine-grained PATs', redactSecrets(`x github_pat_${'A1_'.repeat(10)} y`).includes('<redacted>'))
  } finally {
    fake.close()
  }
}

/** The relay that makes the device flow possible from a static page. */
async function testGitHubRelay() {
  console.log('github oauth relay:')
  const upstreamCalls: { url: string; body: string }[] = []
  const fakeFetch: typeof fetch = async (input, init) => {
    upstreamCalls.push({ url: String(input), body: String(init?.body ?? '') })
    if (String(input).includes('/device/code')) {
      return new Response(JSON.stringify({ device_code: 'dev-123', user_code: 'AB-12', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }), { status: 200 })
    }
    return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 200 })
  }

  const start = await handleRelayRequest({
    path: '/github-oauth/device_code',
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify({ client_id: 'Iv1.test', scope: 'repo gist', client_secret: 'MUST-NOT-BE-FORWARDED' }),
    origin: 'https://slade.example',
    fetchImpl: fakeFetch,
  })
  check('relay answers 200', start.status === 200, String(start.status))
  check('relay returns GitHub\u2019s body verbatim', start.body.includes('AB-12'), start.body)
  check('relay forwards to github.com/login/device/code', upstreamCalls[0]?.url === 'https://github.com/login/device/code', upstreamCalls[0]?.url)
  check('relay drops a client_secret', !upstreamCalls[0]?.body.includes('MUST-NOT'), upstreamCalls[0]?.body)
  check('relay forwards the requested scope', upstreamCalls[0]?.body.includes('scope=repo+gist'), upstreamCalls[0]?.body)
  check('relay echoes the caller origin', start.headers['Access-Control-Allow-Origin'] === 'https://slade.example', JSON.stringify(start.headers))
  check('relay allows the preflight', String(start.headers['Access-Control-Allow-Headers'] ?? '').includes('Content-Type'))

  await handleRelayRequest({
    path: '/github-oauth/access_token',
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
    body: 'client_id=Iv1.test&device_code=dev-123&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code',
    fetchImpl: fakeFetch,
  })
  check('relay maps access_token to the token endpoint', upstreamCalls[1]?.url === 'https://github.com/login/oauth/access_token', upstreamCalls[1]?.url)
  check('relay forwards form-encoded bodies', upstreamCalls[1]?.body.includes('device_code=dev-123'), upstreamCalls[1]?.body)

  const preflight = await handleRelayRequest({ path: '/github-oauth/device_code', method: 'OPTIONS' })
  check('OPTIONS gets 204', preflight.status === 204, String(preflight.status))
  const get = await handleRelayRequest({ path: '/github-oauth/device_code', method: 'GET' })
  check('GET is refused', get.status === 405, String(get.status))
  const noClient = await handleRelayRequest({ path: '/github-oauth/device_code', method: 'POST', body: '{}' })
  check('a request without client_id is refused', noClient.status === 400 && noClient.body.includes('incorrect_client_credentials'), noClient.body)
  const other = await handleRelayRequest({ path: '/api/secrets', method: 'POST', body: '{}' })
  check('the relay is not a general-purpose proxy', other.status === 404, String(other.status))

  const broken = await handleRelayRequest({
    path: '/github-oauth/device_code',
    method: 'POST',
    body: '{"client_id":"x"}',
    fetchImpl: async () => {
      throw new TypeError('offline')
    },
  })
  check('an unreachable github.com becomes a 502', broken.status === 502 && broken.body.includes('relay_upstream_failed'), broken.body)
  check('filterParams keeps only the device-flow keys', JSON.stringify(filterParams('/github-oauth/access_token', { client_id: 'a', device_code: 'b', grant_type: 'c', client_secret: 'd', evil: 'e' })) === JSON.stringify({ client_id: 'a', device_code: 'b', grant_type: 'c' }))
}

/** Device flow end to end, with a scripted relay. */
async function testDeviceFlow() {
  console.log('github device flow:')

  const makeFetch = (script: unknown[], calls?: { url: string; body: string }[]): typeof fetch =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls?.push({ url: String(input), body: String(init?.body ?? '') })
      const next = script.shift()
      if (next === 'throw') throw new TypeError('relay offline')
      return new Response(JSON.stringify(next), { status: 200 })
    }) as typeof fetch

  const deviceCode = {
    device_code: 'dev-1',
    user_code: 'WXYZ-1234',
    verification_uri: 'https://github.com/login/device',
    verification_uri_complete: 'https://github.com/login/device?user_code=WXYZ-1234',
    expires_in: 900,
    interval: 1,
  }

  const calls: { url: string; body: string }[] = []
  const code = await requestDeviceCode({ clientId: 'Iv1.x', fetchImpl: makeFetch([deviceCode], calls) })
  check('device code is returned to the caller', code.userCode === 'WXYZ-1234', code.userCode)
  check('the poll interval is floored at 5s', code.intervalSec === 5, String(code.intervalSec))
  check('device request goes to the relay, not github.com', calls[0]?.url === '/github-oauth/device_code', calls[0]?.url)
  check('device request asks for the default scopes', calls[0]?.body.includes(DEFAULT_SCOPE), calls[0]?.body)

  let missingId: unknown = null
  try {
    await requestDeviceCode({ clientId: '  ' })
  } catch (err) {
    missingId = err
  }
  check('a missing client id explains where to put it', missingId instanceof DeviceFlowError && /Client ID/i.test(missingId.message), String(missingId))

  let disabled: unknown = null
  try {
    await requestDeviceCode({ clientId: 'Iv1.x', fetchImpl: makeFetch([{ error: 'device_flow_disabled' }]) })
  } catch (err) {
    disabled = err
  }
  check('device_flow_disabled names the fix', disabled instanceof DeviceFlowError && /Enable Device Flow/i.test(disabled.message), String(disabled))

  let unreachable: unknown = null
  try {
    await requestDeviceCode({ clientId: 'Iv1.x', fetchImpl: makeFetch(['throw']) })
  } catch (err) {
    unreachable = err
  }
  check('an unreachable relay suggests the alternatives', unreachable instanceof DeviceFlowError && /relay|token/i.test(unreachable.message), String(unreachable))

  const poll = (payload: unknown) => pollOnce({ clientId: 'Iv1.x', deviceCode: 'dev-1', fetchImpl: makeFetch([payload]) })
  check('authorization_pending → pending', (await poll({ error: 'authorization_pending' })).status === 'pending')
  check('slow_down → slow_down', (await poll({ error: 'slow_down' })).status === 'slow_down')
  check('access_denied → denied', (await poll({ error: 'access_denied' })).status === 'denied')
  check('expired_token → expired', (await poll({ error: 'expired_token' })).status === 'expired')
  const authorized = await poll({ access_token: 'gho_token', token_type: 'bearer', scope: 'repo gist' })
  check('access_token → authorized', authorized.status === 'authorized' && authorized.status === 'authorized' && authorized.token === 'gho_token', JSON.stringify(authorized))

  // The full loop: pending twice, then approved.
  const seenCodes: string[] = []
  const statuses: string[] = []
  const result = await runDeviceFlow({
    clientId: 'Iv1.x',
    fetchImpl: makeFetch([deviceCode, { error: 'authorization_pending' }, { error: 'slow_down' }, { access_token: 'gho_final', scope: 'repo gist' }]),
    sleep: async () => {},
    onCode: (c) => seenCodes.push(c.userCode),
    onStatus: (s) => statuses.push(s),
  })
  check('the flow hands the code to the UI', seenCodes.join(',') === 'WXYZ-1234', seenCodes.join(','))
  check('the flow returns the token', result.token === 'gho_final', result.token)
  check('slow_down is reported to the UI', statuses.includes('slow_down'), statuses.join(','))

  let denied: unknown = null
  try {
    await runDeviceFlow({
      clientId: 'Iv1.x',
      fetchImpl: makeFetch([deviceCode, { error: 'access_denied' }]),
      sleep: async () => {},
      onCode: () => {},
    })
  } catch (err) {
    denied = err
  }
  check('cancelling on GitHub surfaces as denied', denied instanceof DeviceFlowError && denied.kind === 'denied', String(denied))

  let aborted: unknown = null
  const controller = new AbortController()
  controller.abort()
  try {
    await runDeviceFlow({
      clientId: 'Iv1.x',
      fetchImpl: makeFetch([deviceCode]),
      sleep: async () => {},
      onCode: () => {},
      signal: controller.signal,
    })
  } catch (err) {
    aborted = err
  }
  check('an aborted sign-in throws AbortError', aborted instanceof DOMException && aborted.name === 'AbortError', String(aborted))

  check('PAT lookalikes are recognised', looksLikeToken('ghp_' + 'a'.repeat(24)) && looksLikeToken(`github_pat_${'A1_'.repeat(10)}`))
  check('non-tokens are not', !looksLikeToken('hello') && !looksLikeToken('sk-abc'))
}

/** Payload builders: what exactly would be sent to GitHub. */
function testPublishPayloads() {
  console.log('publish payloads:')
  const textArtifact: Artifact = {
    id: 'a1',
    name: 'report.md',
    mime: 'text/markdown',
    size: 20,
    kind: 'doc',
    createdAt: Date.now(),
    provenance: { origin: 'model', modelId: 'mock-pro', modelLabel: 'Simulacron Pro' },
    text: '# Report\n\n```ts\nconst a = 1\n```\n',
  }
  const gist = artifactToGist(textArtifact, 'from Slade')
  check('text artifacts become a gist file', gist.files[0]?.name === 'report.md' && gist.files[0]?.content.includes('# Report'), JSON.stringify(gist.files[0]?.name))
  check('the gist description is passed through', gist.description === 'from Slade')

  const binaryArtifact: Artifact = { ...textArtifact, id: 'a2', name: 'logo.png', mime: 'image/png', kind: 'image', text: undefined }
  let binaryError: unknown = null
  try {
    artifactToGist(binaryArtifact)
  } catch (err) {
    binaryError = err
  }
  check('binary artifacts are refused for gists with a reason', binaryError instanceof PublishError && /binary/i.test(binaryError.message), String(binaryError))
  check('binary detection covers images', isBinaryArtifact(binaryArtifact))
  check('text artifacts are not binary', !isBinaryArtifact(textArtifact))

  check('fences grow past nested backticks', fenceFor('a ``` b') === '````', fenceFor('plain') === '```')
  check('fenced output is valid markdown', fenced('```', 'ts').startsWith('````ts'))
  check('slugs are path/branch safe', slugify('Fix the Failover bug! / v2') === 'fix-the-failover-bug-v2', slugify('Fix the Failover bug! / v2'))
  check('branch names carry the prefix', branchNameFor('slade', 'Q3 Report.csv') === 'slade/q3-report.csv', branchNameFor('slade', 'Q3 Report.csv'))
  check('titles come from the first real line', titleFromText('\n\n## Hello **world**\nmore') === 'Hello world', titleFromText('\n\n## Hello **world**\nmore'))
  check('suggested paths honour the prefix', suggestRepoPath('a.csv', 'artifacts') === 'artifacts/a.csv', suggestRepoPath('a.csv', 'artifacts'))
  check('commit messages name the file', commitMessageFor(textArtifact, 'create').includes('report.md'))
  check('gist names keep spaces but lose separators', gistNameFor('src/a.ts') === 'src-a.ts')

  const issueBody = artifactIssueBody(textArtifact, { origin: 'Simulacron Pro', conversationTitle: 'Report chat' })
  check('issue bodies embed the artifact', issueBody.includes('# Report'), issueBody.slice(0, 60))
  check('issue bodies carry provenance', issueBody.includes('Simulacron Pro') && issueBody.includes('Report chat'))
  check('issue titles name the artifact', artifactIssueTitle(textArtifact) === 'Artifact: report.md')
  check('message issue bodies include the text', messageIssueBody('hello', { origin: 'an assistant answer' }).startsWith('hello'))
}

/** executePublish: the three destinations, including the new-branch path. */
async function testPublishFlow() {
  console.log('publish flow:')
  const token = 'ghp_' + 'c'.repeat(24)
  const fake = await startFakeGitHub({
    '/repos/octo/demo/git/ref/heads/main': () => ({ status: 200, json: { object: { sha: 'base-sha' } } }),
    '/repos/octo/demo/git/refs': () => ({ status: 201, json: { ref: 'refs/heads/slade/report' } }),
    '/repos/octo/demo/contents/report.md': (body, meta) =>
      meta.method === 'GET'
        ? { status: 200, json: { type: 'file', path: 'report.md', sha: 'old-sha', size: 3, encoding: 'base64', content: Buffer.from('old').toString('base64') } }
        : { status: 200, json: { content: { path: 'report.md', sha: 'new-sha', html_url: 'https://github.com/octo/demo/blob/slade/report/report.md' }, commit: { sha: 'c0ffee1234', html_url: 'https://github.com/octo/demo/commit/c0ffee1234' } } },
    '/repos/octo/demo/issues': () => ({ status: 201, json: { number: 3, html_url: 'https://github.com/octo/demo/issues/3' } }),
    '/gists': () => ({ status: 201, json: { id: '0123456789ab', html_url: 'https://gist.github.com/0123456789ab', public: true } }),
  })
  const ctx = { token, baseUrl: fake.base }

  try {
    const gist = await executePublish({ target: 'gist', name: 'a.md', text: '# hi', description: 'd', public: true }, ctx)
    check('gist publish returns a link', gist.url.includes('gist.github.com') && gist.kind === 'gist', JSON.stringify(gist))
    check('gist chips name the gist', gist.label === 'gist 0123456', gist.label)

    const file = await executePublish(
      { target: 'file', name: 'report.md', text: '# Report', repo: 'octo/demo', branch: 'main', newBranch: 'slade/report', path: 'report.md', commitMessage: 'Add report' },
      ctx,
    )
    check('file publish reports the path', file.label.includes('report.md'), file.label)
    check('file publish links to the file', file.url.includes('/blob/'), file.url)
    const puts = fake.seen.filter((r) => r.method === 'PUT')
    check('commit lands on the new branch', puts[0]?.body.branch === 'slade/report', JSON.stringify(puts[0]?.body))
    check('an existing file is updated with its sha', puts[0]?.body.sha === 'old-sha', JSON.stringify(puts[0]?.body))
    check('the commit message is forwarded', puts[0]?.body.message === 'Add report', String(puts[0]?.body.message))
    check('a branch is created from the base branch', fake.seen.some((r) => r.method === 'POST' && r.url === '/repos/octo/demo/git/refs'))

    const issue = await executePublish({ target: 'issue', name: 'x', repo: 'octo/demo', title: 'Bug', body: 'text' }, ctx)
    check('issue publish returns its number', issue.label === 'issue #3' && issue.url.endsWith('/issues/3'), JSON.stringify(issue))

    let noToken: unknown = null
    try {
      await executePublish({ target: 'gist', name: 'a.md', text: 'x' }, { token: '' })
    } catch (err) {
      noToken = err
    }
    check('publishing without a token is refused up front', noToken instanceof PublishPreflightError && /Connect GitHub/i.test(noToken.message), String(noToken))

    let noRepo: unknown = null
    try {
      await executePublish({ target: 'file', name: 'a.md', text: 'x' }, ctx)
    } catch (err) {
      noRepo = err
    }
    check('committing without a repo is refused up front', noRepo instanceof PublishPreflightError && /repository/i.test(noRepo.message), String(noRepo))

    const readOnly = await startFakeGitHub({
      '/repos/octo/ro/issues': () => ({ status: 403, json: { message: 'Resource not accessible by integration' } }),
    })
    try {
      let denied: unknown = null
      try {
        await executePublish({ target: 'issue', name: 'x', repo: 'octo/ro', title: 't', body: 'b' }, { token, baseUrl: readOnly.base })
      } catch (err) {
        denied = err
      }
      check('a scope refusal is explained with the fix', /repo/i.test(publishErrorMessage(denied)), publishErrorMessage(denied))
    } finally {
      readOnly.close()
    }

    const textPayload = await artifactToFilePayload({
      id: 'x',
      name: 'a.ts',
      mime: 'text/typescript',
      size: 3,
      kind: 'code',
      createdAt: Date.now(),
      provenance: { origin: 'user' },
      text: 'abc',
    })
    check('text artifacts encode to base64 for the contents API', textPayload.contentBase64 === Buffer.from('abc').toString('base64'), textPayload.contentBase64)
    check('file payloads report their size', textPayload.size === 3, String(textPayload.size))
  } finally {
    fake.close()
  }
}

/**
 * The loop the feature exists for: pull a file out of a repo, attach it, send a
 * prompt — and the file's contents must be in the prompt the model receives.
 */
async function testRepoContextEndToEnd() {
  console.log('repo context → prompt:')
  const source = 'export function answer() {\n  return 42\n}\n'
  const artifact = await artifactFromRemote({
    name: 'answer.ts',
    mime: 'text/typescript',
    remote: {
      kind: 'github',
      repo: 'octo/demo',
      ref: 'main',
      path: 'src/answer.ts',
      url: 'https://github.com/octo/demo/blob/main/src/answer.ts',
      sha: 'b1',
    },
    text: source,
  })
  check('attach builds a code artifact', artifact.kind === 'code', artifact.kind)
  check('attach records where it came from', artifact.remote?.repo === 'octo/demo' && artifact.remote?.ref === 'main', JSON.stringify(artifact.remote))
  check('attach keeps the file contents', artifact.text === source)
  check('small text artifacts survive a reload', artifact.ephemeral === false)
  check('attached size is the byte length', artifact.size === new TextEncoder().encode(source).byteLength, String(artifact.size))

  useArtifacts.getState().add(artifact)
  const convId = useChat.getState().newConversation()
  useChat.getState().appendMessage({
    id: 'msg_gh',
    role: 'user',
    conversationId: convId,
    content: 'what does this return?',
    createdAt: Date.now(),
    status: 'complete',
    attachmentIds: [artifact.id],
  })

  const turns = await buildTurns(useChat.getState().conversations[convId]!)
  const prompt = turns[turns.length - 1]?.text ?? ''
  check('the repo file is folded into the prompt', prompt.includes('return 42'), prompt.slice(0, 80))
  check('the folded block names the file', prompt.includes('attached file: answer.ts'), prompt)
  check('the user text is preserved', prompt.startsWith('what does this return?'), prompt.slice(0, 40))

  const csv = await artifactFromRemote({
    name: 'sales.csv',
    mime: 'text/csv',
    remote: { kind: 'github', repo: 'octo/demo', ref: 'main', path: 'data/sales.csv', url: 'u' },
    text: 'region,total\nwest,10\neast,20\n',
  })
  check('repo spreadsheets get parsed columns', csv.kind === 'sheet' && csv.columns?.join(',') === 'region,total', JSON.stringify(csv.columns))
  check('repo spreadsheets get parsed rows', csv.rows?.length === 2, JSON.stringify(csv.rows))
}

/** The store's own wiring: defaults, persistence key, sign-out. */
function testGitHubStore() {
  console.log('github store:')
  const gh = useGitHub.getState()
  check('starts disconnected', gh.token === '' && gh.authStatus === 'anonymous', `${gh.authStatus}/${gh.token}`)
  check('publish defaults are sane', gh.publishDefaults.target === 'gist' && gh.publishDefaults.gistPublic === false, JSON.stringify(gh.publishDefaults))
  check('device flow is not running', gh.device === undefined)

  gh.setPublishDefaults({ target: 'file', repo: 'octo/demo', prefix: 'artifacts' })
  check('publish defaults update', useGitHub.getState().publishDefaults.repo === 'octo/demo')
  check('github state is persisted under its own key', (localStorage.getItem('slade.github.v1') ?? '').includes('octo/demo'), String(localStorage.getItem('slade.github.v1')))
  check('the export key list stays separate from github', !JSON.stringify(useSettings.getState().s).includes('octo/demo'))

  gh.setClientId('Iv1.smoke')
  check('client id persists', useGitHub.getState().clientId === 'Iv1.smoke')
  gh.setRelayUrl('https://relay.example')
  check('relay url persists', useGitHub.getState().relayUrl === 'https://relay.example')

  useGitHub.setState({ token: 'ghp_x', login: 'octo', authStatus: 'authorized' })
  useGitHub.getState().signOut()
  const after = useGitHub.getState()
  check('sign out forgets the token', after.token === '' && after.authStatus === 'anonymous' && after.login === undefined)
  check('sign out keeps the configuration', after.clientId === 'Iv1.smoke' && after.relayUrl === 'https://relay.example')
  gh.setPublishDefaults({ target: 'gist', repo: undefined, branch: undefined, prefix: '' })
}


/**
 * The store glue the UI actually calls — with `fetch` redirected at a fake
 * api.github.com, so the hardcoded API host, the token header and every store
 * action run for real.
 */
async function testGitHubStoreAgainstFakeApi() {
  console.log('github store ↔ api:')
  const token = 'ghp_' + 'd'.repeat(24)
  const utilText = 'export const answer = 42\n'
  const fake = await startFakeGitHub({
    '/user': () => ({ status: 200, json: { id: 7, login: 'octo', name: 'Octo', avatar_url: 'https://a.example/o.png', html_url: 'https://github.com/octo' }, headers: { 'x-oauth-scopes': 'repo, gist' } }),
    '/user/repos': () => ({ status: 200, json: [{ id: 1, name: 'demo', full_name: 'octo/demo', owner: { login: 'octo', avatar_url: '' }, private: false, fork: false, archived: false, description: 'demo', default_branch: 'main', html_url: 'https://github.com/octo/demo', pushed_at: null, updated_at: null, language: 'TypeScript', stargazers_count: 1 }] }),
    '/repos/octo/demo/git/trees/main': () => ({ status: 200, json: { truncated: false, tree: [{ path: 'src/lib/util.ts', mode: '100644', type: 'blob', sha: 'b1', size: utilText.length }] } }),
    '/repos/octo/demo/contents/src/lib/util.ts': () => ({ status: 200, json: { type: 'file', name: 'util.ts', path: 'src/lib/util.ts', sha: 'b1', size: utilText.length, encoding: 'base64', content: Buffer.from(utilText).toString('base64') } }),
    '/repos/octo/demo/branches': () => ({ status: 200, json: [{ name: 'main', commit: { sha: 's1' } }, { name: 'dev', commit: { sha: 's2' } }] }),
    '/repos/octo/demo': () => ({ status: 200, json: { id: 1, name: 'demo', full_name: 'octo/demo', owner: { login: 'octo', avatar_url: '' }, private: false, fork: false, archived: false, description: 'demo', default_branch: 'main', html_url: 'https://github.com/octo/demo', pushed_at: null, updated_at: null, language: 'TypeScript', stargazers_count: 1 } }),
    '/search/code': () => ({ status: 200, json: { items: [{ path: 'src/lib/util.ts', name: 'util.ts', sha: 'b1', html_url: 'https://github.com/octo/demo/blob/main/src/lib/util.ts' }] } }),
    '/gists': () => ({ status: 201, json: { id: 'ffeeddccbbaa', html_url: 'https://gist.github.com/ffeeddccbbaa', public: false } }),
  })

  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return realFetch(url.replace('https://api.github.com', fake.base), init)
  }) as typeof fetch

  const gh = useGitHub.getState()
  try {
    useUI.getState().clearPendingAttachments()
    useGitHub.setState({ token, login: 'octo', authStatus: 'authorized', scopes: ['repo', 'gist'], repos: [], tree: undefined, preview: undefined, search: null })

    await useGitHub.getState().loadRepos({ force: true })
    check('store loads the repo list', useGitHub.getState().repos[0]?.full_name === 'octo/demo', JSON.stringify(useGitHub.getState().repos.map((r) => r.full_name)))
    check('store clears the loading flag', useGitHub.getState().reposLoading === false)
    check('repo list came from the API host the client pins', fake.seen.some((r) => r.url.startsWith('/user/repos')), JSON.stringify(fake.seen.map((r) => r.url).slice(0, 3)))

    const opened = await useGitHub.getState().openRepo('https://github.com/octo/demo')
    check('opening a repo by URL works', opened === true)
    check('the tree is cached in the store', useGitHub.getState().tree?.entries.length === 1, JSON.stringify(useGitHub.getState().tree?.entries.map((e) => e.path)))
    check('the branch defaults to the repo default', useGitHub.getState().activeBranch === 'main', String(useGitHub.getState().activeBranch))
    // The branch list is a background nicety — give its promise a tick.
    await new Promise((r) => setTimeout(r, 50))
    check('branches load in the background', useGitHub.getState().branches.map((b) => b.name).join(',') === 'main,dev', JSON.stringify(useGitHub.getState().branches))

    await useGitHub.getState().openFile('src/lib/util.ts')
    check('opening a file previews its text', useGitHub.getState().preview?.text === utilText, String(useGitHub.getState().preview?.text))
    check('the preview knows its ref', useGitHub.getState().preview?.ref === 'main', String(useGitHub.getState().preview?.ref))

    const attached = await useGitHub.getState().attachFile('src/lib/util.ts')
    check('attaching returns an artifact', attached?.name === 'util.ts', String(attached?.name))
    check('attaching queues it for the next message', useUI.getState().pendingAttachmentIds.includes(attached!.id), JSON.stringify(useUI.getState().pendingAttachmentIds))
    check('attaching records the repo and path', attached?.remote?.path === 'src/lib/util.ts' && attached?.remote?.ref === 'main', JSON.stringify(attached?.remote))
    check('the artifact is in the artifact store', useArtifacts.getState().byId[attached!.id] != null)
    check('the file contents came along', useArtifacts.getState().byId[attached!.id]?.text === utilText)

    await useGitHub.getState().runSearch('answer')
    check('search results land in the store', useGitHub.getState().search?.hits[0]?.path === 'src/lib/util.ts', JSON.stringify(useGitHub.getState().search?.hits.map((h) => h.path)))

    const published = await useGitHub.getState().publish({ target: 'gist', name: 'answer.md', text: '# answer', public: false })
    check('publishing from the store returns the link', published?.url.includes('gist.github.com'), JSON.stringify(published))
    check('the store remembers the last publish', useGitHub.getState().lastPublish?.url === published?.url)
    check('publishing clears the busy flag', useGitHub.getState().publishing === false)
    check('publishing keeps the step text out of the transcript', useGitHub.getState().publishError === undefined)

    // A failure must land on the store's error fields, not throw into the UI.
    const failing = await startFakeGitHub({})
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return realFetch(url.replace('https://api.github.com', failing.base), init)
    }) as typeof fetch
    useGitHub.setState({ repos: [] })
    await useGitHub.getState().loadRepos({ force: true })
    check('a failing repo load is reported, not thrown', /Not found/i.test(useGitHub.getState().reposError ?? ''), String(useGitHub.getState().reposError))
    const failedPublish = await useGitHub.getState().publish({ target: 'gist', name: 'x.md', text: 'x' })
    check('a failing publish returns null and sets an error', failedPublish === null && Boolean(useGitHub.getState().publishError), String(useGitHub.getState().publishError))
    failing.close()
    useGitHub.getState().dismissPublishError()
  } finally {
    globalThis.fetch = realFetch
    fake.close()
    gh.signOut()
    gh.setPublishDefaults({ repo: undefined, branch: undefined, prefix: '' })
    useUI.getState().clearPendingAttachments()
  }
}

/**
 * Render the new UI server-side.
 *
 * Server rendering uses each store's *initial* state (zustand v5 hands React
 * `getInitialState()` as the SSR snapshot), so these assertions seed that state
 * the way a restored session would have it, then check the markup every render
 * path produces. Effects do not run — this is about the paths that would throw
 * or silently render nothing.
 */
function testGitHubUiRenders() {
  console.log('github ui renders:')

  const uiInit = useUI.getInitialState() as unknown as Record<string, unknown>
  const ghInit = useGitHub.getInitialState() as unknown as Record<string, unknown>
  const artifactInit = useArtifacts.getInitialState() as unknown as { byId: Record<string, Artifact> }
  const originalByid = artifactInit.byId

  const artifact: Artifact = {
    id: 'art_render',
    name: 'answer.ts',
    mime: 'text/typescript',
    size: 25,
    kind: 'code',
    createdAt: Date.now(),
    provenance: { origin: 'user' },
    text: 'export const answer = 42\n',
    remote: {
      kind: 'github',
      repo: 'octo/demo',
      ref: 'main',
      path: 'src/answer.ts',
      url: 'https://github.com/octo/demo/blob/main/src/answer.ts',
      sha: 'b1',
    },
  }

  try {
    const closed = renderToString(createElement(GitHubPanel))
    check('the drawer renders nothing while closed', closed === '', closed.slice(0, 60))

    artifactInit.byId = { ...originalByid, [artifact.id]: artifact }
    uiInit.githubOpen = true
    uiInit.githubTab = 'repos'

    const drawer = renderToString(createElement(GitHubPanel))
    check('the drawer renders its tabs', drawer.includes('Repos') && drawer.includes('Files') && drawer.includes('Search'), drawer.slice(0, 120))
    check('the drawer links to OAuth app creation', drawer.includes('github.com/settings/applications/new'))
    check('the drawer offers the token fallback', drawer.includes('personal access token'))
    check('the drawer asks for a Client ID first', drawer.includes('Client ID'))
    check('the drawer explains the Enable Device Flow step', drawer.includes('Enable Device Flow'))

    // With a client id saved, the connect card offers the flow itself.
    ghInit.clientId = 'Iv1.rendered'
    const ready = renderToString(createElement(GitHubPanel))
    check('a saved client id unlocks the sign-in button', ready.includes('Sign in with GitHub'), ready.slice(0, 120))
    check('the connect card names the requested scopes', ready.includes('repo gist read:user'), ready.slice(0, 200))
    ghInit.clientId = ''

    const card = renderToString(createElement(ArtifactCard, { artifactId: artifact.id }))
    // React SSR separates adjacent text nodes with comment markers.
    const flattened = card.replace(/<!-- -->/g, '')
    check('a repo artifact shows its origin', flattened.includes('octo/demo@main'), flattened.slice(0, 200))
    check('a repo artifact links back to GitHub', card.includes('https://github.com/octo/demo/blob/main/src/answer.ts'))
    check('a repo artifact is still a normal card', card.includes('answer.ts') && card.includes('Send back to model'))
    check('a repo artifact offers publishing', card.includes('Publish to GitHub'))

    uiInit.githubTab = 'files'
    const files = renderToString(createElement(GitHubPanel))
    check('the files tab renders its empty state', files.includes('No repository open'), files.slice(0, 120))

    uiInit.githubTab = 'search'
    const search = renderToString(createElement(GitHubPanel))
    check('the search tab renders its empty state', search.includes('No repository open'), search.slice(0, 120))

    const message = {
      id: 'msg_render',
      role: 'assistant' as const,
      conversationId: 'conv_render',
      content: '# Title\n\nBody text',
      createdAt: Date.now(),
      status: 'complete' as const,
    }
    const bubble = renderToString(createElement(MessageBubble, { message }))
    check('assistant messages offer publishing', bubble.includes('Publish to GitHub'), 'no publish action')
    const userBubble = renderToString(createElement(MessageBubble, { message: { ...message, id: 'msg_user', role: 'user' } }))
    check('user messages offer publishing too', userBubble.includes('Publish to GitHub'))
  } finally {
    artifactInit.byId = originalByid
    delete uiInit.githubOpen
    delete uiInit.githubTab
  }
}

/**
 * The "Add model" flow: a curated catalogue limited to long-context models
 * that excel at programming / problem solving, a provider-first form whose
 * Model ID field unlocks only after a provider is picked, and a picker table
 * that is filterable + sortable and copies the chosen ID into the field.
 */
function testModelPicker() {
  console.log('add-model catalog & picker:')

  // Catalog invariants: this is the "limited to" half of the feature. A model
  // only belongs in the catalogue with a high context window AND a
  // programming / problem-solving strength.
  check('catalogue is non-empty', MODEL_CATALOG.length >= 15, String(MODEL_CATALOG.length))
  check(
    'every catalogue entry has a high context window (≥ 200K)',
    MODEL_CATALOG.every((m) => m.contextWindow >= 200_000),
    JSON.stringify(MODEL_CATALOG.filter((m) => m.contextWindow < 200_000).map((m) => m.apiModel)),
  )
  check(
    'every entry is coding/problem-solving focused',
    MODEL_CATALOG.every((m) => m.strengths.includes('coding') || m.strengths.includes('reasoning')),
    JSON.stringify(MODEL_CATALOG.filter((m) => !m.strengths.includes('coding') && !m.strengths.includes('reasoning')).map((m) => m.apiModel)),
  )
  check(
    'model IDs are unique per provider',
    new Set(MODEL_CATALOG.map((m) => `${m.provider}:${m.apiModel}`)).size === MODEL_CATALOG.length,
  )
  check(
    'every provider has catalogue entries',
    (['openai', 'anthropic', 'google', 'openrouter', 'openai-compatible'] as const).every((p) => catalogFor(p).length > 0),
  )
  check(
    'openai-compatible entries suggest a base URL',
    catalogFor('openai-compatible').every((m) => typeof m.baseURL === 'string' && m.baseURL.startsWith('https://')),
  )
  check(
    'mock provider is not in the catalogue (it is not addable)',
    !MODEL_CATALOG.some((m) => (m.provider as string) === 'mock'),
  )
  check('formatCtx renders millions compactly', formatCtx(1_048_576) === '1M' && formatCtx(1_000_000) === '1M', `${formatCtx(1_048_576)}/${formatCtx(1_000_000)}`)
  check('formatCtx renders kilos compactly', formatCtx(262_144) === '262K' && formatCtx(400_000) === '400K', `${formatCtx(262_144)}/${formatCtx(400_000)}`)
  check('formatPrice hides unknowns and trims zeros', formatPrice(undefined) === '—' && formatPrice(0.03) === '$0.03' && formatPrice(0.0005) === '$0.0005', `${formatPrice(undefined)}/${formatPrice(0.03)}/${formatPrice(0.0005)}`)

  // SSR: the picker table for OpenAI. Default sort is context, descending,
  // so the 1M-context GPTs lead and the 400K mini trails.
  const openai = renderToString(createElement(ModelPickerTable, { provider: 'openai', onPick: () => {} })).replace(/<!-- -->/g, '')
  check('picker table renders a filter input', openai.includes('aria-label="Filter models"'))
  check('picker table shows the filtered/total count', openai.includes('3 of 3'), openai.match(/\d+ of \d+/)?.[0])
  check('sortable headers exist', openai.includes('th-sort'), openai.slice(0, 200))
  check('default sort is context descending (aria-sort)', openai.includes('aria-sort="descending"'))
  check(
    'rows are ordered by context descending',
    openai.indexOf('gpt-5.5') !== -1 && openai.indexOf('gpt-5.5') < openai.indexOf('gpt-5.4-mini'),
  )
  check('rows carry the model ID cells', openai.includes('gpt-5.4-mini') && openai.includes('ctx-chip'))
  check('rows are selectable', openai.includes('pick-row'), openai.slice(0, 300))
  check('strengths render as tags', openai.includes('Coding') && openai.includes('Problem solving'))

  // SSR: the add-model form before a provider is chosen. The Model ID field
  // must start disabled; its hint points at the provider step, and only once a
  // provider is picked does the hint promise the browse dialog.
  const form = renderToString(createElement(AddModelForm, { onAdd: () => {}, onCancel: () => {} }))
  check('form starts on the provider step ("Select a provider…")', form.includes('Select a provider'), form.slice(0, 200))
  check('model id field is disabled until a provider is picked', /placeholder="Select a provider first"/.test(form) && /disabled=""/.test(form), form.slice(0, 400))
  check('disabled model id explains what unlocks it', form.includes('Enabled once a provider is selected'), form)
  check('picker modal only mounts after a provider exists', !form.includes('model-picker') && !form.includes('Browse models'), form)

  // SSR: a filtered table renders its empty state (openrouter + impossible filter is
  // not reachable without state, so exercise the provider swap instead).
  const orTable = renderToString(createElement(ModelPickerTable, { provider: 'openrouter', onPick: () => {} }))
  check('provider swap re-scopes the table to OpenRouter slugs', orTable.includes('deepseek/deepseek-v4-pro') && !orTable.includes('gpt-5.5'), orTable.match(/\d+ of \d+/)?.[0])
  check('openrouter rows keep vendor-prefixed IDs', orTable.includes('z-ai/glm-5.2') && orTable.includes('moonshotai/kimi-k2.7-code'))
}

/**
 * Providers are user-managed like models: Settings → Providers lists the
 * configured connections, "Add a provider" opens a dialog with every
 * supported kind, and deleting a connection cascades to its models. Covers
 * the catalog, the legacy-shape migration, the store actions, and the
 * dialog's SSR render.
 */
function testProviderManagement() {
  console.log('provider management (add/delete):')

  // Catalog integrity: the add-dialog's source of truth.
  const kinds = SUPPORTED_PROVIDERS.map((p) => p.kind)
  check('every adapter kind is represented in the catalog', kinds.length === 6 && new Set(kinds).size === 6, kinds.join(','))
  check('catalog labels are unique', new Set(SUPPORTED_PROVIDERS.map((p) => p.label)).size === SUPPORTED_PROVIDERS.length)
  check('the simulator needs no key', supportedProvider('mock')?.noKey === true)
  check('openai-compatible exposes a base URL field', supportedProvider('openai-compatible')?.supportsBaseURL === true)
  check('every real provider documents where to get a key', (['openai', 'anthropic', 'google', 'openrouter'] as const).every((k) => typeof supportedProvider(k)?.keyUrl === 'string'))

  // Defaults: one factory instance per kind, ids = kinds, and every factory
  // model resolves to one of them.
  const defaultIds = DEFAULT_PROVIDERS.map((p) => p.id)
  check('factory provider ids are unique', new Set(defaultIds).size === DEFAULT_PROVIDERS.length)
  check('factory instances keep their kind as id', DEFAULT_PROVIDERS.every((p) => p.id === p.kind))
  check(
    'every factory model resolves to a factory provider',
    DEFAULT_SETTINGS.models.every((m) => DEFAULT_SETTINGS.providers.some((p) => p.id === m.provider)),
  )

  // Migration: settings saved before providers were user-managed carry a
  // record keyed by kind. Validation must upgrade it in place.
  const legacy = {
    version: 1,
    models: [
      { id: 'm1', label: 'GPT', provider: 'openai', apiModel: 'gpt-4o', enabled: true },
    ],
    defaults: {
      temperature: 0.7, topP: 1, maxTokens: 4096, systemPrompt: '',
      stream: true, typingIndicator: true, autoScroll: 'smooth',
      failoverStrategy: 'priority', requestTimeoutMs: 60_000, firstTokenTimeoutMs: 120_000,
    },
    artifacts: { collapsedByDefault: false, autoExpandImages: true, maxPreviewHeight: 420 },
    appearance: { theme: 'dark', fontSize: 15, density: 'cozy', codeTheme: 'auto', reduceMotion: false, enterToSend: true },
    providers: { openai: { apiKey: 'sk-legacy' }, 'openai-compatible': { apiKey: '', baseURL: 'https://api.groq.com/openai/v1' } },
  }
  const migrated = validateSettings(legacy)
  check('legacy record settings still validate', migrated !== null)
  const migratedProviders = migrated?.providers ?? []
  const openaiInstance = migratedProviders.find((p) => p.id === 'openai')
  check('legacy record becomes a provider-instance list', Array.isArray(migratedProviders) && migratedProviders.length === 2)
  check('migrated instances keep kind-as-id and gain label/kind', openaiInstance?.kind === 'openai' && openaiInstance?.label === 'OpenAI')
  check('migrated keys and base URLs survive', openaiInstance?.apiKey === 'sk-legacy' && migratedProviders.find((p) => p.id === 'openai-compatible')?.baseURL === 'https://api.groq.com/openai/v1')
  check('migrated models keep pointing at the same provider', migrated?.models[0]?.provider === 'openai')

  // Store round-trip: add a connection, hang models off it, delete it and
  // confirm the cascade (models gone, pin cleared).
  const snapshot = useSettings.getState().s
  try {
    useSettings.getState().resetSettings()
    check('factory state starts with the supported set', useSettings.getState().s.providers.length === SUPPORTED_PROVIDERS.length)

    const groq = { id: 'prov_test_groq', kind: 'openai-compatible' as const, label: 'Groq', apiKey: '' }
    useSettings.getState().addProvider(groq)
    check('added provider appears in the list', useSettings.getState().s.providers.some((p) => p.id === groq.id))

    useSettings.getState().addProvider(groq)
    check('adding a duplicate id is a no-op', useSettings.getState().s.providers.filter((p) => p.id === groq.id).length === 1)

    const onGroq = (n: string): ModelDef => ({ id: n, label: n, provider: groq.id, apiModel: 'llama-3.3-70b', enabled: true })
    useSettings.getState().addModel(onGroq('groq-a'))
    useSettings.getState().addModel(onGroq('groq-b'))
    useSettings.getState().pin('groq-b')
    // The factory "OpenAI-compatible" instance exists, so a second one is numbered.
    check('labels deduplicate per kind', nextProviderLabel('openai-compatible', useSettings.getState().s.providers) === 'OpenAI-compatible 2')

    const removed = useSettings.getState().removeProvider(groq.id)
    const after = useSettings.getState().s
    check('removing the provider cascade-deletes its models', removed.length === 2 && !after.models.some((m) => m.id === 'groq-a' || m.id === 'groq-b'), removed.join(','))
    check('a pin on a cascade-deleted model is cleared', after.pinnedModelId === undefined)
    check('the provider itself is gone', !after.providers.some((p) => p.id === groq.id))
    check('removing an unknown provider is a no-op', useSettings.getState().removeProvider('nope').length === 0)

    // Label dedup counts same-kind instances, not all instances.
    check('same-kind labels get numbered', nextProviderLabel('openai', [{ id: 'x', kind: 'openai', label: 'OpenAI', apiKey: '' }]) === 'OpenAI 2')
  } finally {
    useSettings.getState().replaceAll(snapshot)
  }

  // SSR: the dialog lists every supported provider, with the simulator
  // marked as key-free.
  const picker = renderToString(createElement(ProviderPickerList, { onPick: () => {} })).replace(/<!-- -->/g, '')
  check('add-provider dialog lists all supported providers', SUPPORTED_PROVIDERS.every((p) => picker.includes(p.label)), picker.slice(0, 120))
  check('the simulator row says no key is needed', picker.includes('no key needed'))
  check('each row offers where to get a key', picker.includes('Get a key'))

  // SSR: ProviderTokenManager renders tokens list and cooldown badges
  const sampleProv: ProviderDef = {
    id: 'prov_multi_test',
    kind: 'openai',
    label: 'OpenAI Team',
    apiKey: 'sk-primary-key',
    apiKeys: [
      { id: 't1', key: 'sk-primary-key', label: 'Primary Key', enabled: true },
      { id: 't2', key: 'sk-backup-key', label: 'Backup Key', enabled: true },
    ],
  }
  const tokenManagerHtml = renderToString(createElement(ProviderTokenManager, { provider: sampleProv })).replace(/<!-- -->/g, '')
  check('token manager renders token count', tokenManagerHtml.includes('API Tokens (2)'), tokenManagerHtml.slice(0, 200))
  check('token manager renders individual token labels', tokenManagerHtml.includes('Primary Key') && tokenManagerHtml.includes('Backup Key'), tokenManagerHtml.slice(0, 300))
  check('token manager renders active badge', tokenManagerHtml.includes('Active'), tokenManagerHtml.slice(0, 300))
}

function testLocalFsPrimitives() {
  console.log('local file system primitives:')

  check('normalizes leading/trailing slashes and backslashes', normalizeFsPath('/src\\lib//util.ts/') === 'src/lib/util.ts')
  check('strips current-dir segments', normalizeFsPath('./src/./app.ts') === 'src/app.ts')
  check('rejects parent-dir traversal', tryNormalizeFsPath('../secret.txt') === null && tryNormalizeFsPath('src/../../etc/passwd') === null)
  check('rejects empty path', tryNormalizeFsPath('   ') === null && tryNormalizeFsPath('/') === null)
  let caughtTraversal = false
  try {
    normalizeFsPath('src/../bad/../../root.ts')
  } catch (err) {
    caughtTraversal = isFsError(err) && err.kind === 'invalid_path'
  }
  check('normalizeFsPath throws FsError on traversal', caughtTraversal)

  check('fsBaseName extracts leaf name', fsBaseName('src/components/App.tsx') === 'App.tsx' && fsBaseName('README.md') === 'README.md')
  check('fsDirName extracts parent directory', fsDirName('src/components/App.tsx') === 'src/components' && fsDirName('README.md') === '')
  check('fsExt extracts lowercase extension', fsExt('src/App.TSX') === 'tsx' && fsExt('Makefile') === '')

  // Extract file actions from markdown fences & file header comments
  const md = [
    'Here are the changes:',
    '```ts:src/math.ts',
    'export const add = (a: number, b: number) => a + b',
    '```',
    '```fs:append:notes/changelog.md',
    '- Added math module',
    '```',
    '```fs:move:src/old.ts -> src/new.ts',
    '```',
    '```fs:delete:tmp/scratch.txt',
    '```',
    '```python',
    '# file: scripts/build.py',
    'print("building")',
    '```',
  ].join('\n')

  const actions = extractFsActions(md)
  check('extracts all 5 file system actions', actions.length === 5, JSON.stringify(actions.map((a) => `${a.op}:${'path' in a ? a.path : a.toPath}`)))
  check('standard lang:path fence becomes write action', actions[0]?.op === 'write' && actions[0]?.path === 'src/math.ts' && actions[0]?.lang === 'ts')
  check('fs:append fence becomes append action', actions[1]?.op === 'append' && actions[1]?.path === 'notes/changelog.md')
  check('fs:move fence becomes move action', actions[2]?.op === 'move' && actions[2]?.fromPath === 'src/old.ts' && actions[2]?.toPath === 'src/new.ts')
  check('fs:delete fence becomes delete action', actions[3]?.op === 'delete' && actions[3]?.path === 'tmp/scratch.txt')
  check('comment header inside untagged fence becomes write action', actions[4]?.op === 'write' && actions[4]?.path === 'scripts/build.py' && actions[4]?.content === 'print("building")')

  const summary = formatFsOpSummary([
    { op: 'create', path: 'src/math.ts', at: 1 },
    { op: 'update', path: 'src/index.ts', version: 2, at: 2 },
    { op: 'delete', path: 'tmp/scratch.txt', at: 3 },
  ])
  check('formatFsOpSummary describes operations', summary === 'created src/math.ts, updated src/index.ts (v2), deleted tmp/scratch.txt', summary)
}

function testLocalFsStore() {
  console.log('local file system store:')
  const fs = useFs.getState()
  fs.clearAll()
  useUI.getState().clearPendingAttachments()

  const created = fs.writeFile('/src/utils/math.ts', 'export const add = (a: number, b: number) => a + b\n', {
    source: { origin: 'model', modelId: 'sim-pro', modelLabel: 'Simulacron Pro' },
    conversationId: 'conv_fs',
    messageId: 'msg_fs_1',
    syncArtifact: true,
  })
  check('writeFile normalizes path and starts at version 1', created.path === 'src/utils/math.ts' && created.version === 1)
  check('readFile returns stored content', useFs.getState().readFile('src/utils/math.ts')?.content === 'export const add = (a: number, b: number) => a + b\n')
  check('syncs file to artifact store with localPath', useArtifacts.getState().byId[fsArtifactId('src/utils/math.ts')]?.localPath === 'src/utils/math.ts')

  const updated = fs.writeFile('src/utils/math.ts', 'export const add = (a: number, b: number) => a + b\nexport const mul = (a: number, b: number) => a * b\n', {
    source: { origin: 'user' },
  })
  check('updating increments version and preserves createdBy', updated.version === 2 && updated.createdBy.origin === 'model' && updated.updatedBy.origin === 'user')

  const appended = fs.appendFile('notes/todo.md', '- Step 1', { source: { origin: 'user' } })
  const appended2 = fs.appendFile('notes/todo.md', '- Step 2', { source: { origin: 'user' } })
  check('appendFile creates then appends with newline', appended.version === 1 && appended2.version === 2 && appended2.content === '- Step 1\n- Step 2')

  const moved = fs.moveFile('notes/todo.md', 'docs/roadmap.md', { origin: 'user' })
  check('moveFile relocates file and removes old path', moved?.path === 'docs/roadmap.md' && !useFs.getState().exists('notes/todo.md') && useFs.getState().exists('docs/roadmap.md'))

  // Directory tree & search
  const tree = buildFsTree(useFs.getState().listFiles())
  check('buildFsTree groups files into sorted directories', tree.dirs.map((d) => d.name).join(',') === 'docs,src', tree.dirs.map((d) => d.name).join(','))
  const hits = useFs.getState().search('mul')
  check('search finds content matches with line numbers', hits.length === 1 && hits[0]?.file.path === 'src/utils/math.ts' && hits[0]?.lines[0]?.line === 2, JSON.stringify(hits))

  // Manifest and agent context formatting
  const manifest = formatFsManifest(useFs.getState().listFiles())
  check('formatFsManifest lists stored files', manifest.includes('src/utils/math.ts') && manifest.includes('docs/roadmap.md'), manifest)
  const ctx = formatFsContextForAgent(useFs.getState().listFiles(), { queryHint: 'update math.ts' })
  check('formatFsContextForAgent includes manifest and file contents', ctx.includes('LOCAL FILE SYSTEM WORKSPACE') && ctx.includes('export const mul'), ctx.slice(0, 200))

  // Attach file to composer
  const attached = useFs.getState().attachFile('src/utils/math.ts')
  check('attachFile queues artifact in pendingAttachmentIds', Boolean(attached) && useUI.getState().pendingAttachmentIds.includes(attached!.id))
  useUI.getState().clearPendingAttachments()

  // Apply agent output batch
  const ops = useFs.getState().applyAgentOutput(
    [
      '```json:config/settings.json',
      '{"port": 8080}',
      '```',
      '```fs:delete:docs/roadmap.md',
      '```',
    ].join('\n'),
    { source: { origin: 'model', modelId: 'sim-pro', modelLabel: 'Simulacron Pro' } },
  )
  check('applyAgentOutput records create and delete ops', ops.length === 2 && ops[0]?.op === 'create' && ops[1]?.op === 'delete', JSON.stringify(ops))
  check('config/settings.json exists in store', useFs.getState().readFile('config/settings.json')?.content === '{"port": 8080}')
  check('docs/roadmap.md was deleted', !useFs.getState().exists('docs/roadmap.md'))

  // Persistence & export bundle validation
  check('persists under slade.fs.v1 in localStorage', (localStorage.getItem('slade.fs.v1') ?? '').includes('config/settings.json'))
  const bundleCheck = exportBundleSchema.safeParse({
    app: 'slade',
    version: 1,
    exportedAt: Date.now(),
    files: useFs.getState().listFiles(),
  })
  check('exportBundleSchema validates files array', bundleCheck.success)

  // Delete directory
  const deletedCount = useFs.getState().deleteDirectory('src')
  check('deleteDirectory removes all files under directory prefix', deletedCount === 1 && !useFs.getState().exists('src/utils/math.ts'))
  useFs.getState().clearAll()
}

async function testAgentLocalFsIntegration() {
  console.log('agent mode ↔ local file system:')
  useFs.getState().clearAll()

  // Seed an existing file in the local file system before starting the agent run.
  useFs.getState().writeFile('src/counter.ts', 'export let count = 0\n', {
    source: { origin: 'user' },
  })

  const systemPromptsSeen: { call: number; systemPrompt: string }[] = []
  let calls = 0

  const fake = await startFakeProvider({
    '/v1beta/chat/completions': (body) => {
      calls++
      const messages = (body.messages as { role: string; content: string }[]) ?? []
      const sys = messages.find((m) => m.role === 'system')?.content ?? ''
      systemPromptsSeen.push({ call: calls, systemPrompt: sys })

      if (calls === 1) {
        return {
          status: 200,
          sse: orTextStream(
            JSON.stringify({
              mode: 'plan',
              reply: 'Two sequential steps: update src/counter.ts, then add unit tests in src/counter.test.ts.',
              subtasks: [
                {
                  title: 'Implement increment/decrement in src/counter.ts',
                  model: '',
                  prompt: 'Update src/counter.ts to export increment() and decrement() functions.',
                },
                {
                  title: 'Write unit tests in src/counter.test.ts',
                  model: '',
                  prompt: 'Write unit tests for src/counter.ts in src/counter.test.ts.',
                },
              ],
            }),
          ),
        }
      }
      if (calls === 2) {
        return {
          status: 200,
          sse: orTextStream(
            'Updated counter module:\n\n```ts:src/counter.ts\nexport let count = 0\nexport const increment = () => ++count\nexport const decrement = () => --count\n```',
          ),
        }
      }
      if (calls === 3) {
        return {
          status: 200,
          sse: orTextStream(
            'Added unit tests:\n\n```ts:src/counter.test.ts\nimport { increment, decrement } from "./counter"\nincrement()\ndecrement()\n```',
          ),
        }
      }
      return {
        status: 200,
        sse: orTextStream(
          'All done — updated `src/counter.ts` (v2) and created `src/counter.test.ts` (v1), plus `README.md`.\n\n```md:README.md\n# Counter\nRun tests for counter.\n```',
        ),
      }
    },
  })

  const settings = useSettings.getState()
  settings.setProvider('openrouter', { apiKey: 'sk-or-fake-key' })
  settings.addModel(openrouterModel(fake.base))
  settings.setModel('mock-pro', { enabled: false })
  settings.setModel('mock-lite', { enabled: false })
  settings.pin('openrouter-test')
  settings.setAgent({ maxParallel: 1, useLocalFs: true })

  try {
    useHealth.getState().markHealthy('openrouter-test')
    freshAgentConversation()
    await sendUserMessage('Add increment/decrement to src/counter.ts and write tests', [])

    const msg = lastAssistant()
    const run = msg.agent!
    check('agent run completed', msg.status === 'complete' && run?.phase === 'complete', `${msg.status}/${run?.phase}`)
    check(
      'planner received existing local FS files in systemPrompt',
      Boolean(systemPromptsSeen[0]?.systemPrompt.includes('src/counter.ts') && systemPromptsSeen[0]?.systemPrompt.includes('export let count = 0')),
    )
    check(
      'step 1 worker received initial src/counter.ts in systemPrompt',
      Boolean(systemPromptsSeen[1]?.systemPrompt.includes('src/counter.ts')),
    )
    check(
      'step 2 worker immediately saw step 1 updated src/counter.ts (v2) in systemPrompt',
      Boolean(systemPromptsSeen[2]?.systemPrompt.includes('increment = () => ++count')),
    )
    check(
      'synthesizer saw both src/counter.ts (v2) and src/counter.test.ts (v1) in systemPrompt',
      Boolean(
        systemPromptsSeen[3]?.systemPrompt.includes('src/counter.ts') &&
          systemPromptsSeen[3]?.systemPrompt.includes('src/counter.test.ts'),
      ),
    )
    check(
      'all worker and synthesizer files are persisted in useFs with expected versions',
      useFs.getState().readFile('src/counter.ts')?.version === 2 &&
        useFs.getState().readFile('src/counter.test.ts')?.version === 1 &&
        useFs.getState().readFile('README.md')?.version === 1,
      JSON.stringify(useFs.getState().listFiles().map((f) => `${f.path}@v${f.version}`)),
    )
    check(
      'agent run recorded fsOps on steps and run summary',
      Boolean(run.fsOps && run.fsOps.length === 3) &&
        run.steps[0]?.fsOps?.[0]?.op === 'update' &&
        run.steps[1]?.fsOps?.[0]?.op === 'create',
      JSON.stringify(run.fsOps),
    )
  } finally {
    settings.removeModel('openrouter-test')
    settings.pin(undefined)
    settings.setModel('mock-pro', { enabled: true, simulate: 'ok' })
    settings.setModel('mock-lite', { enabled: true, simulate: 'ok' })
    settings.setAgent({ maxParallel: 2, useLocalFs: true })
    useHealth.getState().markHealthy('mock-pro')
    useHealth.getState().markHealthy('mock-lite')
    useFs.getState().clearAll()
    fake.close()
  }
}

function testLocalFsUiRenders() {
  console.log('local file system ui renders:')

  const uiInit = useUI.getInitialState() as unknown as Record<string, unknown>
  const fsInit = useFs.getInitialState() as unknown as {
    files: Record<string, FsFile>
    selectedPath: string | null
    filter: string
  }
  const artifactInit = useArtifacts.getInitialState() as unknown as { byId: Record<string, Artifact> }
  const origFiles = fsInit.files
  const origSelected = fsInit.selectedPath
  const origFilter = fsInit.filter
  const origArtifacts = artifactInit.byId

  const sampleFile: FsFile = {
    path: 'src/agent/runner.ts',
    name: 'runner.ts',
    mime: 'text/typescript',
    kind: 'code',
    size: 48,
    encoding: 'utf8',
    content: 'export function runAgent() {\n  return "ok"\n}\n',
    createdAt: Date.now() - 5000,
    updatedAt: Date.now(),
    version: 2,
    createdBy: { origin: 'model', modelId: 'sim-pro', modelLabel: 'Simulacron Pro' },
    updatedBy: { origin: 'model', modelId: 'sim-pro', modelLabel: 'Simulacron Pro' },
  }

  try {
    uiInit.filesOpen = false
    const closed = renderToString(createElement(FilesPanel))
    check('files drawer renders nothing while closed', closed === '', closed.slice(0, 60))

    uiInit.filesOpen = true
    fsInit.files = {}
    fsInit.selectedPath = null
    fsInit.filter = ''
    const empty = renderToString(createElement(FilesPanel)).replace(/<!-- -->/g, '')
    check('files drawer renders empty state when no files exist', empty.includes('No files stored yet') && empty.includes('Local Files'), empty.slice(0, 160))

    fsInit.files = { [sampleFile.path]: sampleFile }
    fsInit.selectedPath = sampleFile.path
    const populated = renderToString(createElement(FilesPanel)).replace(/<!-- -->/g, '')
    check('files drawer renders directory tree and file row', populated.includes('src/') && populated.includes('runner.ts'), populated.slice(0, 240))
    check('files drawer shows file count and version badge', populated.includes('1 file') && populated.includes('v2'))
    check('files drawer renders selected file preview and provenance', populated.includes('src/agent/runner.ts') && populated.includes('Simulacron Pro') && populated.includes('runAgent'))

    fsInit.filter = 'runAgent'
    const searched = renderToString(createElement(FilesPanel)).replace(/<!-- -->/g, '')
    check('files drawer renders content search hits with line numbers', searched.includes(':1') && searched.includes('runAgent'), searched.slice(0, 300))
    fsInit.filter = ''

    // ArtifactCard with localPath
    const art: Artifact = {
      id: 'art_local_1',
      name: 'runner.ts',
      mime: 'text/typescript',
      size: sampleFile.size,
      kind: 'code',
      createdAt: Date.now(),
      provenance: sampleFile.updatedBy,
      localPath: sampleFile.path,
      text: sampleFile.content,
    }
    artifactInit.byId = { ...origArtifacts, [art.id]: art }
    const cardHtml = renderToString(createElement(ArtifactCard, { artifactId: art.id })).replace(/<!-- -->/g, '')
    check('artifact card displays localPath and Open in Files button', cardHtml.includes('src/agent/runner.ts') && cardHtml.includes('Open in Files'), cardHtml.slice(0, 300))

    // MessageBubble with agent.fsOps
    const msgWithFsOps = {
      id: 'msg_fs_ops',
      role: 'assistant' as const,
      conversationId: 'conv_fs_ops',
      content: 'All files have been written.',
      createdAt: Date.now(),
      status: 'complete' as const,
      agent: {
        phase: 'complete' as const,
        orchestratorId: 'sim-pro',
        strategy: 'Write the runner module.',
        steps: [
          {
            id: 'step_1',
            title: 'Create runner.ts',
            prompt: 'Write src/agent/runner.ts',
            modelId: 'sim-pro',
            modelLabel: 'Simulacron Pro',
            status: 'complete' as const,
            result: '```ts:src/agent/runner.ts\nexport function runAgent() {}\n```',
            fsOps: [{ op: 'update' as const, path: 'src/agent/runner.ts', size: 48, version: 2, at: Date.now() }],
          },
        ],
        fsOps: [{ op: 'update' as const, path: 'src/agent/runner.ts', size: 48, version: 2, at: Date.now() }],
      },
    }
    const bubbleHtml = renderToString(createElement(MessageBubble, { message: msgWithFsOps })).replace(/<!-- -->/g, '')
    check('agent plan card renders fsOps summary strip and file chip', bubbleHtml.includes('updated src/agent/runner.ts') && bubbleHtml.includes('src/agent/runner.ts'), bubbleHtml.slice(0, 350))
  } finally {
    uiInit.filesOpen = false
    fsInit.files = origFiles
    fsInit.selectedPath = origSelected
    fsInit.filter = origFilter
    artifactInit.byId = origArtifacts
  }
}

async function testGitLocalFsReadWriteAcross() {
  console.log('git ↔ local file system read/write across:')
  useFs.getState().clearAll()

  const token = 'ghp_' + 'e'.repeat(24)
  const initialMathTs = 'export const add = (a: number, b: number) => a + b\n'
  const initialLegacyTs = 'export const legacy = true\n'
  let postedTree: { base_tree?: string; tree?: { path: string; mode: string; type: string; sha?: string | null; content?: string }[] } | undefined
  let postedCommit: { message?: string; tree?: string; parents?: string[] } | undefined
  let patchedRefSha: string | undefined

  const fakeGh = await startFakeGitHub({
    '/repos/octo/demo': () => ({
      status: 200,
      json: {
        id: 1,
        name: 'demo',
        full_name: 'octo/demo',
        owner: { login: 'octo', avatar_url: '' },
        private: false,
        fork: false,
        archived: false,
        description: 'demo',
        default_branch: 'main',
        html_url: 'https://github.com/octo/demo',
        pushed_at: null,
        updated_at: null,
        language: 'TypeScript',
        stargazers_count: 1,
      },
    }),
    '/repos/octo/demo/branches': () => ({
      status: 200,
      json: [{ name: 'main', commit: { sha: 'head_sha_1' } }],
    }),
    '/repos/octo/demo/git/trees/main': () => ({
      status: 200,
      json: {
        truncated: false,
        tree: [
          { path: 'src/math.ts', mode: '100644', type: 'blob', sha: 'sha_math_1', size: initialMathTs.length },
          { path: 'src/legacy.ts', mode: '100644', type: 'blob', sha: 'sha_leg_1', size: initialLegacyTs.length },
        ],
      },
    }),
    '/repos/octo/demo/contents/src/math.ts': () => ({
      status: 200,
      json: {
        type: 'file',
        name: 'math.ts',
        path: 'src/math.ts',
        sha: 'sha_math_1',
        size: initialMathTs.length,
        encoding: 'base64',
        content: Buffer.from(initialMathTs).toString('base64'),
      },
    }),
    '/repos/octo/demo/contents/src/legacy.ts': () => ({
      status: 200,
      json: {
        type: 'file',
        name: 'legacy.ts',
        path: 'src/legacy.ts',
        sha: 'sha_leg_1',
        size: initialLegacyTs.length,
        encoding: 'base64',
        content: Buffer.from(initialLegacyTs).toString('base64'),
      },
    }),
    '/repos/octo/demo/git/ref/heads/main': () => ({
      status: 200,
      json: { object: { sha: 'head_sha_1' } },
    }),
    '/repos/octo/demo/git/refs/heads/main': (body) => {
      patchedRefSha = String((body as { sha?: string }).sha ?? '')
      return { status: 200, json: { object: { sha: patchedRefSha } } }
    },
    '/repos/octo/demo/git/commits/head_sha_1': () => ({
      status: 200,
      json: { sha: 'head_sha_1', tree: { sha: 'base_tree_sha_1' } },
    }),
    '/repos/octo/demo/git/trees': (body) => {
      postedTree = body as typeof postedTree
      return { status: 201, json: { sha: 'new_tree_sha_2' } }
    },
    '/repos/octo/demo/git/commits': (body) => {
      postedCommit = body as typeof postedCommit
      return {
        status: 201,
        json: { sha: 'new_commit_sha_2', html_url: 'https://github.com/octo/demo/commit/new_commit_sha_2' },
      }
    },
  })

  let agentCalls = 0
  const agentSysPrompts: string[] = []
  const fakeProvider = await startFakeProvider({
    '/v1beta/chat/completions': (body) => {
      agentCalls++
      const messages = (body.messages as { role: string; content: string }[]) ?? []
      const sys = messages.find((m) => m.role === 'system')?.content ?? ''
      agentSysPrompts.push(sys)
      if (agentCalls === 1) {
        return {
          status: 200,
          sse: orTextStream(
            JSON.stringify({
              mode: 'plan',
              reply: 'Update src/math.ts and remove src/legacy.ts.',
              subtasks: [
                {
                  title: 'Add multiply to src/math.ts and delete src/legacy.ts',
                  model: '',
                  prompt: 'Add multiply(a, b) to src/math.ts and remove src/legacy.ts.',
                },
              ],
            }),
          ),
        }
      }
      if (agentCalls === 2) {
        return {
          status: 200,
          sse: orTextStream(
            'Updated `src/math.ts`, added `src/math.test.ts`, and removed `src/legacy.ts`:\n\n```ts:src/math.ts\nexport const add = (a: number, b: number) => a + b\nexport const multiply = (a: number, b: number) => a * b\n```\n\n```ts:src/math.test.ts\nimport { add, multiply } from "./math"\nconsole.log(add(2, 3), multiply(2, 3))\n```\n\n[FS:DELETE src/legacy.ts]',
          ),
        }
      }
      return {
        status: 200,
        sse: orTextStream('Completed updates across `src/math.ts`, `src/math.test.ts`, and deleted `src/legacy.ts`.'),
      }
    },
  })

  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('https://api.github.com')) {
      return realFetch(url.replace('https://api.github.com', fakeGh.base), init)
    }
    return realFetch(url, init)
  }) as typeof fetch

  const settings = useSettings.getState()
  settings.setProvider('openrouter', { apiKey: 'sk-or-fake-key' })
  settings.addModel(openrouterModel(fakeProvider.base))
  settings.setModel('mock-pro', { enabled: false })
  settings.setModel('mock-lite', { enabled: false })
  settings.pin('openrouter-test')
  settings.setAgent({ maxParallel: 1, useLocalFs: true })

  try {
    useGitHub.setState({
      token,
      login: 'octo',
      authStatus: 'authorized',
      scopes: ['repo'],
      repos: [],
      tree: undefined,
      preview: undefined,
    })

    const opened = await useGitHub.getState().openRepo('octo/demo', 'main')
    check('openRepo loads octo/demo@main', opened === true && useGitHub.getState().tree?.entries.length === 2)

    // 1. Pull single file from GitHub into Local FS
    const pulledLegacy = await useGitHub.getState().pullFileToFs('src/legacy.ts', { silent: true })
    check(
      'pullFileToFs stores file in useFs with remote metadata and dirty=false',
      pulledLegacy?.content === initialLegacyTs &&
        pulledLegacy?.remote?.repo === 'octo/demo' &&
        pulledLegacy?.remote?.ref === 'main' &&
        pulledLegacy?.dirty === false,
      JSON.stringify(pulledLegacy),
    )

    // 2. Run an agent turn mentioning src/math.ts (which is in the GitHub tree but not yet in useFs!)
    useHealth.getState().markHealthy('openrouter-test')
    freshAgentConversation()
    await sendUserMessage('Please add multiply to src/math.ts and delete src/legacy.ts', [])

    check(
      'agent automatically pulled mentioned repo file src/math.ts from GitHub before planning',
      Boolean(
        agentSysPrompts[0]?.includes('src/math.ts') &&
          agentSysPrompts[0]?.includes('export const add') &&
          agentSysPrompts[0]?.includes('CONNECTED GITHUB REPOSITORY (octo/demo@main'),
      ),
    )

    const mathAfterAgent = useFs.getState().readFile('src/math.ts')
    const testAfterAgent = useFs.getState().readFile('src/math.test.ts')
    check(
      'agent modified src/math.ts in useFs, preserving remote provenance and marking dirty=true',
      Boolean(
        mathAfterAgent?.content.includes('multiply') &&
          mathAfterAgent?.remote?.repo === 'octo/demo' &&
          mathAfterAgent?.dirty === true,
      ),
      JSON.stringify(mathAfterAgent),
    )
    check(
      'agent created new file src/math.test.ts in useFs with dirty=true',
      Boolean(testAfterAgent?.content.includes('multiply(2, 3)') && testAfterAgent?.dirty === true),
    )
    check(
      'agent deleted src/legacy.ts in useFs and recorded it in deletedRemotes for Git commit',
      useFs.getState().readFile('src/legacy.ts') === undefined &&
        useFs.getState().deletedRemotes['src/legacy.ts']?.repo === 'octo/demo',
      JSON.stringify(useFs.getState().deletedRemotes),
    )

    // 3. Commit local FS changes (modified src/math.ts, new src/math.test.ts, deleted src/legacy.ts) to GitHub!
    const commitRes = await useGitHub.getState().commitFsToGitHub({
      message: 'Add multiply, unit tests, and remove legacy module',
    })
    check(
      'commitFsToGitHub succeeds and returns commit SHA and URL',
      commitRes?.commitSha === 'new_commit_sha_2' && commitRes?.htmlUrl.includes('new_commit_sha_2'),
      JSON.stringify(commitRes),
    )
    check(
      'Git Data tree payload included updated src/math.ts, created src/math.test.ts, and deleted src/legacy.ts (sha: null)',
      Boolean(
        postedTree?.base_tree === 'base_tree_sha_1' &&
          postedTree?.tree?.some((e) => e.path === 'src/math.ts' && e.content?.includes('multiply')) &&
          postedTree?.tree?.some((e) => e.path === 'src/math.test.ts' && e.content?.includes('multiply(2, 3)')) &&
          postedTree?.tree?.some((e) => e.path === 'src/legacy.ts' && e.sha === null),
      ),
      JSON.stringify(postedTree),
    )
    check(
      'Git commit referenced base head SHA and updated branch ref',
      postedCommit?.parents?.[0] === 'head_sha_1' && patchedRefSha === 'new_commit_sha_2',
      JSON.stringify({ postedCommit, patchedRefSha }),
    )
    check(
      'after commitFsToGitHub, local files are marked dirty=false with remote metadata and deletedRemotes is cleared',
      useFs.getState().readFile('src/math.ts')?.dirty === false &&
        useFs.getState().readFile('src/math.test.ts')?.dirty === false &&
        useFs.getState().readFile('src/math.test.ts')?.remote?.repo === 'octo/demo' &&
        Object.keys(useFs.getState().deletedRemotes).length === 0,
    )
  } finally {
    globalThis.fetch = realFetch
    settings.removeModel('openrouter-test')
    settings.pin(undefined)
    settings.setModel('mock-pro', { enabled: true, simulate: 'ok' })
    settings.setModel('mock-lite', { enabled: true, simulate: 'ok' })
    settings.setAgent({ maxParallel: 2, useLocalFs: true })
    useHealth.getState().markHealthy('mock-pro')
    useHealth.getState().markHealthy('mock-lite')
    useFs.getState().clearAll()
    useGitHub.getState().signOut()
    fakeGh.close()
    fakeProvider.close()
  }
}

function testInlineThoughtsRendering() {
  console.log('inline expandable thoughts UI rendering:')
  const settingsInit = useSettings.getInitialState() as unknown as { s: Settings }
  const origSettings = settingsInit.s

  const msgWithReasoning = {
    id: 'msg_reasoning_1',
    role: 'assistant' as const,
    conversationId: 'conv_thoughts',
    content: 'Here is the final answer.',
    reasoning: 'First consider step A, then analyze edge cases in step B.',
    createdAt: Date.now(),
    status: 'complete' as const,
    modelId: 'mock-pro',
  }

  // 1. Assistant message with reasoning renders .thought-block
  const html = renderToString(createElement(MessageBubble, { message: msgWithReasoning })).replace(/<!-- -->/g, '')
  check('thought block renders into assistant message', html.includes('thought-block') && html.includes('Thought process'), html.slice(0, 300))
  check('thought block calculates word count badge', html.includes('11 words'), html.slice(0, 400))

  // 1b. Streaming message renders open thought block with live content
  const streamingMsg = {
    ...msgWithReasoning,
    status: 'streaming' as const,
    content: '',
  }
  const streamHtml = renderToString(createElement(MessageBubble, { message: streamingMsg })).replace(/<!-- -->/g, '')
  check('streaming message renders open thought body with reasoning text', streamHtml.includes('thought-block') && streamHtml.includes('streaming') && streamHtml.includes('First consider step A'), streamHtml.slice(0, 400))

  // 2. Disabling showThoughts on the model suppresses the thought block
  settingsInit.s = {
    ...origSettings,
    models: origSettings.models.map((m) => (m.id === 'mock-pro' ? { ...m, showThoughts: false } : m)),
  }
  const htmlDisabled = renderToString(createElement(MessageBubble, { message: msgWithReasoning })).replace(/<!-- -->/g, '')
  check('disabled model showThoughts suppresses thought block', !htmlDisabled.includes('thought-block'), htmlDisabled.slice(0, 300))
  settingsInit.s = origSettings

  // 3. Agent plan card renders planning reasoning and worker step reasoning
  const msgWithAgentThoughts = {
    id: 'msg_agent_thoughts',
    role: 'assistant' as const,
    conversationId: 'conv_agent_thoughts',
    content: 'All tasks completed successfully.',
    createdAt: Date.now(),
    status: 'complete' as const,
    modelId: 'mock-pro',
    agent: {
      phase: 'complete' as const,
      orchestratorModelId: 'mock-pro',
      strategy: 'Divide into frontend and backend tasks',
      planningReasoning: 'Decomposing task requirements into modular subcomponents',
      steps: [
        {
          id: 'step_1',
          title: 'Implement component',
          prompt: 'Write component',
          modelId: 'mock-pro',
          modelLabel: 'Simulacron Pro',
          status: 'complete' as const,
          result: 'export function Widget() { return null }',
          reasoning: 'Analyzing state requirements and rendering logic',
        },
      ],
    },
  }

  // With expandStepResults enabled, the step body and its thought process block are expanded
  settingsInit.s = {
    ...origSettings,
    agent: {
      ...origSettings.agent,
      expandStepResults: true,
    },
  }
  const agentHtml = renderToString(createElement(MessageBubble, { message: msgWithAgentThoughts })).replace(/<!-- -->/g, '')
  check('agent plan card renders planning reasoning block', agentHtml.includes('Planning reasoning') && agentHtml.includes('6 words'), agentHtml.slice(0, 500))
  check('agent step renders worker thought process block', agentHtml.includes('Simulacron Pro thought process'), agentHtml.slice(0, 600))
  settingsInit.s = origSettings
}

async function main() {
  testClassify()
  testErrorDetail()
  await testMockStream()
  await testOpenRouter()
  await testGoogleAgainstFakeProvider()
  await testFailedTurnExplainsItself()
  await testFailover()
  await testChainVisibility()
  await testOpenRouterFailover()
  await testMultiTokenRotationAndCooldowns()
  await testReasoningStreams()
  await testReasoningBudgetRetry()
  await testAgentReasoningBudget()
  await testStop()
  testOrchestratorPrompt()
  testPlannerParsing()
  testWorkerResolution()
  await testAgentMode()
  testRepoIdentifiers()
  await testGitHubClient()
  await testGitHubErrors()
  await testGitHubRelay()
  await testDeviceFlow()
  testPublishPayloads()
  await testPublishFlow()
  await testRepoContextEndToEnd()
  await testGitHubStoreAgainstFakeApi()
  testGitHubStore()
  testGitHubUiRenders()
  testModelPicker()
  testProviderManagement()
  testLocalFsPrimitives()
  testLocalFsStore()
  await testAgentLocalFsIntegration()
  testLocalFsUiRenders()
  await testGitLocalFsReadWriteAcross()
  testInlineThoughtsRendering()
  console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} SMOKE TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
