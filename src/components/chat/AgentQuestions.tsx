import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { AgentQuestion, AgentRun } from '../../types'
import { useSettings } from '../../store/settings'
import { useUI } from '../../store/ui'
import { answerAgentQuestion, skipAgentQuestion } from '../../engine/agent'
import { nextPendingQuestion, questionProgress, resolveAnswer } from '../../lib/questions'
import { copyText } from '../../lib/clipboard'
import { IconCheck, IconCopy, IconPencil, IconQuestion, IconX } from '../icons'

/* ------------------------------------------------------------------ */
/* The agent's questions                                               */
/*                                                                     */
/* An orchestrated run can stop before it plans and ask the user to     */
/* choose. Questions are answered one at a time, in order: submitting   */
/* collapses that question into a read-only answer card (the options    */
/* that were not chosen are gone for good) and reveals the next         */
/* question block underneath it. Answering the last one resumes the     */
/* run in place — same message, same plan card.                        */
/* ------------------------------------------------------------------ */

/**
 * Set when a submit just closed a question, so the block that replaces it takes
 * keyboard focus instead of leaving it on a button that no longer exists.
 * Module-scoped on purpose: the handoff crosses a mount boundary.
 */
let focusNextQuestion = false

export function AgentQuestions({ run, messageId }: { run: AgentRun; messageId: string }) {
  const questions = run.questions ?? []
  const parked = run.phase === 'awaiting_input'
  const active = parked ? nextPendingQuestion(questions) : undefined
  const { resolved, total } = questionProgress(questions)

  // Nothing left to ask (the run resumed, or it was superseded): drop a pending
  // focus handoff so it can't land on some later, unrelated question form.
  useEffect(() => {
    if (!active) focusNextQuestion = false
  })

  if (questions.length === 0) return null

  return (
    <div className={`agent-questions${parked ? ' parked' : ''}`} aria-label="Questions from the agent">
      {active ? (
        <div className="agent-questions-head">
          <span className="agent-questions-title">
            <IconQuestion size={12} /> The agent needs your input
          </span>
          <span className="agent-questions-progress">
            Question {Math.min(resolved + 1, total)} of {total}
          </span>
        </div>
      ) : null}

      {questions.map((question, index) => {
        if (question.status === 'pending') {
          return question.id === active?.id ? (
            <QuestionForm
              key={question.id}
              question={question}
              index={index}
              total={total}
              messageId={messageId}
            />
          ) : null
        }
        return <AnswerCard key={question.id} question={question} index={index} total={total} />
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* One open question                                                   */
/* ------------------------------------------------------------------ */

function QuestionForm({
  question,
  index,
  total,
  messageId,
}: {
  question: AgentQuestion
  index: number
  total: number
  messageId: string
}) {
  const toast = useUI((s) => s.toast)
  const labelOf = useSettings((s) => s.s.models.find((m) => m.id === question.modelId)?.label)
  const promptId = useId()
  const detailId = useId()
  const multiple = Boolean(question.multiple)
  const [selected, setSelected] = useState<string[]>([])
  const [customOpen, setCustomOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const customRef = useRef<HTMLTextAreaElement>(null)
  /** Fallback focus target for a question whose options are all gone. */
  const promptRef = useRef<HTMLParagraphElement>(null)

  const answer = useMemo(
    () => resolveAnswer(question, { optionIds: selected, custom: customOpen ? custom : '' }),
    [question, selected, customOpen, custom],
  )

  const choose = (id: string) => {
    if (multiple) {
      setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
      return
    }
    // Single choice: an option and a typed answer are mutually exclusive, so
    // picking one clears the other rather than leaving an ambiguous selection.
    setSelected([id])
    setCustomOpen(false)
    setCustom('')
  }

  const openCustom = () => {
    setCustomOpen(true)
    if (!multiple) setSelected([])
    requestAnimationFrame(() => customRef.current?.focus())
  }

  const submit = () => {
    if (!answer || submitting) return
    setSubmitting(true)
    focusNextQuestion = true
    const ok = answerAgentQuestion(messageId, question.id, {
      optionIds: selected,
      custom: customOpen ? custom : undefined,
    })
    if (!ok) {
      setSubmitting(false)
      focusNextQuestion = false
      toast({ kind: 'error', title: 'That answer could not be recorded', detail: 'The question is no longer open.' })
    }
    // On success the question leaves `pending` in the store and this form is
    // replaced by its answer card — no local state left to clean up.
  }

  const skip = () => {
    if (submitting) return
    setSubmitting(true)
    focusNextQuestion = true
    skipAgentQuestion(messageId, question.id)
  }

  // The block that replaced the one just submitted takes focus, so a keyboard
  // user lands in the next question's options instead of at the top of the page.
  useEffect(() => {
    if (!focusNextQuestion) return
    focusNextQuestion = false
    ;(optionRefs.current[0] ?? promptRef.current)?.focus()
  }, [])

  /** Roving focus for the option list, the way a native radio group behaves. */
  const moveFocus = (from: number, delta: number) => {
    const count = question.options.length + (question.allowCustom ? 1 : 0)
    if (count === 0) return
    const next = (from + delta + count) % count
    const el = optionRefs.current[next]
    if (el) {
      el.focus()
      const id = question.options[next]?.id
      if (id && !multiple) choose(id)
      if (!id && question.allowCustom) openCustom()
    }
  }

  const onKeyDown = (event: React.KeyboardEvent, at: number) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault()
      moveFocus(at, 1)
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault()
      moveFocus(at, -1)
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    // Enter on an unchosen option picks it (single choice) or opens the typed
    // field; Enter on what is already chosen submits — the keyboard equivalent
    // of "click the option, then Submit".
    const id = question.options[at]?.id
    if (!multiple) {
      if (id && !selected.includes(id)) {
        choose(id)
        return
      }
      if (!id && question.allowCustom && !customOpen) {
        openCustom()
        return
      }
    }
    submit()
  }

  const customAt = question.options.length

  return (
    <motion.div
      className={`agent-question${submitting ? ' submitting' : ''}`}
      role={multiple ? 'group' : 'radiogroup'}
      aria-labelledby={promptId}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
    >
      <p className="agent-question-prompt" id={promptId} ref={promptRef} tabIndex={-1}>
        <span className="agent-question-index">
          {index + 1}
          {total > 1 ? `/${total}` : ''}
        </span>
        {question.prompt}
      </p>
      {question.detail ? (
        <p className="agent-question-detail" id={detailId}>
          {question.detail}
        </p>
      ) : null}

      <div className="agent-question-options">
        {question.options.map((option, i) => {
          const checked = selected.includes(option.id)
          return (
            <button
              key={option.id}
              ref={(el) => {
                optionRefs.current[i] = el
              }}
              type="button"
              className={`agent-question-option${checked ? ' checked' : ''}`}
              role={multiple ? 'checkbox' : 'radio'}
              aria-checked={checked}
              aria-describedby={question.detail ? detailId : undefined}
              disabled={submitting}
              // Roving tabindex: one stop in the group, on the chosen option
              // (or the first, when nothing is chosen yet).
              tabIndex={multiple ? 0 : checked || selected.length === 0 ? 0 : -1}
              onClick={() => choose(option.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              <span className="agent-question-mark" aria-hidden="true">
                {checked ? <IconCheck size={11} /> : null}
              </span>
              <span className="agent-question-option-text">
                <span className="agent-question-option-label">{option.label}</span>
                {option.hint ? <span className="agent-question-option-hint">{option.hint}</span> : null}
              </span>
            </button>
          )
        })}

        {question.allowCustom ? (
          <div className={`agent-question-custom${customOpen ? ' open' : ''}`}>
            <button
              ref={(el) => {
                optionRefs.current[customAt] = el
              }}
              type="button"
              className={`agent-question-option custom${customOpen ? ' checked' : ''}`}
              role={multiple ? 'checkbox' : 'radio'}
              aria-checked={customOpen}
              aria-expanded={customOpen}
              disabled={submitting}
              tabIndex={multiple ? 0 : customOpen || selected.length === 0 ? 0 : -1}
              onClick={() => (customOpen ? setCustomOpen(false) : openCustom())}
              onKeyDown={(e) => onKeyDown(e, customAt)}
            >
              <span className="agent-question-mark custom" aria-hidden="true">
                {customOpen ? <IconPencil size={11} /> : null}
              </span>
              <span className="agent-question-option-text">
                <span className="agent-question-option-label">Or type your own answer</span>
                <span className="agent-question-option-hint">
                  {question.customLabel?.trim() || 'None of these — I’ll describe it.'}
                </span>
              </span>
            </button>
            <AnimatePresence initial={false}>
              {customOpen ? (
                <motion.div
                  className="agent-question-field"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                >
                  <textarea
                    ref={customRef}
                    rows={2}
                    value={custom}
                    disabled={submitting}
                    onChange={(e) => setCustom(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        submit()
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setCustomOpen(false)
                      }
                    }}
                    placeholder={question.customLabel?.trim() || 'Type your answer…'}
                    aria-label={`Your own answer to: ${question.prompt}`}
                  />
                  <span className="agent-question-field-hint">Enter to submit · Shift + Enter for a new line</span>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        ) : null}
      </div>

      <div className="agent-question-actions">
        <span className="agent-question-asked">
          {multiple ? 'Select every option that applies' : 'Choose one option, or type your own'}
          {labelOf ? ` · asked by ${labelOf}` : ''}
        </span>
        <button className="btn ghost small" type="button" onClick={skip} disabled={submitting}>
          Skip
        </button>
        <button className="btn primary small" type="button" onClick={submit} disabled={!answer || submitting}>
          <IconCheck size={12} /> {submitting ? 'Sending…' : 'Submit answer'}
        </button>
      </div>
    </motion.div>
  )
}

/* ------------------------------------------------------------------ */
/* One settled question — the answer, as an artifact card              */
/* ------------------------------------------------------------------ */

function AnswerCard({ question, index, total }: { question: AgentQuestion; index: number; total: number }) {
  const toast = useUI((s) => s.toast)
  const skipped = question.status === 'skipped'
  const answer = question.answer
  const labels = answer?.labels ?? []
  const typed = answer?.custom?.trim()
  const headline = skipped ? 'Skipped' : answer?.text?.trim() || 'Answered'
  const detail = question.note ?? (skipped ? 'No answer given — the agent will use the safest interpretation.' : undefined)

  return (
    <motion.figure
      className={`artifact-card kind-answer${skipped ? ' skipped' : ''}`}
      initial={{ opacity: 0, y: 6, scale: 0.995 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      aria-label={`${skipped ? 'Skipped question' : 'Your answer'}: ${question.prompt}`}
    >
      <div className="artifact-head">
        <span className={`artifact-icon kind-answer${skipped ? ' skipped' : ''}`} aria-hidden="true">
          {skipped ? <IconX size={15} /> : <IconCheck size={15} />}
        </span>
        <span className="artifact-meta">
          <span className="artifact-name" title={headline}>
            {headline}
          </span>
          <span className="artifact-sub">
            {skipped ? 'Question skipped' : 'Your answer'} · Question {index + 1} of {total}
            {typed ? ' · typed by you' : ''}
          </span>
        </span>
      </div>

      <div className="artifact-body">
        <div className="answer-body">
          <p className="answer-question">
            <IconQuestion size={11} /> {question.prompt}
          </p>
          {skipped ? (
            <p className="answer-skipped">{detail}</p>
          ) : (
            <div className="answer-value">
              {labels.map((label) => (
                <span key={label} className="answer-chip">
                  <IconCheck size={10} /> {label}
                </span>
              ))}
              {typed ? <p className="answer-typed">{typed}</p> : null}
            </div>
          )}
        </div>
      </div>

      <figcaption className="artifact-foot">
        <button
          className="artifact-action"
          type="button"
          onClick={async () => {
            const ok = await copyText(`${question.prompt}\n→ ${headline}`)
            toast({ kind: ok ? 'success' : 'error', title: ok ? 'Answer copied' : 'Copy failed' })
          }}
        >
          <IconCopy size={12} /> Copy answer
        </button>
        {!skipped && labels.length > 1 ? (
          <span className="artifact-action is-static" title="Every option you selected">
            {labels.length} selected
          </span>
        ) : null}
      </figcaption>
    </motion.figure>
  )
}
