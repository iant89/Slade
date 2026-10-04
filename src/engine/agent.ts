/**
 * The Slade Orchestrator — agent mode.
 *
 * The user talks to exactly one model: the orchestrator. It plans the task,
 * dispatches self-contained subtasks straight to the other models in the
 * chain (each with its own failover walk), and synthesizes the final answer.
 * The user never has to pick a worker model or copy results around — every
 * step of the run is recorded on the message so it stays inspectable.
 *
 * Phases: planning → executing (worker pool) → synthesizing → complete.
 * Every phase rides `runCompletion`, so classification, cooldowns, health
 * tracking and stop/cancel behave exactly like the plain chain.
 */

import type { AgentQuestion, AgentRun, AgentStep, AttemptFailure, ChatTurn, FsOpRecord, Message, ModelDef, RoadmapReport, Settings, Usage } from '../types'
import { z } from 'zod'
import { useChat } from '../store/chat'
import { useSettings } from '../store/settings'
import { useUI } from '../store/ui'
import { useFs } from '../store/fs'
import { useDiskFs, diskWorkspaceContext, applyDiskAgentOutput, workspaceSession, assertWorkspaceSession, type WorkspaceSession } from '../store/diskFs'
import { useGitHub } from '../store/github'
import { formatMemoryContext } from '../store/memory'
import { useGitHubActivity } from '../store/githubActivity'
import { appendAgentThought, closeAgentThought } from '../store/agentTimeline'
import { extractFsActions, formatFsContextForAgent, formatGitHubTreeForAgent } from '../lib/fs'
import { buildRoadmapReport, describeRoadmapReport, snapshotRoadmapFiles, type RoadmapFileSnapshot } from '../lib/roadmap'
import {
  DECISIONS_HEADING,
  MAX_ASK_REFUSALS,
  MAX_QUESTION_ROUNDS,
  MAX_OPTIONS_PER_QUESTION,
  MAX_QUESTIONS_PER_ROUND,
  formatAnswersForModel,
  formatDecisionsForModel,
  formatQuestionsForModel,
  nextPendingQuestion,
  normalizeQuestions,
  questionsResolved,
  resolveAnswer,
  type QuestionSelection,
} from '../lib/questions'
import { buildTurns } from './turns'
import { modelHasKey, newAssistantPlaceholder } from './strategy'
import { announceResponse } from './announce'
import { getRun, finishRun, isGenerating, registerRun } from './active'
import {
  CompletionExhausted,
  modelLabel,
  runCompletion,
  workerCandidates,
  mergeUsage,
} from './completion'
import { ProviderError } from '../providers/base'
import { uid } from '../lib/id'
import { runWorkerCompletion } from './shellCompletion'
import { useShell } from '../lib/shell'
import { CODING_AGENT_ORCHESTRATOR_PROMPT } from './orchestratorPrompt'

/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

function shellAwareOrchestratorPrompt(): string {
  if (!useShell.getState().token) return CODING_AGENT_ORCHESTRATOR_PROMPT
  return CODING_AGENT_ORCHESTRATOR_PROMPT.replace(
    /1\. You have NO shell,[\s\S]*?(?=2\. You have)/,
    `1. Worker steps have an authenticated automatic bash tool in the host checkout ${JSON.stringify(useShell.getState().root)}. Delegate command execution to workers. Planning and synthesis cannot invoke bash directly. Require actual tool results as evidence. The connected Files panel and filename-tagged file blocks use this same disk checkout. Legacy browser files remain separate until explicitly imported. Workers may use bash or final file blocks to edit; do not repeat already-applied changes in synthesis. Commands have host-user permissions, not sandbox isolation. Never read credentials or perform unrelated/destructive operations.\n`,
  )
}

export const PLAN_MARKER = '[SLADE:ORCHESTRATOR:PLAN]'
export const SYNTH_MARKER = '[SLADE:ORCHESTRATOR:SYNTH]'
/**
 * Sentinels the resumed planning turn carries. `ANSWERS_MARKER` tells the
 * runtime (and the simulator, which has to recognise a resume to stop asking)
 * that this user turn is a set of answers to the orchestrator's own questions.
 */
export const ASK_MARKER = '[SLADE:ORCHESTRATOR:ASK]'
export const ANSWERS_MARKER = '[SLADE:ORCHESTRATOR:ANSWERS]'

/** Exported so the smoke test can assert the ask contract the UI renders from. */
export function planSystemPrompt(settings: Settings, maxSteps: number, fsContext = ''): string {
  const workers = settings.models.filter((m) => m.enabled && modelHasKey(settings, m))
  const roster = workers
    .map((m) => {
      const provider = settings.providers.find((p) => p.id === m.provider)
      const bits = [provider?.kind === 'mock' ? 'built-in simulator' : provider?.label ?? m.provider]
      if (m.costPer1kOut != null) bits.push(`$${m.costPer1kOut}/1k out`)
      if (m.contextWindow != null) bits.push(`${Math.round(m.contextWindow / 1000)}k ctx`)
      return `- "${m.label}" (${bits.join(', ')})`
    })
    .join('\n')

  return `${shellAwareOrchestratorPrompt()}

SLADE AGENT-MODE PLANNING CONTRACT

The coding-agent prompt above is your governing role and quality standard. This call is the planning stage of Slade's orchestrator. Slade supplies the conversation, the local file system workspace, and the available worker roster, then dispatches the subtasks you return. ${useShell.getState().token ? "Workers have a live automatic bash tool in the connected host checkout. Delegate checkout edits and tests to workers; require tool evidence. When a task needs any command execution, return a plan with at least one worker, even for a simple task; do not answer as if the command already ran. Filename-tagged file blocks write to the connected disk checkout; legacy browser files are not imported automatically." : "You do not have shell, git, or test-runner tools in this runtime, so never claim that you ran commands or tests or inspected local Git state."}

Slade mounts a persistent LOCAL FILE SYSTEM shared across the orchestrator, all worker steps, and future turns, and bridged directly to the connected GitHub repository when one is open:
- Workers (and you) can create or overwrite files in the local file system by emitting fenced blocks tagged with the target file path: \`\`\`<lang>:<path/to/file.ext> (e.g. \`\`\`typescript:src/index.ts or \`\`\`csv:data/report.csv).
- Workers can pull a file from the connected GitHub repository into the local file system with \`\`\`fs:pull:<path/to/file.ext>, append to a file with \`\`\`fs:append:<path/to/file.ext>, move/rename with \`\`\`fs:move:<old/path> -> <new/path>, or delete with \`\`\`fs:delete:<path/to/file.ext>.
- Files written by completed steps are stored immediately in the local file system, exposed to subsequent worker steps and the synthesis pass, and can be committed back to GitHub.

If a task is simple and can be answered responsibly without delegation, or if essential information is missing and must be requested, return an answer. When a missing decision has a small set of realistic alternatives, do not write prose asking for it — return "ask" and Slade renders it as clickable choices (with a field for the user's own answer), then hands the selections straight back to you. For substantial work, create a small, actionable plan and delegate only the work that can be done with the context available. Each worker receives its own prompt plus the current local file system workspace, so give it the relevant task context and use explicit ROLE, OBJECTIVE, CONTEXT, ALLOWED FILES, PROTECTED FILES, REQUIREMENTS, CONSTRAINTS, ACCEPTANCE CRITERIA, TEST REQUIREMENTS, and DELIVERABLE fields.

${PLAN_MARKER}

For this planning call, respond with ONLY one valid JSON object — no prose or code fences outside the JSON:

To answer directly (greetings, quick facts, simple follow-ups, or a necessary clarification/limitation):
{"mode":"answer","answer":"<the complete Markdown answer>"}

${ASK_MARKER}
To ask the user to choose before you can plan (Slade renders each question as a set of clickable options plus a "type your own answer" field, one question at a time, and resumes this run with the selections):
{"mode":"ask","reply":"<one short sentence saying what you need before you can start>","questions":[{"question":"<the question, one decision only>","detail":"<optional one line: why it changes the work>","options":["<option>","<option>","<option>"],"multiple":false,"allowCustom":true}]}

To delegate a substantial task:
{"mode":"plan","reply":"<one short sentence describing your strategy>","subtasks":[{"title":"<short imperative title>","model":"<exact label from the roster, or empty string for chain order>","prompt":"<the complete, self-contained worker task, including role, objective, context, allowed/protected file scope, requirements, constraints, acceptance criteria, tests, and deliverable>"}]}

Asking rules (only when a wrong guess would waste the run):
- Ask only when two interpretations would produce materially different work, a destructive or irreversible action is involved, or the task needs information that exists only in the user's head. Never ask what the conversation, the local file system, or the safest interpretation already answers.
- At most ${MAX_QUESTIONS_PER_ROUND} questions per round, each with 2 to ${MAX_OPTIONS_PER_QUESTION} concrete, mutually exclusive options written as things the user would actually say ("A minimal working prototype", not "Option A"). A run may ask at most ${MAX_QUESTION_ROUNDS} rounds before Slade tells you to proceed.
- Leave "allowCustom" true unless the choice is genuinely exhaustive — the user must be able to overrule your options. Set "multiple" true only when several options can legitimately apply at once.
- Ask everything you need in one round: the questions are presented together and the run resumes once they are all answered. If the user's answers arrive (marked ${ANSWERS_MARKER}) treat them as explicit user requirements, plan the task, and do not ask again.

Planning rules:
- At most ${maxSteps} subtasks; fewer is better when the task is small.
- Each subtask prompt must be fully self-contained: the worker sees its prompt and the local file system workspace, but nothing else from this conversation.
- Decompose by responsibility and order dependent subtasks so later work builds on earlier results.
- Parallel subtasks must not write to the same file paths concurrently.
- When the task benefits from independent perspectives, use distinct available models when practical.
- If files are involved, ask the worker to return complete, clearly named fenced file blocks (\`\`\`lang:path/to/file.ext) so Slade stores them in the local file system.
- If the local file system holds a roadmap or milestone file (ROADMAP.md, MILESTONES.md, docs/roadmap.md, or similar), read it first and tie the plan to the step or steps it advances. Do not assign roadmap edits to workers: you update the roadmap yourself in the final synthesis, once the results are known.

Worker roster:
${roster || '(no workers configured — answer directly)'}${fsContext ? `\n\n${fsContext}` : ''}`
}

function synthSystemPrompt(fsContext = ''): string {
  return `${shellAwareOrchestratorPrompt()}

SLADE AGENT-MODE FINAL SYNTHESIS CONTRACT

This call happens after the worker-model responses below. The results may be incomplete, incorrect, or unverified; review them against the user's actual request and provided context, reconcile conflicts, and never treat an agent's report as proof. When the request carries a "${DECISIONS_HEADING}" block, those are answers the user picked in response to questions this run asked: treat each one as an explicit user requirement, honour it in the answer, and say so in SUMMARY. A question the user skipped is not a free choice — use the safest interpretation and record the assumption under ISSUES. In this Slade runtime you have access to Slade's persistent local file system (where worker file blocks were stored), ${useShell.getState().token ? "and workers can return runtime-captured bash results from the connected host checkout" : "but you do not have shell, git, or test-runner tools"}. Do not claim that tests/builds were run or a Git checkout diff was reviewed unless the conversation contains evidence that those actions actually occurred. If required verification was unavailable, state that plainly and do not mark the work verified or complete.

For a software-development task, provide a concise final report with these headings, in this order:

SUMMARY
ISSUES
IMPLEMENTED
FILES CHANGED
TESTING
ARCHITECTURE
DOCUMENTATION
ROADMAP
REMAINING
STATUS

SUMMARY is two to four plain sentences on what was done and the outcome; lead with it. ISSUES lists everything the user should be made aware of — failed, skipped, or unrunnable tests and builds; acceptance criteria you could not verify; worker steps that failed or were cut off; assumptions you made; risky, breaking, or destructive changes; manual actions the user must take; problems you noticed but did not fix — each with its impact and your recommended next step. Include ISSUES only when there is something real to report, and never pad it. ROADMAP appears only when a roadmap or milestone file was used (see ROADMAP UPDATE below).

Describe files stored in the local file system accurately. Report actual test and build results only when they are present in the supplied context. Use a status such as BLOCKED, NEEDS_REVIEW, or IN_PROGRESS when any applicable acceptance criterion remains unverified; reserve VERIFIED / COMPLETE for work supported by actual verification. ${useShell.getState().token ? "DISK MODE: worker changes have already been applied. Do not re-emit their file blocks or append/move/delete directives in synthesis. Only emit new intentional changes (for example a roadmap update)." : ""} ${useShell.getState().token ? "Reference changed disk paths without repeating their contents." : "Preserve useful worker file blocks with their filename tags so Slade renders them as artifacts and keeps the local file system up to date."} If a worker failed or returned unusable output, say so and continue with the usable results.

ROADMAP UPDATE. If the local file system holds a roadmap or milestone file (ROADMAP.md, MILESTONES.md, docs/roadmap.md, or similar), you own it. When this run advanced or changed any of its steps, emit the COMPLETE updated file exactly once, as a fenced block tagged with its exact path (\`\`\`markdown:ROADMAP.md), so Slade stores it. Mark a step [x] only when the conversation or files give evidence that its acceptance criteria are met; mark partly finished work [~]; leave every other line exactly as it was — same order, wording, and format — and add newly discovered work as new [ ] steps. If a worker already updated the roadmap, check it against the results and correct it only where it is wrong. Do not create a roadmap when none exists unless the user asked for one, and do not touch it when the work did not advance it. If the roadmap is shown as truncated, never rewrite it — the file you emit would replace the whole roadmap and delete the part you cannot see; say in ROADMAP and ISSUES which steps need updating instead. Slade reads the file after the run and renders the previous, current, and next step and the overall completion progress itself, so do not draw a timeline or progress bar; the ROADMAP section only says which steps changed and why.

${SYNTH_MARKER}${fsContext ? `\n\n${fsContext}` : ''}`
}

function workerSystemPrompt(fsContext = ''): string {
  return `You are a specialist worker model in Slade. An orchestrator delegated exactly one self-contained task to you.

Complete ONLY that task. Return the deliverable directly in Markdown — no meta-commentary about being an AI, no restating the task.
Slade mounts a persistent local file system:
- If the task involves creating or updating a file (CSV, code, document), emit it in a fenced block tagged with its relative path, e.g. \`\`\`csv:report.csv or \`\`\`typescript:src/main.ts. Slade automatically stores it in the local file system.
- To pull a file from the connected GitHub repository into the local file system, use \`\`\`fs:pull:path/to/file.ext.
- To append to an existing file, use \`\`\`fs:append:path/to/file.ext.
- To move or rename a file, use \`\`\`fs:move:old/path.ext -> new/path.ext.
- To delete a file, use \`\`\`fs:delete:path/to/file.ext.
- Do not edit roadmap or milestone files (ROADMAP.md, MILESTONES.md and similar) unless your task explicitly says to; the orchestrator keeps them up to date.${fsContext ? `\n\n${fsContext}` : ''}`
}

export async function prepareAgentWorkspaceContext(
  queryHint: string,
  conversationId?: string,
  includeLocalFs = true,
  session = workspaceSession(),
): Promise<string> {
  assertWorkspaceSession(session)
  const memoryBlock = formatMemoryContext()
  if (!includeLocalFs) return memoryBlock
  if (session.token) return [memoryBlock, await diskWorkspaceContext(queryHint, session)].filter(Boolean).join("\n\n")

  const ownerId = conversationId ?? useFs.getState().currentConversationId
  await useGitHub.getState().syncRepoFilesForPrompt(queryHint, ownerId)
  const fsBlock = formatFsContextForAgent(useFs.getState().listFiles(undefined, ownerId), { queryHint })
  const gh = useGitHub.getState()
  const ghBlock =
    gh.activeRepo && gh.activeBranch && gh.tree
      ? formatGitHubTreeForAgent(gh.activeRepo, gh.activeBranch, gh.tree.entries)
      : ''
  return [memoryBlock, fsBlock, ghBlock].filter(Boolean).join('\n\n')
}

export async function applyAgentOutputWithGit(
  markdown: string,
  meta: {
    source: { origin: 'model'; modelId: string; modelLabel: string }
    conversationId?: string
    messageId?: string
    workspaceSession?: WorkspaceSession
    alreadyApplied?: Set<string>
    signal?: AbortSignal
  },
): Promise<FsOpRecord[]> {
  const session = meta.workspaceSession ?? workspaceSession()
  assertWorkspaceSession(session)
  meta.signal?.throwIfAborted()
  if (session.token) return applyDiskAgentOutput(markdown, meta.source, session, meta.alreadyApplied, meta.signal)
  const pullOps: FsOpRecord[] = []
  const actions = extractFsActions(markdown)
  for (const action of actions) {
    if (action.op === 'pull') {
      const pulled = await useGitHub.getState().pullFileToFs(action.path, {
        silent: true,
        conversationId: meta.conversationId,
      })
      if (pulled) {
        pullOps.push({
          op: 'pull',
          path: pulled.path,
          size: pulled.size,
          version: pulled.version,
          at: Date.now(),
        })
      }
    }
  }
  const writeOps = useFs.getState().applyAgentOutput(markdown, meta)

  // If a GitHub repo is open and an agent created/updated a file whose path
  // matches a blob in that repo's tree, link its remote metadata as dirty so
  // Git sync knows it modifies an upstream file.
  const gh = useGitHub.getState()
  if (gh.activeRepo && gh.activeBranch && gh.tree) {
    const treeByPath = new Map(
      gh.tree.entries.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]),
    )
    for (const op of writeOps) {
      if (op.op === 'create' || op.op === 'update') {
        const cur = useFs.getState().readFile(op.path, meta.conversationId)
        if (cur && !cur.remote && treeByPath.has(op.path)) {
          const sha = treeByPath.get(op.path)
          useFs.getState().setFileRemote(
            op.path,
            {
              kind: 'github',
              repo: gh.activeRepo,
              ref: gh.activeBranch,
              path: op.path,
              url: `https://github.com/${gh.activeRepo}/blob/${encodeURIComponent(gh.activeBranch)}/${op.path}`,
              sha,
            },
            true,
            meta.conversationId,
          )
        }
      }
    }
  }

  return [...pullOps, ...writeOps]
}

/* ------------------------------------------------------------------ */
/* Planner reply parsing                                               */
/* ------------------------------------------------------------------ */

const plannerReplySchema = z.union([
  z.object({ mode: z.literal('answer'), answer: z.string().min(1) }),
  z.object({
    mode: z.literal('ask'),
    reply: z.string().optional(),
    /**
     * Options arrive as bare labels or `{label, hint}`; `normalizeQuestions`
     * accepts both (and drops anything that is not a real choice), so the
     * schema only has to rule out an empty list.
     */
    questions: z
      .array(
        z.object({
          question: z.string().min(1),
          detail: z.string().optional(),
          options: z
            .array(
              z.union([
                z.string().min(1),
                z.object({ label: z.string().min(1), hint: z.string().optional() }),
              ]),
            )
            .min(1),
          allowCustom: z.boolean().optional(),
          multiple: z.boolean().optional(),
          customLabel: z.string().optional(),
        }),
      )
      .min(1),
  }),
  z.object({
    mode: z.literal('plan'),
    reply: z.string().optional(),
    subtasks: z
      .array(
        z.object({
          title: z.string().min(1),
          model: z.string().optional(),
          prompt: z.string().min(1),
        }),
      )
      .min(1),
  }),
])

type PlannerReply = z.infer<typeof plannerReplySchema>

/**
 * Pull the JSON object out of a planner response. Real models wrap JSON in
 * prose or fences no matter how hard the prompt forbids it, and the object
 * itself is frequently only *nearly* JSON, so: try the reply as written, then
 * with the wrapping fences stripped. Each attempt tries the outermost braces,
 * then a string-aware balanced scan, then a repair pass (`repairNearJson`) for
 * the near-JSON every long planner reply drifts into.
 *
 * The reply is tried as written FIRST because a direct `answer` can contain
 * code blocks and file blocks of its own; stripping every triple-backtick up
 * front would delete their fences (and with them any file the answer writes).
 */
export function extractJsonObject(text: string): unknown | undefined {
  return scanJsonObject(text) ?? scanJsonObject(text.replace(/```(?:json)?/gi, ''))
}

/**
 * How many `{`-anchored candidates one scan inspects. A reply that is mostly
 * code has a brace every few characters; each candidate costs one bounded walk,
 * so the cap keeps a brace-heavy reply from turning the scan into a quadratic
 * hunt for JSON that is not there.
 */
const MAX_JSON_CANDIDATES = 32

function scanJsonObject(source: string): unknown | undefined {
  const first = source.indexOf('{')
  if (first < 0) return undefined
  // Fast path: the outermost braces hold the whole reply's JSON. It is tried
  // once, for the first `{`, because that is the shape a compliant model sends.
  const last = source.lastIndexOf('}')
  if (last > first) {
    const whole = parseJsonish(source.slice(first, last + 1))
    if (whole !== undefined) return whole
  }
  // Otherwise walk `{`-anchored candidates. A failed candidate is not the end
  // of the search: a brace in the prose before the JSON (or a code block after
  // it) must not hide the object sitting between them.
  for (let n = 0, from = first; n < MAX_JSON_CANDIDATES; n++) {
    const start = source.indexOf('{', from)
    if (start < 0) return undefined
    const balanced = balancedObject(source, start)
    if (balanced !== undefined) {
      const value = parseJsonish(balanced)
      if (value !== undefined) return value
    }
    from = start + 1
  }
  return undefined
}

/** The `{…}` slice that closes the object opening at `start`, or undefined. */
function balancedObject(source: string, start: number): string | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return undefined
}

/**
 * Parse one candidate slice: as written, then after the near-JSON repair.
 * The repair's output is only used when it parses cleanly, so a reply that was
 * already valid JSON is never rewritten.
 */
function parseJsonish(slice: string): unknown | undefined {
  try {
    return JSON.parse(slice)
  } catch {
    /* fall through to the repair pass */
  }
  const repaired = repairNearJson(slice)
  if (repaired === undefined) return undefined
  try {
    return JSON.parse(repaired)
  } catch {
    return undefined
  }
}

/** Escape letters JSON defines after a backslash. `u` is handled separately. */
const SIMPLE_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't'])
const HEX4 = /^[0-9a-fA-F]{4}$/

/**
 * Repair the three ways a planner reply ends up *nearly* JSON. Each one is a
 * `JSON.parse` error, and each one can be fixed without guessing at what the
 * model meant — which matters, because the fallback (one more orchestrator
 * call asking it to reformat) costs a whole planning round-trip and buries a
 * plan that is already complete on screen:
 *
 * 1. Raw control characters inside a string value. A model "writes" a
 *    multi-line worker prompt (`ROLE: …` / `OBJECTIVE: …`) as a real
 *    multi-line string, which JSON forbids. Escaped, it reads back as written.
 * 2. Backslashes that are not valid escapes — `\d`, `\s`, `\w`, `C:\Users` —
 *    from a regex or path inside a prompt string. Doubling the backslash keeps
 *    the text the model wrote; dropping it would silently change the worker's
 *    instructions.
 * 3. A trailing comma before `}` or `]`, which JSON also forbids.
 *
 * Returns undefined when nothing needed repairing, so the caller does not
 * re-parse an unchanged string.
 */
function repairNearJson(slice: string): string | undefined {
  let out = ''
  let inString = false
  let changed = false
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i]!
    if (!inString) {
      if (ch === '"') {
        inString = true
      } else if (ch === ',') {
        let j = i + 1
        while (j < slice.length && /\s/.test(slice[j]!)) j++
        if (slice[j] === '}' || slice[j] === ']') {
          changed = true
          continue // drop the comma, keep the whitespace
        }
      }
      out += ch
      continue
    }
    if (ch === '"') {
      inString = false
      out += ch
      continue
    }
    if (ch === '\\') {
      const next = slice[i + 1]
      const simple = next !== undefined && SIMPLE_ESCAPES.has(next)
      const unicode = next === 'u' && HEX4.test(slice.slice(i + 2, i + 6))
      if (simple || unicode) {
        const keep = unicode ? 6 : 2
        out += slice.slice(i, i + keep)
        i += keep - 1
      } else {
        out += '\\\\'
        changed = true
      }
      continue
    }
    if (ch === '\n' || ch === '\r' || ch === '\t' || ch < ' ') {
      out +=
        ch === '\n'
          ? '\\n'
          : ch === '\r'
            ? '\\r'
            : ch === '\t'
              ? '\\t'
              : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
      changed = true
      continue
    }
    out += ch
  }
  return changed ? out : undefined
}

export function parsePlannerReply(text: string): PlannerReply | undefined {
  const json = extractJsonObject(text)
  if (json == null) return undefined
  const parsed = plannerReplySchema.safeParse(json)
  return parsed.success ? (parsed.data as PlannerReply) : undefined
}

/* ------------------------------------------------------------------ */
/* Worker resolution                                                   */
/* ------------------------------------------------------------------ */

/**
 * Resolve the planner's model hint (label or id) to a concrete model.
 * Falls back down the chain when the hint matches nothing routable.
 */
export function resolveWorkerModel(
  hint: string | undefined,
  settings: Settings,
  exclude: ReadonlySet<string>,
): ModelDef | undefined {
  const pool = workerCandidates(settings, exclude)
  if (pool.length === 0) return undefined
  if (hint) {
    const h = hint.trim().toLowerCase()
    const byId = pool.find((m) => m.id.toLowerCase() === h)
    if (byId) return byId
    const byLabel = pool.find((m) => m.label.toLowerCase() === h)
    if (byLabel) return byLabel
    const byContains = pool.find(
      (m) => m.label.toLowerCase().includes(h) || h.includes(m.label.toLowerCase()),
    )
    if (byContains) return byContains
  }
  return pool[0]
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

export function orchestratorFor(settings: Settings, convModelId?: string): ModelDef | undefined {
  const enabled = settings.models.filter((m) => m.enabled && modelHasKey(settings, m))
  const byId = (id?: string) => (id ? enabled.find((m) => m.id === id) : undefined)
  return (
    byId(settings.agent.orchestratorModelId) ?? byId(convModelId) ?? byId(settings.pinnedModelId) ?? enabled[0]
  )
}

/** Entry point; routed to from `send.ts` when the conversation is in agent mode. */
export async function runAgentTurn(
  conversationId: string,
  userMessageId: string,
  assistantMessageId: string,
): Promise<void> {
  return runAgent(conversationId, userMessageId, assistantMessageId)
}

/**
 * One orchestrated turn.
 *
 * With `resume`, this continues a run that paused to ask the user something:
 * the message already carries the questions and the answers, so the run keeps
 * its goal, start time and question cards, and planning is re-issued with those
 * answers appended to the conversation. Everything after planning is identical
 * to a fresh run — which is the point: a paused run is a run, not a dead end.
 */
async function runAgent(
  conversationId: string,
  userMessageId: string,
  assistantMessageId: string,
  opts?: { resume?: boolean },
): Promise<void> {
  const resume = Boolean(opts?.resume)
  if (getRun(conversationId)) {
    useUI.getState().toast({ kind: 'warn', title: 'A response is already streaming in this chat.' })
    return
  }

  const settings = useSettings.getState().s
  const fsSession = workspaceSession()
  const conv = useChat.getState().conversations[conversationId]
  if (!conv) return
  const userMessage = conv.messages.find((m) => m.id === userMessageId)
  if (!userMessage) return

  const orchestrator = orchestratorFor(settings, conv.modelId)
  if (!orchestrator) {
    finalize(assistantMessageId, {
      status: 'error',
      error: 'No enabled model available to orchestrate with. Enable a model in Settings → Models.',
      errorClass: 'auth',
    })
    useUI.getState().toast({ kind: 'error', title: 'The orchestrator has no model to run on' })
    return
  }

  const previous = resume ? readRun(assistantMessageId) : undefined
  const goal = previous?.goal?.trim() || userMessage.content.trim()
  const controller = new AbortController()
  const attempt = registerRun(conversationId, controller)
  const signal = controller.signal

  /**
   * Every GitHub call this run makes is tagged with its message scope. The live
   * card snapshot is inserted into that message's timeline at the moment the
   * call starts. Entered inside the try so the finally below always releases it.
   * A resumed pass gets a fresh scope; the cards from the pass that asked are
   * already snapshots on the message's timeline and stay where they were.
   */
  const githubScope = uid('ghs')

  const baseRun: AgentRun = previous
    ? {
        ...previous,
        phase: 'planning',
        goal,
        orchestratorModelId: orchestrator.id,
        // The paused pass never delegated, so there is nothing to carry over —
        // and a stale step list would render as this pass's work.
        steps: [],
        error: undefined,
        note: undefined,
        finishedAt: undefined,
        fsOps: undefined,
        roadmap: undefined,
        githubScope,
      }
    : {
        phase: 'planning',
        goal,
        orchestratorModelId: orchestrator.id,
        steps: [],
        startedAt: Date.now(),
        githubScope,
      }
  finalize(assistantMessageId, {
    status: 'streaming',
    modelId: orchestrator.id,
    chain: [orchestrator.id],
    agent: { ...baseRun },
  })

  const usageAcc: { current?: Usage } = {}
  const attemptsAcc: AttemptFailure[] = []
  const collectAttempts = (rows: AttemptFailure[] | undefined) => {
    if (rows?.length) attemptsAcc.push(...rows)
  }
  const useLocalFs = settings.agent.useLocalFs ?? true

  // The roadmap files as this run found them — snapshotted once the workspace
  // is prepared and before anything is written — so the completion timeline
  // can show what the run changed.
  let roadmapBefore: RoadmapFileSnapshot[] = []
  /** Roadmap timeline as of now. Tracking must never be able to fail a run. */
  const roadmapReport = (delegated: boolean): RoadmapReport | undefined => {
    if (!useLocalFs) return undefined
    try {
      return buildRoadmapReport({
        before: roadmapBefore,
        after: snapshotRoadmapFiles(fsSession.token ? Object.values(useDiskFs.getState().files) : useFs.getState().listFiles(undefined, conversationId)),
        delegated,
      })
    } catch {
      return undefined
    }
  }

  try {
    useGitHubActivity.getState().enterScope(githubScope, assistantMessageId)

    /* ---------------- planning ---------------- */

    const historyTurns = await buildTurns(
      useChat.getState().conversations[conversationId] ?? conv,
      { upToMessageId: userMessageId },
    )
    // A resumed run re-plans with the exchange it just had: the questions it
    // asked (as its own turn) and the answers the user picked (as the user's).
    let planTurns: ChatTurn[] = [...historyTurns, ...(previous ? answersTurnsFor(previous) : [])]
    const planFsContext = await prepareAgentWorkspaceContext(goal, conversationId, useLocalFs, fsSession)
    if (useLocalFs) roadmapBefore = snapshotRoadmapFiles(fsSession.token ? Object.values(useDiskFs.getState().files) : useFs.getState().listFiles(undefined, conversationId))

    let plannerReply: PlannerReply | undefined
    let planModel: ModelDef = orchestrator
    let finalPlanReasoning: string | undefined
    let note: string | undefined
    let askRounds = previous?.questionRounds ?? (previous?.questions?.length ? 1 : 0)
    /**
     * How many times the orchestrator has been told "stop asking, proceed" and
     * asked anyway. Bounded so a stubborn model cannot turn planning into an
     * infinite loop: past this, Slade stops arguing and falls back to the
     * single-step plan it already uses for an unusable reply.
     */
    let refusals = 0

    // One pass per planning call. A pass ends in a plan, a direct answer, or a
    // request to ask the user something — and the ask case either parks the run
    // (returning to the UI with questions on screen) or, when the questions are
    // unusable or the round cap is spent, sends the orchestrator back with an
    // explicit instruction to proceed instead.
    for (;;) {
      let planReasoning = ''
      const planResult = await runCompletion({
        purpose: 'Planning',
        turns: planTurns,
        systemPrompt: planSystemPrompt(settings, settings.agent.maxSteps, planFsContext),
        settings,
        candidates: [orchestrator, ...workerCandidates(settings, new Set([orchestrator.id]))],
        // Every orchestrator call gets the step budget, not the chat default: a
        // reasoning model bills its thinking against the same cap, and a cap
        // that only fits the answer is how a step comes back with nothing in it.
        maxTokensFloor: settings.agent.stepMaxTokens,
        signal,
        silent: true,
        onReasoning: (t) => {
          planReasoning += t
          setRun(assistantMessageId, { ...baseRun, planningReasoning: planReasoning })
          appendAgentThought(assistantMessageId, 'planning', orchestrator.id, t)
        },
      })
      collectAttempts(planResult.attempts)
      usageAcc.current = mergeUsage(usageAcc.current, planResult.usage)
      signal.throwIfAborted()

      planModel = planResult.model
      finalPlanReasoning = planResult.reasoning ?? (planReasoning.trim() ? planReasoning : undefined)
      appendMissingThoughtTail(assistantMessageId, 'planning', orchestrator.id, planReasoning, finalPlanReasoning)
      closeAgentThought(assistantMessageId, 'planning')
      plannerReply = parsePlannerReply(planResult.text)

      // Real models occasionally ignore the JSON contract; give them one
      // explicit repair pass before falling back.
      if (!plannerReply) {
        useChat.getState().mutateMessage(assistantMessageId, (m) => ({
          ...m,
          agent: m.agent ? { ...m.agent, note: 'First plan was malformed — asking the orchestrator to reformat…' } : m.agent,
        }))
        const repair = await runCompletion({
          purpose: 'Planning (retry)',
          turns: [
            ...planTurns,
            { role: 'assistant', text: planResult.text.slice(0, 4000) },
            {
              role: 'user',
              text: 'Your previous response was not the required JSON object. Respond again with ONLY the JSON object — no prose, no code fences.',
            },
          ],
          systemPrompt: planSystemPrompt(settings, settings.agent.maxSteps, planFsContext),
          settings,
          candidates: [orchestrator, ...workerCandidates(settings, new Set([orchestrator.id]))],
          maxTokensFloor: settings.agent.stepMaxTokens,
          signal,
          silent: true,
        })
        collectAttempts(repair.attempts)
        usageAcc.current = mergeUsage(usageAcc.current, repair.usage)
        plannerReply = parsePlannerReply(repair.text)
      }

      /* ---------------- the orchestrator wants to ask the user ---------------- */

      if (plannerReply?.mode === 'ask') {
        const asked = normalizeQuestions(plannerReply.questions, planResult.model.id)
        if (asked.length > 0 && askRounds < MAX_QUESTION_ROUNDS) {
          askRounds++
          parkForAnswers(assistantMessageId, {
            baseRun,
            asked,
            askRounds,
            reply: plannerReply.reply,
            reasoning: finalPlanReasoning,
            model: planResult.model,
            usage: usageAcc.current,
          })
          return
        }
        // Nothing renderable came back, or the run has already asked its quota.
        // Either way the user is not the one who is stuck: plan again with an
        // instruction that removes asking as an option.
        refusals++
        if (refusals > MAX_ASK_REFUSALS) {
          note = `${note ? `${note} ` : ''}The orchestrator kept asking instead of planning, so Slade ran the task as a single step with its own reading of the goal.`
          break
        }
        note =
          asked.length === 0
            ? 'The orchestrator tried to ask a question Slade could not render (no prompt, or fewer than two options), so it was told to proceed with the safest interpretation.'
            : `The orchestrator has already asked ${askRounds} round${askRounds === 1 ? '' : 's'} of questions, so Slade told it to proceed with the safest interpretation instead of asking again.`
        planTurns = [
          ...planTurns,
          { role: 'assistant', text: planResult.text.slice(0, 4000) },
          {
            role: 'user',
            text:
              'Do not ask any further questions. Slade will not present more choices to the user in this run. ' +
              'Pick the safest reasonable interpretation yourself, state each assumption in the final report, and respond with the planning JSON object — a plan, or a direct answer.',
          },
        ]
        continue
      }

      break
    }

    // The orchestrator answered directly — nothing to delegate.
    if (plannerReply?.mode === 'answer') {
      const answer = plannerReply.answer
      const directLabel = modelLabel(settings.models, planModel.id)
      const directFsOps = useLocalFs
        ? await applyAgentOutputWithGit(answer, {
            source: { origin: 'model', modelId: planModel.id, modelLabel: directLabel },
            conversationId,
            messageId: assistantMessageId,
            workspaceSession: fsSession,
            signal,
          })
        : []
      const directRoadmap = roadmapReport(false)
      finalize(assistantMessageId, {
        status: 'complete',
        content: answer,
        reasoning: finalPlanReasoning,
        modelId: planModel.id,
        chain: [planModel.id],
        usage: usageAcc.current,
        agent: {
          ...baseRun,
          phase: 'complete',
          steps: [],
          strategy: undefined,
          planningReasoning: finalPlanReasoning,
          orchestratorModelId: planModel.id,
          finishedAt: Date.now(),
          fsOps: directFsOps.length ? directFsOps : undefined,
          roadmap: directRoadmap,
        },
      })
      announceResponse(`Response from ${directLabel}.${directRoadmap ? ` ${describeRoadmapReport(directRoadmap)}` : ''}`)
      return
    }

    /* ---------------- build the plan ---------------- */

    const exclude = new Set<string>([orchestrator.id])
    let rawSubtasks = plannerReply?.mode === 'plan' ? plannerReply.subtasks.slice(0, settings.agent.maxSteps) : []

    if (!plannerReply) {
      note =
        'The orchestrator did not return a parseable plan, so Slade fell back to a single execution step with the next model in the chain.'
    }
    if (rawSubtasks.length === 0) {
      rawSubtasks = [{ title: 'Execute the task', model: '', prompt: goal }]
    }

    const steps: AgentStep[] = rawSubtasks.map((s) => {
      const worker = resolveWorkerModel(s.model, settings, exclude)
      if (worker) exclude.add(worker.id) // spread distinct subtasks across distinct models
      return {
        id: uid('step'),
        title: s.title.slice(0, 140),
        prompt: s.prompt,
        modelId: worker?.id ?? orchestrator.id,
        modelLabel: worker?.label ?? orchestrator.label,
        status: 'pending',
        attempts: [],
        failedChain: [],
      }
    })

    const executingRun: AgentRun = {
      ...baseRun,
      phase: 'executing',
      steps,
      planningReasoning: finalPlanReasoning,
      strategy: plannerReply?.mode === 'plan' ? plannerReply.reply : undefined,
      note,
      orchestratorModelId: orchestrator.id,
    }
    setRun(assistantMessageId, executingRun)
    signal.throwIfAborted()

    /* ---------------- execution ---------------- */

    const runStep = async (step: AgentStep): Promise<void> => {
      patchStep(assistantMessageId, step.id, { status: 'running' })
      const startedAt = performance.now()
      const pool = workerCandidates(settings, new Set())
      // Prefer the planned worker first, then the rest of the chain.
      const planned = pool.find((m) => m.id === step.modelId)
      const ordered = planned ? [planned, ...pool.filter((m) => m.id !== planned.id)] : pool.length ? pool : [orchestrator]

      // Stream the worker's output and reasoning into the step card, throttled so fast
      // token cadences don't thrash the store.
      let acc = ''
      let stepReasoning = ''
      const flush = makeThrottledFlush(() => {
        patchStep(assistantMessageId, step.id, {
          result: acc,
          reasoning: stepReasoning.trim() ? stepReasoning : undefined,
        })
      }, 140)

      try {
        const stepFsContext = await prepareAgentWorkspaceContext(step.prompt, conversationId, useLocalFs, fsSession)
        const result = await runWorkerCompletion({
          purpose: `Step “${step.title}”`,
          turns: [{ role: 'user', text: step.prompt }],
          systemPrompt: workerSystemPrompt(stepFsContext),
          settings,
          candidates: ordered,
          maxTokensFloor: settings.agent.stepMaxTokens,
          signal,
          onDelta: (t) => {
            acc += t
            flush()
          },
          onReasoning: (t) => {
            stepReasoning += t
            appendAgentThought(assistantMessageId, `step:${step.id}`, step.modelId, t)
            flush()
          },
        }, { conversationId, messageId: assistantMessageId })
        collectAttempts(result.attempts)
        usageAcc.current = mergeUsage(usageAcc.current, result.usage)
        appendMissingThoughtTail(
          assistantMessageId,
          `step:${step.id}`,
          result.model.id,
          stepReasoning,
          result.reasoning,
        )
        closeAgentThought(assistantMessageId, `step:${step.id}`)
        const stepLabel = modelLabel(settings.models, result.model.id)
        const stepFsOps = useLocalFs
          ? await applyAgentOutputWithGit(result.text, {
              source: { origin: 'model', modelId: result.model.id, modelLabel: stepLabel },
              conversationId,
              messageId: `step-${step.id}`,
              workspaceSession: fsSession,
              signal,
            })
          : []
        patchStep(assistantMessageId, step.id, {
          status: 'complete',
          result: result.text,
          reasoning: result.reasoning ?? (stepReasoning.trim() ? stepReasoning : undefined),
          modelId: result.model.id,
          modelLabel: stepLabel,
          failedChain: result.failedChain,
          attempts: result.attempts,
          elapsedMs: Math.round(performance.now() - startedAt),
          // A worker cut off at the token cap hands the synthesis pass a
          // half-finished file; the step card says so instead of letting the
          // truncation look like the worker's choice.
          truncated: result.truncated || undefined,
          fsOps: stepFsOps.length ? stepFsOps : undefined,
        })
      } catch (err) {
        if (err instanceof ProviderError && err.failure === 'aborted') throw err
        if (err instanceof CompletionExhausted) {
          collectAttempts(err.attempts)
          patchStep(assistantMessageId, step.id, {
            status: 'error',
            error: err.message,
            attempts: err.attempts,
            failedChain: err.attempts.filter((a) => !a.midStream).map((a) => a.modelId),
            elapsedMs: Math.round(performance.now() - startedAt),
          })
          return
        }
        throw err
      }
    }

    await runPool(steps, useShell.getState().token ? 1 : Math.max(1, Math.min(settings.agent.maxParallel, steps.length)), runStep)
    signal.throwIfAborted()

    const done = readRun(assistantMessageId)
    const succeeded = done?.steps.filter((s) => s.status === 'complete').length ?? 0
    if (succeeded === 0) {
      throw new CompletionExhausted('Every worker step failed — nothing to synthesize.', attemptsAcc)
    }

    /* ---------------- synthesis ---------------- */

    setRun(assistantMessageId, { ...(done ?? executingRun), phase: 'synthesizing' })

    const resultsBlock = (done?.steps ?? [])
      .map((s, i) => {
        const body =
          s.status === 'complete' && s.result?.trim()
            ? s.result
            : `_(step failed: ${s.error ?? 'no output'}_)`
        return `## [${i + 1}] ${s.title} — ${s.modelLabel}\n\n${body}`
      })
      .join('\n\n---\n\n')

    // What the user chose before the run started. The synthesis pass is where
    // the answer is written, so it has to know the decisions — otherwise a run
    // that asked "prototype or production?" reports back as if it never did.
    const decisions = formatDecisionsForModel(done?.questions ?? baseRun.questions)
    const synthTurns: ChatTurn[] = [
      ...historyTurns,
      {
        role: 'user',
        text: `Goal: ${goal}\n\n${decisions ? `${decisions}\n\n` : ''}Subtask results from the worker models:\n\n${resultsBlock}\n\nAssemble the final answer now.`,
      },
    ]

    let content = ''
    let synthReasoning = ''
    let streamedSynthReasoning = ''
    let synthTruncated = false
    let synthGenerated = false
    let synthModelId = orchestrator.id
    const synthFsContext = await prepareAgentWorkspaceContext(goal, conversationId, useLocalFs, fsSession)
    try {
      const synth = await runCompletion({
        purpose: 'Synthesis',
        turns: synthTurns,
        systemPrompt: synthSystemPrompt(synthFsContext),
        settings,
        candidates: [orchestrator, ...workerCandidates(settings, new Set([orchestrator.id]))],
        maxTokensFloor: settings.agent.stepMaxTokens,
        signal,
        onDelta: (t) => {
          content += t
          useChat.getState().mutateMessage(assistantMessageId, (m) => ({ ...m, content }))
        },
        onReasoning: (t) => {
          synthReasoning += t
          streamedSynthReasoning += t
          useChat.getState().mutateMessage(assistantMessageId, (m) => ({ ...m, reasoning: synthReasoning }))
          appendAgentThought(assistantMessageId, 'synthesis', orchestrator.id, t)
        },
      })
      collectAttempts(synth.attempts)
      usageAcc.current = mergeUsage(usageAcc.current, synth.usage)
      content = synth.text
      synthGenerated = true
      synthModelId = synth.model.id
      synthTruncated = Boolean(synth.truncated)
      if (synth.reasoning) synthReasoning = synth.reasoning
      appendMissingThoughtTail(
        assistantMessageId,
        'synthesis',
        synth.model.id,
        streamedSynthReasoning,
        synthReasoning,
      )
      closeAgentThought(assistantMessageId, 'synthesis')
    } catch (err) {
      if (err instanceof ProviderError && err.failure === 'aborted') throw err
      // Synthesis failed on every candidate — stitch the worker output
      // together ourselves rather than losing the whole run.
      if (err instanceof CompletionExhausted) {
        collectAttempts(err.attempts)
        note = `${note ? `${note} ` : ''}The synthesis pass failed, so Slade assembled the workers' outputs directly.`
      } else {
        throw err
      }
    }
    if (!content.trim()) {
      content = (done?.steps ?? [])
        .filter((s) => s.status === 'complete' && s.result?.trim())
        .map((s) => `### ${s.title}\n\n${s.result}`)
        .join('\n\n')
    }

    const synthFsOps =
      useLocalFs && content && (!fsSession.token || synthGenerated)
        ? await applyAgentOutputWithGit(content, {
            source: {
              origin: 'model',
              modelId: synthModelId,
              modelLabel: modelLabel(settings.models, synthModelId),
            },
            conversationId,
            messageId: assistantMessageId,
            workspaceSession: fsSession,
            signal,
            alreadyApplied: new Set((done?.steps ?? []).filter((step) => step.status === 'complete').flatMap((step) => extractFsActions(step.result ?? '').map((action) => JSON.stringify(action)))),
          })
        : []

    const finalRunState = readRun(assistantMessageId)
    const allFsOps: FsOpRecord[] = [
      ...(finalRunState?.steps ?? []).flatMap((s) => s.fsOps ?? []),
      ...synthFsOps,
    ]
    const workerIds = [...new Set((finalRunState?.steps ?? []).map((s) => s.modelId))]
    const hadFailures = (finalRunState?.steps ?? []).some((s) => s.status === 'error')
    const cutOff = (finalRunState?.steps ?? []).filter((s) => s.truncated)
    if (cutOff.length > 0) {
      note = `${note ? `${note} ` : ''}${cutOff.length === 1 ? `One worker step was` : `${cutOff.length} worker steps were`} cut off at the output token cap, so ${cutOff.length === 1 ? 'its' : 'their'} deliverable may be incomplete — raise “Max tokens per step” in Settings → Agent.`
    }

    const roadmap = roadmapReport(true)
    finalize(assistantMessageId, {
      status: 'complete',
      content,
      reasoning: synthReasoning.trim() ? synthReasoning : finalPlanReasoning,
      modelId: orchestrator.id,
      chain: [orchestrator.id, ...workerIds.filter((id) => id !== orchestrator.id)],
      usage: usageAcc.current,
      truncated: synthTruncated || undefined,
      error: undefined,
      errorClass: undefined,
      agent: {
        ...(finalRunState ?? executingRun),
        phase: 'complete',
        note,
        finishedAt: Date.now(),
        fsOps: allFsOps.length ? allFsOps : undefined,
        roadmap,
      },
    })
    announceResponse(
      `Orchestrator finished: ${succeeded} of ${steps.length} steps completed${hadFailures ? ', some steps failed' : ''}.${roadmap ? ` ${describeRoadmapReport(roadmap)}` : ''}`,
    )
  } catch (err) {
    const aborted = (err instanceof ProviderError && err.failure === 'aborted') || attempt.userAborted
    const state = readRun(assistantMessageId)
    const content = useChat.getState().conversations[conversationId]?.messages.find((m) => m.id === assistantMessageId)?.content ?? ''

    if (aborted) {
      if (!content.trim() && (state?.steps.length ?? 0) === 0) {
        useChat.getState().deleteMessage(assistantMessageId)
        return
      }
      finalize(assistantMessageId, {
        status: 'cancelled',
        usage: usageAcc.current,
        agent: state ? { ...state, phase: 'error', error: 'Cancelled.', finishedAt: Date.now() } : state,
      })
      return
    }

    const message =
      err instanceof CompletionExhausted
        ? err.message
        : err instanceof ProviderError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
    finalize(assistantMessageId, {
      status: 'error',
      error: message,
      errorClass: err instanceof ProviderError ? err.failure : 'unknown',
      usage: usageAcc.current,
      attempts: attemptsAcc,
      agent: state ? { ...state, phase: 'error', error: message, finishedAt: Date.now() } : state,
    })
    useUI.getState().toast({ kind: 'error', title: 'The orchestrated run failed', detail: message })
  } finally {
    // Release the scope: anything the chat or the drawer does after the run is
    // its own activity again.
    useGitHubActivity.getState().exitScope(githubScope)
    finishRun(conversationId)
  }
}

/* ------------------------------------------------------------------ */
/* Clarification questions                                             */
/* ------------------------------------------------------------------ */

/**
 * Park the run on the questions the orchestrator asked.
 *
 * The turn ends here — status `complete`, phase `awaiting_input`, nothing in
 * flight — rather than holding a promise open for however long the user takes
 * to read. That is what makes the exchange survive a reload, a Stop that never
 * comes, and the app being closed: the questions are persisted on the message
 * and answering them re-issues planning from the same point.
 */
function parkForAnswers(
  assistantMessageId: string,
  args: {
    baseRun: AgentRun
    asked: AgentQuestion[]
    askRounds: number
    reply?: string
    reasoning?: string
    model: ModelDef
    usage?: Usage
  },
): void {
  const { baseRun, asked, askRounds, reply, reasoning, model, usage } = args
  const questions = [...(baseRun.questions ?? []), ...asked]
  const ask = reply?.trim() || `I need ${asked.length} decision${asked.length === 1 ? '' : 's'} from you before I plan this.`
  finalize(assistantMessageId, {
    status: 'complete',
    // The question cards carry the answer; the message body stays empty until
    // the resumed run produces one.
    content: '',
    reasoning,
    modelId: model.id,
    chain: [model.id],
    usage,
    agent: {
      ...baseRun,
      phase: 'awaiting_input',
      steps: [],
      questions,
      questionRounds: askRounds,
      // The plan card shows this line above the questions: it is the
      // orchestrator's own sentence about what it needs and why.
      strategy: ask,
      planningReasoning: reasoning ?? baseRun.planningReasoning,
      orchestratorModelId: model.id,
      finishedAt: Date.now(),
    },
  })
  const n = asked.length
  announceResponse(`The agent asked ${n} question${n === 1 ? '' : 's'}: ${asked.map((q) => q.prompt).join(' / ')}`)
}

/** The exchange as the resumed planning call should see it: it asked, you answered. */
function answersTurnsFor(run: AgentRun): ChatTurn[] {
  const questions = run.questions ?? []
  if (questions.length === 0) return []
  return [
    { role: 'assistant', text: `Before planning, I asked:\n\n${formatQuestionsForModel(questions)}` },
    {
      role: 'user',
      text:
        `${ANSWERS_MARKER}\nGoal: ${run.goal}\n\nMy answers:\n\n${formatAnswersForModel(questions)}\n\n` +
        'Those are explicit requirements now. Plan the task with them and do not ask again.',
    },
  ]
}

/** Locate a message across conversations (the chat store is keyed by conversation). */
function locateMessage(messageId: string): { conversationId: string; message: Message } | undefined {
  for (const conv of Object.values(useChat.getState().conversations)) {
    const message = conv.messages.find((m) => m.id === messageId)
    if (message) return { conversationId: conv.id, message }
  }
  return undefined
}

/**
 * Record the user's choice for one question.
 *
 * Answering is per question, in order: the card collapses to the chosen answer
 * and the next pending question is revealed underneath it. Answering the last
 * one resumes the run in place.
 */
export function answerAgentQuestion(
  messageId: string,
  questionId: string,
  selection: QuestionSelection,
): boolean {
  const found = locateMessage(messageId)
  const question = found?.message.agent?.questions?.find((q) => q.id === questionId)
  if (!found || !question || question.status !== 'pending') return false
  const answer = resolveAnswer(question, selection)
  if (!answer) return false
  return settleQuestion(messageId, questionId, { status: 'answered', answer })
}

/** Decline a question: the orchestrator is told to use the safest interpretation. */
export function skipAgentQuestion(messageId: string, questionId: string): boolean {
  const found = locateMessage(messageId)
  const question = found?.message.agent?.questions?.find((q) => q.id === questionId)
  if (!found || !question || question.status !== 'pending') return false
  return settleQuestion(messageId, questionId, { status: 'skipped' })
}

function settleQuestion(
  messageId: string,
  questionId: string,
  patch: { status: 'answered' | 'skipped'; answer?: AgentQuestion['answer']; note?: string },
): boolean {
  useChat.getState().mutateMessage(messageId, (m) => {
    if (!m.agent?.questions) return m
    return {
      ...m,
      agent: {
        ...m.agent,
        questions: m.agent.questions.map((q) =>
          q.id === questionId && q.status === 'pending' ? { ...q, ...patch, answeredAt: Date.now() } : q,
        ),
      },
    }
  })

  const run = locateMessage(messageId)?.message.agent
  if (!run) return true
  const next = nextPendingQuestion(run.questions)
  if (next) {
    // The next block just appeared where the last one collapsed; say so, since
    // a screen reader has no other way to know the list moved.
    announceResponse(`Answer recorded. Next question: ${next.prompt}`)
    return true
  }
  if (!questionsResolved(run.questions)) return true
  // Every question now has an answer: continue the run that asked them.
  announceResponse('Answers sent — the run is continuing.')
  void resumeAgentRun(messageId)
  return true
}

/**
 * Continue a parked run once its questions are answered. Re-plans from the same
 * user message with the answers in context, then executes and synthesizes as
 * usual — the whole exchange stays on one message.
 */
export async function resumeAgentRun(assistantMessageId: string): Promise<void> {
  const found = locateMessage(assistantMessageId)
  if (!found) return
  const { conversationId, message } = found
  const run = message.agent
  if (!run || !questionsResolved(run.questions)) return
  if (run.phase !== 'awaiting_input') return
  if (isGenerating(conversationId)) {
    useUI.getState().toast({ kind: 'warn', title: 'A response is already streaming in this chat.' })
    return
  }

  const conv = useChat.getState().conversations[conversationId]
  const idx = conv?.messages.findIndex((m) => m.id === assistantMessageId) ?? -1
  let userMessageId: string | undefined
  for (let i = idx - 1; i >= 0; i--) {
    if (conv?.messages[i]?.role === 'user') {
      userMessageId = conv.messages[i]!.id
      break
    }
  }
  if (!conv || idx < 0 || !userMessageId) return

  // Show the run waking up before the first orchestrator token lands.
  useChat.getState().mutateMessage(assistantMessageId, (m) => ({
    ...m,
    status: 'pending',
    agent: m.agent ? { ...m.agent, phase: 'planning' } : m.agent,
  }))
  await runAgent(conversationId, userMessageId, assistantMessageId, { resume: true })
}

/**
 * Unanswered questions belong to the turn that asked them. When the user replies
 * in the composer instead, the questions are closed out so the card stops
 * offering a choice that would resurrect a superseded run.
 */
export function expirePendingAgentQuestions(conversationId: string): void {
  const conv = useChat.getState().conversations[conversationId]
  if (!conv) return
  for (const message of conv.messages) {
    const questions = message.agent?.questions
    if (message.role !== 'assistant' || !questions?.some((q) => q.status === 'pending')) continue
    const answeredAny = questions.some((q) => q.status === 'answered')
    useChat.getState().mutateMessage(message.id, (m) => {
      if (!m.agent?.questions) return m
      return {
        ...m,
        agent: {
          ...m.agent,
          // The run is over: it was replaced by whatever the user typed.
          phase: m.agent.phase === 'awaiting_input' ? 'complete' : m.agent.phase,
          note: answeredAny
            ? 'You sent a new message before answering every question, so this run stopped at the questions it had asked.'
            : 'You replied in the composer instead of choosing an option, so this run stopped at its questions.',
          questions: m.agent.questions.map((q) =>
            q.status === 'pending'
              ? { ...q, status: 'skipped' as const, note: 'Superseded by your next message.', answeredAt: Date.now() }
              : q,
          ),
        },
      }
    })
  }
}

/** The question the UI should be showing right now, if the run is parked on one. */
export function activeAgentQuestion(run: AgentRun | undefined): AgentQuestion | undefined {
  if (!run || run.phase !== 'awaiting_input') return undefined
  return nextPendingQuestion(run.questions)
}

/* ------------------------------------------------------------------ */
/* Store plumbing                                                      */
/* ------------------------------------------------------------------ */

function finalize(assistantMessageId: string, patch: Partial<Message>): void {
  useChat.getState().mutateMessage(assistantMessageId, (message) => {
    const mergedAgent = patch.agent
      ? { ...patch.agent, timeline: patch.agent.timeline ?? message.agent?.timeline }
      : message.agent
    const terminal = patch.status != null && patch.status !== 'streaming'
    const agent =
      terminal && mergedAgent?.timeline
        ? {
            ...mergedAgent,
            timeline: mergedAgent.timeline.map((item) =>
              item.type === 'thought' && item.streaming ? { ...item, streaming: false } : item,
            ),
          }
        : mergedAgent
    return { ...message, ...patch, agent }
  })
}

function setRun(assistantMessageId: string, run: AgentRun): void {
  useChat.getState().mutateMessage(assistantMessageId, (message) => ({
    ...message,
    agent: { ...run, timeline: run.timeline ?? message.agent?.timeline },
  }))
}

function appendMissingThoughtTail(
  messageId: string,
  sourceId: string,
  modelId: string,
  streamed: string,
  finalText: string | undefined,
): void {
  if (!finalText) return
  if (!streamed) {
    appendAgentThought(messageId, sourceId, modelId, finalText)
    return
  }
  if (finalText.startsWith(streamed)) {
    appendAgentThought(messageId, sourceId, modelId, finalText.slice(streamed.length))
  }
}

function patchStep(assistantMessageId: string, stepId: string, patch: Partial<AgentStep>): void {
  useChat.getState().mutateMessage(assistantMessageId, (m) => {
    if (!m.agent) return m
    return {
      ...m,
      agent: {
        ...m.agent,
        steps: m.agent.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
      },
    }
  })
}

function readRun(assistantMessageId: string): AgentRun | undefined {
  for (const conv of Object.values(useChat.getState().conversations)) {
    const m = conv.messages.find((x) => x.id === assistantMessageId)
    if (m) return m.agent
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = idx++
      if (i >= items.length) return
      await fn(items[i]!)
    }
  })
  await Promise.all(workers)
}

function makeThrottledFlush(fn: () => void, ms = 150): () => void {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  return () => {
    const now = performance.now()
    if (now - last >= ms) {
      last = now
      fn()
      return
    }
    if (!timer) {
      timer = setTimeout(() => {
        timer = null
        last = performance.now()
        fn()
      }, ms)
    }
  }
}

/** Re-exported so the UI can build placeholders without importing strategy directly. */
export { newAssistantPlaceholder }
