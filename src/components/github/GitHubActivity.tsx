import { useEffect, useMemo, useRef, useState } from 'react'
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

/**
 * Whether the list is open. It opens itself while calls are in flight and folds
 * back to its count line the moment the last one lands — the ledger should not
 * hold a column of stale cards open all session. A manual toggle wins from the
 * moment it is used, so reading back through the list never gets interrupted by
 * the next call arriving.
 */
function useInFlightDisclosure(running: number): [boolean, () => void] {
  const [chosen, setChosen] = useState<boolean | null>(null)
  const expanded = chosen ?? running > 0
  return [expanded, () => setChosen(!expanded)]
}

/** The collapsible ledger body: a header line and, when open, the cards. */
function ActivityBlock({
  entries,
  className,
  summary,
  tail,
  logLabel,
  toggleTitle,
  onClear,
}: {
  entries: GitHubActionEntry[]
  className: string
  summary: string
  tail: string
  logLabel: string
  toggleTitle: string
  /** Present on the session strip; a run's message keeps its own record. */
  onClear?: () => void
}) {
  const running = entries.reduce((n, e) => (e.status === 'running' ? n + 1 : n), 0)
  const [expanded, toggle] = useInFlightDisclosure(running)
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the newest card in view while calls are flying.
  useEffect(() => {
    if (!expanded) return
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries.length, expanded])

  return (
    <section className={`gh-activity${className ? ` ${className}` : ''}${expanded ? '' : ' collapsed'}`} aria-label="GitHub activity">
      <header className="gh-activity-head">
        <button
          type="button"
          className="gh-activity-toggle"
          onClick={toggle}
          aria-expanded={expanded}
          title={expanded ? 'Hide the GitHub activity list' : toggleTitle}
        >
          {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          <IconGithub size={13} />
          <span className="gh-activity-summary">{summary}</span>
          <span className="gh-activity-tail">{tail}</span>
        </button>
        {onClear ? (
          <button type="button" className="btn ghost small" onClick={onClear} title="Dismiss these cards">
            Clear
          </button>
        ) : null}
      </header>
      {expanded ? (
        <div className="gh-activity-list" ref={listRef} role="log" aria-label={logLabel}>
          {entries.map((entry) => (
            <GitHubActionCard key={entry.id} entry={entry} />
          ))}
        </div>
      ) : null}
    </section>
  )
}

/**
 * The session strip above the composer: the GitHub calls you made yourself —
 * clicking through the drawer, searching, publishing, signing in. Calls made by
 * an agent run belong to that run and render inline in its answer instead.
 */
export function GitHubActivityFeed() {
  const entries = useGitHubActivity((s) => s.entries)
  const clear = useGitHubActivity((s) => s.clear)
  const mine = useMemo(() => entries.filter((e) => !e.scope), [entries])

  if (mine.length === 0) return null

  const running = mine.reduce((n, e) => (e.status === 'running' ? n + 1 : n), 0)
  const failed = mine.reduce((n, e) => (e.status === 'error' ? n + 1 : n), 0)
  const tail = running
    ? ` · ${running} running`
    : failed
      ? ` · ${failed} failed`
      : ` · ${formatTime(mine[mine.length - 1]!.at)}`

  return (
    <ActivityBlock
      entries={mine}
      className=""
      summary={`${mine.length} GitHub ${mine.length === 1 ? 'action' : 'actions'}`}
      tail={tail}
      logLabel="GitHub calls this session"
      toggleTitle="Show GitHub activity"
      onClear={clear}
    />
  )
}

/**
 * The GitHub cards one orchestrator run produced, rendered inside that run's
 * answer so the calls sit with the work that caused them — a run that pulls a
 * dozen files from the open repo says so where its steps are, not in a strip
 * above the composer.
 */
export function GitHubRunActivity({ scope }: { scope?: string }) {
  const entries = useGitHubActivity((s) => s.entries)
  const mine = useMemo(() => (scope ? entries.filter((e) => e.scope === scope) : []), [entries, scope])

  if (mine.length === 0) return null

  const running = mine.reduce((n, e) => (e.status === 'running' ? n + 1 : n), 0)
  const failed = mine.reduce((n, e) => (e.status === 'error' ? n + 1 : n), 0)
  const tail = running ? ` · ${running} running` : failed ? ` · ${failed} failed` : ''

  return (
    <ActivityBlock
      entries={mine}
      className="is-inline"
      summary={`GitHub activity · ${mine.length} ${mine.length === 1 ? 'call' : 'calls'}`}
      tail={tail}
      logLabel="GitHub calls this run made"
      toggleTitle="Show this run’s GitHub calls"
    />
  )
}
