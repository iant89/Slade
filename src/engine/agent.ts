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

import type { AgentRun, AgentStep, AttemptFailure, ChatTurn, Message, ModelDef, Settings, Usage } from '../types'
import { z } from 'zod'
import { useChat } from '../store/chat'
import { useSettings } from '../store/settings'
import { useUI } from '../store/ui'
import { buildTurns } from './turns'
import { modelHasKey, newAssistantPlaceholder } from './strategy'
import { announceResponse } from './announce'
import { getRun, finishRun, registerRun } from './active'
import {
  CompletionExhausted,
  modelLabel,
  runCompletion,
  workerCandidates,
  mergeUsage,
} from './completion'
import { ProviderError } from '../providers/base'
import { uid } from '../lib/id'

/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

export const PLAN_MARKER = '[SLADE:ORCHESTRATOR:PLAN]'
export const SYNTH_MARKER = '[SLADE:ORCHESTRATOR:SYNTH]'

function planSystemPrompt(settings: Settings, maxSteps: number): string {
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

  return `You are the Slade Orchestrator: a coordinating model that decomposes the user's task and delegates work to worker models.

${PLAN_MARKER}

Respond with ONLY one JSON object — no prose outside the JSON:

To answer directly (greetings, quick facts, simple follow-ups you can fully handle alone):
{"mode":"answer","answer":"<the complete markdown answer>"}

To delegate (multi-part or substantial tasks):
{"mode":"plan","reply":"<one short sentence describing your strategy>","subtasks":[{"title":"<short imperative title>","model":"<exact label from the roster, or "" for chain order>","prompt":"<the complete, self-contained task for a worker model>"}]}

Rules:
- At most ${maxSteps} subtasks. Fewer is better when the task is small.
- Each subtask prompt must be fully self-contained: the worker sees NOTHING else from this conversation. Repeat every detail it needs.
- Order subtasks so later ones can build on earlier ones.
- When the task benefits from multiple perspectives or formats (e.g. data + analysis + review), spread subtasks across DIFFERENT models from the roster.
- If files are involved, tell the worker to emit them as fenced blocks tagged with a filename.

Worker roster:
${roster || '(no workers configured — answer directly)'}`
}

function synthSystemPrompt(): string {
  return `You are the Slade Orchestrator. Worker models just executed the subtasks of the user's goal, and their outputs are below.

${SYNTH_MARKER}

Assemble ONE final answer for the user, in Markdown:
- Open with a single line confirming what was accomplished.
- Integrate the workers' deliverables into a coherent whole (do not just repeat them verbatim; dedupe and reconcile).
- If a step failed or produced nothing usable, say so briefly and do your best with the rest — never pretend a failed step succeeded.
- Keep any files the workers produced: reproduce their fenced blocks (with the same filename tags) so they become artifacts.
- End only with genuinely useful next steps, if any.`
}

function workerSystemPrompt(): string {
  return `You are a specialist worker model in Slade. An orchestrator delegated exactly one self-contained task to you.

Complete ONLY that task. Return the deliverable directly in Markdown — no meta-commentary about being an AI, no restating the task.
If the task involves a file (CSV, code, document), emit it in a fenced block tagged with a filename, e.g. \`\`\`csv:report.csv or \`\`\`typescript:main.ts.`
}

/* ------------------------------------------------------------------ */
/* Planner reply parsing                                               */
/* ------------------------------------------------------------------ */

const plannerReplySchema = z.union([
  z.object({ mode: z.literal('answer'), answer: z.string().min(1) }),
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
 * prose or fences no matter how hard the prompt forbids it, so: strip fences,
 * then try the outermost braces, then a string-aware balanced scan.
 */
export function extractJsonObject(text: string): unknown | undefined {
  const stripped = text.replace(/```(?:json)?/gi, '')
  const start = stripped.indexOf('{')
  if (start < 0) return undefined
  const end = stripped.lastIndexOf('}')
  if (end > start) {
    try {
      return JSON.parse(stripped.slice(start, end + 1))
    } catch {
      /* fall through to the balanced scan */
    }
  }
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i]
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
      if (depth === 0) {
        try {
          return JSON.parse(stripped.slice(start, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
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
  if (getRun(conversationId)) {
    useUI.getState().toast({ kind: 'warn', title: 'A response is already streaming in this chat.' })
    return
  }

  const settings = useSettings.getState().s
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

  const goal = userMessage.content.trim()
  const controller = new AbortController()
  const attempt = registerRun(conversationId, controller)
  const signal = controller.signal

  const baseRun: AgentRun = {
    phase: 'planning',
    goal,
    orchestratorModelId: orchestrator.id,
    steps: [],
    startedAt: Date.now(),
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

  try {
    /* ---------------- planning ---------------- */

    const historyTurns = await buildTurns(
      useChat.getState().conversations[conversationId] ?? conv,
      { upToMessageId: userMessageId },
    )
    const planTurns: ChatTurn[] = [...historyTurns]
    const planResult = await runCompletion({
      purpose: 'Planning',
      turns: planTurns,
      systemPrompt: planSystemPrompt(settings, settings.agent.maxSteps),
      settings,
      candidates: [orchestrator, ...workerCandidates(settings, new Set([orchestrator.id]))],
      // Every orchestrator call gets the step budget, not the chat default: a
      // reasoning model bills its thinking against the same cap, and a cap
      // that only fits the answer is how a step comes back with nothing in it.
      maxTokensFloor: settings.agent.stepMaxTokens,
      signal,
      silent: true,
    })
    collectAttempts(planResult.attempts)
    usageAcc.current = mergeUsage(usageAcc.current, planResult.usage)
    signal.throwIfAborted()

    let plannerReply = parsePlannerReply(planResult.text)
    let note: string | undefined

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
        systemPrompt: planSystemPrompt(settings, settings.agent.maxSteps),
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

    // The orchestrator answered directly — nothing to delegate.
    if (plannerReply?.mode === 'answer') {
      const answer = plannerReply.answer
      finalize(assistantMessageId, {
        status: 'complete',
        content: answer,
        modelId: planResult.model.id,
        chain: [planResult.model.id],
        usage: usageAcc.current,
        agent: {
          ...baseRun,
          phase: 'complete',
          steps: [],
          strategy: undefined,
          orchestratorModelId: planResult.model.id,
          finishedAt: Date.now(),
        },
      })
      announceResponse(`Response from ${modelLabel(settings.models, planResult.model.id)}.`)
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

      // Stream the worker's output into the step card, throttled so fast
      // token cadences don't thrash the store.
      let acc = ''
      const flush = makeThrottledFlush(() => {
        patchStep(assistantMessageId, step.id, { result: acc })
      }, 140)

      try {
        const result = await runCompletion({
          purpose: `Step “${step.title}”`,
          turns: [{ role: 'user', text: step.prompt }],
          systemPrompt: workerSystemPrompt(),
          settings,
          candidates: ordered,
          maxTokensFloor: settings.agent.stepMaxTokens,
          signal,
          onDelta: (t) => {
            acc += t
            flush()
          },
        })
        collectAttempts(result.attempts)
        usageAcc.current = mergeUsage(usageAcc.current, result.usage)
        patchStep(assistantMessageId, step.id, {
          status: 'complete',
          result: result.text,
          modelId: result.model.id,
          modelLabel: modelLabel(settings.models, result.model.id),
          failedChain: result.failedChain,
          attempts: result.attempts,
          elapsedMs: Math.round(performance.now() - startedAt),
          // A worker cut off at the token cap hands the synthesis pass a
          // half-finished file; the step card says so instead of letting the
          // truncation look like the worker's choice.
          truncated: result.truncated || undefined,
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

    await runPool(steps, Math.max(1, Math.min(settings.agent.maxParallel, steps.length)), runStep)
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

    const synthTurns: ChatTurn[] = [
      ...historyTurns,
      {
        role: 'user',
        text: `Goal: ${goal}\n\nSubtask results from the worker models:\n\n${resultsBlock}\n\nAssemble the final answer now.`,
      },
    ]

    let content = ''
    let synthTruncated = false
    try {
      const synth = await runCompletion({
        purpose: 'Synthesis',
        turns: synthTurns,
        systemPrompt: synthSystemPrompt(),
        settings,
        candidates: [orchestrator, ...workerCandidates(settings, new Set([orchestrator.id]))],
        maxTokensFloor: settings.agent.stepMaxTokens,
        signal,
        onDelta: (t) => {
          content += t
          useChat.getState().mutateMessage(assistantMessageId, (m) => ({ ...m, content }))
        },
      })
      collectAttempts(synth.attempts)
      usageAcc.current = mergeUsage(usageAcc.current, synth.usage)
      content = synth.text
      synthTruncated = Boolean(synth.truncated)
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

    const finalRunState = readRun(assistantMessageId)
    const workerIds = [...new Set((finalRunState?.steps ?? []).map((s) => s.modelId))]
    const hadFailures = (finalRunState?.steps ?? []).some((s) => s.status === 'error')
    const cutOff = (finalRunState?.steps ?? []).filter((s) => s.truncated)
    if (cutOff.length > 0) {
      note = `${note ? `${note} ` : ''}${cutOff.length === 1 ? `One worker step was` : `${cutOff.length} worker steps were`} cut off at the output token cap, so ${cutOff.length === 1 ? 'its' : 'their'} deliverable may be incomplete — raise “Max tokens per step” in Settings → Agent.`
    }

    finalize(assistantMessageId, {
      status: 'complete',
      content,
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
      },
    })
    announceResponse(
      `Orchestrator finished: ${succeeded} of ${steps.length} steps completed${hadFailures ? ', some steps failed' : ''}.`,
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
    finishRun(conversationId)
  }
}

/* ------------------------------------------------------------------ */
/* Store plumbing                                                      */
/* ------------------------------------------------------------------ */

function finalize(assistantMessageId: string, patch: Partial<Message>): void {
  useChat.getState().mutateMessage(assistantMessageId, (m) => ({ ...m, ...patch }))
}

function setRun(assistantMessageId: string, run: AgentRun): void {
  useChat.getState().mutateMessage(assistantMessageId, (m) => ({ ...m, agent: run }))
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
