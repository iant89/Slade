/**
 * Structured clarification questions — the pure half of the feature.
 *
 * The orchestrator may stop before it plans and ask the user to choose between
 * concrete options (the `ask` mode of the planning contract in
 * `src/engine/agent.ts`). Everything here is model- and store-agnostic so it
 * can be exercised headlessly:
 *
 *  - `normalizeQuestions` turns whatever JSON a model produced into question
 *    objects with stable ids and sane bounds;
 *  - `resolveAnswer` turns the user's selection (picked options and/or a typed
 *    answer) into the record that is stored and sent back;
 *  - the `format*ForModel` helpers render questions, answers and decisions into
 *    the prompt text the next planning or synthesis call receives.
 */

import type { AgentQuestion, AgentQuestionAnswer, AgentQuestionOption } from '../types'
import { uid } from './id'

/* ------------------------------------------------------------------ */
/* Bounds                                                              */
/* ------------------------------------------------------------------ */

/** Most questions one ask-round may contain (the planner prompt says the same). */
export const MAX_QUESTIONS_PER_ROUND = 4
/** Most options a single question may offer. */
export const MAX_OPTIONS_PER_QUESTION = 6
/** Fewer than this and it is not a choice, it is a statement. */
export const MIN_OPTIONS_PER_QUESTION = 2
/**
 * Ask-rounds one run may spend. A model that keeps asking instead of working is
 * a stuck run, so the cap is enforced by the engine, not left to the prompt.
 */
export const MAX_QUESTION_ROUNDS = 3
/**
 * How many times the orchestrator may be told "stop asking, proceed" before
 * Slade stops arguing and runs the task as a single step with its own reading
 * of the goal. Without it, a model that insists on asking would loop forever.
 */
export const MAX_ASK_REFUSALS = 2

/** Longest question / option text Slade keeps. Models occasionally ramble. */
const MAX_PROMPT_CHARS = 500
const MAX_DETAIL_CHARS = 600
const MAX_OPTION_CHARS = 200
const MAX_HINT_CHARS = 300
const MAX_CUSTOM_ANSWER_CHARS = 2_000

/* ------------------------------------------------------------------ */
/* Normalizing a model's reply                                         */
/* ------------------------------------------------------------------ */

/** One question as a model writes it. Every field is optional on the wire. */
export interface RawQuestion {
  question?: unknown
  detail?: unknown
  options?: unknown
  allowCustom?: unknown
  multiple?: unknown
  customLabel?: unknown
}

function clip(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed
}

/** An option is either a bare label or `{ label, hint }` (`value` is accepted too). */
function normalizeOption(raw: unknown): AgentQuestionOption | undefined {
  if (typeof raw === 'string') {
    const label = clip(raw, MAX_OPTION_CHARS)
    return label ? { id: uid('opt'), label } : undefined
  }
  if (raw && typeof raw === 'object') {
    const o = raw as { label?: unknown; value?: unknown; hint?: unknown }
    const label = clip(o.label ?? o.value, MAX_OPTION_CHARS)
    if (!label) return undefined
    const hint = clip(o.hint, MAX_HINT_CHARS)
    return hint ? { id: uid('opt'), label, hint } : { id: uid('opt'), label }
  }
  return undefined
}

/**
 * Turn a planner's `questions` array into renderable question objects.
 *
 * Deliberately strict about what makes a usable question: no prompt or fewer
 * than two distinct options means there is nothing to choose between, and the
 * question is dropped rather than rendered as a dead end. Options are
 * deduplicated case-insensitively — models love offering the same choice twice.
 */
export function normalizeQuestions(raw: unknown, modelId?: string): AgentQuestion[] {
  if (!Array.isArray(raw)) return []
  const askedAt = Date.now()
  const questions: AgentQuestion[] = []

  for (const item of raw.slice(0, MAX_QUESTIONS_PER_ROUND)) {
    if (!item || typeof item !== 'object') continue
    const q = item as RawQuestion
    const prompt = clip(q.question, MAX_PROMPT_CHARS)
    if (!prompt) continue

    const options: AgentQuestionOption[] = []
    if (Array.isArray(q.options)) {
      for (const entry of q.options) {
        if (options.length >= MAX_OPTIONS_PER_QUESTION) break
        const option = normalizeOption(entry)
        if (!option) continue
        if (options.some((o) => o.label.toLowerCase() === option.label.toLowerCase())) continue
        options.push(option)
      }
    }
    if (options.length < MIN_OPTIONS_PER_QUESTION) continue

    const detail = clip(q.detail, MAX_DETAIL_CHARS)
    const customLabel = clip(q.customLabel, MAX_OPTION_CHARS)
    questions.push({
      id: uid('q'),
      prompt,
      detail: detail || undefined,
      options,
      // Opt-out, not opt-in: a typed answer is always available unless the model
      // explicitly said the choice is exhaustive.
      allowCustom: q.allowCustom !== false,
      customLabel: customLabel || undefined,
      multiple: q.multiple === true,
      status: 'pending',
      askedAt,
      modelId,
    })
  }

  return questions
}

/* ------------------------------------------------------------------ */
/* The user's side                                                     */
/* ------------------------------------------------------------------ */

/** What the question form holds before it is submitted. */
export interface QuestionSelection {
  optionIds: string[]
  /** The typed answer; only counted when the question allows one. */
  custom?: string
}

/**
 * Resolve a selection into the answer that gets stored and sent back.
 * Returns undefined when nothing was actually chosen, which is what keeps the
 * submit button honest.
 */
export function resolveAnswer(
  question: AgentQuestion,
  selection: QuestionSelection,
): AgentQuestionAnswer | undefined {
  const picked = question.options.filter((o) => selection.optionIds.includes(o.id))
  const typed = question.allowCustom ? clip(selection.custom, MAX_CUSTOM_ANSWER_CHARS) : ''
  if (picked.length === 0 && !typed) return undefined

  const labels = picked.map((o) => o.label)
  const parts = typed ? [...labels, typed] : labels
  return {
    optionIds: picked.map((o) => o.id),
    labels,
    custom: typed || undefined,
    text: parts.join(', '),
  }
}

/** The answer text a skipped question stands for in the model's context. */
export const SKIPPED_ANSWER = '(skipped — use the safest interpretation and state the assumption)'

/** First question still waiting on the user, if any. */
export function nextPendingQuestion(questions: AgentQuestion[] | undefined): AgentQuestion | undefined {
  return (questions ?? []).find((q) => q.status === 'pending')
}

/** True once every question has an answer or was skipped — the run may continue. */
export function questionsResolved(questions: AgentQuestion[] | undefined): boolean {
  const list = questions ?? []
  return list.length > 0 && list.every((q) => q.status !== 'pending')
}

/** How far through the question list the user is: `{ resolved, total }`. */
export function questionProgress(questions: AgentQuestion[] | undefined): { resolved: number; total: number } {
  const list = questions ?? []
  return { resolved: list.filter((q) => q.status !== 'pending').length, total: list.length }
}

/* ------------------------------------------------------------------ */
/* Prompt text                                                         */
/* ------------------------------------------------------------------ */

/** Heading the decisions block uses, so a simulator can find it again. */
export const DECISIONS_HEADING = 'User decisions (answers to the clarification questions you asked)'

/** One question per line, with its options — what the model asked, verbatim. */
export function formatQuestionsForModel(questions: AgentQuestion[] | undefined): string {
  return (questions ?? [])
    .map((q, i) => {
      const options = q.options.map((o) => o.label).join(' | ')
      const custom = q.allowCustom ? ' | (their own typed answer)' : ''
      const kind = q.multiple ? 'multi-select' : 'single choice'
      return `${i + 1}. ${q.prompt} [${kind}]\n   Options: ${options}${custom}`
    })
    .join('\n')
}

/** The user's side of the exchange: one arrow per question. */
export function formatAnswersForModel(questions: AgentQuestion[] | undefined): string {
  return (questions ?? [])
    .map((q, i) => {
      const answer = q.status === 'answered' ? q.answer?.text?.trim() || SKIPPED_ANSWER : SKIPPED_ANSWER
      return `${i + 1}. ${q.prompt}\n   → ${answer}`
    })
    .join('\n')
}

/**
 * Resolved questions as a context block. Used both by the run that resumes
 * (planning and synthesis) and by `buildTurns`, so a later turn — or a plain
 * chain reply — still knows what the user decided.
 */
export function formatDecisionsForModel(questions: AgentQuestion[] | undefined): string {
  const resolved = (questions ?? []).filter((q) => q.status !== 'pending')
  if (resolved.length === 0) return ''
  const lines = resolved.map((q) => {
    const answer = q.status === 'answered' ? q.answer?.text?.trim() || SKIPPED_ANSWER : SKIPPED_ANSWER
    return `- ${q.prompt}\n  → ${answer}`
  })
  return `${DECISIONS_HEADING}:\n${lines.join('\n')}`
}

/** Short human summary for a screen-reader announcement or a toast. */
export function describeQuestions(questions: AgentQuestion[] | undefined): string {
  const total = (questions ?? []).length
  return `${total} question${total === 1 ? '' : 's'}`
}
