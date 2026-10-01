import { useId, useState, type ReactNode } from 'react'
import type { GitHubActionArtifact } from '../../types'
import type { GitHubActionEntry } from '../../store/githubActivity'
import { githubActionPhrase, summarizeGitHubGroup } from '../../lib/github-actions'
import { IconAlert, IconCheck, IconChevronDown, IconChevronRight, IconGithub, IconLoader } from '../icons'

/* ------------------------------------------------------------------ */
/* GitHub action card                                                  */
/*                                                                     */
/* A read-only row: icon, action title, the path it touched, and a     */
/* status glyph. Cards have no delete or dismiss control, and a single */
/* card never expands. A streak of more than two of them is folded     */
/* into one expandable group (see GitHubActionGroup below).            */
/* ------------------------------------------------------------------ */

function statusOf(entry: Pick<GitHubActionArtifact, 'status'>): { icon: ReactNode; label: string } {
  if (entry.status === 'running') return { icon: <IconLoader size={12} />, label: 'in progress' }
  if (entry.status === 'error') return { icon: <IconAlert size={12} />, label: 'failed' }
  if (entry.status === 'cancelled') return { icon: <IconAlert size={12} />, label: 'cancelled' }
  return { icon: <IconCheck size={12} />, label: 'done' }
}

function detailOf(entry: GitHubActionArtifact): string {
  const where = entry.repo ? (entry.ref ? `${entry.repo} @ ${entry.ref}` : entry.repo) : ''
  const bits = [
    githubActionPhrase(entry.title),
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
/* Expandable group                                                    */
/*                                                                     */
/* More than two cards in a row fold into one dropdown, so a run that  */
/* reads a dozen files is one line in the conversation instead of a    */
/* dozen. The header keeps the things you must not miss in view even   */
/* while it is closed: what is running right now, and any failure.     */
/* ------------------------------------------------------------------ */

export function GitHubActionGroup({
  cards,
  defaultOpen = false,
}: {
  cards: readonly GitHubActionArtifact[]
  /** Groups start folded; a caller that knows better can open one. */
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const bodyId = useId()
  const summary = summarizeGitHubGroup(cards)
  const status = statusOf(summary)
  const { current } = summary
  // A closed group still says what it is doing: the call in flight, else what it did.
  const line = current
    ? [githubActionPhrase(current.title), current.subject].filter(Boolean).join(' · ')
    : summary.breakdown

  return (
    <div className={`gh-action-group status-${summary.status}`} data-gh-action-group={summary.total}>
      <button
        type="button"
        className="gh-action-group-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        title={`${open ? 'Hide' : 'Show'} ${summary.total} GitHub actions — ${summary.breakdown}`}
      >
        <span className="gh-action-icon" aria-hidden="true">
          <IconGithub size={13} />
        </span>
        <span className="gh-action-lines">
          <span className="gh-action-group-label">
            <span className="gh-action-title">GitHub Actions</span>
            <span className="gh-action-repeat">
              {summary.total}
              <span className="sr-only"> actions</span>
            </span>
          </span>
          {line ? <span className="gh-action-subject">{line}</span> : null}
        </span>
        <span className="gh-action-side">
          {summary.failed > 0 ? (
            <span className="gh-action-error">{summary.failed} failed</span>
          ) : summary.cancelled > 0 ? (
            <span className="gh-action-time">{summary.cancelled} cancelled</span>
          ) : null}
          <span className={`gh-action-status ${summary.status}`} aria-label={status.label}>
            {status.icon}
          </span>
          <span className="gh-action-group-chevron" aria-hidden="true">
            {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          </span>
        </span>
      </button>
      {open ? (
        <div className="gh-action-group-body" id={bodyId}>
          {cards.map((card) => (
            <GitHubActionCard key={card.id} entry={card} />
          ))}
        </div>
      ) : null}
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

/** The same row for a streak of standalone calls folded into one dropdown. */
export function GitHubActionGroupItem({ entries }: { entries: readonly GitHubActionEntry[] }) {
  return (
    <div className="gh-panel-item" data-gh-panel-group={entries.length}>
      <GitHubActionGroup cards={entries} />
    </div>
  )
}
