import { useEffect, useRef } from 'react'
import { useGitHubActivity, type GitHubActionEntry } from '../../store/githubActivity'
import { formatTime } from '../../lib/format'
import { IconAlert, IconCheck, IconChevronDown, IconChevronRight, IconGithub, IconLoader } from '../icons'

/* ------------------------------------------------------------------ */
/* GitHub action card                                                  */
/*                                                                     */
/* One card per GitHub API call. Deliberately *not* expandable: the    */
/* title says what was done, the sub-title says what it touched, and   */
/* the status dot says whether it worked. There is nothing to open.    */
/* ------------------------------------------------------------------ */

function statusOf(entry: GitHubActionEntry): { icon: React.ReactNode; label: string } {
  if (entry.status === 'running') return { icon: <IconLoader size={12} />, label: 'in progress' }
  if (entry.status === 'error') return { icon: <IconAlert size={12} />, label: 'failed' }
  return { icon: <IconCheck size={12} />, label: 'done' }
}

function detailOf(entry: GitHubActionEntry): string {
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

export function GitHubActionCard({ entry }: { entry: GitHubActionEntry }) {
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
/* The live ledger: every GitHub call this session, newest last        */
/* ------------------------------------------------------------------ */

export function GitHubActivityFeed() {
  const entries = useGitHubActivity((s) => s.entries)
  const collapsed = useGitHubActivity((s) => s.collapsed)
  const setCollapsed = useGitHubActivity((s) => s.setCollapsed)
  const clear = useGitHubActivity((s) => s.clear)
  const listRef = useRef<HTMLDivElement>(null)

  const running = entries.reduce((n, e) => (e.status === 'running' ? n + 1 : n), 0)
  const failed = entries.reduce((n, e) => (e.status === 'error' ? n + 1 : n), 0)

  // Keep the newest card in view while calls are flying.
  useEffect(() => {
    if (collapsed) return
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries.length, collapsed])

  if (entries.length === 0) return null

  const summary = `${entries.length} GitHub ${entries.length === 1 ? 'action' : 'actions'}`
  const tail = running
    ? ` · ${running} running`
    : failed
      ? ` · ${failed} failed`
      : ` · ${formatTime(entries[entries.length - 1]!.at)}`

  return (
    <section className={`gh-activity${collapsed ? ' collapsed' : ''}`} aria-label="GitHub activity">
      <header className="gh-activity-head">
        <button
          type="button"
          className="gh-activity-toggle"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          title={collapsed ? 'Show GitHub activity' : 'Hide the GitHub activity list'}
        >
          {collapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
          <IconGithub size={13} />
          <span className="gh-activity-summary">{summary}</span>
          <span className="gh-activity-tail">{tail}</span>
        </button>
        <button type="button" className="btn ghost small" onClick={clear} title="Dismiss these cards">
          Clear
        </button>
      </header>
      {!collapsed ? (
        <div className="gh-activity-list" ref={listRef} role="log" aria-label="GitHub calls this session">
          {entries.map((entry) => (
            <GitHubActionCard key={entry.id} entry={entry} />
          ))}
        </div>
      ) : null}
    </section>
  )
}
