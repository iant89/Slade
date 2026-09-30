import { useEffect, useMemo, useRef, useState } from 'react'
import { useGitHubActivity, type GitHubActionEntry } from '../../store/githubActivity'
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
/* The panel row: one GitHub call, appended to the chat log            */
/* ------------------------------------------------------------------ */

/**
 * One GitHub Action as a chat panel item.
 *
 * The wrapper puts the card in the message column — same width, same spacing as
 * a message — so the calls you made yourself are appended to the panel and
 * scroll with the conversation instead of sitting in a strip outside it. Cards
 * a run produced are not shown here; they render inside that run's answer (see
 * `GitHubRunActivity`).
 */
export function GitHubActionItem({ entry }: { entry: GitHubActionEntry }) {
  return (
    <div className="gh-panel-item" data-gh-panel-action={entry.kind}>
      <GitHubActionCard entry={entry} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* The run block: the calls one orchestrator run made                  */
/* ------------------------------------------------------------------ */

/**
 * Whether a run's block is open. It opens itself while calls are in flight and
 * folds back to its count line the moment the last one lands — a finished run
 * should not hold a column of cards open. A manual toggle wins from the moment
 * it is used, so reading back through the list never gets interrupted by the
 * next call arriving.
 */
function useInFlightDisclosure(running: number): [boolean, () => void] {
  const [chosen, setChosen] = useState<boolean | null>(null)
  const expanded = chosen ?? running > 0
  return [expanded, () => setChosen(!expanded)]
}

/**
 * The GitHub cards one orchestrator run produced, rendered inside that run's
 * answer so the calls sit with the work that caused them — a run that pulls a
 * dozen files from the open repo says so where its steps are, not in the chat
 * panel alongside everything else.
 */
export function GitHubRunActivity({ scope }: { scope?: string }) {
  const entries = useGitHubActivity((s) => s.entries)
  const mine = useMemo(() => (scope ? entries.filter((e) => e.scope === scope) : []), [entries, scope])
  const running = mine.reduce((n, e) => (e.status === 'running' ? n + 1 : n), 0)
  const [expanded, toggle] = useInFlightDisclosure(running)
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the newest card in view while calls are flying.
  useEffect(() => {
    if (!expanded) return
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [mine.length, expanded])

  if (mine.length === 0) return null

  const failed = mine.reduce((n, e) => (e.status === 'error' ? n + 1 : n), 0)
  const tail = running ? ` · ${running} running` : failed ? ` · ${failed} failed` : ''

  return (
    <section className={`gh-activity is-inline${expanded ? '' : ' collapsed'}`} aria-label="GitHub activity">
      <header className="gh-activity-head">
        <button
          type="button"
          className="gh-activity-toggle"
          onClick={toggle}
          aria-expanded={expanded}
          title={expanded ? 'Hide the GitHub activity list' : 'Show this run’s GitHub calls'}
        >
          {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          <IconGithub size={13} />
          <span className="gh-activity-summary">
            GitHub activity · {mine.length} {mine.length === 1 ? 'call' : 'calls'}
          </span>
          <span className="gh-activity-tail">{tail}</span>
        </button>
      </header>
      {expanded ? (
        <div className="gh-activity-list" ref={listRef} role="log" aria-label="GitHub calls this run made">
          {mine.map((entry) => (
            <GitHubActionCard key={entry.id} entry={entry} />
          ))}
        </div>
      ) : null}
    </section>
  )
}
