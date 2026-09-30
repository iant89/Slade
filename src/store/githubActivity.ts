/**
 * GitHub activity log.
 *
 * One record per GitHub call, fed by `onGitHubCall` (so every request the REST
 * client makes shows up automatically) plus the few GitHub actions that are not
 * api.github.com calls: signing in through the OAuth relay, signing out, and
 * cloning a repo's files into the local file system.
 *
 * Runtime-only by design: it is a live ledger of what Slade just did, not part
 * of a conversation, so it never touches localStorage and is never replayed.
 */

import { create } from 'zustand'
import { uid } from '../lib/id'
import {
  describeGitHubCall,
  githubActionSignature,
  githubActionTitle,
  type GitHubActionInfo,
  type GitHubActionKind,
} from '../lib/github-actions'
import { onGitHubCall } from '../lib/github'

export type GitHubActionStatus = 'running' | 'done' | 'error'

export interface GitHubActionEntry extends GitHubActionInfo {
  id: string
  status: GitHubActionStatus
  at: number
  elapsedMs?: number
  error?: string
  /** How many identical calls this card stands for (same action + same target). */
  count: number
  /**
   * The agent run that caused this call, when one was running. Cards carrying a
   * scope render inside that run's answer; cards without one are the GitHub
   * calls you made yourself and are appended to the chat panel.
   */
  scope?: string
}

/** A GitHub action that did not go through the REST client (OAuth, sign-out, clone). */
export interface GitHubActionInput {
  kind: GitHubActionKind
  subject?: string
  repo?: string
  ref?: string
  error?: string
}

/** Identical repeats of the newest call within this window fold into one card. */
const DEDUPE_WINDOW_MS = 4_000
const MAX_ENTRIES = 60

export interface GitHubActivityState {
  entries: GitHubActionEntry[]
  /** Lifetime count for this session, so the header can say "12 calls". */
  total: number
  /**
   * Open run scopes, innermost last. An agent run pushes its scope for the
   * duration of the run so every call it makes is attributable to it; the chat
   * and the GitHub drawer leave the stack empty.
   */
  scopes: string[]
  /** Open a card for a call that is still in flight. Returns its id. */
  log: (input: GitHubActionInput) => string
  /** Add a card for a call that is already over. Returns its id. */
  logDone: (input: GitHubActionInput) => string
  complete: (
    id: string,
    patch: { status: GitHubActionStatus; elapsedMs?: number; error?: string; subject?: string },
  ) => void
  remove: (id: string) => void
  clear: () => void
  /** Attribute every card logged from now on to `id` (nested runs supported). */
  enterScope: (id: string) => void
  /** Stop attributing cards to `id` (safe out of order, e.g. two open chats). */
  exitScope: (id: string) => void
}

/** The scope new cards belong to: the innermost open run, if any. */
export function activeScope(state: Pick<GitHubActivityState, 'scopes'>): string | undefined {
  return state.scopes[state.scopes.length - 1]
}

function toEntry(input: GitHubActionInput, status: GitHubActionStatus, scope?: string): GitHubActionEntry {
  return {
    id: uid('gha'),
    kind: input.kind,
    title: githubActionTitle(input.kind),
    subject: input.subject ?? '',
    repo: input.repo,
    ref: input.ref,
    status,
    at: Date.now(),
    count: 1,
    error: input.error,
    scope,
  }
}

export const useGitHubActivity = create<GitHubActivityState>((set) => ({
  entries: [],
  total: 0,
  scopes: [],

  log: (input) => {
    const entry = toEntry(input, 'running', activeScope(useGitHubActivity.getState()))
    set((st) => ({ entries: [...st.entries, entry].slice(-MAX_ENTRIES), total: st.total + 1 }))
    return entry.id
  },

  logDone: (input) => {
    const entry = toEntry(input, 'done', activeScope(useGitHubActivity.getState()))
    set((st) => ({ entries: [...st.entries, entry].slice(-MAX_ENTRIES), total: st.total + 1 }))
    return entry.id
  },

  complete: (id, patch) =>
    set((st) => {
      let touched = false
      const entries = st.entries.map((e) => {
        if (e.id !== id) return e
        touched = true
        return {
          ...e,
          status: patch.status,
          subject: patch.subject ?? e.subject,
          // A card that was never a timed request (clone, sign-in) still knows
          // how long it was open, because it was opened with a timestamp.
          elapsedMs:
            patch.elapsedMs ?? e.elapsedMs ?? (patch.status === 'running' ? undefined : Date.now() - e.at),
          error: patch.error ?? e.error,
        }
      })
      return touched ? { entries } : st
    }),

  remove: (id) => set((st) => ({ entries: st.entries.filter((e) => e.id !== id) })),

  clear: () => set({ entries: [] }),

  enterScope: (id) => set((st) => ({ scopes: [...st.scopes, id] })),

  exitScope: (id) => set((st) => ({ scopes: st.scopes.filter((s) => s !== id) })),
}))

/* ------------------------------------------------------------------ */
/* The REST client → the log                                           */
/* ------------------------------------------------------------------ */

/** callId → entry id, so an `end` event closes the card its `start` opened. */
const openCards = new Map<number, string>()
/** callIds folded into an existing card: they get no card, so no close-out. */
const absorbed = new Set<number>()

onGitHubCall((event) => {
  const activity = useGitHubActivity.getState()

  if (event.phase === 'start') {
    const info = describeGitHubCall(event)

    // Fold a repeat of the newest identical call into that card instead of
    // pushing another row for it: pulling a tree reads dozens of files, and a
    // wall of identical cards would bury everything else. Only within the same
    // scope — a manual call must never be absorbed into a run's card.
    const newest = activity.entries[activity.entries.length - 1]
    if (
      newest &&
      newest.status !== 'running' &&
      newest.scope === activeScope(activity) &&
      Date.now() - newest.at < DEDUPE_WINDOW_MS &&
      githubActionSignature(newest) === githubActionSignature(info)
    ) {
      useGitHubActivity.setState((st) => ({
        entries: st.entries.map((e) =>
          e.id === newest.id ? { ...e, count: e.count + 1, at: Date.now(), status: 'running', error: undefined } : e,
        ),
        total: st.total + 1,
      }))
      absorbed.add(event.callId)
      return
    }

    openCards.set(
      event.callId,
      activity.log({ kind: info.kind, subject: info.subject, repo: info.repo, ref: info.ref }),
    )
    return
  }

  if (absorbed.delete(event.callId)) return

  const id = openCards.get(event.callId)
  openCards.delete(event.callId)
  if (!id) return
  // A cancelled request (a search superseded by the next keystroke) was never
  // really an action — drop the card instead of showing it as failed.
  if (event.aborted) {
    activity.remove(id)
    return
  }
  activity.complete(id, {
    status: event.ok ? 'done' : 'error',
    elapsedMs: event.elapsedMs,
    error: event.ok ? undefined : event.error,
  })
})

/** Open a card for a GitHub action that does not go through the REST client. */
export function logGitHubAction(input: GitHubActionInput): string {
  return useGitHubActivity.getState().log(input)
}

/** Add a card for a GitHub action that is already over (the usual case here). */
export function logGitHubActionDone(input: GitHubActionInput): string {
  return useGitHubActivity.getState().logDone(input)
}

/** Close out a card opened with `logGitHubAction`. */
export function finishGitHubAction(
  id: string,
  patch: { status: GitHubActionStatus; elapsedMs?: number; error?: string; subject?: string },
): void {
  if (!id) return
  useGitHubActivity.getState().complete(id, patch)
}
