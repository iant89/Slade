import { uid } from '../lib/id'
import type { AgentTimelineItem, GitHubActionArtifact } from '../types'
import { useChat } from './chat'

/** Append a reasoning delta to the currently open thought card, or start a new one. */
export function appendAgentThought(messageId: string, sourceId: string, modelId: string, text: string): void {
  if (!text) return
  useChat.getState().mutateMessage(messageId, (message) => {
    if (!message.agent) return message

    const timeline = [...(message.agent.timeline ?? [])]
    const last = timeline[timeline.length - 1]
    if (last?.type === 'thought' && last.sourceId === sourceId && last.modelId === modelId && last.streaming) {
      timeline[timeline.length - 1] = { ...last, text: last.text + text }
    } else {
      const closed = closeOpenThoughts(timeline)
      closed.push({
        id: uid('thought'),
        type: 'thought',
        sourceId,
        modelId,
        text,
        streaming: true,
      })
      return { ...message, agent: { ...message.agent, timeline: closed } }
    }

    return { ...message, agent: { ...message.agent, timeline } }
  })
}

/** Close a thought stream when its model phase finishes. */
export function closeAgentThought(messageId: string, sourceId?: string): void {
  useChat.getState().mutateMessage(messageId, (message) => {
    if (!message.agent?.timeline?.some((item) => item.type === 'thought' && item.streaming && (!sourceId || item.sourceId === sourceId))) {
      return message
    }
    return {
      ...message,
      agent: {
        ...message.agent,
        timeline: message.agent.timeline.map((item) =>
          item.type === 'thought' && item.streaming && (!sourceId || item.sourceId === sourceId)
            ? { ...item, streaming: false }
            : item,
        ),
      },
    }
  })
}

/**
 * Insert a GitHub card exactly where the call started, closing any thought card
 * that was streaming at that point. The snapshot is kept on the message so the
 * card survives the live activity ledger and reloads.
 */
export function appendAgentGitHubCard(messageId: string, card: GitHubActionArtifact): void {
  useChat.getState().mutateMessage(messageId, (message) => {
    if (!message.agent) return message

    const timeline = [...(message.agent.timeline ?? [])]
    const existing = timeline.findIndex((item) => item.type === 'github' && item.card.id === card.id)
    if (existing >= 0) {
      timeline[existing] = { id: card.id, type: 'github', card }
      return { ...message, agent: { ...message.agent, timeline } }
    }

    const closed = closeOpenThoughts(timeline)
    closed.push({ id: card.id, type: 'github', card })
    return { ...message, agent: { ...message.agent, timeline: closed } }
  })
}

/** Update the live status/count on a card without moving or removing it. */
export function updateAgentGitHubCard(messageId: string, card: GitHubActionArtifact): void {
  useChat.getState().mutateMessage(messageId, (message) => {
    if (!message.agent?.timeline) return message
    let changed = false
    const timeline = message.agent.timeline.map((item) => {
      if (item.type !== 'github' || item.card.id !== card.id) return item
      changed = true
      return { ...item, card }
    })
    return changed ? { ...message, agent: { ...message.agent, timeline } } : message
  })
}

/** Copy a timeline and close every currently streaming thought before a boundary. */
function closeOpenThoughts(timeline: AgentTimelineItem[]): AgentTimelineItem[] {
  return timeline.map((item) =>
    item.type === 'thought' && item.streaming ? { ...item, streaming: false } : item,
  )
}
