import { useState } from 'react'
import type { AgentRun, AgentStep, FsOpRecord } from '../../types'
import { useSettings, modelShowsThoughts } from '../../store/settings'
import { useFs } from '../../store/fs'
import { useGitHub } from '../../store/github'
import { useUI } from '../../store/ui'
import { formatFsOpSummary } from '../../lib/fs'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './MessageBubble'
import {
  IconAlert,
  IconBot,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconGitCommit,
  IconLoader,
  IconQuestion,
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
  /** Nothing is in flight: the run is parked on the questions below the card. */
  awaiting_input: 'Waiting for you',
}

export function AgentPlanCard({ run, labelOf, conversationId }: { run: AgentRun; labelOf: (id: string | undefined) => string; conversationId: string }) {
  const settings = useSettings((s) => s.s)
  const expandDefault = settings.agent.expandStepResults
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const total = run.steps.length
  const done = run.steps.filter((s) => s.status === 'complete').length
  const failed = run.steps.filter((s) => s.status === 'error').length
  const live = run.phase === 'planning' || run.phase === 'executing' || run.phase === 'synthesizing'

  const phaseBadge =
    run.phase === 'executing' ? `${PHASE_LABEL[run.phase]} ${done + failed}/${total}` : PHASE_LABEL[run.phase]

  const showPlanningThoughts = modelShowsThoughts(settings, run.orchestratorModelId)
  const timelineThoughtSources = new Set(
    (run.timeline ?? []).filter((item) => item.type === 'thought').map((item) => item.sourceId),
  )
  const planningThoughtInTimeline = timelineThoughtSources.has('planning')

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
          {run.phase === 'awaiting_input' && <IconQuestion size={11} />}
          {phaseBadge}
        </span>
      </header>

      {run.phase === 'planning' && (
        <>
          <p className="agent-plan-strategy">Delegating the work…</p>
          {showPlanningThoughts && run.planningReasoning && !planningThoughtInTimeline ? (
            <div style={{ marginTop: '0.5rem' }}>
              <ThinkingBlock reasoning={run.planningReasoning} streaming={true} />
            </div>
          ) : null}
        </>
      )}
      {run.goal.trim() ? (
        <p className="agent-plan-goal" title={run.goal}>
          <span className="agent-plan-goal-label">Task</span>
          {run.goal}
        </p>
      ) : null}
      {run.strategy && run.phase !== 'planning' && (
        <p className="agent-plan-strategy">{run.strategy}</p>
      )}
      {run.phase !== 'planning' && showPlanningThoughts && run.planningReasoning && !planningThoughtInTimeline ? (
        <div style={{ marginTop: '0.5rem', marginBottom: '0.5rem' }}>
          <ThinkingBlock reasoning={run.planningReasoning} />
        </div>
      ) : null}
      {run.note && <p className="agent-plan-note">{run.note}</p>}

      {/* Nothing delegated yet — a direct answer, or a run parked on its questions. */}
      {run.phase === 'planning' || run.steps.length === 0 ? null : (
        <ol className="agent-steps">
          {run.steps.map((step) => (
            <StepRow
              key={step.id}
              step={step}
              labelOf={labelOf}
              expanded={open[step.id] ?? (expandDefault && step.status === 'complete')}
              thoughtInTimeline={timelineThoughtSources.has(`step:${step.id}`)}
              conversationId={conversationId}
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

      {run.fsOps && run.fsOps.length > 0 && <FsOpsStrip ops={run.fsOps} conversationId={conversationId} />}

    </div>
  )
}

function FsOpsStrip({ ops, conversationId }: { ops: FsOpRecord[]; conversationId: string }) {
  const activeRepo = useGitHub((s) => s.activeRepo)
  const defaultRepo = useGitHub((s) => s.publishDefaults.repo)
  const publishing = useGitHub((s) => s.publishing)

  const openInFiles = (path: string) => {
    useFs.getState().selectFile(path, conversationId)
    useUI.getState().openFiles()
  }

  // Deduplicate by final path so the strip lists each touched file once with its latest operation.
  const byPath = new Map<string, FsOpRecord>()
  for (const op of ops) byPath.set(op.path, op)
  const items = Array.from(byPath.values())
  const writablePaths = items.filter((o) => o.op === 'create' || o.op === 'update' || o.op === 'move').map((o) => o.path)
  const targetRepo = activeRepo ?? defaultRepo

  return (
    <div className="agent-fs-strip" aria-label="Local file system operations">
      <div className="gh-row" style={{ justifyContent: 'space-between' }}>
        <span className="agent-fs-summary">
          <IconFolder size={12} /> {formatFsOpSummary(ops)}
        </span>
        {writablePaths.length > 0 ? (
          <button
            className="btn ghost small"
            disabled={publishing}
            onClick={() => {
              if (!targetRepo || !useGitHub.getState().token) {
                useUI.getState().openFiles()
                return
              }
              void useGitHub.getState().commitFsToGitHub({
                paths: writablePaths,
                repo: targetRepo,
                message: `Apply agent changes (${writablePaths.length} file${writablePaths.length === 1 ? '' : 's'} via Slade)`,
                conversationId,
              })
            }}
            title={
              targetRepo
                ? `Commit ${writablePaths.length} file${writablePaths.length === 1 ? '' : 's'} to ${targetRepo}`
                : 'Open Local Files to commit changes to GitHub'
            }
            type="button"
          >
            <IconGitCommit size={11} /> {targetRepo ? `Commit to ${targetRepo}` : 'Commit to GitHub'}
          </button>
        ) : null}
      </div>
      <div className="agent-fs-chips">
        {items.map((op) => (
          <button
            key={`${op.op}:${op.path}`}
            className={`agent-fs-chip op-${op.op}`}
            onClick={() => openInFiles(op.path)}
            title={`Open ${op.path} in local file system`}
            type="button"
          >
            <span className="agent-fs-op">{op.op}</span>
            <code>{op.path}</code>
            {op.version != null && op.version > 1 ? <span className="fs-version-badge">v{op.version}</span> : null}
          </button>
        ))}
      </div>
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
  thoughtInTimeline,
  conversationId,
  onToggle,
}: {
  step: AgentStep
  labelOf: (id: string | undefined) => string
  expanded: boolean
  thoughtInTimeline: boolean
  conversationId: string
  onToggle: () => void
}) {
  const settings = useSettings((s) => s.s)
  const showThoughts = modelShowsThoughts(settings, step.modelId)
  const hasThoughts = Boolean(showThoughts && (step.reasoning || (step.status === 'running' && !step.result)))
  const brief = step.prompt?.trim() ?? ''
  // The brief is part of the body: the plan card is where you read what each
  // step was actually asked to do, running or done.
  const hasBody = Boolean(brief || (step.result && step.result.trim()) || step.error || hasThoughts)
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
          {step.fsOps && step.fsOps.length > 0 && (
            <span className="agent-step-fs" title={step.fsOps.map((o) => `${o.op} ${o.path}`).join(', ')}>
              <IconFolder size={11} /> {step.fsOps.length}
            </span>
          )}
          <span className="agent-step-model">{model}</span>
          {step.truncated && step.status === 'complete' && (
            <span
              className="agent-step-truncated"
              title="The worker stopped at the output token cap, so this deliverable may be incomplete. Raise “Max tokens per step” in Settings → Agent."
            >
              cut off
            </span>
          )}
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
          {brief ? (
            <div className="agent-step-brief">
              <span className="agent-step-brief-label">Brief</span>
              <pre>{brief}</pre>
            </div>
          ) : null}
          {showThoughts && !thoughtInTimeline && (step.reasoning || (step.status === 'running' && !step.result)) ? (
            <div style={{ marginBottom: step.result ? '0.5rem' : '0' }}>
              <ThinkingBlock
                reasoning={step.reasoning}
                streaming={step.status === 'running' && !step.result}
              />
            </div>
          ) : null}
          {step.error ? (
            <p className="agent-step-error">{step.error}</p>
          ) : (
            <Markdown
              text={step.result ?? ''}
              provenance={{ origin: 'model', modelId: step.modelId, modelLabel: step.modelLabel }}
              messageId={`step-${step.id}`}
              conversationId={conversationId}
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
