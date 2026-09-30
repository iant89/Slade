import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { createPortal } from 'react-dom'
import { useFs } from '../../store/fs'
import { useGitHub } from '../../store/github'
import { computeChanges, EMPTY_CHANGES, type ChangesSummary, type FileChange } from '../../lib/changes'
import type { DiffLine } from '../../lib/diff'
import { IconGitCommit, IconX } from '../icons'

/* ------------------------------------------------------------------ */
/* Summary hook                                                        */
/* ------------------------------------------------------------------ */

interface ChangesState {
  summary: ChangesSummary
  /** A recompute (debounce + fetches) is in flight. */
  pending: boolean
  /** The first computation has landed at least once. */
  ready: boolean
}

const DEBOUNCE_MS = 350

/**
 * Recomputed debounced whenever the Local Files workspace, the selected
 * repository/branch, or the loaded tree changes. Base copies are cached
 * (see `lib/changes`), so steady-state recomputes are pure CPU.
 */
function useChangesSummary(): ChangesState {
  const files = useFs((s) => s.files)
  const deletedRemotes = useFs((s) => s.deletedRemotes)
  const repo = useGitHub((s) => s.activeRepo)
  const ref = useGitHub((s) => s.activeBranch)
  const treeState = useGitHub((s) => s.tree)
  const token = useGitHub((s) => s.token)
  const [state, setState] = useState<ChangesState>({
    summary: EMPTY_CHANGES,
    pending: true,
    ready: false,
  })

  useEffect(() => {
    let cancelled = false
    setState((s) => (s.pending ? s : { ...s, pending: true }))
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const summary = await computeChanges({
            repo,
            ref,
            token: token || undefined,
            files,
            deletedRemotes,
            tree: treeState
              ? {
                  repo: treeState.repo,
                  ref: treeState.ref,
                  truncated: treeState.truncated,
                  entries: treeState.entries,
                }
              : undefined,
          })
          if (!cancelled) setState({ summary, pending: false, ready: true })
        } catch (err) {
          console.warn('changes summary failed', err)
          if (!cancelled) setState((s) => ({ ...s, pending: false, ready: true }))
        }
      })()
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [files, deletedRemotes, repo, ref, token, treeState])

  return state
}

/* ------------------------------------------------------------------ */
/* Label                                                               */
/* ------------------------------------------------------------------ */

/**
 * "+664 -2" chip to the right of the branch selector. Green counts lines to
 * be added, red counts lines to be removed; an empty change set reads
 * "No Changes". Clicking opens the full-screen diff viewer.
 */
export function DiffChangesLabel() {
  const { summary, pending, ready } = useChangesSummary()
  const [viewerOpen, setViewerOpen] = useState(false)
  const repo = useGitHub((s) => s.activeRepo)
  const ref = useGitHub((s) => s.activeBranch)
  const close = useCallback(() => setViewerOpen(false), [])

  const hasLineChanges = summary.added > 0 || summary.removed > 0

  const label = !ready
    ? 'Loading changes…'
    : hasLineChanges
      ? `${summary.added} line${summary.added === 1 ? '' : 's'} added, ${summary.removed} line${summary.removed === 1 ? '' : 's'} removed — click for the full diff`
      : 'No changes in Local Files — click to open the diff viewer'

  return (
    <>
      <button
        type="button"
        className={`diff-changes-label${pending && ready ? ' pending' : ''}`}
        onClick={() => setViewerOpen(true)}
        title={label}
        aria-label={label}
      >
        {!ready ? (
          <span className="dcl-none">…</span>
        ) : hasLineChanges ? (
          <>
            {summary.added > 0 ? <span className="dcl-add">+{summary.added}</span> : null}
            {summary.removed > 0 ? <span className="dcl-rem">-{summary.removed}</span> : null}
          </>
        ) : (
          <span className="dcl-none">No Changes</span>
        )}
      </button>
      <DiffViewer
        open={viewerOpen}
        onClose={close}
        summary={summary}
        pending={pending && ready}
        repo={repo}
        refName={ref}
      />
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Full-screen viewer                                                  */
/* ------------------------------------------------------------------ */

/** Rows rendered per file before the "show more" cut-off. */
const ROW_LIMIT = 500
const ROW_LIMIT_MAX = 5_000

function DiffViewer({
  open,
  onClose,
  summary,
  pending,
  repo,
  refName,
}: {
  open: boolean
  onClose: () => void
  summary: ChangesSummary
  pending: boolean
  repo?: string
  refName?: string
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    requestAnimationFrame(() => closeRef.current?.focus())
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose])

  const files = summary.files
  const active = files.find((f) => f.path === selected) ?? files[0]
  const hasLineChanges = summary.added > 0 || summary.removed > 0

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="diff-viewer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          role="dialog"
          aria-modal="true"
          aria-label="Diff viewer"
        >
          <div className="dv-head">
            <div className="dv-head-left">
              <strong>Changes</strong>
              <span className="dv-repo">
                {repo && refName ? (
                  <>
                    {repo} <span className="dv-at">@</span> {refName}
                  </>
                ) : (
                  'no repository selected'
                )}
              </span>
            </div>
            <div className="dv-head-right">
              {pending ? <span className="dv-updating">updating…</span> : null}
              {summary.incomplete && files.length > 0 ? (
                <span className="dv-warn">some remotes unavailable</span>
              ) : null}
              {hasLineChanges ? (
                <span className="dv-totals">
                  {summary.added > 0 ? <span className="dv-add">+{summary.added}</span> : null}
                  {summary.removed > 0 ? <span className="dv-rem">-{summary.removed}</span> : null}
                </span>
              ) : null}
              {files.length > 0 ? (
                <span className="dv-count">
                  {files.length} file{files.length === 1 ? '' : 's'}
                </span>
              ) : null}
              <button
                ref={closeRef}
                type="button"
                className="icon-btn"
                onClick={onClose}
                aria-label="Close diff viewer"
              >
                <IconX size={18} />
              </button>
            </div>
          </div>

          <div className="dv-body">
            {files.length === 0 ? (
              <div className="dv-empty">
                <IconGitCommit size={26} />
                <strong>{pending ? 'Computing changes…' : 'No Changes'}</strong>
                <p>
                  {!repo
                    ? 'Pick a repository and branch in the composer — your Local Files are then compared against GitHub.'
                    : 'Edits you or the agent make in Local Files show up here, line by line, before you commit.'}
                </p>
                {summary.incomplete ? (
                  <p className="dv-warn">Some remote copies couldn’t be loaded.</p>
                ) : null}
              </div>
            ) : (
              <>
                <div className="dv-side" aria-label="Changed files">
                  {files.map((f) => (
                    <button
                      key={f.path}
                      type="button"
                      className={`dv-file${active?.path === f.path ? ' active' : ''}`}
                      onClick={() => setSelected(f.path)}
                      title={f.path}
                      aria-current={active?.path === f.path}
                    >
                      <span className={`dv-dot ${f.status}`} aria-hidden="true" />
                      <span className="dv-file-path">{f.path}</span>
                      <span className="dv-file-stats">
                        {f.binary ? (
                          <span className="dv-file-bin">bin</span>
                        ) : (
                          <>
                            {f.added > 0 ? <span className="dv-add">+{f.added}</span> : null}
                            {f.removed > 0 ? <span className="dv-rem">-{f.removed}</span> : null}
                          </>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="dv-main">
                  {active ? <FileDiffPane key={active.path} file={active} /> : null}
                </div>
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

/* ------------------------------------------------------------------ */
/* Per-file pane                                                        */
/* ------------------------------------------------------------------ */

function FileDiffPane({ file }: { file: FileChange }) {
  const [showAll, setShowAll] = useState(false)
  const limit = showAll ? ROW_LIMIT_MAX : ROW_LIMIT

  const { parts, clipped, totalRows } = useMemo(() => {
    let budget = limit
    let clipped = false
    const parts: { hunk: FileChange['hunks'][number]; lines: DiffLine[] }[] = []
    let totalRows = 0
    for (const hunk of file.hunks) {
      totalRows += hunk.lines.length
      if (budget <= 0) {
        clipped = true
        break
      }
      if (hunk.lines.length > budget) {
        parts.push({ hunk, lines: hunk.lines.slice(0, budget) })
        clipped = true
        budget = 0
        break
      }
      parts.push({ hunk, lines: hunk.lines })
      budget -= hunk.lines.length
    }
    return { parts, clipped, totalRows }
  }, [file, limit])

  return (
    <div className="dv-file-pane">
      <div className="dv-file-head">
        <span className={`dv-badge ${file.status}`}>{file.status}</span>
        <span className="dv-path" title={file.path}>
          {file.path}
        </span>
        {file.binary ? (
          <span className="dv-badge bin">binary</span>
        ) : (
          <span className="dv-file-stats">
            <span className="dv-add">+{file.added}</span>
            <span className="dv-rem">-{file.removed}</span>
          </span>
        )}
      </div>

      {file.note ? (
        <div className="dv-note">Couldn’t load the remote copy — {file.note}</div>
      ) : null}
      {file.simplified && !file.note ? (
        <div className="dv-note">Large change — showing a simplified diff.</div>
      ) : null}
      {file.binary && !file.note ? (
        <div className="dv-note">
          {file.status === 'deleted'
            ? 'Binary file removed — no line diff.'
            : 'Binary file — no line diff available.'}
        </div>
      ) : null}
      {file.hunks.length === 0 && !file.note && !file.binary ? (
        <div className="dv-note">No textual differences.</div>
      ) : null}

      {parts.map(({ hunk, lines }, i) => (
        <div key={`${hunk.oldStart}-${hunk.newStart}-${i}`}>
          <div className="dv-hunk">
            @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
          </div>
          {lines.map((line, j) => (
            <DiffRow key={j} line={line} />
          ))}
        </div>
      ))}

      {clipped ? (
        <div className="dv-more">
          <button className="btn ghost small" type="button" onClick={() => setShowAll(true)}>
            Show {Math.min(totalRows, ROW_LIMIT_MAX).toLocaleString()} lines
          </button>
        </div>
      ) : null}
    </div>
  )
}

function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div className={`dv-row ${line.type}`}>
      <span className="dv-gutter">{line.oldNo ?? ''}</span>
      <span className="dv-gutter">{line.newNo ?? ''}</span>
      <span className="dv-sign">{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ''}</span>
      <span className="dv-text">{line.text === '' ? ' ' : line.text}</span>
    </div>
  )
}
