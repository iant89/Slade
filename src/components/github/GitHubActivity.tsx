import { useState } from 'react'
import { motion } from 'framer-motion'
import type { GitHubActionArtifact, GitHubPullRequestInfo } from '../../types'
import { githubActionPhrase, MAX_OUTPUT_CHARS } from '../../lib/github-actions'
import { useGitHubActivity } from '../../store/githubActivity'
import { useGitHub } from '../../store/github'
import { useUI } from '../../store/ui'
import { formatCount, formatDateTime } from '../../lib/format'
import { CodeArtifact } from '../artifacts/CodeArtifact'
import { IconCheck, IconChevronDown, IconExternal, IconGitMerge, IconGithub, IconLoader } from '../icons'

/* ------------------------------------------------------------------ */
/* GitHub action card                                                  */
/*                                                                     */
/* One card per API call, built like the Memory Added artifact card:   */
/* the GitHub mark, the action as its name, and the thing it touched   */
/* underneath — except a file read, which is one card for the whole    */
/* batch: its name is the action, its sub-title is how many files it   */
/* stands for ("3 Files"), and its block lists their repository paths. */
/* Three things can be added:                                          */
/*                                                                     */
/* - `output` — what the call returned (file contents, a listing, a    */
/*   sha) — sits behind the expand toggle. No output, no toggle: the   */
/*   chevron only exists when there is something behind it.            */
/* - `question` — for an action that cannot finish without the user —  */
/*   renders its choices as buttons at the bottom of the card.         */
/* - `output.pr` — a pull request. The one card that is always open:   */
/*   everything GitHub answered with is drawn as a panel of detail,    */
/*   with a Merge button and an Open on GitHub link under it. There    */
/*   is nothing to hide and nothing to expand — it is the point of     */
/*   the call, so it is never behind a chevron.                        */
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
    // A read card's subject is already a count of its files; the call count
    // beside it would only differ when one file was read twice.
    entry.count > 1 && entry.kind !== 'get-file' ? `${entry.count} calls` : '',
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
  // A read card's sub-title is already a count of its files ("3 Files"), so the
  // call count beside it would say the same thing twice. It stays in the tooltip.
  if (entry.kind === 'get-file') return ''
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

  // A pull request is the one card with nothing to fold: it is drawn open, in
  // full, and takes the body over from the output panel entirely.
  const pr = output?.pr

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
          {/* A pull request is open for good: no chevron, nothing to hide. */}
          {hasOutput && !pr ? (
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

      {pr ? (
        <PullRequestPanel pr={pr} />
      ) : shown ? (
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

      {pr ? (
        <PullRequestActions entry={entry} pr={pr} />
      ) : question ? (
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

/* ------------------------------------------------------------------ */
/* Pull request panel                                                  */
/*                                                                     */
/* Everything GitHub said about the pull request it just opened: the   */
/* branches, who opened it, the size of the change, whether it can be  */
/* merged, and the description. Drawn open, because a card that made   */
/* a pull request is the place to read it.                             */
/* ------------------------------------------------------------------ */

/** The state a card shows: GitHub's own word, with a draft and a merge of our own folded in. */
function prState(pr: GitHubPullRequestInfo): { label: string; tone: string } {
  if (pr.merged) return { label: 'Merged', tone: 'merged' }
  if (pr.state === 'closed') return { label: 'Closed', tone: 'closed' }
  if (pr.draft) return { label: 'Draft', tone: 'draft' }
  return { label: 'Open', tone: 'open' }
}

/** GitHub's mergeable words, in Slade's voice. */
const MERGEABLE_WORD: Record<string, string> = {
  clean: 'no conflicts',
  dirty: 'has conflicts',
  blocked: 'blocked by checks or rules',
  behind: 'branch is behind',
  unstable: 'checks failing',
  has_hooks: 'waiting on hooks',
}

function PullRequestPanel({ pr }: { pr: GitHubPullRequestInfo }) {
  const state = prState(pr)
  const opened = pr.createdAt ? Date.parse(pr.createdAt) : NaN
  return (
    <div className="artifact-body gh-pr-body">
      <div className="gh-pr-headline">
        <span className="gh-pr-number">#{pr.number}</span>
        <span className="gh-pr-title" title={pr.title}>
          {pr.title}
        </span>
        <span className={`gh-pr-state ${state.tone}`}>{state.label}</span>
      </div>

      <dl className="gh-pr-facts">
        {pr.head || pr.base ? (
          <div className="gh-pr-fact branches">
            <dt>Branches</dt>
            <dd>
              <span className="gh-pr-branch" title="The branch carrying the change">
                {pr.head || '?'}
              </span>
              <span className="gh-pr-arrow" aria-hidden="true">
                →
              </span>
              <span className="gh-pr-branch" title="The branch this merges into">
                {pr.base || '?'}
              </span>
            </dd>
          </div>
        ) : null}
        {pr.author ? (
          <div className="gh-pr-fact">
            <dt>Opened by</dt>
            <dd>{pr.author}</dd>
          </div>
        ) : null}
        {pr.commits != null ? (
          <div className="gh-pr-fact">
            <dt>Commits</dt>
            <dd>{formatCount(pr.commits)}</dd>
          </div>
        ) : null}
        {pr.changedFiles != null ? (
          <div className="gh-pr-fact">
            <dt>Files</dt>
            <dd>{formatCount(pr.changedFiles)}</dd>
          </div>
        ) : null}
        {pr.additions != null || pr.deletions != null ? (
          <div className="gh-pr-fact">
            <dt>Changes</dt>
            <dd className="gh-pr-diff">
              {pr.additions != null ? <span className="gh-pr-add">+{formatCount(pr.additions)}</span> : null}
              {pr.deletions != null ? <span className="gh-pr-del">−{formatCount(pr.deletions)}</span> : null}
            </dd>
          </div>
        ) : null}
        {!pr.merged && (pr.mergeable != null || pr.mergeableState) ? (
          <div className="gh-pr-fact">
            <dt>Mergeable</dt>
            <dd className={pr.mergeable === false ? 'gh-pr-blocked' : undefined}>
              {pr.mergeableState ? MERGEABLE_WORD[pr.mergeableState] ?? pr.mergeableState.replace(/_/g, ' ') : pr.mergeable ? 'yes' : 'no'}
            </dd>
          </div>
        ) : null}
        {Number.isFinite(opened) ? (
          <div className="gh-pr-fact">
            <dt>Opened</dt>
            <dd>{formatDateTime(opened)}</dd>
          </div>
        ) : null}
        {pr.merged ? (
          <div className="gh-pr-fact merged">
            <dt>Merged</dt>
            <dd>
              {pr.mergedAt ? `${formatDateTime(pr.mergedAt)} · ` : ''}
              {pr.mergeSha ? <code>{pr.mergeSha.slice(0, 7)}</code> : 'by Slade'}
            </dd>
          </div>
        ) : null}
        {pr.url ? (
          <div className="gh-pr-fact">
            <dt>On GitHub</dt>
            <dd>
              <a className="gh-pr-link" href={pr.url} target="_blank" rel="noreferrer" title={pr.url}>
                {pr.url.replace(/^https?:\/\//, '')}
              </a>
            </dd>
          </div>
        ) : null}
      </dl>

      {pr.body ? <p className="gh-pr-description">{pr.body}</p> : null}
    </div>
  )
}

/**
 * The two things a pull request card is for: merge it, and go read it on
 * GitHub. Merging goes through the store, so it is the same call (and the same
 * logged card) as any other GitHub call Slade makes — and the answer is written
 * back onto this card, so the merge survives a reload.
 */
function PullRequestActions({ entry, pr }: { entry: GitHubActionArtifact; pr: GitHubPullRequestInfo }) {
  const mergePullRequest = useGitHub((s) => s.mergePullRequest)
  const markPrMerged = useGitHubActivity((s) => s.markPrMerged)
  const toast = useUI((s) => s.toast)
  const [busy, setBusy] = useState(false)

  const repo = entry.repo
  const closable = !pr.merged && pr.state !== 'closed'
  const canMerge = Boolean(repo) && closable && !busy

  const onMerge = async () => {
    if (!repo || !canMerge) return
    setBusy(true)
    const res = await mergePullRequest({ repo, number: pr.number, silent: true })
    setBusy(false)
    if (res?.merged) {
      markPrMerged(entry.id, { sha: res.sha })
      toast({
        kind: 'success',
        title: `Merged pull request #${pr.number}`,
        detail: res.sha ? `${repo} @ ${res.sha.slice(0, 7)}` : repo,
      })
    } else {
      toast({
        kind: 'error',
        title: `GitHub did not merge #${pr.number}`,
        detail: res?.message || 'It may have conflicts, or the branch may need to be up to date.',
      })
    }
  }

  return (
    <figcaption className="artifact-foot gh-pr-foot">
      <a
        className="artifact-action gh-pr-open"
        href={pr.url || undefined}
        target="_blank"
        rel="noreferrer"
        title={pr.url ? `Open #${pr.number} on GitHub` : 'GitHub did not return a link for this pull request'}
        aria-disabled={pr.url ? undefined : true}
      >
        <IconExternal size={12} /> Open on GitHub
      </a>
      {pr.merged ? (
        <span className="artifact-action is-static gh-pr-merged" title={pr.mergeSha ? `Merge commit ${pr.mergeSha}` : 'Merged'}>
          <IconCheck size={12} /> Merged
        </span>
      ) : (
        <button
          className="artifact-action gh-pr-merge primary"
          onClick={() => void onMerge()}
          disabled={!canMerge}
          title={
            !repo
              ? 'This card did not record which repository it opened the pull request on'
              : !closable
                ? `#${pr.number} is closed — there is nothing left to merge`
                : `Merge #${pr.number} into ${pr.base || 'its base branch'}`
          }
          type="button"
        >
          {busy ? <IconLoader size={12} /> : <IconGitMerge size={12} />}
          {busy ? 'Merging…' : 'Merge pull request'}
        </button>
      )}
    </figcaption>
  )
}
