import type { ReactNode } from 'react'
import type { GitHubActionArtifact } from '../../types'
import type { GitHubActionEntry } from '../../store/githubActivity'
import { IconAlert, IconCheck, IconGithub, IconLoader } from '../icons'

/* ------------------------------------------------------------------ */
/* GitHub action card                                                  */
/*                                                                     */
/* A read-only row: icon, action title, the path it touched, and a     */
/* status glyph. Cards have no delete or dismiss control.              */
/* ------------------------------------------------------------------ */

function statusOf(entry: GitHubActionArtifact): { icon: ReactNode; label: string } {
  if (entry.status === 'running') return { icon: <IconLoader size={12} />, label: 'in progress' }
  if (entry.status === 'error') return { icon: <IconAlert size={12} />, label: 'failed' }
  if (entry.status === 'cancelled') return { icon: <IconAlert size={12} />, label: 'cancelled' }
  return { icon: <IconCheck size={12} />, label: 'done' }
}

function detailOf(entry: GitHubActionArtifact): string {
  const where = entry.repo ? (entry.ref ? `${entry.repo} @ ${entry.ref}` : entry.repo) : ''
  const bits = [
    entry.title.replace(/^GitHub Action:\s*/, ''),
    entry.subject,
    where,
    entry.count > 1 ? `${entry.count} calls` : '',
    entry.error ?? statusOf(entry).label,
  ].filter(Boolean)
  return bits.join(' · ')
}

/** `987ms` / `1.4s` — the same shape the agent steps use. */
function durationOf(ms: number | undefined): string {
  if (ms == null) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export function GitHubActionCard({ entry }: { entry: GitHubActionArtifact }) {
  const status = statusOf(entry)
  const target = entry.repo ? (entry.ref ? `${entry.repo}@${entry.ref}` : entry.repo) : ''
  const duration = durationOf(entry.elapsedMs)
  return (
    <div
      className={`gh-action-card status-${entry.status}`}
      title={detailOf(entry)}
      data-gh-action={entry.kind}
    >
      <span className="gh-action-icon" aria-hidden="true">
        <IconGithub size={13} />
      </span>
      <span className="gh-action-lines">
        <span className="gh-action-title">{entry.title}</span>
        {entry.subject ? (
          <span className="gh-action-subject">
            <code>{entry.subject}</code>
          </span>
        ) : null}
      </span>
      <span className="gh-action-side">
        {entry.status === 'error' && entry.error ? (
          <span className="gh-action-error">{clip(entry.error, 54)}</span>
        ) : null}
        {entry.status === 'cancelled' ? <span className="gh-action-time">Cancelled</span> : null}
        {entry.count > 1 ? <span className="gh-action-repeat">×{entry.count}</span> : null}
        {target ? <span className="gh-action-target">{target}</span> : null}
        {duration ? <span className="gh-action-time">{duration}</span> : null}
        <span className={`gh-action-status ${entry.status}`} aria-label={status.label}>
          {status.icon}
        </span>
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Session-level action row                                            */
/* ------------------------------------------------------------------ */

/** Calls made outside an agent response remain standalone chat log rows. */
export function GitHubActionItem({ entry }: { entry: GitHubActionEntry }) {
  return (
    <div className="gh-panel-item" data-gh-panel-action={entry.kind}>
      <GitHubActionCard entry={entry} />
    </div>
  )
}
