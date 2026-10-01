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
import { firstActiveId, hydrateConversations, MAX_TITLE_LENGTH, normalizeTitle, useChat } from '../src/store/chat'
import { cooldownMsFor, useHealth } from '../src/store/health'
import { isGenerating, sendUserMessage, stopGeneration } from '../src/engine/send'
import { classifyHttp } from '../src/providers/base'
import type { ProviderError } from '../src/providers/base'
import { mockAdapter } from '../src/providers/mock'
import {
  commitTree,
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
import { createFsArchive, readFsArchive } from '../src/lib/fs-archive'
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
import {
  ANSWERS_MARKER,
  ASK_MARKER,
  activeAgentQuestion,
  answerAgentQuestion,
  expirePendingAgentQuestions,
  parsePlannerReply,
  planSystemPrompt,
  resolveWorkerModel,
  skipAgentQuestion,
} from '../src/engine/agent'
import {
  MAX_ASK_REFUSALS,
  MAX_OPTIONS_PER_QUESTION,
  MAX_QUESTIONS_PER_ROUND,
  formatAnswersForModel,
  formatDecisionsForModel,
  formatQuestionsForModel,
  nextPendingQuestion,
  normalizeQuestions,
  questionProgress,
  questionsResolved,
  resolveAnswer,
} from '../src/lib/questions'
import { CODING_AGENT_ORCHESTRATOR_PROMPT } from '../src/engine/orchestratorPrompt'
import { z } from 'zod'
import { conversationSchema, exportBundleSchema, roadmapReportSchema } from '../src/lib/schemas'
import {
  buildRoadmapReport,
  describeRoadmapReport,
  findRoadmapBlobs,
  isRoadmapPath,
  parseRoadmap,
  snapshotRoadmapFiles,
  tickFirstOpenStep,
} from '../src/lib/roadmap'
import type {
  AgentQuestion,
  AgentRun,
  AgentTimelineItem,
  Artifact,
  Conversation,
  FsFile,
  GitHubActionArtifact,
  Message,
  RoadmapReport,
} from '../src/types'
// The browser build of react-dom/server avoids the `stream` require that the
// node build does, which esbuild cannot bundled for ESM.
import { renderToString } from 'react-dom/server.browser'
import { createElement } from 'react'
import { GitHubPanel } from '../src/components/github/GitHubPanel'
import {
  GitHubActionCard,
  GitHubActionGroup,
  GitHubActionGroupItem,
  GitHubActionItem,
} from '../src/components/github/GitHubActivity'
import { buildPanelItems, sessionGitHubActions, usePanelHasContent } from '../src/components/chat/panel'
import { ChatView } from '../src/components/chat/ChatView'
import {
  useGitHubActivity,
  logGitHubAction,
  logGitHubActionDone,
  finishGitHubAction,
  type GitHubActionEntry,
} from '../src/store/githubActivity'
import { appendAgentThought } from '../src/store/agentTimeline'
import {
  describeGitHubCall,
  foldActionRuns,
  githubActionTitle,
  GITHUB_ACTION_TITLE,
  GITHUB_GROUP_THRESHOLD,
  summarizeGitHubGroup,
} from '../src/lib/github-actions'
import { onGitHubCall } from '../src/lib/github'
import { FilesPanel } from '../src/components/fs/FilesPanel'
import { ArtifactCard } from '../src/components/artifacts/ArtifactCard'
import { MessageBubble } from '../src/components/chat/MessageBubble'
import { AgentQuestions } from '../src/components/chat/AgentQuestions'
import { RoadmapTimeline } from '../src/components/chat/RoadmapTimeline'
import { Toasts } from '../src/components/common/Toasts'
import { archiveWithUndo, unarchiveWithToast } from '../src/components/layout/ConversationMenu'
import { Header } from '../src/components/layout/Header'
import { Sidebar } from '../src/components/layout/Sidebar'
import { MENU_GAP, MENU_MARGIN, placeMenu, type MenuAnchor } from '../src/lib/menuPlacement'
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

/**
 * The standalone GitHub actions a panel holds, oldest first — whether each one
 * is a row of its own or folded into a group. Assertions about "is this call in
 * the panel" go through here, so they cannot go vacuous when a streak folds.
 */
const panelActions = (items: ReturnType<typeof buildPanelItems>): GitHubActionEntry[] =>
  items.flatMap((item) => (item.kind === 'github' ? [item.entry] : item.kind === 'github-group' ? item.entries : []))

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
  // Collapse all whitespace so the prose checks survive line-wrapping in the
  // prompt source: long sentences are wrapped across physical lines, so exact
  // substring matching against the raw string would fail on a newline.
  const P = CODING_AGENT_ORCHESTRATOR_PROMPT.replace(/\s+/g, ' ').trim()
  check('uses the requested lead-engineer role', P.includes('lead software-engineering orchestrator'))
  check('is explicit about its runtime capability limits (no shell/git/test runner)', P.includes('NO shell, NO terminal, NO Git client, and NO test/build runner'))
  check('forbids fabricating tool results (provenance of claims)', P.includes('invent file contents, test results, build outcomes, or Git operations'))
  check('includes the full development lifecycle', P.includes('UNDERSTAND ↓ (inspect context) PLAN ↓ (decompose) DELEGATE'))
  check('includes the no-false-completion quality gate', P.includes('Never report "Done" unless all relevant acceptance criteria have been verified'))
  check('includes the required final-report sections', ['IMPLEMENTED', 'FILES CHANGED', 'TESTING', 'ARCHITECTURE', 'DOCUMENTATION', 'REMAINING', 'STATUS'].every((section) => P.includes(section)))
  check('includes the final orchestrator responsibility', P.includes('the work is verified and complete'))

  // Completion report: a plain-language summary first, then only the issues
  // the user must know about, then the detail — and the roadmap rules.
  const reportSpec = P.slice(P.indexOf('31. FINAL REPORT'))
  const at = ['SUMMARY', 'ISSUES', 'IMPLEMENTED', 'FILES CHANGED', 'TESTING', 'ARCHITECTURE', 'DOCUMENTATION', 'ROADMAP', 'REMAINING', 'STATUS'].map(
    (h) => reportSpec.indexOf(h),
  )
  check(
    'final report leads with SUMMARY, then ISSUES, and keeps the detail sections in order',
    at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1]!)),
    JSON.stringify(at),
  )
  check(
    'ISSUES is reserved for real problems and names what the user must know',
    reportSpec.includes('Include ISSUES only when there is something real to report') &&
      reportSpec.includes('failed, skipped, or unrunnable tests and builds') &&
      reportSpec.includes('manual actions the user must take'),
  )
  check(
    'ROADMAP section only appears when a roadmap was used',
    reportSpec.includes('only when a roadmap or milestone file was used'),
  )
  check(
    'orchestrator owns the roadmap and may only mark verified work done',
    P.includes('You own the roadmap.') &&
      P.includes('Do not mark incomplete work as complete.') &&
      P.includes('Mark a step done only when its acceptance criteria are verified'),
  )
  check(
    'roadmap notation Slade parses is spelled out',
    ['[x] the step is complete', '[~] the step is in progress', '[ ] the step is not started'].every((n) => P.includes(n)),
  )
  check(
    'model is told Slade renders the timeline itself, and not to draw its own',
    P.includes('renders the previous, current, and next step') &&
      P.includes('do not draw your own timeline or progress bar'),
  )
  check(
    'the model is told never to rewrite a roadmap it only saw truncated',
    P.includes('If the roadmap is shown to you truncated, never rewrite it.'),
  )
  check('quality gate covers the roadmap and the issues report', P.includes('[ ] Everything the user must be made aware of is reported under ISSUES'))
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

  // A direct answer may carry code blocks and file blocks of its own: their fences must survive.
  const fenced = `Here is the change:\n\n${FENCE}ts:src/a.ts\nexport const a = 1\n${FENCE}\n`
  const withCode = parsePlannerReply(JSON.stringify({ mode: 'answer', answer: fenced }))
  check('a direct answer keeps the code fences inside it', withCode?.mode === 'answer' && withCode.answer === fenced, JSON.stringify(withCode))
  check(
    '…so a file block in a direct answer still becomes a file',
    withCode?.mode === 'answer' && extractFsActions(withCode.answer).some((a) => a.op === 'write' && a.path === 'src/a.ts'),
  )
  const wrapped = parsePlannerReply(`Sure!\n${FENCE}json\n${JSON.stringify({ mode: 'answer', answer: 'plain' })}\n${FENCE}`)
  check('a fence wrapped around the JSON is still tolerated', wrapped?.mode === 'answer' && wrapped.answer === 'plain')
  const trailing = parsePlannerReply(`${JSON.stringify({ mode: 'answer', answer: 'ok' })}\n\n${FENCE}ts\nfunction f() { return { a: 1 } }\n${FENCE}`)
  check('JSON followed by a code block with braces of its own still parses', trailing?.mode === 'answer' && trailing.answer === 'ok', JSON.stringify(trailing))
  check('prose without JSON → undefined', parsePlannerReply('I would start by researching the topic.') === undefined)
  check('wrong shape → undefined', parsePlannerReply('{"mode":"surprise"}') === undefined)
  check('empty subtasks → undefined', parsePlannerReply('{"mode":"plan","subtasks":[]}') === undefined)

  // Near-JSON: what a *long* planner reply drifts into. Real models "write" a
  // multi-line worker prompt as a real multi-line string value, paste a regex
  // that lost its doubled backslash, and leave a trailing comma behind. Each is
  // a JSON.parse error, and each is worth repairing rather than spending
  // another orchestrator round-trip to reformat a plan that is already complete.
  const near = parsePlannerReply(
    '{"mode":"plan","reply":"Two steps.",' +
      '"subtasks":[{"title":"Build it","model":"","prompt":"ROLE: engineer\nOBJECTIVE: split on /\\s+/ and ship src/a.ts",},]}',
  )
  const nearPrompt = near?.mode === 'plan' ? near.subtasks[0]!.prompt : ''
  check('a raw newline inside a string value still plans', near?.mode === 'plan', JSON.stringify(near))
  check(
    '…and the worker prompt keeps the line structure the model wrote',
    nearPrompt === 'ROLE: engineer\nOBJECTIVE: split on /\\s+/ and ship src/a.ts',
    JSON.stringify(nearPrompt),
  )
  check(
    '…and a trailing comma is dropped instead of failing the plan',
    parsePlannerReply('{"mode":"answer","answer":"ok",}')?.mode === 'answer',
  )
  check(
    'a brace in the prose before the JSON does not hide the plan',
    parsePlannerReply('Plan {see below}:\n{"mode":"answer","answer":"ok"}')?.mode === 'answer',
  )
  check(
    'a truncated plan is still refused, never salvaged into half a plan',
    parsePlannerReply('{"mode":"plan","reply":"r","subtasks":[{"title":"t","prompt":"cut off') === undefined,
  )
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

/**
 * The planner's near-JSON path, end to end. A first plan reply in the shape a
 * real model actually sends it — the worker prompt typed as a real multi-line
 * string, a regex that lost its doubled backslash, a trailing comma — must plan
 * the run on that first call. Every miss sends the user "First plan was
 * malformed — asking the orchestrator to reformat…" and spends an extra
 * planning round-trip on a plan the model had already written out in full.
 */
async function testPlannerNearJsonRun() {
  console.log('planner near-JSON (scripted models):')
  const script = { plans: [] as string[], workers: [] as string[], synths: [] as string[] }
  const primary = 'ROLE: engineer\nOBJECTIVE: add splitWords() to src/split.ts\nCONSTRAINTS: keep /\\s+/ handling'
  const second = 'Review src/split.ts\nand list what to fix'

  await withScriptedAgent(script, async ({ seen }) => {
    script.plans.push(
      '{"mode":"plan","reply":"Implement, then review.",' +
        `"subtasks":[{"title":"Implement the splitter","model":"","prompt":"${primary}"},` +
        `{"title":"Review the splitter","model":"","prompt":"${second}",},]}`,
    )
    script.workers.push('Done: splitWords() added.', 'Reviewed — nothing to fix.')
    script.synths.push('SUMMARY\nAdded the splitter.\n\nSTATUS\nCOMPLETE')
    freshAgentConversation()
    await sendUserMessage('add a word splitter helper', [])

    const msg = lastAssistant()
    const run = msg.agent
    const planCalls = seen.filter((s) => s.kind === 'plan').length
    check('run completed', msg.status === 'complete' && run?.phase === 'complete', `${msg.status}/${run?.phase}: ${msg.error ?? ''}`)
    check('the near-JSON plan was accepted on the first call', planCalls === 1, `${planCalls} planning calls`)
    check('…so the card never says the plan was malformed', !run?.note, String(run?.note))
    check(
      '…and both subtasks ran',
      run?.steps.length === 2 && run.steps.every((s) => s.status === 'complete'),
      JSON.stringify(run?.steps.map((s) => s.status)),
    )
    check(
      'the worker received the multi-line prompt, regex backslash and all',
      run?.steps[0]?.prompt === primary,
      JSON.stringify(run?.steps[0]?.prompt),
    )
  })
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

/**
 * Local Files cannot represent a file mode, so `commitTree` has to read the
 * modes off the branch — otherwise every commit rewrites the paths it touches as
 * 100644 and silently clears the executable bit (and would corrupt a symlink by
 * writing file content under mode 120000).
 */
async function testCommitTreeModes() {
  console.log('git commit tree modes:')
  const sha = 'ghp_' + 'd'.repeat(24)
  let posted: { base_tree?: string; tree?: { path: string; mode?: string; type?: string; sha?: string | null }[] } | undefined
  const fake = await startFakeGitHub({
    '/repos/octo/demo/git/ref/heads/main': () => ({ status: 200, json: { object: { sha: 'head1' } } }),
    '/repos/octo/demo/git/commits/head1': () => ({ status: 200, json: { sha: 'head1', tree: { sha: 'tree1' } } }),
    '/repos/octo/demo/git/trees/tree1': () => ({
      status: 200,
      json: {
        truncated: false,
        tree: [
          { path: 'bin/tool.sh', mode: '100755', type: 'blob', sha: 'sh1', size: 10 },
          { path: 'link.sh', mode: '120000', type: 'blob', sha: 'ln1', size: 9 },
          { path: 'plain.txt', mode: '100644', type: 'blob', sha: 'p1', size: 6 },
          { path: 'vendor/lib', mode: '160000', type: 'commit', sha: 'sub1' },
        ],
      },
    }),
    '/repos/octo/demo/git/trees': (body) => {
      posted = body as typeof posted
      return { status: 201, json: { sha: 'tree2', tree: [] } }
    },
    '/repos/octo/demo/git/commits': () => ({
      status: 201,
      json: { sha: 'commit2', html_url: 'https://github.com/octo/demo/commit/commit2' },
    }),
    '/repos/octo/demo/git/refs/heads/main': () => ({ status: 200, json: { object: { sha: 'commit2' } } }),
  })
  try {
    const res = await commitTree('octo/demo', {
      token: sha,
      baseUrl: fake.base,
      branch: 'main',
      message: 'content edits only',
      entries: [
        { path: 'bin/tool.sh', content: '#!/bin/sh\necho v2\n' },
        { path: 'link.sh', content: 'this used to be a symlink\n' },
        { path: 'plain.txt', content: 'plain v2\n' },
        { path: 'added.txt', content: 'brand new\n' },
        { path: 'gone.txt', deleted: true },
      ],
    })
    const modeOf = (path: string) => posted?.tree?.find((e) => e.path === path)?.mode
    check('an edited executable keeps 100755', modeOf('bin/tool.sh') === '100755', String(modeOf('bin/tool.sh')))
    check('an edited plain file stays 100644', modeOf('plain.txt') === '100644', String(modeOf('plain.txt')))
    check('a new file defaults to 100644', modeOf('added.txt') === '100644', String(modeOf('added.txt')))
    check('a symlink mode is not carried onto file content', modeOf('link.sh') === '100644', String(modeOf('link.sh')))
    check('a delete is still sha: null', posted?.tree?.find((e) => e.path === 'gone.txt')?.sha === null)
    check(
      'the base tree is read for its modes',
      fake.seen.filter((r) => r.url.startsWith('/repos/octo/demo/git/trees/tree1')).length === 1,
      JSON.stringify(fake.seen.map((r) => r.url)),
    )
    check('the commit lands on the branch', res.commitSha === 'commit2' && res.branch === 'main', JSON.stringify(res))

    const cut = fake.seen.length
    await commitTree('octo/demo', {
      token: sha,
      baseUrl: fake.base,
      branch: 'main',
      message: 'explicit mode',
      entries: [{ path: 'added.sh', content: '#!/bin/sh\n', mode: '100755' }],
    })
    check(
      'an explicit mode wins, without a mode lookup',
      modeOf('added.sh') === '100755' &&
        !fake.seen.slice(cut).some((r) => r.url.startsWith('/repos/octo/demo/git/trees/tree1')),
      String(modeOf('added.sh')),
    )
  } finally {
    fake.close()
  }
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
/**
 * GitHub action cards: one card per API call, titled and sub-titled, never
 * expandable. Covers the vocabulary, the live log (through a fake
 * api.github.com), the non-REST actions, and the rendered card. (A streak of
 * more than two cards folds into an expandable group — see
 * `testGitHubActionGroups`.)
 */
async function testGitHubActionCards() {
  console.log('github action cards:')

  /* ---- the vocabulary every card title comes from ---- */
  const REQUIRED: [keyof typeof GITHUB_ACTION_TITLE, string][] = [
    ['get-file', 'Get File Contents'],
    ['delete-file', 'Deleted File'],
    ['create-file', 'Created File'],
    ['create-branch', 'Created Branch'],
    ['delete-branch', 'Removed Branch'],
    ['create-pr', 'Create Pull-Request'],
    ['merge-pr', 'Merge Pull-Request'],
    ['get-branch', 'Fetching Branch'],
    ['search-code', 'Performed Code Search'],
    ['clone-repo', 'Cloning Repository'],
    ['list-repos', 'Refreshing Repository List'],
    ['sign-in', 'Signed in using OAuth'],
    ['sign-out', 'Signed out'],
    ['test-token', 'Testing API Token'],
  ]
  for (const [kind, phrase] of REQUIRED) {
    check(`vocabulary covers "${phrase}"`, GITHUB_ACTION_TITLE[kind] === phrase, String(GITHUB_ACTION_TITLE[kind]))
    check(`"${phrase}" is prefixed on the card`, githubActionTitle(kind) === `GitHub Action: ${phrase}`)
  }
  check(
    'no action kind is titled with an empty phrase',
    Object.values(GITHUB_ACTION_TITLE).every((t) => t.trim().length > 0),
    JSON.stringify(Object.entries(GITHUB_ACTION_TITLE).filter(([, t]) => !t.trim())),
  )

  const describe = (call: { method: string; path: string; query?: Record<string, string>; body?: unknown }) =>
    describeGitHubCall(call)
  const read = describe({ method: 'GET', path: '/repos/octo/demo/contents/src/lib/util.ts', query: { ref: 'main' } })
  check('a contents read reads as Get File Contents', read.title === 'GitHub Action: Get File Contents', read.title)
  check('its sub-title is the path', read.subject === '/src/lib/util.ts', read.subject)
  check('the card remembers the repo and ref', read.repo === 'octo/demo' && read.ref === 'main', `${read.repo}@${read.ref}`)
  const created = describe({ method: 'PUT', path: '/repos/octo/demo/contents/docs/a.md', body: { message: 'add', content: 'eA==' } })
  check('a PUT without a sha is a creation', created.title === 'GitHub Action: Created File', created.title)
  const updated = describe({ method: 'PUT', path: '/repos/octo/demo/contents/docs/a.md', body: { message: 'upd', sha: 'b1' } })
  check('a PUT with a sha is an update', updated.title === 'GitHub Action: Updated File', updated.title)
  check('a file body never leaks into the card', !JSON.stringify(updated).includes('eA=='), JSON.stringify(updated))
  const branch = describe({ method: 'POST', path: '/repos/octo/demo/git/refs', body: { ref: 'refs/heads/slade/new', sha: 'abc' } })
  check('creating a ref reads as Created Branch', branch.title === 'GitHub Action: Created Branch' && branch.subject === 'slade/new', `${branch.title} ${branch.subject}`)
  const removed = describe({ method: 'DELETE', path: '/repos/octo/demo/git/refs/heads/slade%2Fold' })
  check('deleting a ref reads as Removed Branch', removed.title === 'GitHub Action: Removed Branch' && removed.subject === 'slade/old', `${removed.title} ${removed.subject}`)
  const moved = describe({ method: 'PATCH', path: '/repos/octo/demo/git/refs/heads/main', body: { sha: 'c0ffee1234' } })
  check('a ref patch reads as moving the branch', moved.title === 'GitHub Action: Moved Branch' && moved.subject === 'main → c0ffee1', moved.subject)
  const pr = describe({ method: 'POST', path: '/repos/octo/demo/pulls', body: { title: 'Add the thing', head: 'a', base: 'main' } })
  check('opening a pull request is titled', pr.title === 'GitHub Action: Create Pull-Request' && pr.subject === 'Add the thing', `${pr.title} ${pr.subject}`)
  const merge = describe({ method: 'POST', path: '/repos/octo/demo/pulls/42/merge', body: {} })
  check('merging a pull request is titled', merge.title === 'GitHub Action: Merge Pull-Request' && merge.subject === '#42', `${merge.title} ${merge.subject}`)
  const search = describe({ method: 'GET', path: '/search/code', query: { q: 'answer repo:octo/demo' } })
  check('a code search is titled with its query', search.title === 'GitHub Action: Performed Code Search' && search.subject === 'answer repo:octo/demo', search.subject)
  const commit = describe({ method: 'POST', path: '/repos/octo/demo/git/commits', body: { message: 'Apply agent changes (3 files)\n\nbody' } })
  check('a commit is titled with its subject line', commit.subject === 'Apply agent changes (3 files)', commit.subject)
  const gist = describe({ method: 'POST', path: '/gists', body: { description: 'Answer', files: { 'answer.md': { content: 'x' } } } })
  check('a gist is titled with its description', gist.title === 'GitHub Action: Created Gist' && gist.subject === 'Answer', `${gist.title} ${gist.subject}`)
  const issue = describe({ method: 'POST', path: '/repos/octo/demo/issues', body: { title: 'Bug: cards' } })
  check('an issue is titled with its own action', issue.title === 'GitHub Action: Created Issue' && issue.subject === 'Bug: cards', `${issue.title} ${issue.subject}`)
  const blob = describe({ method: 'POST', path: '/repos/octo/demo/git/blobs', body: { content: 'AAEC', encoding: 'base64' } })
  check('a blob upload is titled', blob.title === 'GitHub Action: Uploaded File Blob', blob.title)
  const budget = describe({ method: 'GET', path: '/rate_limit' })
  check('the rate-limit probe is titled', budget.title === 'GitHub Action: Checking API Budget', budget.title)
  const listing = describe({ method: 'GET', path: '/repos/octo/demo/contents/docs' })
  check('a directory read names the directory', listing.subject === '/docs', listing.subject)
  const unknown = describe({ method: 'GET', path: '/emojis' })
  check('an unmapped call still gets a card', unknown.title === 'GitHub Action: Performed API Request' && unknown.subject === '/emojis', `${unknown.title} ${unknown.subject}`)

  /* ---- the log, driven through the real REST client ---- */
  const token = 'ghp_' + 'c'.repeat(24)
  const utilText = 'export const answer = 42\n'
  const fake = await startFakeGitHub({
    '/user': () => ({ status: 200, json: { id: 7, login: 'octo', name: 'Octo', avatar_url: 'https://a.example/o.png', html_url: 'https://github.com/octo' } }),
    '/user/repos': () => ({ status: 200, json: [{ id: 1, name: 'demo', full_name: 'octo/demo', owner: { login: 'octo', avatar_url: '' }, private: false, fork: false, archived: false, description: 'demo', default_branch: 'main', html_url: 'https://github.com/octo/demo', pushed_at: null, updated_at: null, language: 'TypeScript', stargazers_count: 1 }] }),
    '/repos/octo/demo/git/trees/main': () => ({ status: 200, json: { truncated: false, tree: [{ path: 'src/lib/util.ts', mode: '100644', type: 'blob', sha: 'b1', size: utilText.length }] } }),
    '/repos/octo/demo/contents/src/lib/util.ts': () => ({ status: 200, json: { type: 'file', name: 'util.ts', path: 'src/lib/util.ts', sha: 'b1', size: utilText.length, encoding: 'base64', content: Buffer.from(utilText).toString('base64') } }),
    '/repos/octo/demo/contents/docs/answer.md': (body, meta) =>
      meta.method === 'PUT'
        ? { status: 201, json: { content: { path: 'docs/answer.md', sha: 'n1', html_url: 'https://github.com/octo/demo/blob/main/docs/answer.md' }, commit: { sha: 'c0ffee1234', html_url: 'https://github.com/octo/demo/commit/c0ffee1234' } } }
        : { status: 404, json: { message: 'Not Found' } },
    '/repos/octo/demo/branches': () => ({ status: 200, json: [{ name: 'main', commit: { sha: 's1' } }] }),
    '/repos/octo/demo/git/ref/heads/main': () => ({ status: 200, json: { object: { sha: 'c0ffee1234' } } }),
    '/repos/octo/demo/git/commits/c0ffee1234': () => ({ status: 200, json: { sha: 'c0ffee1234', tree: { sha: 'tree-base' } } }),
    // The commit path reads the base tree for its modes before writing one.
    '/repos/octo/demo/git/trees/tree-base': () => ({
      status: 200,
      json: { truncated: false, tree: [{ path: 'docs/roadmap.md', mode: '100644', type: 'blob', sha: 'blob0', size: 12 }] },
    }),
    '/repos/octo/demo/git/trees': () => ({ status: 201, json: { sha: 'tree-new', tree: [{ path: 'docs/answer.md', sha: 'blob1' }] } }),
    '/repos/octo/demo/git/commits': () => ({ status: 201, json: { sha: 'c0ffee9999', html_url: 'https://github.com/octo/demo/commit/c0ffee9999' } }),
    '/repos/octo/demo/git/refs': () => ({ status: 201, json: { ref: 'refs/heads/main', object: { sha: 'c0ffee9999' } } }),
    '/repos/octo/demo': () => ({ status: 200, json: { id: 1, name: 'demo', full_name: 'octo/demo', owner: { login: 'octo', avatar_url: '' }, private: false, fork: false, archived: false, description: 'demo', default_branch: 'main', html_url: 'https://github.com/octo/demo', pushed_at: null, updated_at: null, language: 'TypeScript', stargazers_count: 1 } }),
  })
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return realFetch(url.replace('https://api.github.com', fake.base), init)
  }) as typeof fetch

  const observed: string[] = []
  const off = onGitHubCall((e) => observed.push(`${e.phase}:${e.method}:${e.path}`))
  useGitHubActivity.setState({ entries: [], total: 0, scopes: [], scopeMessages: {} })
  try {
    useGitHub.setState({ token, login: 'octo', authStatus: 'authorized', scopes: ['repo', 'gist'], repos: [], tree: undefined, preview: undefined })

    await useGitHub.getState().loadRepos({ force: true })
    await useGitHub.getState().openRepo('octo/demo')
    await useGitHub.getState().openFile('src/lib/util.ts')
    const published = await useGitHub.getState().publish({
      target: 'file',
      name: 'answer.md',
      text: '# answer',
      repo: 'octo/demo',
      branch: 'main',
      path: 'docs/answer.md',
    })
    check('the file publish went through', published?.label === 'added docs/answer.md', JSON.stringify(published))

    // A multi-file commit goes through the Git Data API, which is five calls —
    // each one gets its own card.
    useFs.getState().writeFile('docs/roadmap.md', '# roadmap\n', { source: { origin: 'user' } })
    await useGitHub.getState().commitFsToGitHub({ paths: ['docs/roadmap.md'], repo: 'octo/demo', branch: 'main', message: 'Apply agent changes (1 file)', silent: true })
    // The branch list and the tree refresh are background calls: let them land.
    await new Promise((r) => setTimeout(r, 120))

    // Cloning files into Local Files is a store action, not one API call, so it
    // logs its own card on top of the reads it performs.
    const pulled = await useGitHub.getState().pullTreeToFs({ paths: ['src/lib/util.ts'], silent: true })
    check('pulling files lands them in Local Files', pulled.length === 1 && pulled[0]?.path === 'src/lib/util.ts', JSON.stringify(pulled.map((f) => f.path)))

    const titles = () => useGitHubActivity.getState().entries.map((e) => `${e.title} ${e.subject}`)
    check('a clone gets its own card', titles().some((t) => t === 'GitHub Action: Cloning Repository 1 of 1 file in Local Files'), JSON.stringify(titles()))
    check('listing repos logs a card', titles().some((t) => t === 'GitHub Action: Refreshing Repository List your repositories'), JSON.stringify(titles()))
    check('opening a repo logs a card', titles().some((t) => t === 'GitHub Action: Fetching Repository octo/demo'), JSON.stringify(titles()))
    check('reading the tree logs a card', titles().some((t) => t.startsWith('GitHub Action: Read Repository Tree')), JSON.stringify(titles()))
    check('reading a file logs it with its path', titles().some((t) => t === 'GitHub Action: Get File Contents /src/lib/util.ts'), JSON.stringify(titles()))
    check('a missing file logs a read that failed', titles().some((t) => t === 'GitHub Action: Get File Contents /docs/answer.md'), JSON.stringify(titles()))
    const failed = useGitHubActivity.getState().entries.find((e) => e.subject === '/docs/answer.md' && e.status === 'error')
    check('the failed read is marked as an error, not hidden', Boolean(failed), JSON.stringify(failed))
    check('a git commit is logged with its message', titles().some((t) => t === 'GitHub Action: Created Commit Apply agent changes (1 file)'), JSON.stringify(titles()))
    check('the commit tree is logged with its file count', titles().some((t) => t === 'GitHub Action: Created Commit Tree 1 file staged'), JSON.stringify(titles()))
    check('the ref move is logged', titles().some((t) => t.startsWith('GitHub Action: Moved Branch main')), JSON.stringify(titles()))
    check('the parent commit read is logged', titles().some((t) => t === 'GitHub Action: Fetching Commit c0ffee1'), JSON.stringify(titles()))
    check('every logged call is closed out', useGitHubActivity.getState().entries.every((e) => e.status !== 'running'), JSON.stringify(useGitHubActivity.getState().entries.map((e) => e.status)))
    check('calls are timed', useGitHubActivity.getState().entries.every((e) => e.elapsedMs != null), JSON.stringify(useGitHubActivity.getState().entries.map((e) => e.elapsedMs)))
    const handLogged = useGitHubActivity
      .getState()
      .entries.filter((e) => e.kind === 'clone-repo' || e.kind === 'sign-in' || e.kind === 'sign-out').length
    check(
      'the log counts every api call once',
      useGitHubActivity.getState().total === fake.seen.length + handLogged,
      `${useGitHubActivity.getState().total} vs ${fake.seen.length}+${handLogged}`,
    )
    check(
      'the observer pairs every start with an end',
      observed.filter((o) => o.startsWith('start:')).length === observed.filter((o) => o.startsWith('end:')).length,
      JSON.stringify(observed.slice(0, 4)),
    )
    const firstLoggedCardId = useGitHubActivity.getState().entries[0]?.id
    for (let i = 0; i < 65; i++) logGitHubActionDone({ kind: 'other', subject: `retained-${i}` })
    check(
      'the activity ledger never prunes cards, even after more than sixty calls',
      useGitHubActivity.getState().entries.length > 60 &&
        Boolean(firstLoggedCardId && useGitHubActivity.getState().entries.some((entry) => entry.id === firstLoggedCardId)),
      String(useGitHubActivity.getState().entries.length),
    )

    // GitHub actions that are not api.github.com calls are logged by hand.
    const signOutLogin = useGitHub.getState().login
    useGitHub.getState().signOut()
    check(
      'signing out logs its own card',
      useGitHubActivity.getState().entries.some((e) => e.title === 'GitHub Action: Signed out' && e.subject === `@${signOutLogin}`),
      JSON.stringify(useGitHubActivity.getState().entries.slice(-2).map((e) => `${e.title} ${e.subject}`)),
    )
    const manual = logGitHubActionDone({ kind: 'sign-in', subject: '@octo' })
    check(
      'a hand-logged card starts finished',
      useGitHubActivity.getState().entries.find((e) => e.id === manual)?.status === 'done',
      manual,
    )
    const openId = logGitHubActionDone({ kind: 'clone-repo', subject: 'octo/demo @ main', repo: 'octo/demo', ref: 'main' })
    finishGitHubAction(openId, { status: 'error', error: 'GitHub unreachable' })
    const errored = useGitHubActivity.getState().entries.find((e) => e.id === openId)
    check('a hand-closed card carries its failure', errored?.status === 'error' && errored.error === 'GitHub unreachable', JSON.stringify(errored))

    /* ---- the rendered card ---- */
    const entry = useGitHubActivity.getState().entries.find((e) => e.kind === 'get-file' && e.subject === '/src/lib/util.ts')
    check('the read card is in the log', Boolean(entry), JSON.stringify(titles()))
    const card = renderToString(createElement(GitHubActionCard, { entry: entry! })).replace(/<!-- -->/g, '')
    check('the card shows the github mark', card.includes('viewBox="0 0 16 16"'), card.slice(0, 160))
    check('the card title is the action', card.includes('GitHub Action: Get File Contents'), card.slice(0, 240))
    check('the card sub-title is the path', card.includes('gh-action-subject') && card.includes('/src/lib/util.ts'), card.slice(0, 320))
    check('the card says which repo it touched', card.includes('octo/demo@main'), card.slice(0, 320))
    check('the card is NOT expandable', !card.includes('aria-expanded') && !card.includes('<button') && !card.includes('chevron'), card.slice(0, 240))
    check('the card is a div, not a disclosure', card.includes('gh-action-card status-done'), card.slice(0, 120))
    check('the activity store has no per-card removal operation', !('remove' in useGitHubActivity.getState()))

    const activityInit = useGitHubActivity.getInitialState() as unknown as {
      entries: ReturnType<typeof useGitHubActivity.getState>['entries']
    }
    // SSR renders from the store's *initial* snapshot, so every render below
    // has to be seeded with the ledger as it stands right now.
    const seed = () => {
      activityInit.entries = useGitHubActivity.getState().entries
    }
    /* ---- the panel: standalone calls are appended to the chat log ---- */

    const now = Date.now()
    const userMessage: Message = {
      id: 'msg_panel_user',
      role: 'user',
      conversationId: 'conv_panel',
      content: 'ship it',
      createdAt: now,
      status: 'complete',
    }
    const assistantMessage: Message = {
      id: 'msg_panel_assistant',
      role: 'assistant',
      conversationId: 'conv_panel',
      content: 'done',
      createdAt: now,
      status: 'complete',
    }
    const sessionEntries = () => sessionGitHubActions(useGitHubActivity.getState().entries)
    const panelItems = () => buildPanelItems([userMessage, assistantMessage], sessionEntries())

    const before = panelItems()
    check(
      'the panel keeps the conversation in order',
      before[0]?.id === 'msg_panel_user' && before[1]?.id === 'msg_panel_assistant',
      JSON.stringify(before.map((i) => i.id)),
    )
    check(
      'every action is appended after the last message, never between messages',
      before.length > 2 && before.slice(2).every((i) => i.kind === 'github' || i.kind === 'github-group'),
      JSON.stringify(before.map((i) => i.kind)),
    )
    check(
      'this many standalone calls are folded into one group, not a screenful of rows',
      sessionEntries().length > 2 && before.length === 3 && before[2]?.kind === 'github-group',
      JSON.stringify(before.map((i) => i.kind)),
    )
    check(
      'the appended cards keep the order the calls happened in',
      JSON.stringify(panelActions(before).map((e) => e.id)) === JSON.stringify(sessionEntries().map((e) => e.id)),
      JSON.stringify(panelActions(before).map((e) => e.id)),
    )
    const lastItem = before[before.length - 1]!
    const newestEntry = panelActions(before).at(-1)
    check(
      'the newest call is the last thing in the panel',
      newestEntry?.id === sessionEntries()[sessionEntries().length - 1]?.id && lastItem.kind === 'github-group',
      JSON.stringify(newestEntry),
    )
    seed()
    const itemHtml = renderToString(createElement(GitHubActionItem, { entry: newestEntry! })).replace(/<!-- -->/g, '')
    check('a panel card renders as a row in the message column', itemHtml.includes('gh-panel-item') && itemHtml.includes('gh-action-card'), itemHtml.slice(0, 200))
    check('…carrying the action and what it touched', itemHtml.includes('GitHub Action:') && itemHtml.includes('<code>'), itemHtml.slice(0, 300))
    check('…and it is still not a button', !itemHtml.includes('<button'), itemHtml.slice(0, 200))

    // In flight: the card is in the panel as it happens, with its status glyph.
    const liveId = logGitHubAction({ kind: 'get-file', subject: '/live.ts', repo: 'octo/demo', ref: 'main' })
    const livePanel = panelItems()
    const liveItem = livePanel[livePanel.length - 1]!
    const liveEntry = panelActions(livePanel).at(-1)
    seed()
    const liveHtml = renderToString(createElement(GitHubActionItem, { entry: liveEntry! })).replace(/<!-- -->/g, '')
    check(
      'a call in flight is appended to the panel, marked running',
      liveEntry?.id === liveId && liveHtml.includes('/live.ts') && liveHtml.includes('gh-action-card status-running'),
      liveHtml.slice(0, 300),
    )
    // …and the folded row it joined says so, without being opened.
    const liveGroupHtml = renderToString(
      createElement(GitHubActionGroupItem, { entries: liveItem.kind === 'github-group' ? liveItem.entries : [] }),
    ).replace(/<!-- -->/g, '')
    check(
      'the folded panel row reports the call in flight on its closed header',
      liveItem.kind === 'github-group' &&
        liveGroupHtml.includes('gh-action-group status-running') &&
        liveGroupHtml.includes('Get File Contents · /live.ts'),
      liveGroupHtml.slice(0, 400),
    )
    finishGitHubAction(liveId, { status: 'done' })

    /* ---- run calls split the thought timeline in-place and are never removable ---- */
    const runMessage: Message = {
      id: 'msg_run_timeline',
      role: 'assistant',
      conversationId: 'conv_run_timeline',
      content: 'The final answer follows.',
      createdAt: now,
      status: 'streaming',
      modelId: 'mock-pro',
      agent: {
        phase: 'synthesizing',
        goal: 'update a repository',
        orchestratorModelId: 'mock-pro',
        steps: [],
        startedAt: now,
        githubScope: 'scope_run_1',
        timeline: [],
      },
    }
    seedConversations([convFixture('conv_run_timeline', 'Run timeline', now, { messages: [runMessage] })], 'conv_run_timeline')
    useGitHubActivity.getState().enterScope('scope_run_1', runMessage.id)
    appendAgentThought(runMessage.id, 'synthesis', 'mock-pro', 'Thought before the GitHub call.')
    const inRun = logGitHubAction({ kind: 'get-file', subject: '/src/math.ts', repo: 'octo/demo', ref: 'main' })
    appendAgentThought(runMessage.id, 'synthesis', 'mock-pro', 'Thought after the GitHub call.')
    const runCards = useGitHubActivity.getState().entries.filter((e) => e.id === inRun)
    check('a card logged during a run carries its scope and message', runCards[0]?.scope === 'scope_run_1' && runCards[0]?.messageId === runMessage.id, JSON.stringify(runCards))

    seed()
    const timelineHtml = renderToString(
      createElement(MessageBubble, {
        message: useChat.getState().conversations.conv_run_timeline!.messages[0]!,
      }),
    ).replace(/<!-- -->/g, '')
    const firstThought = timelineHtml.indexOf('thought-block')
    const actionCard = timelineHtml.indexOf('gh-action-card')
    const secondThought = timelineHtml.indexOf('thought-block', firstThought + 1)
    check(
      'a GitHub call splits the thought into thought → action → thought cards',
      firstThought >= 0 && firstThought < actionCard && actionCard < secondThought,
      timelineHtml.slice(Math.max(0, firstThought - 80), secondThought + 120),
    )
    check('the in-message action card has no remove or dismiss button', !timelineHtml.slice(actionCard).split('</div>')[0]?.includes('<button'), timelineHtml.slice(actionCard, actionCard + 240))
    check(
      'a run action is not repeated as a panel row',
      !panelActions(panelItems()).some((entry) => entry.id === inRun),
      JSON.stringify(panelActions(panelItems()).map((entry) => entry.id)),
    )

    finishGitHubAction(inRun, { status: 'done' })
    const cancelledId = logGitHubAction({ kind: 'get-file', subject: '/cancelled.ts', repo: 'octo/demo', ref: 'main' })
    finishGitHubAction(cancelledId, { status: 'cancelled', error: 'Cancelled' })
    const runMessageAfter = useChat.getState().conversations.conv_run_timeline!.messages[0]!
    const cancelledCard = runMessageAfter.agent?.timeline?.find((item) => item.type === 'github' && item.card.id === cancelledId)
    check('a cancelled action remains in both the ledger and message timeline',
      useGitHubActivity.getState().entries.some((entry) => entry.id === cancelledId) && cancelledCard?.type === 'github' && cancelledCard.card.status === 'cancelled',
      JSON.stringify(cancelledCard),
    )
    const persistedRun = conversationSchema.safeParse(useChat.getState().conversations.conv_run_timeline)
    check(
      'thought/action cards pass conversation persistence validation',
      persistedRun.success && Boolean(persistedRun.data.messages[0]?.agent?.timeline?.some((item) => item.type === 'github' && item.card.id === cancelledId)),
      persistedRun.success ? JSON.stringify(persistedRun.data.messages[0]?.agent?.timeline?.map((item) => item.type)) : String(persistedRun.error),
    )
    useGitHubActivity.getState().exitScope('scope_run_1')
    check('the scope stack is released again', useGitHubActivity.getState().scopes.length === 0, JSON.stringify(useGitHubActivity.getState().scopes))
    check('a scope with no calls does not create a chat row', !panelActions(panelItems()).some((entry) => entry.id === 'scope_nothing'))

    check('the card title escapes nothing weird', card.includes('octo/demo@main'))
  } finally {
    off()
    globalThis.fetch = realFetch
    fake.close()
    useGitHub.getState().setPublishDefaults({ repo: undefined, branch: undefined, prefix: '' })
    useGitHubActivity.setState({ entries: [], total: 0, scopes: [], scopeMessages: {} })
    useChat.getState().clearAllConversations()
    useFs.getState().deleteFile('docs/roadmap.md')
    useFs.getState().deleteFile('src/lib/util.ts')
  }
}

/**
 * Folding a streak of GitHub action cards into one expandable group: the pure
 * rule (more than two in a row), the group's header and body, and the two
 * places it shows up — an agent run's message and the chat panel.
 */
function testGitHubActionGroups() {
  console.log('github action groups (more than two cards in a row):')

  const card = (id: string, patch: Partial<GitHubActionArtifact> = {}): GitHubActionArtifact => ({
    id,
    kind: 'get-file',
    title: 'GitHub Action: Get File Contents',
    subject: `/src/${id}.ts`,
    repo: 'octo/demo',
    ref: 'main',
    status: 'done',
    at: 1,
    count: 1,
    ...patch,
  })
  const render = (el: Parameters<typeof renderToString>[0]) => renderToString(el).replace(/<!-- -->/g, '')
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

  /* ---- the rule ---- */

  type Item = AgentTimelineItem
  type GhItem = Extract<Item, { type: 'github' }>
  const gh = (id: string, patch?: Partial<GitHubActionArtifact>): Item => ({ id, type: 'github', card: card(id, patch) })
  const th = (id: string, text = `thinking about ${id}`, streaming?: boolean): Item => ({
    id,
    type: 'thought',
    sourceId: 'synthesis',
    modelId: 'mock-pro',
    text,
    streaming,
  })
  const isGh = (item: Item): item is GhItem => item.type === 'github'
  const shape = (items: Item[]) =>
    foldActionRuns(items, isGh)
      .map((f) => (f.kind === 'group' ? `[${f.items.map((i) => i.id).join(',')}]` : f.item.id))
      .join(' ')
  const ids = (...names: string[]) => names.map((n) => gh(n))

  check('the threshold is "more than two"', GITHUB_GROUP_THRESHOLD === 2, String(GITHUB_GROUP_THRESHOLD))
  check('nothing to fold is nothing', foldActionRuns([] as Item[], isGh).length === 0)
  check('one card stays a row of its own', shape(ids('a')) === 'a', shape(ids('a')))
  check('two cards stay two rows — not "more than two"', shape(ids('a', 'b')) === 'a b', shape(ids('a', 'b')))
  check('three cards fold into one group', shape(ids('a', 'b', 'c')) === '[a,b,c]', shape(ids('a', 'b', 'c')))
  check(
    'a longer streak is still one group, in call order',
    shape(ids('a', 'b', 'c', 'd', 'e', 'f', 'g')) === '[a,b,c,d,e,f,g]',
    shape(ids('a', 'b', 'c', 'd', 'e', 'f', 'g')),
  )
  check(
    'a thought ends a streak: two, a thought, two stays as rows',
    shape([gh('a'), gh('b'), th('t1'), gh('c'), gh('d')]) === 'a b t1 c d',
    shape([gh('a'), gh('b'), th('t1'), gh('c'), gh('d')]),
  )
  const busy = [th('t0'), gh('a'), gh('b'), gh('c'), th('t1'), gh('d'), gh('e'), th('t2'), gh('f'), gh('g'), gh('h'), gh('i')]
  check(
    'each streak is judged on its own, and the thoughts keep their place',
    shape(busy) === 't0 [a,b,c] t1 d e t2 [f,g,h,i]',
    shape(busy),
  )
  check('a streak at the very start of a timeline folds too', shape([...ids('a', 'b', 'c'), th('t1')]) === '[a,b,c] t1')
  const grown = (n: number) => foldActionRuns(ids(...'abcdefgh'.slice(0, n).split('')), isGh)[0]!
  check(
    'a group keeps its id while the streak grows, so an open group stays open',
    grown(3).kind === 'group' && grown(8).kind === 'group' && (grown(3) as { id: string }).id === (grown(8) as { id: string }).id,
    JSON.stringify([grown(3), grown(8)].map((f) => (f.kind === 'group' ? f.id : f.item.id))),
  )
  check(
    '…and that id is its own, never a card id',
    !'abcdefgh'.split('').includes((grown(3) as { id: string }).id) && (grown(3) as { id: string }).id.startsWith('gh-group:'),
  )
  check(
    'folding does not touch or drop a card',
    JSON.stringify(foldActionRuns(ids('a', 'b', 'c'), isGh).flatMap((f) => (f.kind === 'group' ? f.items : [f.item]))) ===
      JSON.stringify(ids('a', 'b', 'c')),
  )

  /* ---- what a folded group says about its cards ---- */

  const mixed = summarizeGitHubGroup([
    card('a'),
    card('b'),
    card('c', { kind: 'create-commit', title: 'GitHub Action: Created Commit', subject: 'Apply changes' }),
  ])
  check('a group counts its cards', mixed.total === 3 && mixed.running === 0 && mixed.failed === 0, JSON.stringify(mixed))
  check(
    '…and names each kind of action once, in the order it first appeared, with how many',
    mixed.breakdown === 'Get File Contents ×2 · Created Commit',
    mixed.breakdown,
  )
  check('a streak that all went well is done', mixed.status === 'done' && mixed.current === undefined, mixed.status)
  const failed = summarizeGitHubGroup([card('a'), card('b', { status: 'error', error: 'Not found' }), card('c')])
  check('one failure makes the group failed, and is counted', failed.status === 'error' && failed.failed === 1, JSON.stringify(failed))
  const live = summarizeGitHubGroup([card('a'), card('b', { status: 'error' }), card('c', { status: 'running' })])
  check(
    'live work outranks a failure for the header status — the failure is still counted',
    live.status === 'running' && live.failed === 1 && live.running === 1 && live.current?.id === 'c',
    JSON.stringify(live),
  )
  const twoLive = summarizeGitHubGroup([card('a', { status: 'running' }), card('b', { status: 'running' }), card('c')])
  check('with several calls in flight, the newest one is the one named', twoLive.running === 2 && twoLive.current?.id === 'b', twoLive.current?.id)
  const stopped = summarizeGitHubGroup([card('a'), card('b', { status: 'cancelled' }), card('c')])
  check('a cancelled call marks the group cancelled', stopped.status === 'cancelled' && stopped.cancelled === 1, JSON.stringify(stopped))
  check(
    'a failure outranks a cancellation',
    summarizeGitHubGroup([card('a', { status: 'cancelled' }), card('b', { status: 'error' }), card('c')]).status === 'error',
  )
  check(
    'titles come from the cards themselves, so a card saved under an older vocabulary still reads',
    summarizeGitHubGroup([card('a', { title: 'GitHub Action: Old Phrase' }), card('b'), card('c')]).breakdown.startsWith('Old Phrase'),
  )

  /* ---- the group itself ---- */

  const three = [card('a'), card('b'), card('c')]
  const closed = render(createElement(GitHubActionGroup, { cards: three }))
  check(
    'a group renders folded',
    closed.includes('gh-action-group status-done') && closed.includes('aria-expanded="false"'),
    closed.slice(0, 240),
  )
  check(
    '…as one button — a disclosure, not a card',
    count(closed, '<button') === 1 && closed.includes('type="button"') && closed.includes('gh-action-group-head'),
    closed.slice(0, 240),
  )
  check(
    '…named GitHub Actions, with how many cards it holds',
    closed.includes('>GitHub Actions<') && closed.includes('3<span class="sr-only"> actions</span>'),
    closed.slice(0, 700),
  )
  check('…saying what is inside without opening it', closed.includes('Get File Contents ×3'), closed.slice(0, 900))
  check(
    '…and rendering none of the cards while it is folded',
    !closed.includes('gh-action-card') && !closed.includes('/src/a.ts') && !closed.includes('gh-action-group-body'),
    closed.slice(0, 900),
  )
  check('…with nothing for aria-controls to point at', !closed.includes('aria-controls'))
  check('…and the chevron points right', closed.includes('m9 18 6-6-6-6') && !closed.includes('m6 9 6 6 6-6'))
  check('…and the done glyph, not a spinner', closed.includes('aria-label="done"') && !closed.includes('M12 3v3.5M12 17.5V21'))

  const open = render(createElement(GitHubActionGroup, { cards: three, defaultOpen: true }))
  const at = (needle: string) => open.indexOf(needle)
  check('opened, it says so', open.includes('aria-expanded="true"') && open.includes('gh-action-group-body'), open.slice(0, 300))
  const controls = /aria-controls="([^"]+)"/.exec(open)?.[1]
  check('…and the button points at the body it opens', Boolean(controls) && open.includes(`id="${controls}"`), String(controls))
  check('…with every card as its own row, in order', count(open, 'gh-action-card status-done') === 3 && at('/src/a.ts') < at('/src/b.ts') && at('/src/b.ts') < at('/src/c.ts'), open.slice(0, 900))
  check('…the rows come after the header', at('gh-action-group-head') < at('gh-action-group-body') && at('gh-action-group-body') < at('/src/a.ts'))
  check('…and the chevron points down', open.includes('m6 9 6 6 6-6') && !open.includes('m9 18 6-6-6-6'))
  check('…the cards inside are still plain rows: the header is the only button', count(open, '<button') === 1)
  check(
    '…and there is no remove or dismiss control anywhere in it',
    !/aria-label="(remove|dismiss|delete|clear)/i.test(open) && !/(>|\s)(remove|dismiss|clear)(<|\s)/i.test(open),
  )
  check('a card on its own is still not expandable', !render(createElement(GitHubActionCard, { entry: card('solo') })).includes('aria-expanded'))

  const failing = render(createElement(GitHubActionGroup, { cards: [card('a'), card('b', { status: 'error', error: 'Not found' }), card('c')] }))
  check(
    'a failure stays visible on a folded group — it cannot hide behind it',
    failing.includes('gh-action-group status-error') && failing.includes('1 failed') && failing.includes('aria-label="failed"') && !failing.includes('gh-action-card'),
    failing.slice(0, 700),
  )
  const running = render(
    createElement(GitHubActionGroup, { cards: [card('a'), card('b'), card('c', { status: 'running', subject: '/src/live.ts' })] }),
  )
  check(
    'a folded group says what is running right now',
    running.includes('gh-action-group status-running') &&
      running.includes('aria-label="in progress"') &&
      running.includes('Get File Contents · /src/live.ts'),
    running.slice(0, 800),
  )
  check('…with the spinner glyph', running.includes('M12 3v3.5M12 17.5V21'))
  const stoppedHtml = render(createElement(GitHubActionGroup, { cards: [card('a'), card('b', { status: 'cancelled' }), card('c')] }))
  check(
    'a cancelled streak says so',
    stoppedHtml.includes('gh-action-group status-cancelled') && stoppedHtml.includes('1 cancelled') && stoppedHtml.includes('aria-label="cancelled"'),
    stoppedHtml.slice(0, 600),
  )

  // Opened, the cards keep their own story — the header only summarises it.
  const openMixed = render(
    createElement(GitHubActionGroup, {
      defaultOpen: true,
      cards: [
        card('a'),
        card('b', { status: 'error', error: 'Not found on GitHub' }),
        card('c', { status: 'cancelled' }),
        card('d', { status: 'running' }),
      ],
    }),
  )
  check(
    'opened, every card keeps its own status — the failure its reason, the cancelled one its label',
    count(openMixed, 'class="gh-action-card ') === 4 &&
      openMixed.includes('gh-action-card status-done') &&
      openMixed.includes('gh-action-card status-error') &&
      openMixed.includes('Not found on GitHub') &&
      openMixed.includes('gh-action-card status-cancelled') &&
      openMixed.includes('gh-action-card status-running'),
    openMixed.slice(0, 900),
  )

  /* ---- inside an agent run's message ---- */

  const settingsInit = useSettings.getInitialState() as unknown as { s: Settings }
  const origSettings = settingsInit.s
  const runWith = (timeline: Item[], status: Message['status'] = 'complete'): Message => ({
    id: 'msg_group_run',
    role: 'assistant',
    conversationId: 'conv_group_run',
    content: 'Done.',
    createdAt: 1,
    status,
    modelId: 'mock-pro',
    agent: { phase: 'complete', goal: 'inspect the repo', orchestratorModelId: 'mock-pro', steps: [], startedAt: 1, timeline },
  })
  const bubble = (timeline: Item[], status?: Message['status']) =>
    render(createElement(MessageBubble, { message: runWith(timeline, status) }))
  const groups = (html: string) => count(html, 'class="gh-action-group ')
  const rows = (html: string) => count(html, 'class="gh-action-card ')

  try {
    const folded = bubble([th('t1'), ...ids('a', 'b', 'c', 'd'), th('t2')])
    check('four calls in a run render as one group, not four rows', groups(folded) === 1 && rows(folded) === 0, `${groups(folded)} groups, ${rows(folded)} rows`)
    const firstThought = folded.indexOf('thought-block')
    const groupAt = folded.indexOf('gh-action-group ')
    const lastThought = folded.lastIndexOf('thought-block')
    check('…between the two thoughts it sat between', firstThought >= 0 && firstThought < groupAt && groupAt < lastThought, folded.slice(Math.max(0, firstThought - 60), lastThought + 80))
    check('…holding all four', folded.includes('>4<span class="sr-only"> actions</span>'), folded.slice(groupAt, groupAt + 700))
    check('…and folded, so none of the four is on screen yet', !folded.includes('/src/a.ts') && !folded.includes('/src/d.ts'))

    const pair = bubble([th('t1'), ...ids('a', 'b'), th('t2')])
    check('two calls in a run stay two rows', groups(pair) === 0 && rows(pair) === 2, `${groups(pair)} groups, ${rows(pair)} rows`)
    const split = bubble([...ids('a', 'b'), th('t1'), ...ids('c', 'd')])
    check('two, a thought, then two stay four rows — each streak is judged alone', groups(split) === 0 && rows(split) === 4, `${groups(split)} groups, ${rows(split)} rows`)
    const mixedRun = bubble([th('t0'), ...ids('a', 'b', 'c'), th('t1'), ...ids('d', 'e')])
    check('a folded streak and a short one sit side by side', groups(mixedRun) === 1 && rows(mixedRun) === 2, `${groups(mixedRun)} groups, ${rows(mixedRun)} rows`)

    // A thought that draws nothing does not separate its neighbours.
    settingsInit.s = {
      ...origSettings,
      models: origSettings.models.map((m) => (m.id === 'mock-pro' ? { ...m, showThoughts: false } : m)),
    }
    const hidden = bubble([gh('a'), th('t1'), gh('b'), th('t2'), gh('c')])
    check(
      'thoughts switched off draw nothing, so the calls around them group together',
      groups(hidden) === 1 && rows(hidden) === 0 && !hidden.includes('thought-block'),
      `${groups(hidden)} groups, ${rows(hidden)} rows`,
    )
    settingsInit.s = origSettings
    const shown = bubble([gh('a'), th('t1'), gh('b'), th('t2'), gh('c')])
    check('…but with thoughts on, they still split the streak', groups(shown) === 0 && rows(shown) === 3 && count(shown, 'thought-block') >= 2, `${groups(shown)} groups, ${rows(shown)} rows`)
    const blank = bubble([gh('a'), th('t1', '   '), gh('b'), gh('c')])
    check('a thought with no text draws nothing either, so the calls still group', groups(blank) === 1 && rows(blank) === 0, `${groups(blank)} groups, ${rows(blank)} rows`)
    const live = bubble([...ids('a', 'b'), th('t1', 'still thinking', true), ...ids('c', 'd')], 'streaming')
    check('a thought that is streaming does split them', groups(live) === 0 && rows(live) === 4, `${groups(live)} groups, ${rows(live)} rows`)
    // The streaming flag alone is enough to draw: the card shows "thinking…" before any text arrives.
    const starting = bubble([...ids('a', 'b'), th('t1', '', true), ...ids('c', 'd')], 'streaming')
    check(
      '…even before it has any text — it already draws "thinking…"',
      groups(starting) === 0 && rows(starting) === 4 && starting.includes('thinking…'),
      `${groups(starting)} groups, ${rows(starting)} rows`,
    )
    // A stale flag on a message that is no longer streaming draws nothing, so it separates nothing.
    const stale = bubble([...ids('a', 'b'), th('t1', '', true), ...ids('c', 'd')], 'complete')
    check(
      'a leftover streaming flag on a finished run draws nothing, so it does not split them',
      groups(stale) === 1 && rows(stale) === 0 && !stale.includes('thought-block'),
      `${groups(stale)} groups, ${rows(stale)} rows`,
    )
    const runningRun = bubble([...ids('a', 'b'), gh('c', { status: 'running', subject: '/src/now.ts' })], 'streaming')
    check(
      'a run in progress shows what its folded calls are doing',
      groups(runningRun) === 1 && runningRun.includes('gh-action-group status-running') && runningRun.includes('/src/now.ts'),
      runningRun.slice(runningRun.indexOf('gh-action-group'), runningRun.indexOf('gh-action-group') + 600),
    )
  } finally {
    settingsInit.s = origSettings
  }

  /* ---- in the chat panel ---- */

  const entry = (id: string, patch?: Partial<GitHubActionArtifact>): GitHubActionEntry => ({ ...card(id, patch) })
  const msg = (id: string, role: Message['role']): Message => ({
    id,
    role,
    conversationId: 'conv_group_panel',
    content: id,
    createdAt: 1,
    status: 'complete',
  })
  const messages = [msg('m1', 'user'), msg('m2', 'assistant')]
  const kinds = (items: ReturnType<typeof buildPanelItems>) => items.map((i) => i.kind).join()

  check('no standalone calls: just the conversation', kinds(buildPanelItems(messages, [])) === 'message,message')
  check(
    'two standalone calls stay two rows after the messages',
    kinds(buildPanelItems(messages, [entry('a'), entry('b')])) === 'message,message,github,github',
    kinds(buildPanelItems(messages, [entry('a'), entry('b')])),
  )
  const folded3 = buildPanelItems(messages, [entry('a'), entry('b'), entry('c')])
  check('three fold into a single row after the messages', kinds(folded3) === 'message,message,github-group', kinds(folded3))
  const groupItem = folded3[2]
  check(
    '…holding the calls oldest first',
    groupItem?.kind === 'github-group' && groupItem.entries.map((e) => e.id).join() === 'a,b,c',
    JSON.stringify(groupItem),
  )
  check(
    '…and the conversation above it is untouched',
    folded3[0]?.id === 'm1' && folded3[1]?.id === 'm2',
    JSON.stringify(folded3.map((i) => i.id)),
  )
  const grown4 = buildPanelItems(messages, [entry('a'), entry('b'), entry('c'), entry('d')])
  check(
    'the group row keeps its id as calls arrive, so it is the same row in the list (and stays open)',
    grown4.length === 3 && grown4[2]?.id === groupItem?.id && grown4[2]?.kind === 'github-group',
    JSON.stringify(grown4.map((i) => i.id)),
  )
  const failedRows = buildPanelItems(messages, [entry('a'), entry('b', { status: 'error' }), entry('c')])
  check('a failed call is still in the folded row, counted on its header', panelActions(failedRows).some((e) => e.status === 'error'))

  const rowHtml = render(createElement(GitHubActionGroupItem, { entries: groupItem?.kind === 'github-group' ? groupItem.entries : [] }))
  check(
    'a folded panel row sits in the message column like a card row does',
    rowHtml.includes('class="gh-panel-item"') && rowHtml.includes('gh-action-group status-done') && rowHtml.includes('aria-expanded="false"'),
    rowHtml.slice(0, 300),
  )
  check('…and holds the three calls behind its header', rowHtml.includes('>3<span class="sr-only"> actions</span>') && !rowHtml.includes('gh-action-card'), rowHtml.slice(0, 700))
}

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
  check(
    'formatPrice keeps cheap models truthful instead of rounding them up',
    formatPrice(0.00008) === '$0.00008' && formatPrice(0.00045) === '$0.00045' && formatPrice(0.00087) === '$0.00087',
    `${formatPrice(0.00008)}/${formatPrice(0.00045)}/${formatPrice(0.00087)}`,
  )

  // NVIDIA Nemotron 3 Super: curated on both routes a user can take — the
  // OpenRouter slug (262K served context, $0.08/$0.45 per million) and NVIDIA's
  // own OpenAI-compatible endpoint, which the form prefills.
  const nemotron = MODEL_CATALOG.filter((m) => m.apiModel === 'nvidia/nemotron-3-super-120b-a12b')
  check(
    'Nemotron 3 Super is catalogued for OpenRouter and NVIDIA NIM',
    nemotron.length === 2 && new Set(nemotron.map((m) => m.provider)).size === 2,
    JSON.stringify(nemotron.map((m) => m.provider)),
  )
  const orNemotron = nemotron.find((m) => m.provider === 'openrouter')
  check(
    '…the OpenRouter entry carries the 262K context and real per-1k pricing',
    orNemotron?.contextWindow === 262_144 && orNemotron.costPer1kIn === 0.00008 && orNemotron.costPer1kOut === 0.00045,
    JSON.stringify(orNemotron),
  )
  const nimNemotron = nemotron.find((m) => m.provider === 'openai-compatible')
  check(
    '…and the NIM entry prefills NVIDIA’s OpenAI-compatible endpoint',
    nimNemotron?.baseURL === 'https://integrate.api.nvidia.com/v1',
    String(nimNemotron?.baseURL),
  )
  check(
    'agentic models qualify for the catalogue',
    (orNemotron?.strengths.includes('agents') && nimNemotron?.strengths.includes('agents')) === true,
    JSON.stringify(nemotron.map((m) => m.strengths)),
  )

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
  check(
    'the OpenRouter table lists Nemotron 3 Super with its context and price intact',
    orTable.includes('nvidia/nemotron-3-super-120b-a12b') && orTable.includes('262K') && orTable.includes('$0.00008') && orTable.includes('$0.00045'),
    orTable.includes('nvidia/nemotron-3-super-120b-a12b') ? 'row present, price cell rendered' : 'row missing',
  )
  const compatTable = renderToString(createElement(ModelPickerTable, { provider: 'openai-compatible', onPick: () => {} }))
  check(
    'the OpenAI-compatible table lists the NIM endpoint too',
    compatTable.includes('nvidia/nemotron-3-super-120b-a12b') && compatTable.includes('build.nvidia.com'),
    compatTable.match(/1M/)?.[0] ?? 'no context chip',
  )
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

async function testFsArchiveRoundTrip() {
  const binary = btoa(String.fromCharCode(0, 1, 2, 127, 255))
  const blob = await createFsArchive([
    { path: 'notes/plan.md', content: '# Plan\n\nKeep the folder path.', encoding: 'utf8' },
    { path: 'assets/sample.bin', content: binary, encoding: 'base64' },
  ])
  const result = await readFsArchive(new File([blob], 'workspace.zip', { type: 'application/zip' }))
  const text = result.entries.find((entry) => entry.path === 'notes/plan.md')
  const data = result.entries.find((entry) => entry.path === 'assets/sample.bin')
  check('workspace ZIP round-trips nested UTF-8 file paths and contents', text?.content === '# Plan\n\nKeep the folder path.' && text?.encoding === 'utf8')
  check('workspace ZIP round-trips binary bytes without corruption', data?.content === binary && data.encoding === 'base64')
  check('workspace ZIP importer returns no skipped files for a clean archive', result.entries.length === 2 && result.skippedUnsafe === 0 && result.skippedLarge === 0)
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
    check('files drawer renders its workspace empty state', empty.includes('No files stored yet') && empty.includes('YOUR WORKSPACE'), empty.slice(0, 160))
    check('files drawer offers zip import and export actions', empty.includes('Import ZIP') && empty.includes('Export ZIP'))

    fsInit.files = { [sampleFile.path]: sampleFile }
    fsInit.selectedPath = sampleFile.path
    const populated = renderToString(createElement(FilesPanel)).replace(/<!-- -->/g, '')
    check('files drawer renders directory tree and file row', populated.includes('src/') && populated.includes('runner.ts'), populated.slice(0, 240))
    check('files drawer shows workspace file count and version badge', populated.includes('<strong>1</strong>') && populated.includes('v2'))
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
        goal: 'write the runner module',
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
    // `src/math.ts` is executable on the branch — the commit path has to notice
    // and keep 100755, including when the agent edits only its contents.
    '/repos/octo/demo/git/trees/main': () => ({
      status: 200,
      json: {
        truncated: false,
        tree: [
          { path: 'src/math.ts', mode: '100755', type: 'blob', sha: 'sha_math_1', size: initialMathTs.length },
          { path: 'src/legacy.ts', mode: '100644', type: 'blob', sha: 'sha_leg_1', size: initialLegacyTs.length },
        ],
      },
    }),
    // Same tree, addressed by sha — what commitTree reads modes from.
    '/repos/octo/demo/git/trees/base_tree_sha_1': () => ({
      status: 200,
      json: {
        truncated: false,
        tree: [
          { path: 'src/math.ts', mode: '100755', type: 'blob', sha: 'sha_math_1', size: initialMathTs.length },
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
    const postedMode = (path: string) => postedTree?.tree?.find((e) => e.path === path)?.mode
    check(
      'an edited executable keeps mode 100755 (a content edit, not a mode change)',
      postedMode('src/math.ts') === '100755',
      `${postedMode('src/math.ts')} — ${JSON.stringify(postedTree?.tree)}`,
    )
    check(
      'a file created by the run is 100644',
      postedMode('src/math.test.ts') === '100644',
      `${postedMode('src/math.test.ts')}`,
    )
    check(
      'the base tree is read for its modes',
      fakeGh.seen.some((r) => r.method === 'GET' && r.url.startsWith('/repos/octo/demo/git/trees/base_tree_sha_1')),
      JSON.stringify(fakeGh.seen.map((r) => r.url)),
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

    /* ---- the run's GitHub cards are persisted in its message timeline ---- */

    const runMsg = useChat.getState().conversations[useChat.getState().currentId]!.messages.find(
      (m) => m.agent?.githubScope,
    )
    const scope = runMsg?.agent?.githubScope
    check('the agent run stamped a GitHub scope on its message', typeof scope === 'string' && scope.length > 0, String(scope))
    check('the run released its scope when it finished', useGitHubActivity.getState().scopes.length === 0, JSON.stringify(useGitHubActivity.getState().scopes))
    const scoped = useGitHubActivity.getState().entries.filter((e) => e.scope === scope)
    check(
      'the files the run pulled from GitHub are logged under that scope and message',
      scoped.some((e) => e.kind === 'get-file' && e.subject === '/src/math.ts' && e.messageId === runMsg?.id),
      JSON.stringify(scoped.map((e) => `${e.title} ${e.subject} → ${e.messageId}`)),
    )
    check(
      'the commit the button triggered afterwards is NOT part of the run',
      useGitHubActivity.getState().entries.some((e) => !e.scope && e.kind === 'create-commit') &&
        !useGitHubActivity.getState().entries.some((e) => e.scope === scope && e.kind === 'create-commit'),
      JSON.stringify(useGitHubActivity.getState().entries.map((e) => `${e.kind}:${e.scope ? 'run' : 'manual'}`)),
    )
    const inlineArtifacts = runMsg?.agent?.timeline?.filter((item) => item.type === 'github') ?? []
    check(
      'the run message owns a snapshot of every scoped GitHub action',
      inlineArtifacts.length === scoped.length && inlineArtifacts.some((item) => item.type === 'github' && item.card.subject === '/src/math.ts'),
      JSON.stringify(inlineArtifacts.map((item) => item.type === 'github' ? `${item.card.title} ${item.card.subject}` : item.type)),
    )
    const inlineRun = renderToString(createElement(MessageBubble, { message: runMsg! })).replace(/<!-- -->/g, '')
    check(
      'the run message renders action cards in its timeline, not a grouped activity footer',
      inlineRun.includes('agent-activity-timeline') && inlineRun.includes('gh-action-card') &&
        inlineRun.includes('/src/math.ts') && !inlineRun.includes('gh-activity'),
      inlineRun.slice(Math.max(0, inlineRun.indexOf('agent-activity-timeline')), inlineRun.indexOf('agent-activity-timeline') + 500),
    )
    check(
      'the chat panel does not repeat run-scoped cards',
      !panelActions(buildPanelItems([], sessionGitHubActions(useGitHubActivity.getState().entries))).some(
        (entry) => entry.subject === '/src/math.ts',
      ),
      JSON.stringify(sessionGitHubActions(useGitHubActivity.getState().entries).map((entry) => `${entry.title} ${entry.subject}`)),
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
  check('thought card renders into assistant message', html.includes('thought-block') && html.includes('Thoughts'), html.slice(0, 300))
  check('thought card is titled "Thoughts", not "Thought process"', html.includes('thought-title\">Thoughts<'), html.slice(0, 400))
  check('thought card uses the brain icon', html.includes('M9.5 2A2.5 2.5'), html.slice(0, 300))
  check('thought card never wears a spinner', !html.includes('M12 3v3.5M12 17.5V21'), html.slice(0, 300))
  check('thought card keeps its word count badge', html.includes('11 words'), html.slice(0, 400))
  check('no call site renames the card', !html.includes('Thought process'), html.slice(0, 300))

  // 1b. Streaming message renders open thought block with live content
  const streamingMsg = {
    ...msgWithReasoning,
    status: 'streaming' as const,
    content: '',
  }
  const streamHtml = renderToString(createElement(MessageBubble, { message: streamingMsg })).replace(/<!-- -->/g, '')
  check('streaming message renders open thought body with reasoning text', streamHtml.includes('thought-block') && streamHtml.includes('streaming') && streamHtml.includes('First consider step A'), streamHtml.slice(0, 400))
  check('streaming thought card is still called Thoughts', streamHtml.includes('thought-title\">Thoughts<') && streamHtml.includes('thinking…'), streamHtml.slice(0, 400))
  check('streaming thought card keeps the brain icon', streamHtml.includes('M9.5 2A2.5 2.5') && !streamHtml.includes('M12 3v3.5M12 17.5V21'), streamHtml.slice(0, 300))

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
      goal: 'ship the widget',
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
  check('agent plan card renders planning reasoning block', (agentHtml.match(/thought-title\">Thoughts</g) ?? []).length === 2 && agentHtml.includes('6 words'), agentHtml.slice(0, 500))
  const stepBodyAt = agentHtml.indexOf('agent-step-body')
  check('agent steps render the same Thoughts card', stepBodyAt >= 0 && agentHtml.slice(stepBodyAt).includes('thought-title\">Thoughts<'), agentHtml.slice(0, 600))
  check('thinking bodies stay collapsed until opened', !agentHtml.includes('Analyzing state requirements and rendering logic'), 'step reasoning should be behind the card')
  check('agent cards never label thoughts per-model', !agentHtml.includes('thought process') && !agentHtml.includes('Planning reasoning'), agentHtml.slice(0, 500))

  // The card is called "Task plan": it must show the plan — the task it is
  // executing and what each step was actually asked to do — not just outcomes.
  check(
    'the plan card names the task it is planning',
    agentHtml.includes('agent-plan-goal') && agentHtml.includes('ship the widget'),
    agentHtml.slice(0, 400),
  )
  check(
    '…and each step shows the brief the orchestrator wrote for it',
    agentHtml.includes('agent-step-brief') && agentHtml.includes('Brief') && agentHtml.includes('Write component'),
    agentHtml.slice(stepBodyAt, stepBodyAt + 600),
  )

  // With step results collapsed by default, a step is still a real disclosure:
  // the row opens onto the brief, so the plan is readable before any result.
  settingsInit.s = { ...origSettings, agent: { ...origSettings.agent, expandStepResults: false } }
  const collapsedSteps = renderToString(createElement(MessageBubble, { message: msgWithAgentThoughts })).replace(/<!-- -->/g, '')
  const headOf = (html: string) => html.slice(html.indexOf('agent-step-head'), html.indexOf('agent-step-head') + 300)
  check(
    'a collapsed step row still offers its brief',
    !collapsedSteps.includes('agent-step-body') &&
      /aria-expanded="false"/.test(headOf(collapsedSteps)) &&
      !/disabled/.test(headOf(collapsedSteps)),
    headOf(collapsedSteps),
  )

  // …and a step that has not produced anything yet is not a dead row either.
  settingsInit.s = origSettings
  const pendingBrief = {
    ...msgWithAgentThoughts,
    agent: {
      ...msgWithAgentThoughts.agent,
      phase: 'executing' as const,
      steps: [
        {
          id: 'step_pending',
          title: 'Queued work',
          prompt: 'Do the queued thing',
          modelId: 'mock-pro',
          modelLabel: 'Simulacron Pro',
          status: 'pending' as const,
          attempts: [],
          failedChain: [],
        },
      ],
    },
  }
  const pendingHtml = renderToString(createElement(MessageBubble, { message: pendingBrief })).replace(/<!-- -->/g, '')
  check(
    'a queued step can still be opened to read its brief',
    /aria-expanded="false"/.test(headOf(pendingHtml)) && !/disabled/.test(headOf(pendingHtml)),
    headOf(pendingHtml),
  )
  settingsInit.s = origSettings
}

/* ------------------------------------------------------------------ */
/* Roadmap tracking: the orchestrator's completion timeline            */
/* ------------------------------------------------------------------ */

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** Order-insensitive deep equality: zod re-emits object keys in schema order. */
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)]))
      : v
const sameData = (a: unknown, b: unknown) => same(canon(a), canon(b))
const stepLine = (s: { label: string; status: string; group?: string }) => `${s.status}:${s.label}${s.group ? `@${s.group}` : ''}`
const parsedSteps = (md: string) => parseRoadmap(md).steps.map(stepLine)
const FENCE = '```'
/** A fenced file block the way models emit them: ```lang:path … ``` */
const fileBlock = (info: string, body: string) => `${FENCE}${info}\n${body.endsWith('\n') ? body : `${body}\n`}${FENCE}\n`

function testRoadmapPaths() {
  console.log('roadmap file detection:')
  const yes = ['ROADMAP.md', 'roadmap.md', 'docs/roadmap.md', 'MILESTONES.md', 'milestone.md', 'product-roadmap.txt', 'ROADMAP', 'docs/Q3_Milestones.markdown']
  const no = ['README.md', 'CHANGELOG.md', 'src/lib/roadmap.ts', 'roadmap.test.ts', 'roadmapping.md', 'node_modules/pkg/ROADMAP.md', 'src/roadmap/index.ts']
  check('recognises roadmap and milestone documents', yes.every(isRoadmapPath), JSON.stringify(yes.filter((p) => !isRoadmapPath(p))))
  check('ignores source files, vendored copies and look-alikes', no.every((p) => !isRoadmapPath(p)), JSON.stringify(no.filter(isRoadmapPath)))

  const snap = snapshotRoadmapFiles([
    { path: 'ROADMAP.md', content: '- [x] a' },
    { path: 'docs/milestones.md', content: '- [ ] b', encoding: 'utf8' },
    { path: 'other/roadmap.md', content: 'AAAA', encoding: 'base64' },
    { path: 'src/app.ts', content: 'x' },
  ])
  check('snapshot keeps only the text roadmap files', same(snap.map((f) => f.path), ['ROADMAP.md', 'docs/milestones.md']), JSON.stringify(snap))

  const blobs = findRoadmapBlobs([
    { path: 'docs/deep/roadmap.md', type: 'blob', size: 100 },
    { path: 'ROADMAP.md', type: 'blob', size: 50 },
    { path: 'huge/MILESTONES.md', type: 'blob', size: 900_000 },
    { path: 'docs/ROADMAP', type: 'tree' },
    { path: 'src/a.ts', type: 'blob', size: 10 },
  ])
  check('finds roadmap blobs in a repo tree: shallowest first, no folders, no huge files', same(blobs, ['ROADMAP.md', 'docs/deep/roadmap.md']), JSON.stringify(blobs))
  check(
    'caps how many roadmap files are pulled',
    findRoadmapBlobs(['a/ROADMAP.md', 'b/ROADMAP.md', 'c/ROADMAP.md'].map((path) => ({ path, type: 'blob', size: 1 })), 2).length === 2,
  )
}

function testRoadmapParsing() {
  console.log('roadmap parsing:')

  // 1. GFM task lists grouped under milestone headings; a parent with steps of its own is a group.
  const checklist = [
    '# Roadmap',
    '',
    '## Milestone 1 — Core chat',
    '- [x] Streaming responses',
    '- [x] Failover engine',
    '',
    '## Milestone 2 — GitHub',
    '- [x] Device flow',
    '- [~] Publish dialog',
    '- [ ] Code search',
    '  - [ ] nested child A',
    '  - [x] nested child B',
  ].join('\n')
  check(
    'task lists: [x] done, [~] in progress, [ ] not started, grouped by milestone heading',
    same(parsedSteps(checklist), [
      'done:Streaming responses@Milestone 1 — Core chat',
      'done:Failover engine@Milestone 1 — Core chat',
      'done:Device flow@Milestone 2 — GitHub',
      'active:Publish dialog@Milestone 2 — GitHub',
      'todo:nested child A@Milestone 2 — GitHub › Code search',
      'done:nested child B@Milestone 2 — GitHub › Code search',
    ]),
    JSON.stringify(parsedSteps(checklist)),
  )
  check('the single H1 is the roadmap title, not a group', parseRoadmap(checklist).title === 'Roadmap')
  check('steps are numbered 1..n in document order', same(parseRoadmap(checklist).steps.map((s) => s.index), [1, 2, 3, 4, 5, 6]))

  // 2. Status-named sections: plain bullets take the section's status; nested notes are ignored.
  const buckets = ['# Slade Roadmap', '', '## ✅ Done', '- Streaming responses', '- Failover engine', '  - uses SSE parsing (a note, not a step)', '', '## 🚧 In progress', '- Provider dialog', '', '## ⏳ Planned', '- Mobile app', '- Plugin API'].join('\n')
  check(
    'status sections (Done / In progress / Planned) give their bullets a status; sub-bullet notes are not steps',
    same(parsedSteps(buckets), ['done:Streaming responses', 'done:Failover engine', 'active:Provider dialog', 'todo:Mobile app', 'todo:Plugin API']),
    JSON.stringify(parsedSteps(buckets)),
  )
  check(
    'Now / Next / Later sections',
    same(parsedSteps(['## Now', '- Fix cooldown UI', '## Next', '- Multi-token rotation', '## Later', '- Team workspaces'].join('\n')), ['active:Fix cooldown UI', 'todo:Multi-token rotation', 'todo:Team workspaces']),
  )
  check(
    'sub-headings inside a status section keep the section status',
    same(parsedSteps(['## Planned', '### Q4', '- Mobile app', '### Q1', '- Plugin API'].join('\n')), ['todo:Mobile app@Q4', 'todo:Plugin API@Q1']),
  )

  // 3. Headings that carry a status (emoji, parenthesis, dash) are steps themselves.
  check(
    'status-marked headings are steps: emoji, (word) and ": word" forms',
    same(parsedSteps(['# Product plan', '', '### M1 — Core chat ✅', '### M2 — GitHub 🚧', '### M3 — Agent (planned)', '### M4 — Mobile: not started'].join('\n')), [
      'done:M1 — Core chat',
      'active:M2 — GitHub',
      'todo:M3 — Agent',
      'todo:M4 — Mobile',
    ]),
  )
  check(
    'a "Status:" line under a heading gives the heading its status',
    same(
      parsedSteps(['# Plan', '', '## Milestone 1: Foundation', '**Status:** Done', '', '## Milestone 2: Providers', '**Status:** In progress · **Target:** Q4', '', '## Milestone 3: Agents', 'Status: planned'].join('\n')),
      ['done:Milestone 1: Foundation', 'active:Milestone 2: Providers', 'todo:Milestone 3: Agents'],
    ),
  )
  check(
    'a status heading that contains steps only groups them',
    same(parsedSteps(['## Milestone 1 ✅', '- [x] one', '- [x] two'].join('\n')), ['done:one@Milestone 1', 'done:two@Milestone 1']),
  )

  // 4. Tables.
  check(
    'tables: the Status column decides, the Milestone column names the step (not Owner)',
    same(parsedSteps(['| Milestone | Owner | Status |', '|---|---|---|', '| M1 | ian | ✅ Done |', '| M2 | ian | 🚧 In progress |', '| M3 | sam | Planned |'].join('\n')), ['done:M1', 'active:M2', 'todo:M3']),
  )
  check(
    'tables: a "#" column is skipped in favour of the named column',
    same(parsedSteps(['| # | Milestone | Status |', '|---|---|---|', '| 1 | Core chat | ✅ |', '| 2 | Agents | ⏳ |'].join('\n')), ['done:Core chat', 'todo:Agents']),
  )
  check(
    'tables: a marker on the label cell itself ("✅ Streaming") works without a Status column',
    same(parsedSteps(['| Feature | Owner |', '|---|---|', '| ✅ Streaming | ian |', '| 🚧 Failover | sam |'].join('\n')), ['done:Streaming', 'active:Failover']),
  )
  check(
    'tables: rows without a recognisable status are not steps',
    same(parsedSteps(['| Milestone | Status |', '|---|---|', '| M1 | Done |', '| notes | see below |'].join('\n')), ['done:M1']),
  )

  // 5. Inline status markers on plain bullets.
  const inline = ['- ✅ Core chat', '- 🔄 GitHub integration', '- ⏳ Agent mode', '- Search — done', '- Voice: in progress', '- Themes (planned)', '- **Done** — Export', '- [Planned] Import'].join('\n')
  check(
    'inline markers: emoji, "— done", ": in progress", "(planned)", **Done** — and [Planned] badges',
    same(parsedSteps(inline), ['done:Core chat', 'active:GitHub integration', 'todo:Agent mode', 'done:Search', 'active:Voice', 'todo:Themes', 'done:Export', 'todo:Import']),
    JSON.stringify(parsedSteps(inline)),
  )
  check('an explicit word beats an emoji when both are present', same(parsedSteps('- ⏳ Provider dialog (in progress)'), ['active:Provider dialog']))
  check('a task checkbox beats a contradicting word, but [ ] plus "in progress" is in progress', same(parsedSteps('- [x] Foo (todo)\n- [ ] Publish (in progress)'), ['done:Foo', 'active:Publish']))
  check('"Status page: in progress" is a step, not a Status line', same(parsedSteps('- Status page rewrite: in progress'), ['active:Status page rewrite']))

  // 6. Things that must never count.
  const noise = ['# Roadmap', 'Some prose that says done.', '', FENCE + 'md', '- [x] inside a fence, ignored', FENCE, '', '- [x] Real step', '- [ ] ~~Cancelled idea~~', '- [ ] **Bold** step with `code` and [a link](http://x)'].join('\n')
  check(
    'fenced code, struck-through items and prose are ignored; Markdown decoration is stripped from labels',
    same(parsedSteps(noise), ['done:Real step', 'todo:Bold step with code and a link']),
    JSON.stringify(parsedSteps(noise)),
  )
  check('a document with no status markers has no steps', parsedSteps('# Notes\n- buy milk\n- write docs\n## Ideas\n- something').length === 0)
  check('an empty document has no steps', parsedSteps('').length === 0)

  // 7. Titles, CRLF, long lines.
  const twoH1 = parseRoadmap('# Phase 1\n- [x] A\n# Phase 2\n- [ ] B')
  check('several H1s: no title, and each becomes its steps\' group', twoH1.title === undefined && same(twoH1.steps.map(stepLine), ['done:A@Phase 1', 'todo:B@Phase 2']))
  check('CRLF line endings parse the same', same(parsedSteps('- [x] One\r\n- [ ] Two\r\n'), ['done:One', 'todo:Two']))
  const long = parseRoadmap(`- [x] ${'a'.repeat(500)}`).steps[0]?.label ?? ''
  check('over-long labels are clipped with an ellipsis', long.length <= 140 && long.endsWith('…'), String(long.length))

  // 8. Ticking a step (simulator support).
  const md = '# R\n- [x] A\n- [~] B\n- [ ] C\n'
  const t1 = tickFirstOpenStep(md)
  check('tickFirstOpenStep completes the first open step and touches nothing else', t1?.label === 'B' && t1.content === '# R\n- [x] A\n- [x] B\n- [ ] C\n', JSON.stringify(t1))
  const t2 = t1 ? tickFirstOpenStep(t1.content) : undefined
  const t3 = t2 ? tickFirstOpenStep(t2.content) : undefined
  check('…then the next one, and finally reports there is nothing left', t2?.label === 'C' && t3 === undefined)
  check('roadmaps without task-list lines (tables) are left alone', tickFirstOpenStep('| M | Status |\n|---|---|\n| M1 | Planned |') === undefined)
  check('CRLF survives ticking', tickFirstOpenStep('- [ ] One\r\n- [ ] Two\r\n')?.content === '- [x] One\r\n- [ ] Two\r\n')
}

/** "# Roadmap" + one task-list line per mark: ' ' todo, '~' in progress, 'x' done. */
const doc = (marks: string[]) => `# Roadmap\n\n${marks.map((m, i) => `- [${m}] Step ${i + 1}`).join('\n')}\n`
const report = (before: string | null, after: string, delegated = true, path = 'ROADMAP.md') =>
  buildRoadmapReport({ before: before === null ? [] : [{ path, content: before }], after: [{ path, content: after }], delegated })
const tl = (s?: { index: number; label: string; status: string; changed?: boolean }) => (s ? `${s.index}:${s.label}:${s.status}${s.changed ? '*' : ''}` : '—')

function testRoadmapReport() {
  console.log('roadmap report (timeline + progress):')

  // A step completed this run.
  const a = report(doc(['x', 'x', '~', ' ', ' ']), doc(['x', 'x', 'x', ' ', ' ']))!
  check(
    'completed step → previous / current / next around it, current flagged as changed this run',
    tl(a.previous) === '2:Step 2:done' && tl(a.current) === '3:Step 3:done*' && tl(a.next) === '4:Step 4:todo',
    `${tl(a.previous)} | ${tl(a.current)} | ${tl(a.next)}`,
  )
  check('overall progress after: 3 of 5 = 60%', same(a.progress, { done: 3, active: 0, total: 5, percent: 60 }), JSON.stringify(a.progress))
  check('progress before the run is kept: 2 of 5 = 40%, one in progress', same(a.before, { done: 2, active: 1, total: 5, percent: 40 }), JSON.stringify(a.before))
  check('the status change is listed', same(a.changes, [{ label: 'Step 3', from: 'active', to: 'done' }]), JSON.stringify(a.changes))
  check('report carries the file path and title', a.path === 'ROADMAP.md' && a.title === 'Roadmap')

  // A step started, none completed.
  const b = report(doc(['x', ' ', ' ']), doc(['x', '~', ' ']))!
  check('started (not finished) step becomes current', tl(b.previous) === '1:Step 1:done' && tl(b.current) === '2:Step 2:active*' && tl(b.next) === '3:Step 3:todo')

  // Several completed: the last one is current, the one before it is previous even though it changed too.
  const c = report(doc([' ', ' ', ' ', ' ']), doc(['x', 'x', 'x', ' ']))!
  check('several completed → the last is current; previous is its neighbour (also changed)', tl(c.previous) === '2:Step 2:done*' && tl(c.current) === '3:Step 3:done*' && tl(c.next) === '4:Step 4:todo')
  check('every completion is listed in roadmap order', same(c.changes.map((x) => x.label), ['Step 1', 'Step 2', 'Step 3']))

  // Completion outranks starting.
  const c2 = report(doc([' ', ' ', ' ']), doc(['x', '~', ' ']))!
  check('a completed step outranks a started one for "current"', tl(c2.current) === '1:Step 1:done*' && tl(c2.next) === '2:Step 2:active*')

  // Nothing changed: where the roadmap stands.
  const d1 = report(doc(['x', '~', ' ']), doc(['x', '~', ' ']))!
  check('no change → current is the step in progress; nothing listed as changed', tl(d1.current) === '2:Step 2:active' && tl(d1.previous) === '1:Step 1:done' && tl(d1.next) === '3:Step 3:todo' && d1.changes.length === 0)
  check('no change → progress before equals progress after', same(d1.before, d1.progress))
  const d2 = report(doc(['x', 'x', ' ', ' ']), doc(['x', 'x', ' ', ' ']))!
  check('no change and nothing in progress → current is the first step not started', tl(d2.current) === '3:Step 3:todo' && tl(d2.previous) === '2:Step 2:done' && tl(d2.next) === '4:Step 4:todo')
  const d3 = report(doc(['x', 'x']), doc(['x', 'x']))!
  check('everything done → current is the final step, no next, 100%', tl(d3.current) === '2:Step 2:done' && d3.next === undefined && d3.progress.percent === 100)

  // Whether a report is produced at all.
  check('roadmap untouched by a direct answer → no report', report(doc(['x', ' ']), doc(['x', ' ']), false) === undefined)
  check('roadmap edited by a direct answer → report', report(doc(['x', ' ']), doc(['x', 'x']), false)?.progress.percent === 100)
  check('a workspace without any roadmap → no report', buildRoadmapReport({ before: [], after: [], delegated: true }) === undefined)
  check(
    'a "roadmap" file with no status markers → no report',
    buildRoadmapReport({ before: [], after: [{ path: 'ROADMAP.md', content: '# Roadmap\nWe will build things.' }], delegated: true }) === undefined,
  )

  // Created by the run.
  const e = report(null, doc([' ', ' ', ' ']))!
  check('roadmap created in the run → no "before", no changes, starts at the first step', e.before === undefined && e.changes.length === 0 && tl(e.current) === '1:Step 1:todo' && e.previous === undefined)
  const e2 = report('# Roadmap\nJust notes so far.\n', doc(['x', ' ']))!
  check('a notes-only file that gained steps counts as created too', e2.before === undefined && e2.progress.total === 2)

  // Boundaries.
  const f = report(doc([' ', ' ']), doc([' ', ' ']))!
  check('first step current → no previous', f.previous === undefined && tl(f.current) === '1:Step 1:todo' && tl(f.next) === '2:Step 2:todo')
  const g = report(doc(['x', '~']), doc(['x', 'x']))!
  check('last step completed → no next, roadmap at 100%', g.next === undefined && tl(g.current) === '2:Step 2:done*' && g.progress.percent === 100)
  const h = report(doc([' ', 'x', ' ']), doc(['x', 'x', ' ']))!
  check('"next" skips steps that are already done', tl(h.current) === '1:Step 1:done*' && tl(h.next) === '3:Step 3:todo', tl(h.next))
  check('"previous" is the immediate neighbour even when it was skipped', tl(report(doc([' ', ' ', ' ']), doc([' ', ' ', 'x']))!.previous) === '2:Step 2:todo')

  // Matching steps across edits.
  const j = report('## A\n- [~] Ship it\n', '## B\n- [x] Ship it\n')!
  check('a step moved to another section is still the same step', same(j.changes, [{ label: 'Ship it', from: 'active', to: 'done' }]), JSON.stringify(j.changes))
  const k = report(doc(['x', ' ']), '# Roadmap\n\n- [x] Step 1\n- [ ] Brand new\n')!
  check(
    'added and removed steps are reported',
    same(k.changes, [{ label: 'Brand new', from: 'new', to: 'todo' }, { label: 'Step 2', from: 'todo', to: 'removed' }]),
    JSON.stringify(k.changes),
  )
  const l = report(doc(['x', 'x']), doc(['x', ' ']))!
  check('a reopened step becomes current and progress goes down', tl(l.current) === '2:Step 2:todo*' && l.progress.done === 1 && l.before?.done === 2)
  const dup = report('- [ ] Write tests\n- [ ] Write tests\n', '- [x] Write tests\n- [ ] Write tests\n')!
  check('duplicate labels are matched in order', same(dup.changes, [{ label: 'Write tests', from: 'todo', to: 'done' }]) && dup.current?.index === 1, JSON.stringify(dup.changes))

  // Which file, when there are several.
  const multi = buildRoadmapReport({
    before: [{ path: 'ROADMAP.md', content: doc([' ', ' ']) }, { path: 'docs/roadmap.md', content: doc([' ', ' ']) }],
    after: [{ path: 'ROADMAP.md', content: doc([' ', ' ']) }, { path: 'docs/roadmap.md', content: doc(['x', ' ']) }],
    delegated: true,
  })
  check('the roadmap the run changed wins over one it left alone', multi?.path === 'docs/roadmap.md', multi?.path)
  const multi2 = buildRoadmapReport({
    before: [],
    after: [{ path: 'docs/roadmap.md', content: doc([' ']) }, { path: 'MILESTONES.md', content: doc([' ']) }, { path: 'ROADMAP.md', content: doc([' ']) }],
    delegated: true,
  })
  check('otherwise the shallowest wins, ROADMAP before MILESTONES', multi2?.path === 'ROADMAP.md', multi2?.path)

  // Rounding and wording.
  check('percentages round to whole numbers', report(doc([' ', ' ', ' ']), doc(['x', ' ', ' ']))!.progress.percent === 33 && report(doc([' ', ' ', ' ']), doc(['x', 'x', ' ']))!.progress.percent === 67)
  check('a very long change list is capped', report(doc(Array(60).fill(' ')), doc(Array(60).fill('x')))!.changes.length <= 30)
  check('screen-reader summary names the percentage and the current step', describeRoadmapReport(a) === 'Roadmap 60% complete, 3 of 5 steps done. Current step: Step 3.', describeRoadmapReport(a))
}

function testRoadmapPersistence() {
  console.log('roadmap report persistence:')
  const good: RoadmapReport = {
    path: 'ROADMAP.md',
    title: 'Roadmap',
    previous: { index: 2, label: 'Step 2', status: 'done' },
    current: { index: 3, label: 'Step 3', status: 'done', changed: true, group: 'M1' },
    next: { index: 4, label: 'Step 4', status: 'todo' },
    progress: { done: 3, active: 0, total: 5, percent: 60 },
    before: { done: 2, active: 1, total: 5, percent: 40 },
    changes: [{ label: 'Step 3', from: 'active', to: 'done' }],
  }
  const conv = (roadmap: unknown) => ({
    id: 'c1',
    title: 't',
    createdAt: 1,
    updatedAt: 1,
    messages: [
      {
        id: 'm1',
        role: 'assistant',
        conversationId: 'c1',
        content: 'final answer',
        createdAt: 1,
        status: 'complete',
        agent: { phase: 'complete', goal: 'g', orchestratorModelId: 'mock-pro', steps: [], startedAt: 1, roadmap },
      },
    ],
  })
  const parse = (roadmap: unknown) => conversationSchema.safeParse(conv(roadmap))

  check('a report is a valid schema value', roadmapReportSchema.safeParse(good).success)
  const ok = parse(good)
  const back = ok.success ? ok.data.messages[0]?.agent?.roadmap : undefined
  check(
    'a stored report survives a reload with every field intact',
    ok.success && sameData(back, good),
    JSON.stringify(back),
  )

  const broken = parse({ path: 'ROADMAP.md', progress: 'lots' })
  check(
    'a malformed report is dropped on its own — the conversation still loads',
    broken.success && broken.data.messages[0]?.content === 'final answer' && broken.data.messages[0]?.agent?.roadmap === undefined,
    JSON.stringify(broken.success ? broken.data : broken.error.issues.slice(0, 2)),
  )
  const badStatus = parse({ ...good, current: { ...good.current, status: 'nope' } })
  check('an unknown step status also drops just the report', badStatus.success && badStatus.data.messages[0]?.agent?.roadmap === undefined)
  const outOfRange = parse({ ...good, progress: { ...good.progress, percent: 240 } })
  check('an impossible percentage is rejected', outOfRange.success && outOfRange.data.messages[0]?.agent?.roadmap === undefined)
  check('conversations saved before this feature (no report) still load', parse(undefined).success)
  const extra = parse({ ...good, futureField: 1 })
  check('unknown extra keys are stripped, not fatal', extra.success && extra.data.messages[0]?.agent?.roadmap?.path === 'ROADMAP.md')
}

function testRoadmapUi() {
  console.log('roadmap timeline UI:')
  const html = (r: RoadmapReport) => renderToString(createElement(RoadmapTimeline, { report: r })).replace(/<!-- -->/g, '')
  const A: RoadmapReport = {
    path: 'ROADMAP.md',
    title: 'Slade Roadmap',
    previous: { index: 3, label: 'Supported-providers dialog', status: 'done', group: 'Milestone 2 — Providers' },
    current: { index: 4, label: 'Delete-provider flow', status: 'done', group: 'Milestone 2 — Providers', changed: true },
    next: { index: 5, label: 'Per-provider key testing', status: 'todo', group: 'Milestone 2 — Providers' },
    progress: { done: 4, active: 0, total: 7, percent: 57 },
    before: { done: 3, active: 1, total: 7, percent: 43 },
    changes: [{ label: 'Delete-provider flow', from: 'active', to: 'done' }],
  }
  const a = html(A)
  check('shows previous, current and next steps in that order', ['Previous', 'Current', 'Next'].every((w) => a.includes(w)) && a.indexOf('Supported-providers dialog') < a.indexOf('Delete-provider flow') && a.indexOf('Delete-provider flow') < a.indexOf('Per-provider key testing'))
  check('the current step is marked for assistive tech', a.includes('aria-current="step"') && /aria-current="step"[^>]*>[\s\S]*?Delete-provider flow/.test(a))
  check('overall progress is a labelled progressbar with the numbers', a.includes('role="progressbar"') && a.includes('aria-valuenow="57"') && a.includes('4 of 7 steps done') && a.includes('57%'))
  check('run delta and the change list are shown', a.includes('+1 step this run') && a.includes('was 43%') && a.includes('Marked done') && a.includes('Delete-provider flow'))
  check('each step states its status in words, and flags this run\'s change', a.includes('Done · this run') && a.includes('Not started'))
  check('steps show their milestone and position', a.includes('Milestone 2 — Providers') && a.includes('step 4 of 7'))
  check('the connector is solid where travelled and dashed ahead', a.includes('roadmap-link is-travelled') && a.includes('roadmap-link is-ahead'))
  check('offers to open the roadmap file, naming it for screen readers', a.includes('aria-label="Open ROADMAP.md in Local Files"'))

  const first = html({ path: 'ROADMAP.md', current: { index: 1, label: 'One', status: 'active' }, next: { index: 2, label: 'Two', status: 'todo' }, progress: { done: 0, active: 1, total: 2, percent: 0 }, before: { done: 0, active: 1, total: 2, percent: 0 }, changes: [] })
  check('first step: no previous node, in-progress state is drawn', !first.includes('slot-previous') && first.includes('roadmap-dot-half') && first.includes('1 in progress'))
  check('untouched roadmap says so plainly', first.includes('No step changed status in this run') && !first.includes('this run ·'))

  const done = html({ path: 'ROADMAP.md', previous: { index: 1, label: 'One', status: 'done' }, current: { index: 2, label: 'Two', status: 'done', changed: true }, progress: { done: 2, active: 0, total: 2, percent: 100 }, before: { done: 1, active: 0, total: 2, percent: 50 }, changes: [{ label: 'Two', from: 'todo', to: 'done' }] })
  check('complete roadmap: no next node, completion styling and note', !done.includes('slot-next') && done.includes('is-complete') && done.includes('Every step on the roadmap is done.'))

  const created = html({ path: 'ROADMAP.md', current: { index: 1, label: 'One', status: 'todo' }, progress: { done: 0, active: 0, total: 1, percent: 0 }, changes: [] })
  check('roadmap created by the run is called out', created.includes('created in this run') && !created.includes('was 0%'))

  const many = html({ ...A, changes: ['a', 'b', 'c', 'd', 'e', 'f'].map((label) => ({ label, from: 'todo' as const, to: 'done' as const })) })
  check('long change lists collapse to "+N more"', many.includes('+2 more') && !many.includes('>e<'))

  const back = html({ ...A, before: { done: 5, active: 0, total: 7, percent: 71 }, changes: [{ label: 'X', from: 'active', to: 'todo' }, { label: 'Y', from: 'done', to: 'active' }] })
  check('going backwards is shown as a decrease, with "Reopened" / "Set back" wording', back.includes('−1 step this run') && back.includes('is-negative') && back.includes('Set back') && back.includes('Reopened'))

  // Inside a message: a completion footer after the final report, and only when the run is done.
  const base = { id: 'm', role: 'assistant' as const, conversationId: 'c', content: 'Final report text.', createdAt: Date.now(), status: 'complete' as const, modelId: 'mock-pro' }
  const agent = { phase: 'complete' as const, goal: 'g', orchestratorModelId: 'mock-pro', steps: [], startedAt: 1, finishedAt: 2, roadmap: A }
  const done1 = renderToString(createElement(MessageBubble, { message: { ...base, agent } })).replace(/<!-- -->/g, '')
  check('an orchestrated message renders the timeline after its final report', done1.includes('roadmap-card') && done1.indexOf('Final report text.') < done1.indexOf('roadmap-card'))
  const live = renderToString(createElement(MessageBubble, { message: { ...base, status: 'streaming' as const, agent: { ...agent, phase: 'synthesizing' as const } } })).replace(/<!-- -->/g, '')
  check('no timeline while the run is still going', !live.includes('roadmap-card'))
  const none = renderToString(createElement(MessageBubble, { message: { ...base, agent: { ...agent, roadmap: undefined } } })).replace(/<!-- -->/g, '')
  check('no timeline when no roadmap was used', !none.includes('roadmap-card') && none.includes('agent-plan'))
}

function testRoadmapContextPriority() {
  console.log('roadmap in the agent context:')
  useFs.getState().clearAll()
  useFs.getState().writeFile('ROADMAP.md', '# Roadmap\n- [x] one\n- [ ] two\n', { source: { origin: 'user' } })
  // Busier files, written later and big enough to eat the whole 32k context budget.
  const t0 = Date.now()
  while (Date.now() === t0) { /* make sure the next writes are strictly newer */ }
  for (let i = 1; i <= 5; i++) useFs.getState().writeFile(`src/big${i}.ts`, `// file ${i}\n${'x'.repeat(12_000)}`, { source: { origin: 'user' } })

  const ctx = formatFsContextForAgent(useFs.getState().listFiles())
  check('the roadmap is in the context even when newer, bigger files fill the budget', ctx.includes('--- local file: ROADMAP.md') && ctx.includes('- [ ] two'))
  check('the roadmap is the first file in the context', ctx.indexOf('--- local file: ') === ctx.indexOf('--- local file: ROADMAP.md'))
  const hinted = formatFsContextForAgent(useFs.getState().listFiles(), { queryHint: 'please look at src/big1.ts' })
  check('a file the prompt names still comes first', hinted.indexOf('--- local file: src/big1.ts') < hinted.indexOf('--- local file: ROADMAP.md'))

  // The orchestrator rewrites a roadmap as a whole file, so it has to see all of it.
  const longRoadmap = (n: number) => `# Roadmap\n${Array.from({ length: n }, (_, i) => `- [ ] Step number ${i + 1} of the plan`).join('\n')}\n`
  useFs.getState().clearAll()
  useFs.getState().writeFile('ROADMAP.md', longRoadmap(500), { source: { origin: 'user' } }) // ~17k chars: over the usual 12k cap
  useFs.getState().writeFile('src/long.ts', 'x'.repeat(20_000), { source: { origin: 'user' } })
  const long = formatFsContextForAgent(useFs.getState().listFiles())
  check('a roadmap longer than the usual per-file cap still arrives whole', long.includes('Step number 500 of the plan') && !/ROADMAP\.md \([^)]*truncated/.test(long))
  check('ordinary files keep the usual cap and are flagged when cut', /src\/long\.ts \([^)]*truncated/.test(long))
  useFs.getState().writeFile('ROADMAP.md', longRoadmap(2000), { source: { origin: 'user' } }) // ~68k chars: beyond any allowance
  const huge = formatFsContextForAgent(useFs.getState().listFiles())
  check('an enormous roadmap is cut off and clearly flagged as truncated', /ROADMAP\.md \([^)]*, truncated\)/.test(huge) && !huge.includes('Step number 2000 of the plan'))
  check('an explicit per-file cap is still honoured for roadmaps', /ROADMAP\.md \([^)]*, truncated\)/.test(formatFsContextForAgent(useFs.getState().listFiles(), { maxFileChars: 50 })))
  useFs.getState().clearAll()
}

/**
 * Run `fn` with the chain replaced by one scripted OpenRouter-style model.
 * Replies are consumed from `script` by role: the planner, the workers and the
 * synthesizer are told apart by the markers in their system prompts.
 */
async function withScriptedAgent<T>(
  script: { plans: string[]; workers: string[]; synths: string[] },
  fn: (ctx: { seen: { kind: 'plan' | 'work' | 'synth'; sys: string }[] }) => Promise<T>,
): Promise<T> {
  const seen: { kind: 'plan' | 'work' | 'synth'; sys: string }[] = []
  const fake = await startFakeProvider({
    '/v1beta/chat/completions': (body) => {
      const messages = (body.messages as { role: string; content: string }[]) ?? []
      const sys = messages.find((m) => m.role === 'system')?.content ?? ''
      const kind = sys.includes('[SLADE:ORCHESTRATOR:PLAN]') ? 'plan' : sys.includes('[SLADE:ORCHESTRATOR:SYNTH]') ? 'synth' : 'work'
      seen.push({ kind, sys })
      const queue = kind === 'plan' ? script.plans : kind === 'synth' ? script.synths : script.workers
      return { status: 200, sse: orTextStream(queue.shift() ?? `(no scripted ${kind} reply)`) }
    },
  })
  const settings = useSettings.getState()
  settings.setProvider('openrouter', { apiKey: 'sk-or-fake-key' })
  settings.addModel(openrouterModel(fake.base))
  settings.setModel('mock-pro', { enabled: false })
  settings.setModel('mock-lite', { enabled: false })
  settings.pin('openrouter-test')
  settings.setAgent({ maxParallel: 1, useLocalFs: true })
  useHealth.getState().markHealthy('openrouter-test')
  try {
    return await fn({ seen })
  } finally {
    settings.removeModel('openrouter-test')
    settings.pin(undefined)
    settings.setModel('mock-pro', { enabled: true, simulate: 'ok' })
    settings.setModel('mock-lite', { enabled: true, simulate: 'ok' })
    settings.setAgent({ maxParallel: 2, useLocalFs: true })
    useHealth.getState().markHealthy('mock-pro')
    useHealth.getState().markHealthy('mock-lite')
    fake.close()
  }
}

const onePlan = (title: string, prompt: string) =>
  JSON.stringify({ mode: 'plan', reply: 'One step.', subtasks: [{ title, model: '', prompt }] })

async function testRoadmapSimulator() {
  console.log('built-in simulator plays along with the roadmap:')
  const lite: ModelDef = { id: 'mock-lite', label: 'Simulacron Lite', provider: 'mock', apiModel: 'simulacron-lite', enabled: true }
  const synth = async (systemPrompt: string) => {
    const out: string[] = []
    await mockAdapter.run({
      model: lite,
      turns: [{ role: 'user', text: 'Goal: ship the report\n\nSubtask results from the worker models:\n\n## [1] Build it — Simulacron Lite\n\nok\n\nAssemble the final answer now.' }],
      systemPrompt,
      temperature: 0.7,
      maxTokens: 4096,
      topP: 1,
      stream: true,
      apiKey: '',
      signal: new AbortController().signal,
      onEvent: (ev) => {
        if (ev.type === 'delta') out.push(ev.text)
      },
    })
    return out.join('')
  }
  // The synthesis system prompt as the engine builds it: marker + workspace context.
  const contextFor = (files: Record<string, string>, opts?: { maxFileChars?: number }) => {
    useFs.getState().clearAll()
    for (const [path, content] of Object.entries(files)) useFs.getState().writeFile(path, content, { source: { origin: 'user' } })
    return `[SLADE:ORCHESTRATOR:SYNTH]\n\n${formatFsContextForAgent(useFs.getState().listFiles(), opts)}`
  }

  const roadmap = '# Roadmap\n\n- [x] Alpha\n- [~] Beta\n- [ ] Gamma\n'
  const reply = await synth(contextFor({ 'ROADMAP.md': roadmap, 'src/a.ts': 'export {}' }))
  check('with a roadmap in the workspace it ticks the first open step and says so', reply.includes('### Roadmap') && reply.includes('Marked **Beta** done'), reply.slice(-300))
  const write = extractFsActions(reply).find((a) => a.op === 'write' && a.path === 'ROADMAP.md')
  check(
    '…by emitting the whole updated file, as a real orchestrator is told to',
    write?.op === 'write' && write.content.includes('- [x] Alpha') && write.content.includes('- [x] Beta') && write.content.includes('- [ ] Gamma'),
    JSON.stringify(write),
  )
  check('without a roadmap it says nothing about one', !(await synth(contextFor({ 'src/a.ts': 'export {}' }))).includes('### Roadmap'))
  check('a truncated roadmap is never rewritten', !(await synth(contextFor({ 'ROADMAP.md': roadmap }, { maxFileChars: 12 }))).includes('### Roadmap'))
  check('a finished roadmap is left alone', !(await synth(contextFor({ 'ROADMAP.md': '- [x] a\n- [x] b\n' }))).includes('### Roadmap'))
  check('a roadmap without task-list lines is left alone', !(await synth(contextFor({ 'ROADMAP.md': '| M | Status |\n|---|---|\n| M1 | Planned |\n' }))).includes('### Roadmap'))
  useFs.getState().clearAll()
}

async function testRoadmapAgentRun() {
  console.log('roadmap timeline (orchestrated runs, scripted models):')
  useFs.getState().clearAll()
  const script = { plans: [] as string[], workers: [] as string[], synths: [] as string[] }

  await withScriptedAgent(script, async ({ seen }) => {
    const v1 = ['# Roadmap', '', '## Milestone 1 — Reports', '- [x] Streaming', '- [~] Report card', '- [ ] Roadmap timeline', '- [ ] Docs', ''].join('\n')
    const v2 = v1.replace('- [~] Report card', '- [x] Report card').replace('- [ ] Roadmap timeline', '- [~] Roadmap timeline')
    const roadmapText = () => useFs.getState().readFile('ROADMAP.md')?.content ?? ''
    const html = (m: Parameters<typeof MessageBubble>[0]['message']) => renderToString(createElement(MessageBubble, { message: m })).replace(/<!-- -->/g, '')
    useFs.getState().writeFile('ROADMAP.md', v1, { source: { origin: 'user' } })
    useFs.getState().writeFile('src/report.ts', 'export const report = () => ""\n', { source: { origin: 'user' } })
    const plan = onePlan('Build the report card', 'Update src/report.ts to render the completion report.')

    /* ---- run 1: the run advances the roadmap ---- */
    script.plans.push(plan)
    script.workers.push(`Updated the report:\n\n${fileBlock('ts:src/report.ts', 'export const report = () => "done"')}`)
    script.synths.push(`SUMMARY\nBuilt the report card.\n\nROADMAP\nReport card is done; the timeline is next.\n\n${fileBlock('markdown:ROADMAP.md', v2)}`)
    freshAgentConversation()
    await sendUserMessage('Implement the completion report card', [])
    const msg1 = lastAssistant()
    const run1 = msg1.agent!
    check('run completed', msg1.status === 'complete' && run1?.phase === 'complete', `${msg1.status}/${run1?.phase}: ${msg1.error ?? ''}`)
    check(
      'the planner reads the roadmap from the workspace and is told to tie its plan to it',
      seen[0]?.kind === 'plan' && seen[0].sys.includes('- [~] Report card') && seen[0].sys.includes('tie the plan to the step or steps it advances'),
    )
    check('workers are told to leave the roadmap to the orchestrator', seen[1]?.kind === 'work' && seen[1].sys.includes('Do not edit roadmap or milestone files'))
    check(
      'the synthesizer gets the new report headings and the roadmap-update contract',
      seen[2]?.kind === 'synth' && seen[2].sys.includes('SUMMARY\nISSUES\nIMPLEMENTED') && seen[2].sys.includes('ROADMAP UPDATE.') && seen[2].sys.includes('- [~] Report card') && seen[2].sys.includes('If the roadmap is shown as truncated, never rewrite it'),
    )
    check(
      'the updated roadmap was written to the local file system',
      roadmapText().includes('- [x] Report card') && roadmapText().includes('- [~] Roadmap timeline') && useFs.getState().readFile('ROADMAP.md')?.version === 2,
      roadmapText(),
    )
    check('the run recorded the roadmap write', Boolean(run1.fsOps?.some((o) => o.path === 'ROADMAP.md' && o.op === 'update')), JSON.stringify(run1.fsOps))

    const r1 = run1.roadmap
    check('the run carries a roadmap report', Boolean(r1), JSON.stringify(r1))
    check(
      'timeline: previous is Streaming, current is the step just finished, next is the one it started',
      tl(r1?.previous) === '1:Streaming:done' && tl(r1?.current) === '2:Report card:done*' && tl(r1?.next) === '3:Roadmap timeline:active*',
      `${tl(r1?.previous)} | ${tl(r1?.current)} | ${tl(r1?.next)}`,
    )
    check(
      'overall progress moved from 25% to 50%',
      same(r1?.before, { done: 1, active: 1, total: 4, percent: 25 }) && same(r1?.progress, { done: 2, active: 1, total: 4, percent: 50 }),
      JSON.stringify([r1?.before, r1?.progress]),
    )
    check(
      'the changes made to the roadmap are listed',
      same(r1?.changes, [
        { label: 'Report card', from: 'active', to: 'done' },
        { label: 'Roadmap timeline', from: 'todo', to: 'active' },
      ]),
      JSON.stringify(r1?.changes),
    )
    check('the step\'s milestone travels with it', r1?.current?.group === 'Milestone 1 — Reports')

    await new Promise((r) => setTimeout(r, 600)) // let the 350ms persist debounce flush
    const stored = z.array(conversationSchema).safeParse(JSON.parse(localStorage.getItem('slade.conversations.v1') ?? '[]'))
    const storedReport = stored.success ? stored.data.flatMap((c) => c.messages).find((m) => m.agent?.roadmap)?.agent?.roadmap : undefined
    check('the report is persisted with the message and survives validation', stored.success && storedReport?.current?.label === 'Report card' && storedReport.progress.percent === 50, JSON.stringify(stored.success ? storedReport : stored.error.issues.slice(0, 2)))
    const page1 = html(msg1)
    check('the message renders the timeline under its final report', page1.includes('roadmap-card') && page1.includes('aria-valuenow="50"') && page1.includes('Done · this run') && page1.includes('Roadmap timeline'))

    /* ---- run 2: a delegated run that leaves the roadmap alone ---- */
    script.plans.push(plan)
    script.workers.push('Nothing here touches the roadmap.')
    script.synths.push('SUMMARY\nNothing to record on the roadmap.')
    freshAgentConversation()
    await sendUserMessage('Tidy up the report code', [])
    const msg2 = lastAssistant()
    const r2 = msg2.agent?.roadmap
    check('the next run\'s planner sees the roadmap as the previous run left it', seen[3]?.kind === 'plan' && seen[3].sys.includes('- [x] Report card'))
    check(
      'a delegated run that never touches the roadmap still reports where it stands',
      Boolean(r2) && tl(r2?.previous) === '2:Report card:done' && tl(r2?.current) === '3:Roadmap timeline:active' && tl(r2?.next) === '4:Docs:todo' && r2?.changes.length === 0 && same(r2?.before, r2?.progress),
      `${tl(r2?.previous)} | ${tl(r2?.current)} | ${tl(r2?.next)}`,
    )
    check('…and the card says no step changed', html(msg2).includes('No step changed status in this run'))

    /* ---- run 3: a greeting next to the roadmap ---- */
    script.plans.push(JSON.stringify({ mode: 'answer', answer: 'Hi there!' }))
    freshAgentConversation()
    await sendUserMessage('hello', [])
    const msg3 = lastAssistant()
    check('a greeting answered directly, with the roadmap untouched, gets no report', msg3.status === 'complete' && msg3.agent?.steps.length === 0 && msg3.agent?.roadmap === undefined)

    /* ---- run 4: a direct answer that edits the roadmap ---- */
    const v3 = v2.replace('- [~] Roadmap timeline', '- [x] Roadmap timeline')
    script.plans.push(JSON.stringify({ mode: 'answer', answer: `Marked the timeline step done.\n\n${fileBlock('markdown:ROADMAP.md', v3)}` }))
    freshAgentConversation()
    await sendUserMessage('Mark the roadmap timeline step as done', [])
    const msg4 = lastAssistant()
    const r4 = msg4.agent?.roadmap
    check(
      'a direct answer that edits the roadmap still gets a report',
      msg4.agent?.steps.length === 0 && Boolean(r4) && tl(r4?.current) === '3:Roadmap timeline:done*' && r4?.progress.percent === 75,
      JSON.stringify(r4),
    )

    /* ---- run 5: the run creates the roadmap ---- */
    useFs.getState().deleteFile('ROADMAP.md')
    script.plans.push(plan)
    script.workers.push('Drafted the plan.')
    script.synths.push(`SUMMARY\nCreated a roadmap.\n\n${fileBlock('markdown:ROADMAP.md', ['# Roadmap', '', '- [ ] Scaffold', '- [ ] Ship', ''].join('\n'))}`)
    freshAgentConversation()
    await sendUserMessage('Create a roadmap for the project', [])
    const r5 = lastAssistant().agent?.roadmap
    check(
      'a roadmap the run created is reported as new: no "before", no changes, starts at step 1',
      Boolean(r5) && r5?.before === undefined && r5?.changes.length === 0 && tl(r5?.current) === '1:Scaffold:todo' && r5?.progress.total === 2,
      JSON.stringify(r5),
    )

    /* ---- run 6: local file system switched off ---- */
    useSettings.getState().setAgent({ useLocalFs: false })
    script.plans.push(plan)
    script.workers.push('ok')
    script.synths.push('SUMMARY\nDone.')
    freshAgentConversation()
    await sendUserMessage('Do a thing', [])
    check(
      'with the local file system off there is no roadmap context and no report',
      lastAssistant().agent?.roadmap === undefined && !seen[seen.length - 1]!.sys.includes('LOCAL FILE SYSTEM WORKSPACE'),
    )
    useSettings.getState().setAgent({ useLocalFs: true })
  })
  useFs.getState().clearAll()
}

async function testRoadmapFromGitHub() {
  console.log('roadmap from a connected GitHub repository:')
  useFs.getState().clearAll()
  const token = 'ghp_' + 'r'.repeat(24)
  const remoteRoadmap = '# Roadmap\n\n- [x] Foundation\n- [~] Provider dialog\n- [ ] Agent mode\n'
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
    '/repos/octo/demo/branches': () => ({ status: 200, json: [{ name: 'main', commit: { sha: 'head_sha_1' } }] }),
    '/repos/octo/demo/git/trees/main': () => ({
      status: 200,
      json: {
        truncated: false,
        tree: [
          { path: 'ROADMAP.md', mode: '100644', type: 'blob', sha: 'sha_rm_1', size: remoteRoadmap.length },
          { path: 'src/app.ts', mode: '100644', type: 'blob', sha: 'sha_app_1', size: 20 },
        ],
      },
    }),
    '/repos/octo/demo/contents/ROADMAP.md': () => ({
      status: 200,
      json: {
        type: 'file',
        name: 'ROADMAP.md',
        path: 'ROADMAP.md',
        sha: 'sha_rm_1',
        size: remoteRoadmap.length,
        encoding: 'base64',
        content: Buffer.from(remoteRoadmap).toString('base64'),
      },
    }),
  })
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('https://api.github.com')) return realFetch(url.replace('https://api.github.com', fakeGh.base), init)
    return realFetch(url, init)
  }) as typeof fetch

  try {
    useGitHub.setState({ token, login: 'octo', authStatus: 'authorized', scopes: ['repo'], repos: [], tree: undefined, preview: undefined })
    const opened = await useGitHub.getState().openRepo('octo/demo', { branch: 'main' })
    check('openRepo loads octo/demo@main', opened === true && useGitHub.getState().tree?.entries.length === 2)

    const sync = (hint: string) => useGitHub.getState().syncRepoFilesForPrompt(hint)
    const pulled = await sync('please refactor the parser')
    check(
      'the repo roadmap is pulled into the workspace although the prompt never names it',
      pulled.length === 1 && pulled[0]?.path === 'ROADMAP.md' && useFs.getState().readFile('ROADMAP.md')?.content === remoteRoadmap,
      JSON.stringify(pulled.map((f) => f.path)),
    )
    const pulledFile = useFs.getState().readFile('ROADMAP.md')
    check('…as a synced remote file, not a local modification', pulledFile?.remote?.repo === 'octo/demo' && pulledFile.dirty === false)
    check('files the prompt does not need are not pulled', !useFs.getState().exists('src/app.ts'))
    check('a roadmap already in the workspace is not pulled again', (await sync('anything else')).length === 0)
    useFs.getState().deleteFile('ROADMAP.md')
    check('a roadmap the user deleted locally is not silently pulled back', (await sync('anything')).length === 0 && !useFs.getState().exists('ROADMAP.md'))
    useFs.setState({ deletedRemotes: {} })
    check('an empty prompt still pulls the roadmap when it is missing', (await sync('')).length === 1)

    // The whole loop: an agent run picks the repo roadmap up itself, plans with it and updates it.
    useFs.getState().clearAll()
    const script = { plans: [] as string[], workers: [] as string[], synths: [] as string[] }
    await withScriptedAgent(script, async ({ seen }) => {
      const updated = remoteRoadmap.replace('- [~] Provider dialog', '- [x] Provider dialog')
      script.plans.push(onePlan('Finish the dialog', 'Finish the provider dialog.'))
      script.workers.push('Implemented the dialog.')
      script.synths.push(`SUMMARY\nDone.\n\n${fileBlock('markdown:ROADMAP.md', updated)}`)
      freshAgentConversation()
      await sendUserMessage('Finish the provider dialog', [])
      const r = lastAssistant().agent?.roadmap
      check('the agent pulled the repo roadmap on its own and planned with it', seen[0]?.kind === 'plan' && seen[0].sys.includes('- [~] Provider dialog'), seen[0]?.sys.slice(-200))
      check(
        'the run reports the repo roadmap: Foundation → Provider dialog (just finished) → Agent mode, 33% → 67%',
        tl(r?.previous) === '1:Foundation:done' && tl(r?.current) === '2:Provider dialog:done*' && tl(r?.next) === '3:Agent mode:todo' && r?.before?.percent === 33 && r?.progress.percent === 67,
        JSON.stringify(r),
      )
      const file = useFs.getState().readFile('ROADMAP.md')
      check(
        'the updated roadmap is a pending change to the repo file, ready to commit',
        file?.dirty === true && file.remote?.repo === 'octo/demo' && file.content.includes('- [x] Provider dialog'),
        JSON.stringify({ dirty: file?.dirty, remote: file?.remote?.repo }),
      )
    })
  } finally {
    globalThis.fetch = realFetch
    useFs.getState().clearAll()
    useGitHub.getState().signOut()
    fakeGh.close()
  }
}

/* ------------------------------------------------------------------ */
/* Conversation menu: rename + archive                                  */
/* ------------------------------------------------------------------ */

const convFixture = (id: string, title: string, updatedAt: number, extra: Partial<Conversation> = {}): Conversation => ({
  id,
  title,
  createdAt: updatedAt,
  updatedAt,
  messages: [],
  ...extra,
})

const chatMessage = (conversationId: string, role: 'user' | 'assistant', content: string): Message => ({
  id: `${conversationId}-${role}-${content.length}`,
  role,
  conversationId,
  content,
  createdAt: 1,
  status: 'complete',
})

/** Replace the store's conversations with `list` (same order) and open `openId`. */
function seedConversations(list: Conversation[], openId?: string) {
  useChat.getState().clearAllConversations()
  // importConversations puts each newcomer first, so feed the list back to front.
  useChat.getState().importConversations([...list].reverse())
  if (openId !== undefined) useChat.getState().selectConversation(openId)
}

function testConversationHelpers() {
  console.log('conversation helpers (titles · hydrate · schema · menu placement):')

  /* --- normalizeTitle ---------------------------------------------------- */
  check('normalizeTitle collapses runs of spaces, newlines and tabs', normalizeTitle('  a \n b\t\tc  ') === 'a b c', normalizeTitle('  a \n b\t\tc  '))
  check('normalizeTitle: blank → "" (which means "keep the old title")', normalizeTitle('  \n\t ') === '' && normalizeTitle('') === '')
  check('normalizeTitle leaves an ordinary title alone', normalizeTitle('Trip planning: Lisbon') === 'Trip planning: Lisbon')
  check(`normalizeTitle caps at ${MAX_TITLE_LENGTH} characters`, normalizeTitle('x'.repeat(500)).length === MAX_TITLE_LENGTH)
  const emoji = normalizeTitle('😀'.repeat(400))
  check(
    'normalizeTitle cuts by code point, never through the middle of an emoji',
    Array.from(emoji).length === MAX_TITLE_LENGTH && Array.from(emoji).every((c) => c === '😀') && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji),
  )
  check(
    'normalizeTitle trims a space exposed by the cut',
    normalizeTitle('a'.repeat(MAX_TITLE_LENGTH - 1) + ' tail') === 'a'.repeat(MAX_TITLE_LENGTH - 1),
  )

  /* --- firstActiveId ----------------------------------------------------- */
  const rec = { a: convFixture('a', 'A', 30, { archived: true }), b: convFixture('b', 'B', 20), c: convFixture('c', 'C', 10) }
  check('firstActiveId skips archived conversations', firstActiveId(['a', 'b', 'c'], rec) === 'b')
  check('firstActiveId honours `except`', firstActiveId(['a', 'b', 'c'], rec, 'b') === 'c')
  check('firstActiveId → "" when everything is archived or excluded', firstActiveId(['a'], rec) === '' && firstActiveId(['b'], rec, 'b') === '')
  check('firstActiveId ignores ids missing from the record', firstActiveId(['ghost', 'c'], rec) === 'c')

  /* --- hydrateConversations ---------------------------------------------- */
  const asStored = (list: unknown[]) => JSON.parse(JSON.stringify(list)) as unknown
  const legacy = hydrateConversations(asStored([convFixture('old', 'Legacy', 5), convFixture('new', 'Newer', 9)]))
  check(
    'a conversation saved before archiving existed loads as active',
    legacy.conversations.old?.archived === undefined && legacy.order.join() === 'new,old' && legacy.currentId === 'new',
  )
  const interruptedMessage: Message = {
    id: 'msg_interrupted',
    role: 'assistant',
    conversationId: 'interrupted',
    content: '',
    createdAt: 10,
    status: 'streaming',
    agent: {
      phase: 'synthesizing',
      goal: 'test interrupted activity',
      orchestratorModelId: 'mock-pro',
      steps: [],
      startedAt: 10,
      timeline: [
        { id: 'thought_live', type: 'thought', sourceId: 'synthesis', modelId: 'mock-pro', text: 'still thinking', streaming: true },
        {
          id: 'gha_live',
          type: 'github',
          card: {
            id: 'gha_live', kind: 'get-file', title: 'GitHub Action: Get File Contents', subject: '/src/a.ts',
            status: 'running', at: 11, count: 1,
          },
        },
      ],
    },
  }
  const interrupted = hydrateConversations(asStored([convFixture('interrupted', 'Interrupted', 10, { messages: [interruptedMessage] })]))
  const restored = interrupted.conversations.interrupted?.messages[0]
  check(
    'reload closes live thought cards and preserves interrupted GitHub cards as cancelled',
    restored?.status === 'cancelled' && restored.agent?.timeline?.[0]?.type === 'thought' &&
      !restored.agent.timeline[0].streaming && restored.agent.timeline[1]?.type === 'github' &&
      restored.agent.timeline[1].card.status === 'cancelled',
  )
  const newestArchived = hydrateConversations(asStored([convFixture('old', 'Old', 5), convFixture('arch', 'Newest but archived', 99, { archived: true })]))
  check(
    'startup opens the newest ACTIVE conversation, not an archived one',
    newestArchived.currentId === 'old' && newestArchived.order[0] === 'arch' && newestArchived.conversations.arch?.archived === true,
    JSON.stringify({ cur: newestArchived.currentId, order: newestArchived.order }),
  )
  const allArchived = hydrateConversations(asStored([convFixture('x', 'X', 5, { archived: true })]))
  check('everything archived → no open conversation (the empty state)', allArchived.currentId === '' && allArchived.order.join() === 'x')
  const mangledList = asStored([convFixture('m', 'Mangled', 9), convFixture('n', 'Fine', 4)]) as Array<Record<string, unknown>>
  mangledList[0]!.archived = 'yes please'
  const mangled = hydrateConversations(mangledList)
  check(
    'a mangled archived flag degrades to "active" and keeps EVERY conversation',
    mangled.order.length === 2 && mangled.conversations.m?.archived === undefined && mangled.currentId === 'm',
    JSON.stringify(mangled.order),
  )
  check('archived:false (e.g. from an export) means active', hydrateConversations(asStored([convFixture('f', 'False', 5, { archived: false })])).currentId === 'f')
  check(
    'garbage in storage → empty state, no throw',
    hydrateConversations('nope').order.length === 0 && hydrateConversations(null).currentId === '' && hydrateConversations([{ id: 1 }]).order.length === 0,
  )

  /* --- schema ------------------------------------------------------------ */
  const base = { id: 'c', title: 't', createdAt: 1, updatedAt: 1, messages: [] }
  const withFlag = (archived: unknown) => conversationSchema.safeParse({ ...base, archived })
  check('schema keeps archived:true', withFlag(true).success && withFlag(true).data?.archived === true)
  check('schema keeps archived:false', withFlag(false).data?.archived === false)
  const absent = conversationSchema.safeParse(base)
  check('schema: an absent flag stays absent', absent.success && !('archived' in absent.data))
  const bad = withFlag('yes')
  check('schema: a mangled flag is dropped but the conversation still parses', bad.success && bad.data.archived === undefined)
  const bundle = exportBundleSchema.safeParse({ app: 'slade', version: 1, exportedAt: 1, conversations: [{ ...base, archived: true }] })
  check('an export bundle round-trips archived', bundle.success && bundle.data.conversations?.[0]?.archived === true, JSON.stringify(bundle.error?.issues.slice(0, 2)))

  /* --- placeMenu --------------------------------------------------------- */
  const VP = { width: 1000, height: 700 }
  const MENU = { width: 200, height: 80 }
  const rectAt = (left: number, top: number, w = 30, h = 30) => ({ left, top, right: left + w, bottom: top + h })

  const below = placeMenu({ kind: 'rect', rect: rectAt(100, 50) }, MENU, VP)
  check('a button with room below: the menu drops just under it, left edges aligned', below.left === 100 && below.top === 50 + 30 + MENU_GAP && !below.flipped, JSON.stringify(below))
  const endAligned = placeMenu({ kind: 'rect', rect: rectAt(400, 50), align: 'end' }, MENU, VP)
  check('align "end" lines the right edges up', endAligned.left === 430 - 200 && endAligned.top === below.top, JSON.stringify(endAligned))
  const low = placeMenu({ kind: 'rect', rect: rectAt(100, 640) }, MENU, VP)
  check('too low to drop down → flips above the button', low.flipped && low.top === 640 - MENU_GAP - MENU.height, JSON.stringify(low))
  const shortMoreBelow = placeMenu({ kind: 'rect', rect: rectAt(100, 10, 30, 20) }, MENU, { width: 1000, height: 100 })
  check('fits nowhere, more room below → stays below but is pulled back on-screen', !shortMoreBelow.flipped && shortMoreBelow.top === 100 - 80 - MENU_MARGIN, JSON.stringify(shortMoreBelow))
  const shortMoreAbove = placeMenu({ kind: 'rect', rect: rectAt(100, 80, 30, 16) }, MENU, { width: 1000, height: 100 })
  check('fits nowhere, more room above → flips and is pulled back on-screen', shortMoreAbove.flipped && shortMoreAbove.top === MENU_MARGIN, JSON.stringify(shortMoreAbove))
  check('a button hanging off the left edge is clamped to the margin', placeMenu({ kind: 'rect', rect: rectAt(-50, 50) }, MENU, VP).left === MENU_MARGIN)
  check('a button at the far right is clamped so the menu stays inside', placeMenu({ kind: 'rect', rect: rectAt(950, 50, 40) }, MENU, VP).left === 1000 - 200 - MENU_MARGIN)
  check('align "end" near the left edge is clamped to the margin', placeMenu({ kind: 'rect', rect: rectAt(0, 50), align: 'end' }, MENU, VP).left === MENU_MARGIN)

  const pt = placeMenu({ kind: 'point', x: 100, y: 100 }, MENU, VP)
  check('right-click: the menu corner sits on the pointer', pt.left === 100 && pt.top === 100 && !pt.flipped)
  const ptRight = placeMenu({ kind: 'point', x: 900, y: 100 }, MENU, VP)
  check('right-click near the right edge mirrors to the pointer’s left', ptRight.left === 700 && ptRight.top === 100, JSON.stringify(ptRight))
  const ptBottom = placeMenu({ kind: 'point', x: 100, y: 650 }, MENU, VP)
  check('right-click near the bottom mirrors upward', ptBottom.top === 570 && ptBottom.flipped, JSON.stringify(ptBottom))
  const ptCorner = placeMenu({ kind: 'point', x: 990, y: 690 }, MENU, VP)
  check('right-click in the corner mirrors both ways', ptCorner.left === 790 && ptCorner.top === 610, JSON.stringify(ptCorner))
  const tiny = placeMenu({ kind: 'point', x: 10, y: 10 }, MENU, { width: 150, height: 50 })
  check('a window smaller than the menu: the top-left edge wins, no NaN', tiny.left === MENU_MARGIN && tiny.top === MENU_MARGIN, JSON.stringify(tiny))

  // Property check: wherever a button or the pointer is, a menu that fits ends up fully inside the window.
  let seed = 12345
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  let escaped = 0
  let notBelow = 0
  let cases = 0
  for (let i = 0; i < 3000; i++) {
    const vw = 300 + rnd() * 1500
    const vh = 200 + rnd() * 900
    const mw = 120 + rnd() * 200
    const mh = 40 + rnd() * 150
    if (mw > vw - 2 * MENU_MARGIN || mh > vh - 2 * MENU_MARGIN) continue
    cases++
    const x = rnd() * vw
    const y = rnd() * vh
    const w = 16 + rnd() * 60
    const h = 16 + rnd() * 30
    const anchor: MenuAnchor =
      rnd() < 0.5
        ? { kind: 'point', x, y }
        : { kind: 'rect', rect: { left: x, top: y, right: x + w, bottom: y + h }, align: rnd() < 0.5 ? 'start' : 'end' }
    const p = placeMenu(anchor, { width: mw, height: mh }, { width: vw, height: vh })
    const inside = p.left >= MENU_MARGIN - 1e-9 && p.top >= MENU_MARGIN - 1e-9 && p.left + mw <= vw - MENU_MARGIN + 1e-9 && p.top + mh <= vh - MENU_MARGIN + 1e-9
    if (!inside) escaped++
    if (anchor.kind === 'rect' && anchor.rect.bottom + MENU_GAP + mh <= vh - MENU_MARGIN) {
      if (p.flipped || Math.abs(p.top - (anchor.rect.bottom + MENU_GAP)) > 1e-9) notBelow++
    }
  }
  check(`${cases} random anchors: the menu always lands fully inside the window`, escaped === 0, `${escaped} escaped`)
  check('…and a button with room below always gets the menu directly below it', notBelow === 0, `${notBelow} misplaced`)

  /* --- ensureConversation (the panel always has a chat to append to) ------ */
  const ensure = () => useChat.getState().ensureConversation()
  const chatState = () => useChat.getState()

  seedConversations([convFixture('a', 'Alpha', 30), convFixture('b', 'Beta', 20)], 'a')
  check(
    'ensureConversation returns the open chat and creates nothing',
    ensure() === 'a' && chatState().order.join() === 'a,b' && chatState().conversations.a?.title === 'Alpha',
  )

  seedConversations([convFixture('a', 'Alpha', 30)], '')
  const created = ensure()
  check(
    'with nothing open — the last chat deleted or archived — it creates one',
    created !== '' && chatState().currentId === created && chatState().conversations[created]?.messages.length === 0,
    JSON.stringify({ created, order: chatState().order }),
  )
  check('…and handing the id back stays stable on the next call', ensure() === created)

  useChat.setState({ currentId: 'ghost' })
  const recovered = ensure()
  check(
    'a dangling currentId is replaced, never handed back',
    recovered !== 'ghost' && Boolean(chatState().conversations[recovered]),
    JSON.stringify({ recovered, order: chatState().order }),
  )
}

async function testConversationArchive() {
  console.log('archive · rename (store):')
  const T0 = 1_000_000
  const list = () => [
    convFixture('a', 'Alpha', T0 + 4),
    convFixture('b', 'Beta', T0 + 3),
    convFixture('c', 'Gamma', T0 + 2),
    convFixture('d', 'Delta', T0 + 1),
  ]
  const st = () => useChat.getState()
  const conv = (id: string) => useChat.getState().conversations[id]
  const hasFlag = (id: string) => Boolean(conv(id) && 'archived' in conv(id)!)

  /* --- archive ------------------------------------------------------------ */
  seedConversations(list(), 'a')
  check('seed: order and open chat are as expected', st().order.join() === 'a,b,c,d' && st().currentId === 'a')
  st().archiveConversation('c')
  check('archive sets the flag', conv('c')?.archived === true)
  check('archive keeps the order (it stays in the list, just not in the main group)', st().order.join() === 'a,b,c,d')
  check('archive is not chat activity: updatedAt is untouched', conv('c')?.updatedAt === T0 + 2, String(conv('c')?.updatedAt))
  check('archiving a chat that is not open leaves the open chat open', st().currentId === 'a')
  const snapshot = st().conversations
  st().archiveConversation('c')
  check('archiving twice is a no-op (same state object)', st().conversations === snapshot)
  st().archiveConversation('nope')
  check('archiving an unknown id is a no-op', st().conversations === snapshot)

  st().archiveConversation('a')
  check('archiving the OPEN chat moves the view to the next active one', st().currentId === 'b', st().currentId)
  st().archiveConversation('b')
  check('…skipping archived chats (c is archived) → d', st().currentId === 'd', st().currentId)
  st().archiveConversation('d')
  check('archiving the last active chat leaves no open chat (the empty state)', st().currentId === '')
  check('all four are flagged', ['a', 'b', 'c', 'd'].every((id) => conv(id)?.archived === true))

  /* --- unarchive ---------------------------------------------------------- */
  st().unarchiveConversation('c')
  check('unarchive removes the flag entirely (not archived:false)', conv('c') !== undefined && !hasFlag('c'))
  check('unarchive keeps updatedAt', conv('c')?.updatedAt === T0 + 2)
  check('unarchiving does not open the chat', st().currentId === '')
  const beforeNoop = st().conversations
  st().unarchiveConversation('c')
  check('unarchiving an active chat is a no-op', st().conversations === beforeNoop)

  /* --- rename ------------------------------------------------------------- */
  seedConversations(list(), 'a')
  st().renameConversation('b', '  New\n name  ')
  check('rename normalises whitespace', conv('b')?.title === 'New name', conv('b')?.title)
  check('rename is not chat activity: updatedAt is untouched', conv('b')?.updatedAt === T0 + 3)
  check('rename does not reorder the list', st().order.join() === 'a,b,c,d')
  const renamed = st().conversations
  st().renameConversation('b', '   ')
  check('a blank name is ignored', conv('b')?.title === 'New name' && st().conversations === renamed)
  st().renameConversation('b', 'New name')
  check('renaming to the same name is a no-op', st().conversations === renamed)
  st().renameConversation('ghost', 'x')
  check('renaming an unknown id is a no-op', st().conversations === renamed)
  st().renameConversation('b', 'y'.repeat(300))
  check(`an over-long name is capped at ${MAX_TITLE_LENGTH}`, conv('b')?.title.length === MAX_TITLE_LENGTH)
  st().renameConversation('c', 'Renamed and archived')
  st().archiveConversation('c')
  check('an archived chat can be renamed and stays archived', conv('c')?.title === 'Renamed and archived' && conv('c')?.archived === true)

  /* --- writing to an archived chat ---------------------------------------- */
  seedConversations(list(), 'a')
  st().archiveConversation('c')
  st().appendMessage(chatMessage('c', 'assistant', 'a late reply'))
  check('a reply landing after the user archived the chat does NOT un-archive it', conv('c')?.archived === true)
  st().appendMessage(chatMessage('c', 'user', 'hello again'))
  check('a new USER message brings an archived chat back to the main list', conv('c') !== undefined && !hasFlag('c'))
  check('…and that is activity: updatedAt moves forward', (conv('c')?.updatedAt ?? 0) > T0 + 2)
  check('…with every message kept', conv('c')?.messages.length === 2)

  /* --- delete / import ------------------------------------------------------ */
  seedConversations(list(), 'b')
  st().archiveConversation('a')
  st().deleteConversation('b')
  check('deleting the open chat falls back to an ACTIVE one, never an archived one', st().currentId === 'c', st().currentId)
  st().deleteConversation('a')
  check('deleting an archived chat leaves the open chat alone', st().currentId === 'c')
  seedConversations([convFixture('x', 'X', 5, { archived: true }), convFixture('y', 'Y', 4)], 'y')
  st().deleteConversation('y')
  check('deleting the last active chat opens nothing when only archived ones remain', st().currentId === '')

  st().clearAllConversations()
  st().importConversations([convFixture('i1', 'I1', 5, { archived: true })])
  check('importing only archived chats opens nothing', st().currentId === '')
  st().importConversations([convFixture('i2', 'I2', 6)])
  check('…and then importing an active one opens it', st().currentId === 'i2')

  /* --- persistence ---------------------------------------------------------- */
  seedConversations(list(), 'a')
  st().archiveConversation('b')
  await new Promise((r) => setTimeout(r, 500)) // the store persists on a 350ms debounce
  const stored = () => JSON.parse(localStorage.getItem('slade.conversations.v1') ?? '[]') as Conversation[]
  check(
    'the archived flag is written to storage',
    stored().find((c) => c.id === 'b')?.archived === true && stored().find((c) => c.id === 'a')?.archived === undefined,
  )
  const reloaded = hydrateConversations(stored())
  check('…and survives a reload', reloaded.conversations.b?.archived === true && reloaded.currentId === 'a')
  check('…without changing its time', reloaded.conversations.b?.updatedAt === T0 + 3)
  st().unarchiveConversation('b')
  await new Promise((r) => setTimeout(r, 500))
  check('un-archiving removes the flag from storage too', !('archived' in stored().find((c) => c.id === 'b')!))
  check('storage still validates against the schema', z.array(conversationSchema).safeParse(stored()).success)
  st().clearAllConversations()
}

/**
 * Server rendering reads each store's *initial* state (see testGitHubUiRenders), so
 * mirror the live chat and UI state into it for one render, then put it back.
 */
function renderWithLiveState(el: Parameters<typeof renderToString>[0]): string {
  const stores = [useChat, useUI] as const
  const inits = stores.map((st) => st.getInitialState() as unknown as Record<string, unknown>)
  const originals = inits.map((init) => ({ ...init }))
  stores.forEach((st, n) => Object.assign(inits[n]!, st.getState()))
  try {
    return renderToString(el).replace(/<!-- -->/g, '')
  } finally {
    inits.forEach((init, n) => {
      for (const k of Object.keys(init)) delete init[k]
      Object.assign(init, originals[n])
    })
  }
}

function testConversationMenuUi() {
  console.log('conversation menu UI:')
  const html = renderWithLiveState
  const T0 = 1_000_000
  const tag = (markup: string, cls: string) => new RegExp(`<button[^>]*class="${cls}"[^>]*>`).exec(markup)?.[0] ?? ''
  const tags = (markup: string, cls: string) => markup.match(new RegExp(`<button[^>]*class="[^"]*${cls}[^"]*"[^>]*>`, 'g')) ?? []

  /* --- sidebar -------------------------------------------------------------- */
  seedConversations(
    [
      convFixture('a', 'Alpha chat', T0 + 4),
      convFixture('b', 'Beta <img src=x onerror=alert(1)>', T0 + 3),
      convFixture('c', 'Gamma archived', T0 + 2, { archived: true }),
      convFixture('d', 'Delta archived', T0 + 1, { archived: true }),
    ],
    'a',
  )
  const side = html(createElement(Sidebar))
  check('the main list shows the active chats', side.includes('Alpha chat') && side.includes('Beta '))
  check('archived chats are not in the main list', !side.includes('Gamma archived') && !side.includes('Delta archived'))
  const head = tag(side, 'conv-group-head')
  check('an Archived group is offered, with a spoken count', head.includes('aria-label="Archived, 2 conversations"'), head)
  check('…collapsed by default, wired to its list', head.includes('aria-expanded="false"') && head.includes('aria-controls="conv-archived-list"'))
  check('…and clickable when not searching', !head.includes('disabled'))
  check('the count is shown', /conv-count">2</.test(side))

  const options = tags(side, 'conv-menu-btn')
  check('each visible row has an options button', options.length === 2, String(options.length))
  check('…that announces a menu popup, closed', options.every((b) => b.includes('aria-haspopup="menu"') && b.includes('aria-expanded="false"')))
  check('…and says which conversation it belongs to', options[0]?.includes('aria-label="Options for Alpha chat"') === true, options[0])
  check('each row also has its own delete button', tags(side, 'conv-delete').length === 2)
  check('rows are containers with sibling buttons, not role="button" wrappers around buttons', !side.includes('role="button"'))
  check('exactly the open chat is marked aria-current', (side.match(/aria-current="true"/g) ?? []).length === 1)
  check('titles are escaped: no markup gets injected', !side.includes('<img') && side.includes('Beta &lt;img'))

  seedConversations([convFixture('x', 'Only archived', T0, { archived: true })])
  const allArchived = html(createElement(Sidebar))
  check('everything archived → says so and still offers the group', allArchived.includes('Everything is archived.') && allArchived.includes('conv-group-head'))
  useChat.getState().clearAllConversations()
  check('no conversations → the plain empty message', html(createElement(Sidebar)).includes('No conversations yet.'))

  /* --- header ---------------------------------------------------------------- */
  seedConversations([convFixture('a', 'Alpha chat', T0 + 4), convFixture('c', 'Gamma archived', T0 + 2, { archived: true })], 'a')
  const header = html(createElement(Header))
  const titleBtn = tag(header, 'header-title-btn')
  check('the header name is a button that announces a menu', titleBtn.includes('aria-haspopup="menu"') && titleBtn.includes('aria-expanded="false"'), titleBtn)
  check('…named for the conversation', titleBtn.includes('aria-label="Conversation options: Alpha chat"'))
  check('an active chat has no Archived badge', !header.includes('header-badge'))
  useChat.getState().selectConversation('c')
  const archivedHeader = html(createElement(Header))
  check('an archived chat that is open shows the Archived badge', archivedHeader.includes('header-badge') && archivedHeader.includes('>Archived<'))
  useChat.getState().clearAllConversations()
  const noneHeader = html(createElement(Header))
  check('no conversation → a plain "Slade" title and no menu button', !noneHeader.includes('header-title-btn') && noneHeader.includes('>Slade<'))

  /* --- archive with undo (toasts) ---------------------------------------------- */
  const toasts = () => useUI.getState().toasts
  seedConversations([convFixture('a', 'Alpha chat', T0 + 4), convFixture('b', 'Beta', T0 + 3), convFixture('c', 'A'.repeat(90), T0 + 2)], 'a')
  useUI.setState({ toasts: [] })
  archiveWithUndo('a')
  const t1 = toasts()[0]
  check('archiving raises a success toast', toasts().length === 1 && t1?.kind === 'success' && t1.title === 'Conversation archived')
  check('…that says which chat and where it went', t1?.detail?.includes('“Alpha chat”') === true && t1.detail.includes('Archived in the sidebar'), t1?.detail)
  check('…with an Undo action', t1?.action?.label === 'Undo')
  check('the open chat moved on to the next one', useChat.getState().currentId === 'b')
  t1?.action?.onClick()
  check('Undo restores the chat AND the view (it was the open one)', useChat.getState().conversations.a?.archived === undefined && useChat.getState().currentId === 'a')

  useUI.setState({ toasts: [] })
  archiveWithUndo('b')
  useChat.getState().selectConversation('c') // the user moved on before pressing Undo
  toasts()[0]?.action?.onClick()
  check('Undo for a chat that was not open does not yank the view back', useChat.getState().conversations.b?.archived === undefined && useChat.getState().currentId === 'c')

  useUI.setState({ toasts: [] })
  archiveWithUndo('c')
  const longDetail = toasts()[0]?.detail ?? ''
  check('a long title is shortened inside the toast', longDetail.includes('…') && longDetail.length < 90, longDetail)

  seedConversations([convFixture('a', 'Alpha', T0 + 2), convFixture('b', 'Beta', T0 + 1)], 'a')
  useUI.setState({ toasts: [] })
  archiveWithUndo('a')
  useChat.getState().deleteConversation('a')
  toasts()[0]?.action?.onClick()
  check('Undo after the chat was deleted does nothing, and never points the view at a ghost', !useChat.getState().conversations.a && useChat.getState().currentId === 'b')

  useUI.setState({ toasts: [] })
  archiveWithUndo('b')
  archiveWithUndo('b')
  archiveWithUndo('ghost')
  check('archiving twice, or an unknown id, raises no extra toast', toasts().length === 1)
  useUI.setState({ toasts: [] })
  unarchiveWithToast('nope')
  check('unarchiving an unknown or active chat is a no-op', toasts().length === 0)
  unarchiveWithToast('b')
  check('unarchive raises a plain confirmation without an Undo', toasts()[0]?.title === 'Conversation restored' && toasts()[0]?.action === undefined, JSON.stringify(toasts()[0]))

  /* --- the toast component ------------------------------------------------------ */
  useUI.setState({ toasts: [] })
  useUI.getState().toast({ kind: 'success', title: 'With button', action: { label: 'Undo', onClick: () => {} } })
  useUI.getState().toast({ kind: 'info', title: 'Plain' })
  const toastHtml = html(createElement(Toasts))
  check('a toast with an action renders its button', toastHtml.includes('class="toast-action"') && toastHtml.includes('>Undo<'))
  check('a plain toast has none', (toastHtml.match(/toast-action/g) ?? []).length === 1)

  const realSetTimeout = globalThis.setTimeout
  const delays: number[] = []
  ;(globalThis as Record<string, unknown>).setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    delays.push(ms ?? 0)
    return realSetTimeout(fn, ms, ...rest)
  }) as typeof setTimeout
  try {
    useUI.setState({ toasts: [] })
    useUI.getState().toast({ kind: 'success', title: 'a', action: { label: 'Undo', onClick: () => {} } })
    useUI.getState().toast({ kind: 'info', title: 'b' })
    useUI.getState().toast({ kind: 'error', title: 'c' })
  } finally {
    ;(globalThis as Record<string, unknown>).setTimeout = realSetTimeout
  }
  check('a toast with a button lingers like an error (7s) so it can be pressed; a plain one goes at 4.2s', same(delays, [7000, 4200, 7000]), JSON.stringify(delays))

  useUI.setState({ toasts: [] })
  useChat.getState().clearAllConversations()
}

/**
 * The chat panel's own predicate: does the panel hold anything? The composer
 * asks it to choose between the centered greeting and a docked composer above a
 * panel that already has content, so a session whose only content is GitHub
 * cards still gets a panel that scrolls instead of a floating log.
 */
function testChatPanelUi() {
  console.log('chat panel (composer layout gate):')
  const html = renderWithLiveState
  const Probe = () => createElement('span', { 'data-panel': usePanelHasContent() ? 'content' : 'empty' })
  const actInit = useGitHubActivity.getInitialState() as unknown as { entries: unknown[] }
  const card = (id: string, scope?: string) => ({
    id,
    kind: 'get-file',
    title: 'GitHub Action: Get File Contents',
    subject: '/src/a.ts',
    status: 'done',
    at: 1,
    count: 1,
    scope,
  })
  const seedLog = (entries: unknown[]) => {
    actInit.entries = entries
  }
  const label = () => html(createElement(Probe))

  seedConversations([], '')
  seedLog([])
  check('nothing stored: no conversation and no cards → the panel is empty', label() === '<span data-panel="empty"></span>', label())

  seedConversations([convFixture('a', 'Alpha', 10)], 'a')
  check('a conversation with no messages yet is still empty', label() === '<span data-panel="empty"></span>', label())

  seedConversations([convFixture('a', 'Alpha', 10, { messages: [chatMessage('a', 'user', 'hi')] })], 'a')
  seedLog([])
  check('a message makes the panel content, so the composer docks', label() === '<span data-panel="content"></span>', label())

  seedConversations([convFixture('a', 'Alpha', 10)], 'a')
  seedLog([card('gha_1')])
  check('a GitHub action alone makes the panel content (composer docks under it)', label() === '<span data-panel="content"></span>', label())

  seedLog([card('gha_2', 'scope_run_1')])
  check('a run’s card does not: it belongs to its run’s answer, not the panel', label() === '<span data-panel="empty"></span>', label())

  seedLog([card('gha_3', 'scope_run_1'), card('gha_4')])
  check('one session card among a run’s calls is enough', label() === '<span data-panel="content"></span>', label())

  seedLog([])
  useChat.getState().clearAllConversations()
}

/**
 * The chat panel itself, rendered.
 *
 * Virtuoso is generated from a `system()` definition, and its prop setter
 * copies every prop it finds with `'components' in props` — so an explicitly
 * `undefined` `components` prop counts as present, writes `undefined` into the
 * component registry, and the next render of the list reads through it
 * (`u[a]` / "Cannot read properties of undefined"). The panel must always hand
 * Virtuoso a registry object, pending footer or not.
 */
function testChatPanelRenders() {
  console.log('chat panel render (virtuoso component registry):')
  const html = renderWithLiveState
  const actInit = useGitHubActivity.getInitialState() as unknown as { entries: unknown[] }
  const actState = { ...useGitHubActivity.getState() } as unknown as { entries: unknown[] }

  /** Render the panel, reporting a crash as a failed check instead of a stack. */
  const renderPanel = (): { markup: string; error: string } => {
    try {
      return { markup: html(createElement(ChatView)), error: '' }
    } catch (err) {
      return { markup: '', error: err instanceof Error ? err.message : String(err) }
    }
  }

  try {
    const settled: Message = {
      id: 'msg_panel_settled',
      role: 'assistant',
      conversationId: 'conv_render',
      content: 'the panel keeps its messages',
      createdAt: 1,
      status: 'complete',
    }
    const pending: Message = { ...settled, id: 'msg_panel_pending', status: 'pending' }

    // The scroller shell is what the crash took down: the list mounts it, then
    // the component registry is read back. (Rows themselves are measured in the
    // browser, so server rendering legitimately shows an empty item list.)
    const shell = (markup: string) => markup.includes('virtuoso-scroller') && markup.includes('virtuoso-item-list')

    seedConversations([convFixture('conv_render', 'Render', 10, { messages: [settled] })], 'conv_render')
    actInit.entries = []
    const idle = renderPanel()
    check('a settled conversation renders the list without crashing', idle.error === '', idle.error)
    check('…and the panel mounts as content, not the empty state', shell(idle.markup) && !idle.markup.includes('chat-view empty'), idle.markup.slice(0, 160))

    seedConversations([convFixture('conv_render', 'Render', 10, { messages: [pending] })], 'conv_render')
    const waiting = renderPanel()
    check('a pending message renders the list without crashing', waiting.error === '', waiting.error)
    check('…and the typing footer is mounted', waiting.markup.includes('pending-footer'), waiting.markup.slice(0, 160))

    seedConversations([convFixture('conv_render', 'Render', 10, { messages: [settled] })], 'conv_render')
    actInit.entries = [
      { id: 'gha_render', kind: 'get-file', title: 'GitHub Action: Get File Contents', subject: '/src/a.ts', status: 'done', at: 1, count: 1 },
    ]
    const withAction = renderPanel()
    check('an appended action renders the list without crashing', withAction.error === '', withAction.error)
    check('…and the action keeps the panel docked rather than empty', shell(withAction.markup) && !withAction.markup.includes('chat-view empty'), withAction.markup.slice(0, 160))
    check('…and it drops the pending footer again', !withAction.markup.includes('pending-footer'))

    // More than two standalone actions fold into one group row at the end of the list.
    seedConversations([convFixture('conv_render', 'Render', 10, { messages: [settled] })], 'conv_render')
    actInit.entries = ['a', 'b', 'c', 'd'].map((n) => ({
      id: `gha_render_${n}`,
      kind: 'get-file',
      title: 'GitHub Action: Get File Contents',
      subject: `/src/${n}.ts`,
      status: 'done',
      at: 1,
      count: 1,
    }))
    const folded = renderPanel()
    check('a streak of actions folded into a group renders the list without crashing', folded.error === '', folded.error)
    check('…and still keeps the panel docked rather than empty', shell(folded.markup) && !folded.markup.includes('chat-view empty'), folded.markup.slice(0, 160))

    seedConversations([convFixture('conv_render', 'Render', 10, { messages: [settled, pending] })], 'conv_render')
    actInit.entries = []
    const both = renderPanel()
    check('a pending message after a settled one still renders both', both.error === '', both.error)
    check('…with the footer back for the pending turn', both.markup.includes('pending-footer'), both.markup.slice(0, 160))
  } finally {
    useChat.getState().clearAllConversations()
    Object.assign(actInit, actState)
  }
}

/* ------------------------------------------------------------------ */
/* Clarification questions (the agent asks, the user chooses)          */
/* ------------------------------------------------------------------ */

/** Read a message back out of the store, wherever it lives. */
function readMessage(messageId: string): Message | undefined {
  for (const conv of Object.values(useChat.getState().conversations)) {
    const found = conv.messages.find((m) => m.id === messageId)
    if (found) return found
  }
  return undefined
}

/** The last assistant message in the open conversation (`lastAssistant` finds the first). */
function latestAssistant(): Message | undefined {
  const chat = useChat.getState()
  const conv = chat.conversations[chat.currentId]
  return [...(conv?.messages ?? [])].reverse().find((m) => m.role === 'assistant')
}

function testQuestionNormalization() {
  console.log('agent question normalization:')
  const [q] = normalizeQuestions(
    [{ question: ' Which target? ', detail: ' It  changes the plan. ', options: ['Prototype', 'Production', 'prototype'] }],
    'mock-pro',
  )
  check('a usable question survives normalization', Boolean(q))
  check('options get stable ids', Boolean(q?.options.every((o) => o.id.startsWith('opt_'))))
  check('duplicate options collapse case-insensitively', q?.options.length === 2, String(q?.options.length))
  check('whitespace is collapsed in prompt and detail', q?.prompt === 'Which target?' && q?.detail === 'It changes the plan.', q?.detail)
  check('a typed answer is allowed unless the model says otherwise', q?.allowCustom === true)
  check('single choice stays single choice', q?.multiple === false)
  check('the asking model is recorded for attribution', q?.modelId === 'mock-pro')
  check('a fresh question is pending', q?.status === 'pending' && q.answer === undefined)

  const shaped = normalizeQuestions([{ question: 'Q?', options: [{ label: 'A', hint: 'why A' }, { value: 'B' }, 'C'] }])[0]
  check('{label, hint} options keep their hint', shaped?.options[0]?.hint === 'why A')
  check('a {value} option is accepted as a label', shaped?.options[1]?.label === 'B', shaped?.options[1]?.label)
  check('bare strings and objects can be mixed', shaped?.options.length === 3, String(shaped?.options.length))

  check('one option is not a choice', normalizeQuestions([{ question: 'Q?', options: ['Only'] }]).length === 0)
  check('a question with no prompt is dropped', normalizeQuestions([{ options: ['A', 'B'] }]).length === 0)
  check('a question with junk options is dropped', normalizeQuestions([{ question: 'Q?', options: [null, 42, ''] }]).length === 0)
  check('a non-array normalizes to nothing', normalizeQuestions(undefined).length === 0 && normalizeQuestions('nope').length === 0)
  check(
    `at most ${MAX_QUESTIONS_PER_ROUND} questions per round`,
    normalizeQuestions(Array.from({ length: 9 }, (_, i) => ({ question: `Q${i}?`, options: ['A', 'B'] }))).length ===
      MAX_QUESTIONS_PER_ROUND,
  )
  check(
    `option lists are capped at ${MAX_OPTIONS_PER_QUESTION}`,
    normalizeQuestions([{ question: 'Q?', options: Array.from({ length: 14 }, (_, i) => `O${i}`) }])[0]?.options.length ===
      MAX_OPTIONS_PER_QUESTION,
  )
  check('allowCustom:false is honoured', normalizeQuestions([{ question: 'Q?', options: ['A', 'B'], allowCustom: false }])[0]?.allowCustom === false)
  check('multiple:true survives', normalizeQuestions([{ question: 'Q?', options: ['A', 'B'], multiple: true }])[0]?.multiple === true)
  check('a custom-field label survives', normalizeQuestions([{ question: 'Q?', options: ['A', 'B'], customLabel: 'e.g. "Q2 vs Q2"' }])[0]?.customLabel === 'e.g. "Q2 vs Q2"')
  check('a rambling question is clipped', (normalizeQuestions([{ question: 'x'.repeat(900), options: ['A', 'B'] }])[0]?.prompt.length ?? 0) <= 500)
}

function testQuestionAnswers() {
  console.log('agent question answers:')
  const [q] = normalizeQuestions([{ question: 'Which target?', options: ['Prototype', 'Production'] }], 'mock-pro')
  const proto = q!.options[0]!
  const prod = q!.options[1]!

  const picked = resolveAnswer(q!, { optionIds: [proto.id] })
  check('a picked option becomes the answer text', picked?.text === 'Prototype', picked?.text)
  check('…and records which option it was', picked?.optionIds.join() === proto.id && picked?.labels.join() === 'Prototype')
  check('the other option can be picked too', resolveAnswer(q!, { optionIds: [prod.id] })?.text === 'Production')
  check('nothing picked → no answer', resolveAnswer(q!, { optionIds: [] }) === undefined)
  check('an unknown option id → no answer', resolveAnswer(q!, { optionIds: ['opt_nope'] }) === undefined)

  const typed = resolveAnswer(q!, { optionIds: [], custom: '  A CLI tool with a --json flag  ' })
  check('a typed answer is trimmed and kept', typed?.text === 'A CLI tool with a --json flag' && typed?.custom === typed?.text, typed?.text)
  check('a typed answer names no option', typed?.optionIds.length === 0 && typed?.labels.length === 0)

  const closed = normalizeQuestions([{ question: 'Q?', options: ['A', 'B'], allowCustom: false }])[0]!
  check('a closed question ignores typed text', resolveAnswer(closed, { optionIds: [], custom: 'ignore me' }) === undefined)

  const multi = normalizeQuestions([{ question: 'Which apply?', options: ['Tests', 'Docs', 'Perf'], multiple: true }])[0]!
  const both = resolveAnswer(multi, { optionIds: [multi.options[0]!.id, multi.options[2]!.id], custom: 'and a benchmark' })
  check('multi-select keeps every label plus the typed answer', both?.text === 'Tests, Perf, and a benchmark', both?.text)
  check('…and lists all of them', both?.labels.length === 2 && both?.custom === 'and a benchmark')
}

function testQuestionFormatting() {
  console.log('question prompt formatting:')
  const qs = normalizeQuestions(
    [
      { question: 'Which target?', options: ['Prototype', 'Production'] },
      { question: 'Which apply?', options: ['Tests', 'Docs'], allowCustom: false, multiple: true },
    ],
    'mock-pro',
  )
  const asked = formatQuestionsForModel(qs)
  const lines = asked.split('\n')
  check('the ask is numbered and says what kind of choice it is', lines[0] === '1. Which target? [single choice]', lines[0])
  check('options are listed with the typed escape hatch', lines[1] === '   Options: Prototype | Production | (their own typed answer)', lines[1])
  check('a multi-select question says so', asked.includes('2. Which apply? [multi-select]'), asked)
  check('a closed question does not offer one', !lines[3]!.includes('their own typed answer'), lines[3])

  qs[0]!.status = 'answered'
  qs[0]!.answer = resolveAnswer(qs[0]!, { optionIds: [qs[0]!.options[1]!.id] })
  qs[1]!.status = 'skipped'
  const answers = formatAnswersForModel(qs)
  check('answers are arrowed per question', answers.includes('1. Which target?\n   → Production'), answers)
  check('a skipped question tells the model what to do instead', answers.includes('skipped — use the safest interpretation'), answers)

  const decisions = formatDecisionsForModel(qs)
  check('the decisions block is headed for the model', decisions.startsWith('User decisions'), decisions.slice(0, 60))
  check('…and carries every settled question', decisions.includes('- Which target?\n  → Production') && decisions.includes('- Which apply?'), decisions)
  const pending = normalizeQuestions([{ question: 'Q?', options: ['A', 'B'] }])
  check('pending questions never reach the model', formatDecisionsForModel(pending) === '' && formatDecisionsForModel(undefined) === '')

  check('progress counts settled questions', JSON.stringify(questionProgress(qs)) === '{"resolved":2,"total":2}')
  check('progress on nothing is zero', JSON.stringify(questionProgress(undefined)) === '{"resolved":0,"total":0}')
  check('the next pending question is the first unsettled one', nextPendingQuestion(pending)?.id === pending[0]!.id && nextPendingQuestion(qs) === undefined)
  check('a run may continue only once every question is settled', questionsResolved(qs) && !questionsResolved(pending) && !questionsResolved([]))
}

function testPlannerAskParsing() {
  console.log('planner ask parsing:')
  const ask = parsePlannerReply(
    '{"mode":"ask","reply":"Two decisions.","questions":[{"question":"Which target?","detail":"It changes the plan.","options":["Prototype","Production"],"allowCustom":true,"multiple":false}]}',
  )
  check('ask mode parses', ask?.mode === 'ask')
  check('…and keeps the question and its options', ask?.mode === 'ask' && ask.questions[0]!.question === 'Which target?' && ask.questions[0]!.options.length === 2)
  check('…and the one-line reply', ask?.mode === 'ask' && ask.reply === 'Two decisions.')
  check('{label, hint} options parse', parsePlannerReply('{"mode":"ask","questions":[{"question":"Q?","options":[{"label":"A","hint":"h"},{"label":"B"}]}]}')?.mode === 'ask')
  check('a fence around the ask is tolerated', parsePlannerReply('```json\n{"mode":"ask","questions":[{"question":"Q?","options":["A","B"]}]}\n```')?.mode === 'ask')
  check('prose around the ask is tolerated', parsePlannerReply('Let me ask:\n{"mode":"ask","questions":[{"question":"Q?","options":["A","B"]}]}')?.mode === 'ask')
  check('an ask with no questions is refused', parsePlannerReply('{"mode":"ask","questions":[]}') === undefined)
  check('an ask with no options is refused', parsePlannerReply('{"mode":"ask","questions":[{"question":"Q?","options":[]}]}') === undefined)
  check('a question with no text is refused', parsePlannerReply('{"mode":"ask","questions":[{"options":["A","B"]}]}') === undefined)
  check('a near-JSON ask is still repaired', parsePlannerReply('{"mode":"ask","questions":[{"question":"Q?","options":["A","B"],},]}')?.mode === 'ask')
}

function testAskPromptContract() {
  console.log('ask contract in the prompts:')
  const P = planSystemPrompt(DEFAULT_SETTINGS, DEFAULT_SETTINGS.agent.maxSteps).replace(/\s+/g, ' ')
  check('the planning contract teaches the ask mode', P.includes('{"mode":"ask"'), P.slice(0, 200))
  check('…with options, a typed-answer field and multi-select', P.includes('"options"') && P.includes('"allowCustom"') && P.includes('"multiple"'))
  check('…and carries the ask marker', P.includes(ASK_MARKER))
  check('answers come back marked, so the orchestrator recognises them', P.includes(ANSWERS_MARKER))
  check('questions and options are bounded in the contract itself', P.includes('At most 4 questions per round') && P.includes('2 to 6'), P.slice(0, 200))
  check('the round cap is stated', P.includes('at most 3 rounds'), P.slice(0, 200))
  check('it forbids asking what the context already answers', P.includes('Never ask what the conversation'))
  check('it tells the orchestrator not to ask again once answered', P.includes('do not ask again'))
  check('options must be things a user would say', P.includes('not "Option A"'))

  const role = CODING_AGENT_ORCHESTRATOR_PROMPT.replace(/\s+/g, ' ')
  check('the orchestrator role says to ask in structured choices', role.includes('structured choices'), role.slice(0, 200))
  check('…never as "Option A"/"Option B"', role.includes('never as "Option A"/"Option B"'))
  check('…and a typed escape hatch stays open', role.includes('typed-answer escape hatch'))
  check('answers outrank the orchestrator’s own preference', role.includes('it outranks your own preference'))
  check('a skipped question is not a free choice', role.includes('A question the user skipped is not permission'))
}

function testAgentQuestionUi() {
  console.log('agent question UI rendering:')
  const questions = normalizeQuestions(
    [
      { question: 'Which target should the implementation aim at?', detail: 'It changes the split.', options: [{ label: 'Prototype', hint: 'fast, throwaway' }, 'Production'] },
      { question: 'Which apply?', options: ['Tests', 'Docs'], multiple: true },
      { question: 'Binary only?', options: ['Yes', 'No'], allowCustom: false },
    ],
    'mock-pro',
  ) as AgentQuestion[]
  const run: AgentRun = {
    phase: 'awaiting_input',
    goal: 'ship it',
    orchestratorModelId: 'mock-pro',
    steps: [],
    startedAt: 1,
    questions,
    questionRounds: 1,
    strategy: 'I need three decisions from you.',
  }
  const html = (r: AgentRun) => renderToString(createElement(AgentQuestions, { run: r, messageId: 'm_ask' })).replace(/<!-- -->/g, '')

  const open = html(run)
  check('only the first question is offered', open.split('agent-question-prompt').length - 1 === 1, String(open.split('agent-question-prompt').length - 1))
  check('the group says how far through it is', open.includes('Question 1 of 3'), open.slice(0, 200))
  check('a single choice is a radiogroup', open.includes('role="radiogroup"'), open.slice(0, 200))
  check('options render as unchecked radios', open.includes('role="radio"') && open.includes('aria-checked="false"'))
  check('an option hint is rendered', open.includes('fast, throwaway'), open.slice(0, 300))
  check('the typed-answer option is offered', open.includes('Or type your own answer'), open.slice(0, 400))
  check('the detail explains why it matters', open.includes('It changes the split.'))
  check('submit is disabled until something is chosen', open.includes('disabled=""'), open.slice(0, 400))
  check('skipping is offered too', open.includes('>Skip<'), open.slice(0, 400))
  check('the questions that are not up yet are not rendered', !open.includes('Which apply?') && !open.includes('Binary only?'))
  check('an unanswered run renders no answer card', !open.includes('artifact-card kind-answer'))

  // Multi-select shape.
  const multiRun: AgentRun = { ...run, questions: [questions[1]!] }
  const multi = html(multiRun)
  check('a multi-select question is a checkbox group', multi.includes('role="group"') && multi.includes('role="checkbox"'), multi.slice(0, 200))
  check('…and says every option may apply', multi.includes('Select every option that applies'), multi.slice(0, 300))

  // A question that forbids a typed answer offers none.
  const closedRun: AgentRun = { ...run, questions: [questions[2]!] }
  const closed = html(closedRun)
  check('a closed question offers no typed answer', !closed.includes('type your own answer') && !closed.includes('<textarea'), closed.slice(0, 400))
  check('…and says to choose one option', closed.includes('Choose one option'), closed.slice(0, 300))

  // Answered: the options are gone and the choice is an artifact card.
  questions[0]!.status = 'answered'
  questions[0]!.answer = resolveAnswer(questions[0]!, { optionIds: [questions[0]!.options[0]!.id] })
  questions[0]!.answeredAt = 5
  const answered = html(run)
  check('the answered question became an artifact card', answered.includes('artifact-card kind-answer'), answered.slice(0, 200))
  check('…labelled as the user’s answer', answered.includes('Your answer · Question 1 of 3'), answered.slice(0, 300))
  check('…carrying the chosen option', answered.includes('Prototype'))
  check('the options that were not chosen are removed', !answered.includes('>Production<'), answered.slice(0, 600))
  check('the question itself stays on the card', answered.includes('Which target should the implementation aim at?'))
  check('the next question block rendered underneath', answered.includes('Which apply?') && answered.includes('Question 2 of 3'), answered.slice(0, 200))
  check('…and the answered one left no form behind', answered.split('agent-question-prompt').length - 1 === 1)
  check('a typed answer would be labelled as one', !answered.includes('typed by you'))

  // Typed + skipped shapes.
  questions[1]!.status = 'answered'
  questions[1]!.answer = resolveAnswer(questions[1]!, { optionIds: [], custom: 'Just the numbers' })
  questions[2]!.status = 'skipped'
  questions[2]!.note = 'Superseded by your next message.'
  const settled = html({ ...run, phase: 'complete' })
  check('a typed answer is shown as typed', settled.includes('Just the numbers') && settled.includes('typed by you'), settled.slice(0, 400))
  check('a skipped question renders as skipped', settled.includes('artifact-card kind-answer skipped') && settled.includes('Question skipped'), settled.slice(0, 300))
  check('…and says why', settled.includes('Superseded by your next message.'), settled.slice(0, 400))
  check('a settled run offers no form at all', !settled.includes('agent-question-prompt') && !settled.includes('Submit answer'))
  check('every settled question keeps a card', settled.split('artifact-card kind-answer').length - 1 === 3, String(settled.split('artifact-card kind-answer').length - 1))

  check('a run with no questions renders nothing', html({ ...run, questions: [] }) === '')
  check('questions on a finished run still render their cards', html({ ...run, phase: 'complete' }).includes('artifact-card kind-answer'))
}

async function testAgentAsksAndResumes() {
  console.log('agent asks, the user chooses, the run resumes:')
  useHealth.getState().markHealthy('mock-pro')
  useHealth.getState().markHealthy('mock-lite')
  useSettings.getState().setModel('mock-pro', { simulate: 'ok' })
  useSettings.getState().setModel('mock-lite', { simulate: 'ok' })

  const goal = 'ask me a multiple-choice question about the Q3 sales report'
  freshAgentConversation()
  await sendUserMessage(goal, [])
  const parkedId = latestAssistant()!.id
  const parked = readMessage(parkedId)!
  const run = parked.agent
  const questions = run?.questions ?? []

  check('the turn ended instead of hanging on the user', parked.status === 'complete', `${parked.status}: ${parked.error ?? ''}`)
  check('…and the run is parked waiting for input', run?.phase === 'awaiting_input', String(run?.phase))
  check('questions were recorded on the message', questions.length >= 2, String(questions.length))
  check('every question is still pending', questions.every((q) => q.status === 'pending'))
  check('each question is a real choice', questions.every((q) => q.options.length >= 2 && q.allowCustom))
  check('the orchestrator’s sentence leads the ask', Boolean(run?.strategy), run?.strategy)
  check('the answer body stays empty until the run resumes', parked.content === '', parked.content.slice(0, 80))
  check('nothing is in flight while the user reads', !isGenerating(useChat.getState().currentId))
  check('the active question is the first pending one', activeAgentQuestion(run)?.id === questions[0]?.id)
  check('the ask round was counted', run?.questionRounds === 1, String(run?.questionRounds))

  const markup = (id: string) => renderToString(createElement(MessageBubble, { message: readMessage(id)! })).replace(/<!-- -->/g, '')
  const first = markup(parkedId)
  const [q1, q2] = questions
  check('the plan card says the run is waiting', first.includes('Waiting for you'), first.slice(0, 200))
  check('the first question renders as a form', first.includes('agent-question-prompt') && first.includes('Submit answer'))
  check('…with every option clickable', q1!.options.every((o) => first.includes(o.label)))
  check('…and a typed-answer option', first.includes('Or type your own answer'), first.slice(0, 400))
  check('the next question is not offered yet', !first.includes(q2!.prompt), q2!.prompt)

  check('an empty selection is refused', answerAgentQuestion(parkedId, q1!.id, { optionIds: [] }) === false)
  check('an unknown question is refused', answerAgentQuestion(parkedId, 'q_nope', { optionIds: [q1!.options[0]!.id] }) === false)

  // Answer the first question with an option.
  check('answering records the choice', answerAgentQuestion(parkedId, q1!.id, { optionIds: [q1!.options[0]!.id] }))
  check('answering the same question twice does nothing', answerAgentQuestion(parkedId, q1!.id, { optionIds: [q1!.options[1]!.id] }) === false)
  const after1 = readMessage(parkedId)!
  check('the answer was stored with its text', after1.agent!.questions![0]!.answer?.text === q1!.options[0]!.label, after1.agent!.questions![0]!.answer?.text)
  check('…and stamped', Boolean(after1.agent!.questions![0]!.answeredAt))
  check('the run stays parked while questions remain', after1.agent!.phase === 'awaiting_input', String(after1.agent!.phase))
  check('nothing started streaming yet', !isGenerating(useChat.getState().currentId))

  const second = markup(parkedId)
  check('the answer collapsed into an artifact card', second.includes('artifact-card kind-answer') && second.includes('Your answer · Question 1 of 3'), second.slice(0, 300))
  check('the chosen answer is what remains', second.includes(q1!.options[0]!.label))
  check('the options that were not chosen are gone', !second.includes(q1!.options[1]!.label), q1!.options[1]!.label)
  check('the next question block rendered underneath', second.includes(q2!.prompt) && second.includes('Question 2 of 3'), second.slice(0, 200))
  check('…and exactly one form is open', second.split('agent-question-prompt').length - 1 === 1, String(second.split('agent-question-prompt').length - 1))

  // Answer the rest; the last one with a typed answer, which resumes the run.
  const rest = after1.agent!.questions!.slice(1)
  const typedAnswer = 'Just the numbers, with a one-line takeaway'
  rest.forEach((q, i) => {
    const last = i === rest.length - 1
    answerAgentQuestion(parkedId, q.id, last ? { optionIds: [], custom: typedAnswer } : { optionIds: [q.options[0]!.id] })
  })
  const settling = readMessage(parkedId)!
  check('every question is settled', settling.agent!.questions!.every((q) => q.status !== 'pending'))
  check('the typed answer was kept as typed', settling.agent!.questions!.at(-1)!.answer?.custom === typedAnswer, settling.agent!.questions!.at(-1)!.answer?.text)
  check('answering the last question woke the run up', settling.status === 'pending' || settling.status === 'streaming', settling.status)

  await waitFor(() => {
    const m = readMessage(parkedId)!
    return m.status !== 'pending' && m.status !== 'streaming'
  }, 60_000)
  const done = readMessage(parkedId)!
  check('the resumed run completed', done.status === 'complete', `${done.status}: ${done.error ?? ''}`)
  check('…and is no longer parked', done.agent?.phase === 'complete', String(done.agent?.phase))
  check('it delegated the work it asked about', (done.agent?.steps.length ?? 0) >= 2, String(done.agent?.steps.length))
  check('the plan was built around the answers', (done.agent?.steps ?? []).some((s) => s.title.includes('decisions')), JSON.stringify(done.agent?.steps.map((s) => s.title)))
  check('the final answer arrived on the same message', done.content.length > 50 && done.id === parkedId)
  check('the answer reflects the decisions', done.content.includes('Your decisions'), done.content.slice(0, 240))
  check('the typed answer reached the model', done.content.includes(typedAnswer), done.content.slice(0, 400))
  check('the questions and answers stayed on the run', (done.agent?.questions?.length ?? 0) === questions.length && done.agent!.questions!.every((q) => q.status !== 'pending'))
  check('the goal survived the round trip', done.agent?.goal === goal, done.agent?.goal)
  check('the run did not ask again', done.agent?.questionRounds === 1, String(done.agent?.questionRounds))
  check('the exchange stayed on one message', useChat.getState().conversations[useChat.getState().currentId]!.messages.filter((m) => m.role === 'assistant').length === 1)

  const finished = markup(parkedId)
  check('every settled question renders as an answer card', finished.split('artifact-card kind-answer').length - 1 === questions.length, String(finished.split('artifact-card kind-answer').length - 1))
  check('no form is left open', !finished.includes('Submit answer') && !finished.includes('agent-question-prompt'))
  check('the typed answer is on its card', finished.includes(typedAnswer) && finished.includes('typed by you'))

  // A reload must keep the whole exchange.
  const parsed = conversationSchema.safeParse(JSON.parse(JSON.stringify(useChat.getState().conversations[useChat.getState().currentId])))
  check('the conversation still validates with its questions', parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3)))
  const roundTripped = parsed.success ? (parsed.data as Conversation).messages.find((m) => m.id === parkedId) : undefined
  check('answers survive a persistence round trip', Boolean(roundTripped?.agent?.questions?.length === questions.length && roundTripped.agent!.questions!.every((q) => q.status === 'answered' && Boolean(q.answer?.text))))
  check('the parked phase survives it too', roundTripped?.agent?.phase === 'complete', String(roundTripped?.agent?.phase))
}

async function testAgentQuestionSkip() {
  console.log('agent questions: skipping is an answer too:')
  useHealth.getState().markHealthy('mock-pro')
  useHealth.getState().markHealthy('mock-lite')
  useSettings.getState().setModel('mock-pro', { simulate: 'ok' })
  useSettings.getState().setModel('mock-lite', { simulate: 'ok' })

  freshAgentConversation()
  await sendUserMessage('ask me a multiple-choice question about the release notes', [])
  const parkedId = latestAssistant()!.id
  const questions = readMessage(parkedId)!.agent!.questions!
  check('the simulator asked again for a new run', questions.length >= 1 && readMessage(parkedId)!.agent?.phase === 'awaiting_input')

  check('skipping a question is accepted', skipAgentQuestion(parkedId, questions[0]!.id))
  check('…and cannot be skipped twice', skipAgentQuestion(parkedId, questions[0]!.id) === false)
  check('a skipped question is settled without an answer', readMessage(parkedId)!.agent!.questions![0]!.status === 'skipped' && !readMessage(parkedId)!.agent!.questions![0]!.answer)

  for (const q of readMessage(parkedId)!.agent!.questions!.slice(1)) skipAgentQuestion(parkedId, q.id)
  await waitFor(() => {
    const m = readMessage(parkedId)!
    return m.status !== 'pending' && m.status !== 'streaming'
  }, 60_000)
  const done = readMessage(parkedId)!
  check('skipping the last question resumes the run', done.status === 'complete' && done.agent?.phase === 'complete', `${done.status}/${done.agent?.phase}: ${done.error ?? ''}`)
  check('the model is told a skip means "use the safest interpretation"', done.content.includes('skipped — use the safest interpretation'), done.content.slice(0, 300))
  check('every skipped question still has a card', done.agent!.questions!.every((q) => q.status === 'skipped'))
}

async function testAgentQuestionSuperseded() {
  console.log('agent questions: a composer reply supersedes them:')
  useHealth.getState().markHealthy('mock-pro')
  useHealth.getState().markHealthy('mock-lite')
  useSettings.getState().setModel('mock-pro', { simulate: 'ok' })
  useSettings.getState().setModel('mock-lite', { simulate: 'ok' })

  freshAgentConversation()
  await sendUserMessage('ask me a multiple-choice question about the Q3 sales report', [])
  const convId = useChat.getState().currentId
  const parkedId = latestAssistant()!.id
  check('parked with open questions', readMessage(parkedId)!.agent?.phase === 'awaiting_input')

  // Answering one, then replying in the composer instead of finishing.
  const first = readMessage(parkedId)!.agent!.questions![0]!
  answerAgentQuestion(parkedId, first.id, { optionIds: [first.options[0]!.id] })
  await sendUserMessage('never mind — just generate the CSV', [])

  const parked = readMessage(parkedId)!
  check('the answered question kept its answer', parked.agent!.questions![0]!.status === 'answered')
  check('the open questions were closed out', parked.agent!.questions!.slice(1).every((q) => q.status === 'skipped'), JSON.stringify(parked.agent!.questions!.map((q) => q.status)))
  check('…with a note that says why', parked.agent!.questions!.slice(1).every((q) => (q.note ?? '').includes('Superseded')), JSON.stringify(parked.agent!.questions!.map((q) => q.note)))
  check('the superseded run is no longer waiting', parked.agent?.phase === 'complete', String(parked.agent?.phase))
  check('and the card says what happened', (parked.agent?.note ?? '').includes('before answering every question'), parked.agent?.note)
  const html = renderToString(createElement(MessageBubble, { message: parked })).replace(/<!-- -->/g, '')
  check('no form is offered for a superseded question', !html.includes('Submit answer') && !html.includes('agent-question-prompt'))
  check('the closed question renders as a skipped card', html.includes('artifact-card kind-answer skipped'))
  check('answering a superseded question does nothing', answerAgentQuestion(parkedId, readMessage(parkedId)!.agent!.questions![1]!.id, { optionIds: [] }) === false)
  check('the newer turn ran on its own', latestAssistant()!.id !== parkedId && latestAssistant()!.status === 'complete', String(latestAssistant()?.status))
  check('the newer turn’s answers did not leak into it', !(latestAssistant()!.agent?.questions?.length))

  // Expiring a conversation with nothing pending is a no-op.
  expirePendingAgentQuestions(convId)
  check('expiring twice changes nothing', readMessage(parkedId)!.agent!.questions!.filter((q) => q.status === 'answered').length === 1)
}

async function testAgentAskRefusalBound() {
  console.log('agent questions: an unusable ask is refused, not rendered:')
  const script = { plans: [] as string[], workers: [] as string[], synths: [] as string[] }
  // A "question" with one option is not a choice: rendering it would be a dead
  // end, so the engine refuses it and tells the orchestrator to proceed. This
  // one refuses every time, which is exactly the loop that has to be bounded.
  const stub = '{"mode":"ask","reply":"One decision.","questions":[{"question":"Which target?","options":["Prototype"]}]}'

  await withScriptedAgent(script, async ({ seen }) => {
    script.plans.push(stub, stub, stub, stub, stub, stub)
    script.workers.push('Delivered against the safest interpretation.')
    script.synths.push('SUMMARY\nProceeded with the safest interpretation.\n\nSTATUS\nIN_PROGRESS')
    freshAgentConversation()
    await sendUserMessage('build the thing', [])

    const msg = lastAssistant()
    const run = msg.agent
    const planCalls = seen.filter((s) => s.kind === 'plan').length
    check('the run finished instead of looping forever', msg.status === 'complete' && run?.phase === 'complete', `${msg.status}/${run?.phase}: ${msg.error ?? ''}`)
    check(`planning was re-issued at most ${MAX_ASK_REFUSALS + 1} times`, planCalls === MAX_ASK_REFUSALS + 1, `${planCalls} planning calls`)
    check('no dead-end question reached the user', !run?.questions?.length, String(run?.questions?.length))
    check('the card says the question could not be rendered', (run?.note ?? '').includes('could not render'), run?.note)
    check('…and that Slade ran the task itself after the refusals', (run?.note ?? '').includes('kept asking instead of planning'), run?.note)
    check('it fell back to a single execution step', run?.steps.length === 1 && run.steps[0]!.status === 'complete', JSON.stringify(run?.steps.map((s) => s.status)))
    check('the answer still arrived', msg.content.includes('safest interpretation'), msg.content.slice(0, 120))
  })
}

async function testAgentQuestionRounds() {
  console.log('agent questions: rounds accumulate, then the cap stops it:')
  const script = { plans: [] as string[], workers: [] as string[], synths: [] as string[] }
  const ask = (n: number) =>
    `{"mode":"ask","reply":"Round ${n}.","questions":[{"question":"Round ${n} decision?","options":["A${n}","B${n}"]}]}`

  await withScriptedAgent(script, async ({ seen }) => {
    // Three ask-rounds are granted; the fourth is refused and the run proceeds.
    script.plans.push(ask(1), ask(2), ask(3), ask(4), ask(4), ask(4))
    script.workers.push('Built to the decisions.')
    script.synths.push('SUMMARY\nBuilt to your decisions.\n\nSTATUS\nCOMPLETE')

    freshAgentConversation()
    await sendUserMessage('build the thing', [])
    const parkedId = lastAssistant().id
    const questionsOf = () => readMessage(parkedId)!.agent!.questions ?? []

    for (let round = 1; round <= 3; round++) {
      const qs = questionsOf()
      check(`round ${round}: the run parked on a new question`, readMessage(parkedId)!.agent?.phase === 'awaiting_input' && qs.length === round, `${qs.length} questions`)
      check(`round ${round}: earlier answers are kept alongside it`, qs.slice(0, -1).every((q) => q.status === 'answered' && Boolean(q.answer?.text)))
      check(`round ${round}: the round counter advanced`, readMessage(parkedId)!.agent?.questionRounds === round, String(readMessage(parkedId)!.agent?.questionRounds))
      check(`round ${round}: only the new question is offered`, renderToString(createElement(MessageBubble, { message: readMessage(parkedId)! })).split('agent-question-prompt').length - 1 === 1)
      answerAgentQuestion(parkedId, qs[qs.length - 1]!.id, { optionIds: [qs[qs.length - 1]!.options[1]!.id] })
      await waitFor(() => {
        const agent = readMessage(parkedId)!.agent
        return agent?.phase === 'awaiting_input' ? (agent.questions?.length ?? 0) > round : agent?.phase === 'complete'
      }, 20_000)
    }

    const msg = readMessage(parkedId)!
    const run = msg.agent
    const planCalls = seen.filter((s) => s.kind === 'plan').length
    check('the fourth round was refused at the cap', run?.questionRounds === 3, String(run?.questionRounds))
    check('…and the card says so', (run?.note ?? '').includes('already asked 3 rounds'), run?.note)
    check('the capped run still finished', msg.status === 'complete' && run?.phase === 'complete', `${msg.status}/${run?.phase}: ${msg.error ?? ''}`)
    check('planning was called once per round plus the bounded refusals', planCalls === 3 + MAX_ASK_REFUSALS + 1, `${planCalls} planning calls`)
    check('every answered round is still on the message', run?.questions?.length === 3 && run.questions.every((q) => q.status === 'answered'), JSON.stringify(run?.questions?.map((q) => q.status)))
    check('the later answers are the ones that were picked', run?.questions?.map((q) => q.answer?.text).join() === 'B1,B2,B3', run?.questions?.map((q) => q.answer?.text).join())
    check('all three rounds render as settled cards', renderToString(createElement(MessageBubble, { message: msg })).split('artifact-card kind-answer').length - 1 === 3)
    check('the resumed run delegated and answered', (run?.steps.length ?? 0) >= 1 && msg.content.includes('your decisions'), msg.content.slice(0, 120))
  })
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
  testQuestionNormalization()
  testQuestionAnswers()
  testQuestionFormatting()
  testPlannerAskParsing()
  testAskPromptContract()
  testAgentQuestionUi()
  await testAgentAsksAndResumes()
  await testAgentQuestionSkip()
  await testAgentQuestionSuperseded()
  await testAgentAskRefusalBound()
  await testAgentQuestionRounds()
  testWorkerResolution()
  testRoadmapPaths()
  testRoadmapParsing()
  testRoadmapReport()
  await testAgentMode()
  await testPlannerNearJsonRun()
  await testRoadmapSimulator()
  testRepoIdentifiers()
  await testCommitTreeModes()
  await testGitHubClient()
  await testGitHubErrors()
  await testGitHubRelay()
  await testDeviceFlow()
  testPublishPayloads()
  await testPublishFlow()
  await testRepoContextEndToEnd()
  await testGitHubStoreAgainstFakeApi()
  testGitHubStore()
  await testGitHubActionCards()
  testGitHubActionGroups()
  testGitHubUiRenders()
  testModelPicker()
  testProviderManagement()
  testLocalFsPrimitives()
  testLocalFsStore()
  await testAgentLocalFsIntegration()
  await testRoadmapAgentRun()
  testRoadmapPersistence()
  testRoadmapUi()
  testRoadmapContextPriority()
  testLocalFsUiRenders()
  await testFsArchiveRoundTrip()
  await testGitLocalFsReadWriteAcross()
  await testRoadmapFromGitHub()
  testInlineThoughtsRendering()
  testConversationHelpers()
  await testConversationArchive()
  testConversationMenuUi()
  testChatPanelUi()
  testChatPanelRenders()
  console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} SMOKE TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
