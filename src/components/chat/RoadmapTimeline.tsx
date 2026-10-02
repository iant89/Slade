import type { CSSProperties } from 'react'
import type { RoadmapChange, RoadmapReport, RoadmapStatus, RoadmapTimelineStep } from '../../types'
import { useFs } from '../../store/fs'
import { useUI } from '../../store/ui'
import { IconCheck, IconFolder, IconRoute } from '../icons'

/* ------------------------------------------------------------------ */
/* Roadmap timeline                                                    */
/*                                                                     */
/* Shown under an orchestrated run's final answer whenever a roadmap   */
/* or milestone file was used: overall completion, plus the previous,  */
/* current and next step. Everything comes from the RoadmapReport the  */
/* engine derived by diffing the roadmap file before and after the     */
/* run (src/lib/roadmap.ts), so it can't claim more than the file says. */
/* ------------------------------------------------------------------ */

type Slot = 'previous' | 'current' | 'next'

const SLOT_LABEL: Record<Slot, string> = { previous: 'Previous', current: 'Current', next: 'Next' }
const STATUS_LABEL: Record<RoadmapStatus, string> = { done: 'Done', active: 'In progress', todo: 'Not started' }

function changeVerb(c: RoadmapChange): string {
  if (c.to === 'removed') return 'Removed'
  if (c.from === 'new') return c.to === 'done' ? 'Added, done' : 'Added'
  if (c.to === 'done') return 'Marked done'
  if (c.to === 'active') return c.from === 'done' ? 'Reopened' : 'Started'
  return c.from === 'done' ? 'Reopened' : 'Set back'
}

const steps = (n: number) => `${n} step${n === 1 ? '' : 's'}`
const MAX_CHANGES_SHOWN = 4

export function RoadmapTimeline({ report, conversationId }: { report: RoadmapReport; conversationId: string }) {
  const { progress, before, changes } = report
  const complete = progress.total > 0 && progress.done === progress.total
  const delta = before ? progress.done - before.done : 0

  const nodes: { slot: Slot; step: RoadmapTimelineStep }[] = []
  if (report.previous) nodes.push({ slot: 'previous', step: report.previous })
  if (report.current) nodes.push({ slot: 'current', step: report.current })
  if (report.next) nodes.push({ slot: 'next', step: report.next })

  // The bar animates from where the roadmap stood when the run began to where
  // it stands now, so a run's contribution is visible at a glance.
  const barStyle = {
    '--roadmap-from': `${before?.percent ?? progress.percent}%`,
    '--roadmap-to': `${progress.percent}%`,
  } as CSSProperties

  const openRoadmap = () => {
    useFs.getState().selectFile(report.path, conversationId)
    useUI.getState().openFiles()
  }

  return (
    <section className={`roadmap-card${complete ? ' is-complete' : ''}`} aria-label="Roadmap progress">
      <header className="roadmap-head">
        <span className="roadmap-title">
          <IconRoute size={13} />
          <span className="roadmap-title-text">{report.title ?? 'Roadmap'}</span>
          <code className="roadmap-path" title={report.path}>
            {report.path}
          </code>
        </span>
        <button
          className="btn ghost small roadmap-open"
          type="button"
          onClick={openRoadmap}
          aria-label={`Open ${report.path} in Local Files`}
          title={`Open ${report.path} in Local Files`}
        >
          <IconFolder size={11} /> Open
        </button>
      </header>

      <div
        className="roadmap-bar"
        role="progressbar"
        aria-label="Overall roadmap completion"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        aria-valuetext={`${progress.done} of ${steps(progress.total)} done, ${progress.percent}%`}
      >
        <span className="roadmap-bar-fill" style={barStyle} />
      </div>
      <div className="roadmap-progress">
        <span className="roadmap-progress-main">
          <strong>{progress.percent}%</strong> complete · {progress.done} of {steps(progress.total)} done
          {progress.active > 0 ? ` · ${progress.active} in progress` : ''}
        </span>
        {before && delta !== 0 ? (
          <span className={`roadmap-progress-delta${delta < 0 ? ' is-negative' : ''}`}>
            {delta > 0 ? `+${steps(delta)}` : `−${steps(-delta)}`} this run · was {before.percent}%
          </span>
        ) : null}
      </div>

      {nodes.length > 0 ? (
        <ol className={`roadmap-timeline nodes-${nodes.length}`} aria-label="Roadmap timeline: previous, current and next step">
          {nodes.map(({ slot, step }, i) => {
            const following = nodes[i + 1]?.step
            // The line to the next node is solid once the path has been travelled
            // (this step done, the next one done or under way), dashed while ahead.
            const travelled = step.status === 'done' && following !== undefined && following.status !== 'todo'
            return (
              <li
                key={slot}
                className={`roadmap-node slot-${slot} status-${step.status}`}
                aria-current={slot === 'current' ? 'step' : undefined}
              >
                <span className="roadmap-dot" aria-hidden="true">
                  {step.status === 'done' ? (
                    <IconCheck size={12} />
                  ) : step.status === 'active' ? (
                    <span className="roadmap-dot-half" />
                  ) : null}
                </span>
                <span className="roadmap-node-body">
                  <span className="roadmap-slot">
                    {SLOT_LABEL[slot]} · step {step.index} of {progress.total}
                  </span>
                  <span className="roadmap-label" title={step.label}>
                    {step.label}
                  </span>
                  {step.group ? (
                    <span className="roadmap-group" title={step.group}>
                      {step.group}
                    </span>
                  ) : null}
                  <span className="roadmap-status">
                    {STATUS_LABEL[step.status]}
                    {step.changed ? ' · this run' : ''}
                  </span>
                </span>
                {following ? (
                  <span className={`roadmap-link ${travelled ? 'is-travelled' : 'is-ahead'}`} aria-hidden="true" />
                ) : null}
              </li>
            )
          })}
        </ol>
      ) : null}

      {complete && !report.next ? <p className="roadmap-note is-done">Every step on the roadmap is done.</p> : null}

      {!before ? (
        <p className="roadmap-note">This roadmap was created in this run, so the timeline shows where it starts.</p>
      ) : changes.length === 0 ? (
        <p className="roadmap-note">
          No step changed status in this run. The timeline shows where the roadmap currently stands.
        </p>
      ) : (
        <ul className="roadmap-changes" aria-label="Roadmap changes in this run">
          {changes.slice(0, MAX_CHANGES_SHOWN).map((c, i) => (
            <li key={`${c.label}-${i}`} className={`roadmap-change to-${c.to}`}>
              <span className="roadmap-change-verb">{changeVerb(c)}</span>
              <span className="roadmap-change-label" title={c.label}>
                {c.label}
              </span>
            </li>
          ))}
          {changes.length > MAX_CHANGES_SHOWN ? (
            <li className="roadmap-change roadmap-more">+{changes.length - MAX_CHANGES_SHOWN} more</li>
          ) : null}
        </ul>
      )}
    </section>
  )
}
