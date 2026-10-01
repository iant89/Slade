/**
 * What the chat panel holds, in order.
 *
 * The panel is the scrollable log between the header and the composer. It holds
 * the open conversation's messages, followed by standalone GitHub Actions made
 * outside an agent response. An agent run's calls are written into that
 * assistant message's thought/action timeline and are never repeated here.
 */

import { useMemo } from 'react'
import type { Message } from '../../types'
import { useChat } from '../../store/chat'
import { useGitHubActivity, type GitHubActionEntry } from '../../store/githubActivity'

export type PanelItem =
  | { kind: 'message'; id: string; message: Message }
  | { kind: 'github'; id: string; entry: GitHubActionEntry }

/**
 * The GitHub Actions the panel owns: the calls you made yourself. A call a run
 * made carries a scope and renders inside that run's answer instead.
 */
export function sessionGitHubActions(entries: readonly GitHubActionEntry[]): GitHubActionEntry[] {
  return entries.filter((e) => !e.scope)
}

/** Messages in order, followed by standalone actions that have no agent message. */
export function buildPanelItems(
  messages: readonly Message[],
  actions: readonly GitHubActionEntry[],
): PanelItem[] {
  const items: PanelItem[] = messages.map((message) => ({ kind: 'message', id: message.id, message }))
  for (const entry of actions) items.push({ kind: 'github', id: entry.id, entry })
  return items
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
