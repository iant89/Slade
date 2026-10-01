/**
 * What the chat panel holds, in order.
 *
 * The panel is the scrollable log between the header and the composer. It holds
 * the open conversation's messages, followed by standalone GitHub Actions made
 * outside an agent response. An agent run's calls are written into that
 * assistant message's thought/action timeline and are never repeated here.
 *
 * More than two standalone actions in a row are folded into one expandable
 * group, so a burst of calls is a single row instead of a screenful.
 */

import { useMemo } from 'react'
import type { Message } from '../../types'
import { foldActionRuns } from '../../lib/github-actions'
import { useChat } from '../../store/chat'
import { useGitHubActivity, type GitHubActionEntry } from '../../store/githubActivity'

export type PanelItem =
  | { kind: 'message'; id: string; message: Message }
  | { kind: 'github'; id: string; entry: GitHubActionEntry }
  /** A streak of more than two standalone actions, folded into one dropdown. Oldest first. */
  | { kind: 'github-group'; id: string; entries: GitHubActionEntry[] }

type GitHubPanelItem = Extract<PanelItem, { kind: 'github' }>

const isGitHubItem = (item: PanelItem): item is GitHubPanelItem => item.kind === 'github'

/**
 * The GitHub Actions the panel owns: the calls you made yourself. A call a run
 * made carries a scope and renders inside that run's answer instead.
 */
export function sessionGitHubActions(entries: readonly GitHubActionEntry[]): GitHubActionEntry[] {
  return entries.filter((e) => !e.scope)
}

/**
 * Messages in order, followed by standalone actions that have no agent message.
 * The actions are one streak after the last message; when there are more than
 * two they come back as a single `github-group` row, oldest call first.
 */
export function buildPanelItems(
  messages: readonly Message[],
  actions: readonly GitHubActionEntry[],
): PanelItem[] {
  const items: PanelItem[] = messages.map((message) => ({ kind: 'message', id: message.id, message }))
  for (const entry of actions) items.push({ kind: 'github', id: entry.id, entry })
  return foldActionRuns(items, isGitHubItem).map(
    (fold): PanelItem =>
      fold.kind === 'group'
        ? { kind: 'github-group', id: fold.id, entries: fold.items.map((item) => item.entry) }
        : fold.item,
  )
}

/** The actions to append to the open panel. Re-renders only when the log changes. */
export function useSessionGitHubActions(): GitHubActionEntry[] {
  const entries = useGitHubActivity((s) => s.entries)
  return useMemo(() => sessionGitHubActions(entries), [entries])
}

/**
 * Whether the panel holds anything at all — messages or appended actions.
 *
 * The composer asks this so a session that has GitHub cards but no message yet
 * still gets a docked composer and a panel that scrolls, instead of a centered
 * greeting with a log floating above it.
 */
export function usePanelHasContent(): boolean {
  const hasMessages = useChat((s) => Boolean(s.currentId && s.conversations[s.currentId]?.messages.length))
  const hasActions = useGitHubActivity((s) => s.entries.some((e) => !e.scope))
  return hasMessages || hasActions
}
