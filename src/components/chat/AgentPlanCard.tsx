import { useState } from 'react'
import type { AgentRun, AgentStep } from '../../types'
import { useSettings } from '../../store/settings'
import { Markdown } from './Markdown'
import {
  IconAlert,
  IconBot,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconLoader,
} from '../icons'

/* ------------------------------------------------------------------ */
/* The orchestrator run card                                           */
/*                                                                     */
/* Renders the whole delegated run: the plan, each worker step with    */
/* which model executed it, live status while the run progresses, and  */
/* expandable worker output. The final synthesized answer streams in   */
/* the message body underneath (rendered by AssistantBody).            */
/* ------------------------------------------------------------------ */

const PHASE_LABEL: Record<AgentRun['phase'], string> = {
  planning: 'Planning',
  executing: 'Executing',
  synthesizing: 'Synthesizing',
  complete: 'Complete',
  error: 'Failed',
}

export function AgentPlanCard({ run, labelOf }: { run: AgentRun; labelOf: (id: string | undefined) => string }) {
  const expandDefault = useSettings((s) => s.s.agent.expandStepResults)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const total = run.steps.length
  const done = run.steps.filter((s) => s.status === 'complete').length
  const failed = run.steps.filter((s) => s.status === 'error').length
  const live = run.phase === 'planning' || run.phase === 'executing' || run.phase === 'synthesizing'

  const phaseBadge =
    run.phase === 'executing' ? `${PHASE_LABEL[run.phase]} ${done + failed}/${total}` : PHASE_LABEL[run.phase]

  return (
    <div className={`agent-plan phase-${run.phase}`} aria-label="Orchestrator run">
      <header className="agent-plan-head">
        <span className="agent-plan-title">
          <IconBot size={13} /> Task plan
        </span>
        <span className={`agent-phase phase-${run.phase}`}>
          {live && <IconLoader size={11} className="spin" />}
          {run.phase === 'complete' && <IconCheck size={11} />}
          {run.phase === 'error' && <IconAlert size={11} />}
          {phaseBadge}
        </span>
      </header>

      {run.phase === 'planning' && (
        <p className="agent-plan-strategy">Delegating the work…</p>
      )}
      {run.strategy && run.phase !== 'planning' && (
        <p className="agent-plan-strategy">{run.strategy}</p>
      )}
      {run.note && <p className="agent-plan-note">{run.note}</p>}

      {run.phase === 'planning' ? null : (
        <ol className="agent-steps">
          {run.steps.map((step) => (
            <StepRow
              key={step.id}
              step={step}
              labelOf={labelOf}
              expanded={open[step.id] ?? (expandDefault && step.status === 'complete')}
              onToggle={() => setOpen((o) => ({ ...o, [step.id]: !(o[step.id] ?? (expandDefault && step.status === 'complete')) }))}
            />
          ))}
        </ol>
      )}

      {run.phase === 'error' && run.error && (
        <p className="agent-plan-error" role="alert">
          <IconAlert size={12} /> {run.error}
        </p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* One delegated step                                                  */
/* ------------------------------------------------------------------ */

function StepRow({
  step,
  labelOf,
  expanded,
  onToggle,
}: {
  step: AgentStep
  labelOf: (id: string | undefined) => string
  expanded: boolean
  onToggle: () => void
}) {
  const hasBody = Boolean((step.result && step.result.trim()) || step.error)
  const model = labelOf(step.modelId) || step.modelLabel
  const fellBackFrom = (step.failedChain ?? []).filter((id) => id !== step.modelId)

  return (
    <li className={`agent-step status-${step.status}`}>
      <button
        className="agent-step-head"
        onClick={onToggle}
        disabled={!hasBody}
        aria-expanded={hasBody ? expanded : undefined}
        type="button"
      >
        <StepStatus step={step} />
        <span className="agent-step-title">{step.title}</span>
        <span className="agent-step-meta">
          {fellBackFrom.length > 0 && (
            <span className="agent-step-fallback">← {fellBackFrom.map(labelOf).join(', ')}</span>
          )}
          <span className="agent-step-model">{model}</span>
          {step.elapsedMs != null && step.status !== 'running' && (
            <span className="agent-step-time">{formatMs(step.elapsedMs)}</span>
          )}
          {hasBody ? (
            expanded ? (
              <IconChevronDown size={12} />
            ) : (
              <IconChevronRight size={12} />
            )
          ) : null}
        </span>
      </button>
      {expanded && hasBody && (
        <div className="agent-step-body">
          {step.error ? (
            <p className="agent-step-error">{step.error}</p>
          ) : (
            <Markdown
              text={step.result ?? ''}
              provenance={{ origin: 'model', modelId: step.modelId, modelLabel: step.modelLabel }}
              messageId={`step-${step.id}`}
            />
          )}
        </div>
      )}
    </li>
  )
}

function StepStatus({ step }: { step: AgentStep }) {
  switch (step.status) {
    case 'running':
      return (
        <span className="step-icon running" aria-label="running">
          <IconLoader size={12} className="spin" />
        </span>
      )
    case 'complete':
      return (
        <span className="step-icon complete" aria-label="done">
          <IconCheck size={12} />
        </span>
      )
    case 'error':
      return (
        <span className="step-icon error" aria-label="failed">
          <IconAlert size={12} />
        </span>
      )
    case 'skipped':
      return (
        <span className="step-icon skipped" aria-label="skipped">
          —
        </span>
      )
    default:
      return <span className="step-icon pending" aria-label="queued" />
  }
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}
