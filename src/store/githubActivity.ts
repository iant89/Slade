/**
 * GitHub activity log.
 *
 * One record per GitHub call, fed by `onGitHubCall` (so every request the REST
 * client makes shows up automatically) plus the few GitHub actions that are not
 * api.github.com calls: signing in through the OAuth relay, signing out, and
 * cloning a repo's files into the local file system.
 *
 * The ledger is runtime-only. When a call belongs to an agent run, a snapshot
 * is also written into that message's chronological timeline so its card stays
 * in place after the live ledger is gone.
 */

import { create } from 'zustand'
import { uid } from '../lib/id'
import {
  describeGitHubCall,
  githubActionSignature,
  githubActionTitle,
  type GitHubActionKind,
} from '../lib/github-actions'
import type { GitHubActionArtifact, GitHubActionStatus } from '../types'
import { onGitHubCall } from '../lib/github'
import { appendAgentGitHubCard, updateAgentGitHubCard } from './agentTimeline'

export type { GitHubActionStatus } from '../types'

export interface GitHubActionEntry extends GitHubActionArtifact {
  /**
   * The agent run that caused this call, when one was running. Scoped cards are
   * written into that run's message timeline; unscoped cards are session-level
   * GitHub actions shown in the chat panel.
   */
  scope?: string
  messageId?: string
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

export interface GitHubActivityState {
  entries: GitHubActionEntry[]
  /** Lifetime count for this session, so the header can say "12 calls". */
  total: number
  /**
   * Open run scopes, innermost last. An agent run pushes its scope for the
   * duration of the run so every call it makes is attributable to its message.
   */
  scopes: string[]
  /** Scope → assistant message, used to put each action into the right timeline. */
  scopeMessages: Record<string, string>
  /** Open a card for a call that is still in flight. Returns its id. */
  log: (input: GitHubActionInput) => string
  /** Add a card for a call that is already over. Returns its id. */
  logDone: (input: GitHubActionInput) => string
  complete: (
    id: string,
    patch: { status: GitHubActionStatus; elapsedMs?: number; error?: string; subject?: string },
  ) => void
  /** Attribute every card logged from now on to `id` and its assistant message. */
  enterScope: (id: string, messageId?: string) => void
  /** Stop attributing cards to `id` (safe out of order, e.g. two open chats). */
  exitScope: (id: string) => void
}

/** The scope new cards belong to: the innermost open run, if any. */
export function activeScope(state: Pick<GitHubActivityState, 'scopes'>): string | undefined {
  return state.scopes[state.scopes.length - 1]
}

function toArtifact(entry: GitHubActionEntry): GitHubActionArtifact {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    subject: entry.subject,
    repo: entry.repo,
    ref: entry.ref,
    status: entry.status,
    at: entry.at,
    elapsedMs: entry.elapsedMs,
    error: entry.error,
    count: entry.count,
  }
}

function toEntry(
  input: GitHubActionInput,
  status: GitHubActionStatus,
  scope?: string,
  messageId?: string,
): GitHubActionEntry {
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
    messageId,
  }
}

function scopedEntry(input: GitHubActionInput, status: GitHubActionStatus): GitHubActionEntry {
  const state = useGitHubActivity.getState()
  const scope = activeScope(state)
  return toEntry(input, status, scope, scope ? state.scopeMessages[scope] : undefined)
}

export const useGitHubActivity = create<GitHubActivityState>((set) => ({
  entries: [],
  total: 0,
  scopes: [],
  scopeMessages: {},

  log: (input) => {
    const entry = scopedEntry(input, 'running')
    set((st) => ({ entries: [...st.entries, entry], total: st.total + 1 }))
    if (entry.messageId) appendAgentGitHubCard(entry.messageId, toArtifact(entry))
    return entry.id
  },

  logDone: (input) => {
    const entry = scopedEntry(input, 'done')
    set((st) => ({ entries: [...st.entries, entry], total: st.total + 1 }))
    if (entry.messageId) appendAgentGitHubCard(entry.messageId, toArtifact(entry))
    return entry.id
  },

  complete: (id, patch) => {
    let updated: GitHubActionEntry | undefined
    set((st) => {
      const entries = st.entries.map((entry) => {
        if (entry.id !== id) return entry
        updated = {
          ...entry,
          status: patch.status,
          subject: patch.subject ?? entry.subject,
          // A card that was never a timed request (clone, sign-in) still knows
          // how long it was open, because it was opened with a timestamp.
          elapsedMs:
            patch.elapsedMs ?? entry.elapsedMs ?? (patch.status === 'running' ? undefined : Date.now() - entry.at),
          error: patch.error ?? entry.error,
        }
        return updated
      })
      return updated ? { entries } : st
    })
    if (updated?.messageId) updateAgentGitHubCard(updated.messageId, toArtifact(updated))
  },

  // There is deliberately no remove/clear operation: action cards are part of
  // the record of the run, including requests that were cancelled.

  enterScope: (id, messageId) =>
    set((st) => ({
      scopes: [...st.scopes, id],
      scopeMessages: messageId ? { ...st.scopeMessages, [id]: messageId } : st.scopeMessages,
    })),

  exitScope: (id) =>
    set((st) => {
      const scopeMessages = { ...st.scopeMessages }
      delete scopeMessages[id]
      return { scopes: st.scopes.filter((scope) => scope !== id), scopeMessages }
    }),
}))

/* ------------------------------------------------------------------ */
/* The REST client → the log                                           */
/* ------------------------------------------------------------------ */

/** callId → entry id, so an `end` event closes the card its `start` opened. */
const openCards = new Map<number, string>()
/** callIds folded into an existing card, so its count and status stay current. */
const absorbed = new Map<number, string>()

function finishCall(
  activity: GitHubActivityState,
  id: string,
  event: { ok?: boolean; aborted?: boolean; elapsedMs?: number; error?: string },
): void {
  activity.complete(id, {
    status: event.aborted ? 'cancelled' : event.ok ? 'done' : 'error',
    elapsedMs: event.elapsedMs,
    error: event.aborted ? 'Cancelled' : event.ok ? undefined : event.error,
  })
}

onGitHubCall((event) => {
  const activity = useGitHubActivity.getState()

  if (event.phase === 'start') {
    const info = describeGitHubCall(event)

    // Fold a repeat of the newest identical call into that card instead of
    // pushing another row for it. It remains the same immutable card; only its
    // count and live status change. Only within the same scope, so a manual call
    // is never absorbed into an agent's card.
    const newest = activity.entries[activity.entries.length - 1]
    if (
      newest &&
      newest.status !== 'running' &&
      newest.scope === activeScope(activity) &&
      Date.now() - newest.at < DEDUPE_WINDOW_MS &&
      githubActionSignature(newest) === githubActionSignature(info)
    ) {
      const updated: GitHubActionEntry = {
        ...newest,
        count: newest.count + 1,
        at: Date.now(),
        status: 'running',
        error: undefined,
      }
      useGitHubActivity.setState((state) => ({
        entries: state.entries.map((entry) => (entry.id === newest.id ? updated : entry)),
        total: state.total + 1,
      }))
      if (updated.messageId) updateAgentGitHubCard(updated.messageId, toArtifact(updated))
      absorbed.set(event.callId, newest.id)
      return
    }

    openCards.set(
      event.callId,
      activity.log({ kind: info.kind, subject: info.subject, repo: info.repo, ref: info.ref }),
    )
    return
  }

  const absorbedId = absorbed.get(event.callId)
  if (absorbedId) {
    absorbed.delete(event.callId)
    finishCall(activity, absorbedId, event)
    return
  }

  const id = openCards.get(event.callId)
  openCards.delete(event.callId)
  if (!id) return
  // Keep cancelled calls as cards too: a visible cancelled row is still part
  // of the activity record and can never make the thought/action sequence jump.
  finishCall(activity, id, event)
})

/** Open a card for a GitHub action that does not go through api.github.com. */
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
