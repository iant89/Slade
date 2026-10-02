import type { GitHubActionArtifact } from '../../types'
import { githubActionPhrase } from '../../lib/github-actions'
import { IconGithub } from '../icons'

/* ------------------------------------------------------------------ */
/* GitHub action card                                                  */
/*                                                                     */
/* One line per API call: the GitHub mark, the action ("GitHub Action: */
/* Get File Contents"), and the thing it touched on the second line.   */
/* The card has no buttons, no status glyph and nothing to expand —    */
/* the full detail (repo, timing, failure) stays in its tooltip, and   */
/* the card is inserted into the conversation as its own message.      */
/* ------------------------------------------------------------------ */

function detailOf(entry: GitHubActionArtifact): string {
  const where = entry.repo ? (entry.ref ? `${entry.repo} @ ${entry.ref}` : entry.repo) : ''
  const elapsed =
    entry.elapsedMs == null ? '' : entry.elapsedMs < 1000 ? `${entry.elapsedMs}ms` : `${(entry.elapsedMs / 1000).toFixed(1)}s`
  const bits = [
    githubActionPhrase(entry.title),
    entry.subject,
    where,
    entry.count > 1 ? `${entry.count} calls` : '',
    entry.status === 'running' ? 'in progress' : entry.status === 'cancelled' ? 'cancelled' : '',
    entry.error ?? '',
    elapsed,
  ].filter(Boolean)
  return bits.join(' · ')
}

export function GitHubActionCard({ entry }: { entry: GitHubActionArtifact }) {
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
    </div>
  )
}
