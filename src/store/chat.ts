import { create } from 'zustand'
import type { Conversation, Message } from '../types'
import { uid } from '../lib/id'
import { KEYS, loadRaw, saveJSON } from '../lib/storage'
import { conversationSchema } from '../lib/schemas'
import { z } from 'zod'

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

const conversationsArraySchema = z.array(conversationSchema)

/** Longest title the rename UI accepts (auto-titles from a prompt are ~43 characters). */
export const MAX_TITLE_LENGTH = 120

/**
 * Collapse whitespace and newlines, trim, and cap the length (by code point, so an
 * emoji is never cut in half). An empty result means "keep the current title".
 */
export function normalizeTitle(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim()
  const chars = Array.from(t)
  return chars.length > MAX_TITLE_LENGTH ? chars.slice(0, MAX_TITLE_LENGTH).join('').trimEnd() : t
}

/** First conversation in `order` that is not archived (and is not `except`), or '' when there is none. */
export function firstActiveId(
  order: readonly string[],
  conversations: Record<string, Conversation>,
  except?: string,
): string {
  for (const id of order) {
    if (id === except) continue
    const c = conversations[id]
    if (c && !c.archived) return id
  }
  return ''
}

/** Turn whatever was stored into store state. Pure, so it can be tested without a browser. */
export function hydrateConversations(raw: unknown): {
  conversations: Record<string, Conversation>
  order: string[]
  currentId: string
} {
  let list: Conversation[] = []
  const parsed = conversationsArraySchema.safeParse(raw)
  if (parsed.success) {
    list = parsed.data as unknown as Conversation[]
  }
  // Sanitize interrupted streams: anything pending/streaming becomes cancelled.
  for (const c of list) {
    for (const m of c.messages) {
      if (m.status === 'streaming' || m.status === 'pending') m.status = 'cancelled'
    }
  }
  const conversations: Record<string, Conversation> = {}
  for (const c of list) conversations[c.id] = c
  const order = list
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => c.id)
  // Open on the newest conversation that is still in the main list, never on an archived one.
  return { conversations, order, currentId: firstActiveId(order, conversations) }
}

function hydrate() {
  return hydrateConversations(loadRaw<unknown>(KEYS.conversations, null))
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
function schedulePersist(get: () => ChatState) {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    const { conversations, order } = get()
    const list = order
      .map((id) => conversations[id])
      .filter((c): c is Conversation => !!c)
      .map((c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.status === 'streaming' || m.status === 'pending' ? { ...m, status: 'cancelled' as const } : m,
        ),
      }))
    saveJSON(KEYS.conversations, list)
  }, 350)
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export interface ChatState {
  conversations: Record<string, Conversation>
  order: string[]
  currentId: string

  newConversation: (modelId?: string) => string
  /**
   * The id of the open conversation, creating a fresh one when there is none
   * (first run, or the last chat was just deleted or archived). The chat panel
   * calls this so there is always a conversation for its log — messages, and
   * the GitHub Actions appended to the panel — to belong to.
   */
  ensureConversation: () => string
  selectConversation: (id: string) => void
  deleteConversation: (id: string) => void
  /** Blank titles are ignored. Renaming is not chat activity: `updatedAt` is left alone. */
  renameConversation: (id: string, title: string) => void
  /**
   * Move a conversation out of the main list into the Archived group. If it is the
   * open one, the view moves to the next active conversation (or the empty state).
   * `updatedAt` is left alone, so its time and sort position survive a round trip.
   */
  archiveConversation: (id: string) => void
  unarchiveConversation: (id: string) => void
  setConversationModel: (id: string, modelId: string | undefined) => void
  setConversationAgent: (id: string, enabled: boolean) => void

  appendMessage: (msg: Message) => void
  updateMessage: (id: string, patch: Partial<Message>) => void
  mutateMessage: (id: string, fn: (m: Message) => Message) => void
  deleteMessage: (id: string) => void
  /** Drop every message after (not including) the given message; returns conv id. */
  truncateAfter: (conversationId: string, messageId: string) => void
  /** Copy messages up to & including messageId into a brand-new conversation. */
  branchFrom: (conversationId: string, messageId: string) => string

  clearAllConversations: () => void
  importConversations: (list: Conversation[]) => void
}

function touch(conv: Conversation): Conversation {
  return { ...conv, updatedAt: Date.now() }
}

function findConv(get: () => ChatState, id: string): Conversation | undefined {
  return get().conversations[id]
}

export const useChat = create<ChatState>((set, get) => {
  const persistSoon = () => schedulePersist(() => get())

  const updateConv = (id: string, fn: (c: Conversation) => Conversation) => {
    set((st) => {
      const conv = st.conversations[id]
      if (!conv) return st
      const next = touch(fn(conv))
      return { conversations: { ...st.conversations, [id]: next } }
    })
    persistSoon()
  }

  const setArchived = (id: string, archived: boolean) => {
    const conv = get().conversations[id]
    if (!conv || Boolean(conv.archived) === archived) return
    set((st) => {
      const cur = st.conversations[id]
      if (!cur) return st
      const { archived: _was, ...active } = cur
      const conversations = { ...st.conversations, [id]: archived ? { ...cur, archived: true } : active }
      return {
        conversations,
        currentId: archived && st.currentId === id ? firstActiveId(st.order, conversations, id) : st.currentId,
      }
    })
    persistSoon()
  }

  return {
    ...hydrate(),

    newConversation: (modelId) => {
      const id = uid('conv')
      const now = Date.now()
      const conv: Conversation = { id, title: 'New chat', createdAt: now, updatedAt: now, modelId, messages: [] }
      set((st) => ({
        conversations: { ...st.conversations, [id]: conv },
        order: [id, ...st.order],
        currentId: id,
      }))
      persistSoon()
      return id
    },

    ensureConversation: () => {
      const { currentId, conversations } = get()
      if (currentId && conversations[currentId]) return currentId
      return get().newConversation()
    },

    selectConversation: (id) => set({ currentId: id }),

    deleteConversation: (id) => {
      set((st) => {
        const conversations = { ...st.conversations }
        delete conversations[id]
        const order = st.order.filter((x) => x !== id)
        return {
          conversations,
          order,
          currentId: st.currentId === id ? firstActiveId(order, conversations) : st.currentId,
        }
      })
      persistSoon()
    },

    renameConversation: (id, title) => {
      const next = normalizeTitle(title)
      const conv = get().conversations[id]
      if (!next || !conv || conv.title === next) return
      set((st) => {
        const cur = st.conversations[id]
        return cur ? { conversations: { ...st.conversations, [id]: { ...cur, title: next } } } : st
      })
      persistSoon()
    },

    archiveConversation: (id) => setArchived(id, true),

    unarchiveConversation: (id) => setArchived(id, false),

    setConversationModel: (id, modelId) => updateConv(id, (c) => ({ ...c, modelId })),

    setConversationAgent: (id, enabled) => updateConv(id, (c) => ({ ...c, agentEnabled: enabled })),

    appendMessage: (msg) =>
      updateConv(msg.conversationId, (c) => {
        const messages = [...c.messages, msg]
        // Writing to an archived chat brings it back to the main list. Only a USER message
        // does: a reply that finishes streaming after the user archived the chat must not
        // silently undo that.
        if (msg.role === 'user' && c.archived) {
          const { archived: _was, ...active } = c
          return { ...active, messages }
        }
        return { ...c, messages }
      }),

    updateMessage: (id, patch) => {
      set((st) => {
        for (const convId of Object.keys(st.conversations)) {
          const conv = st.conversations[convId]
          if (!conv) continue
          const idx = conv.messages.findIndex((m) => m.id === id)
          if (idx >= 0) {
            const messages = conv.messages.slice()
            messages[idx] = { ...messages[idx]!, ...patch }
            const next = touch({ ...conv, messages })
            return { conversations: { ...st.conversations, [convId]: next } }
          }
        }
        return st
      })
      persistSoon()
    },

    mutateMessage: (id, fn) => {
      set((st) => {
        for (const convId of Object.keys(st.conversations)) {
          const conv = st.conversations[convId]
          if (!conv) continue
          const idx = conv.messages.findIndex((m) => m.id === id)
          if (idx >= 0) {
            const messages = conv.messages.slice()
            messages[idx] = fn(messages[idx]!)
            const next = touch({ ...conv, messages })
            return { conversations: { ...st.conversations, [convId]: next } }
          }
        }
        return st
      })
      persistSoon()
    },

    deleteMessage: (id) => {
      const st = get()
      for (const convId of Object.keys(st.conversations)) {
        const conv = st.conversations[convId]
        if (conv?.messages.some((m) => m.id === id)) {
          updateConv(convId, (c) => ({ ...c, messages: c.messages.filter((m) => m.id !== id) }))
          break
        }
      }
    },

    truncateAfter: (conversationId, messageId) => {
      updateConv(conversationId, (c) => {
        const idx = c.messages.findIndex((m) => m.id === messageId)
        if (idx < 0) return c
        return { ...c, messages: c.messages.slice(0, idx + 1) }
      })
    },

    branchFrom: (conversationId, messageId) => {
      const src = findConv(get, conversationId)
      if (!src) return ''
      const idx = src.messages.findIndex((m) => m.id === messageId)
      if (idx < 0) return ''
      const id = uid('conv')
      const now = Date.now()
      const conv: Conversation = {
        id,
        title: `${src.title} ↗`,
        createdAt: now,
        updatedAt: now,
        modelId: src.modelId,
        messages: src.messages.slice(0, idx + 1).map((m) => ({ ...m, conversationId: id, status: 'complete' })),
      }
      set((st) => ({
        conversations: { ...st.conversations, [id]: conv },
        order: [id, ...st.order],
        currentId: id,
      }))
      persistSoon()
      return id
    },

    clearAllConversations: () => {
      set({ conversations: {}, order: [], currentId: '' })
      persistSoon()
    },

    importConversations: (list) => {
      set((st) => {
        const conversations = { ...st.conversations }
        const order = [...st.order]
        for (const c of list) {
          if (!conversations[c.id]) order.unshift(c.id)
          conversations[c.id] = c
        }
        const currentId = st.currentId || firstActiveId(order, conversations)
        return { conversations, order, currentId }
      })
      persistSoon()
    },
  }
})

/* ------------------------------------------------------------------ */
/* Selectors & helpers                                                 */
/* ------------------------------------------------------------------ */

export function useCurrentConversation(): Conversation | undefined {
  return useChat((s) => (s.currentId ? s.conversations[s.currentId] : undefined))
}

export function titleFromPrompt(prompt: string): string {
  const t = prompt.replace(/\s+/g, ' ').trim()
  if (!t) return 'New chat'
  return t.length > 42 ? t.slice(0, 42).trimEnd() + '…' : t
}
