import { useState } from 'react'
import { motion } from 'framer-motion'
import type { GitHubActionArtifact } from '../../types'
import { githubActionPhrase, MAX_OUTPUT_CHARS } from '../../lib/github-actions'
import { useGitHubActivity } from '../../store/githubActivity'
import { CodeArtifact } from '../artifacts/CodeArtifact'
import { IconCheck, IconChevronDown, IconGithub } from '../icons'

/* ------------------------------------------------------------------ */
/* GitHub action card                                                  */
/*                                                                     */
/* One card per API call, built like the Memory Added artifact card:   */
/* the GitHub mark, the action as its name, and the thing it touched   */
/* underneath. Two things can be added:                                */
/*                                                                     */
/* - `output` — what the call returned (file contents, a listing, a    */
/*   sha) — sits behind the expand toggle. No output, no toggle: the   */
/*   chevron only exists when there is something behind it.            */
/* - `question` — for an action that cannot finish without the user —  */
/*   renders its choices as buttons at the bottom of the card.         */
/*                                                                     */
/* The full detail (repo, ref, timing, failure, call count) stays in   */
/* the card's tooltip, exactly as it did before.                       */
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

/** The short state of a call, shown next to its subject. */
function statusOf(entry: GitHubActionArtifact): string {
  if (entry.status === 'running') return 'in progress'
  if (entry.status === 'cancelled') return 'cancelled'
  if (entry.status === 'error') return 'failed'
  return entry.count > 1 ? `${entry.count} calls` : ''
}

export function GitHubActionCard({
  entry,
  defaultExpanded = false,
}: {
  entry: GitHubActionArtifact
  /** Open the output panel on first render (tests; a caller that already knows the output matters). */
  defaultExpanded?: boolean
}) {
  const respond = useGitHubActivity((s) => s.respond)
  const [open, setOpen] = useState(defaultExpanded)

  const output = entry.output
  const outputText = output?.text?.trim() ?? ''
  const errorText = entry.error?.trim() ?? ''
  // A failure is output too: it is the reason the card exists, so it is worth
  // a toggle of its own rather than only a tint and a tooltip.
  const hasOutput = outputText.length > 0 || errorText.length > 0
  const shown = open && hasOutput

  const question = entry.question
  const awaiting = Boolean(question && !question.response)
  const answered = question?.response
    ? question.choices.find((choice) => choice.id === question.response)?.label ?? 'Answered'
    : ''

  return (
    <motion.figure
      className={`artifact-card gh-artifact-card status-${entry.status}${awaiting ? ' awaiting-response' : ''}`}
      initial={{ opacity: 0, y: 8, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      title={detailOf(entry)}
      data-gh-action={entry.kind}
      aria-label={entry.title}
    >
      <div className="artifact-head">
        <span className="artifact-icon gh-artifact-icon">
          <IconGithub size={15} />
        </span>
        <span className="artifact-meta">
          <span className="artifact-name" title={entry.title}>
            {entry.title}
          </span>
          {entry.subject || statusOf(entry) ? (
            <span className="artifact-sub">
              {entry.subject ? <span className="gh-artifact-subject">{entry.subject}</span> : null}
              {statusOf(entry) ? (
                <span className="gh-artifact-status">
                  {entry.subject ? ' · ' : ''}
                  {statusOf(entry)}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        <div className="artifact-head-actions">
          {hasOutput ? (
            <button
              className="icon-btn"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={shown}
              aria-label={shown ? 'Hide output' : 'Show output'}
              title={shown ? 'Hide output' : 'Show output'}
              type="button"
            >
              <IconChevronDown size={14} className={shown ? 'flip-v' : ''} />
            </button>
          ) : null}
        </div>
      </div>

      {shown ? (
        <div className="artifact-body">
          {outputText ? (
            <>
              {output?.label ? <span className="gh-artifact-label">{output.label}</span> : null}
              {output?.language ? (
                <CodeArtifact code={outputText} lang={output.language} maxHeight={280} />
              ) : (
                <pre className="gh-artifact-output" tabIndex={0}>
                  {outputText}
                </pre>
              )}
              {output?.truncated ? (
                <span className="gh-artifact-note">Clipped to the first {MAX_OUTPUT_CHARS.toLocaleString()} characters.</span>
              ) : null}
            </>
          ) : (
            <pre className="gh-artifact-output failed" tabIndex={0}>
              {errorText}
            </pre>
          )}
        </div>
      ) : null}

      {question ? (
        <figcaption className="artifact-foot gh-artifact-ask">
          <span className="gh-artifact-question">{question.question}</span>
          <div className="gh-artifact-choices">
            {awaiting ? (
              question.choices.map((choice) => (
                <button
                  key={choice.id}
                  className={`artifact-action gh-choice${choice.tone && choice.tone !== 'default' ? ` ${choice.tone}` : ''}`}
                  onClick={() => respond(entry.id, choice.id)}
                  title={choice.hint}
                  type="button"
                >
                  {choice.label}
                </button>
              ))
            ) : (
              <span className="artifact-action is-static gh-artifact-answer" title={`You chose: ${answered}`}>
                <IconCheck size={12} /> {answered}
              </span>
            )}
          </div>
        </figcaption>
      ) : null}
    </motion.figure>
  )
}
