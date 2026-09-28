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

function hydrate(): { conversations: Record<string, Conversation>; order: string[]; currentId: string } {
  const raw = loadRaw<unknown>(KEYS.conversations, null)
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
  return { conversations, order, currentId: order[0] ?? '' }
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
  selectConversation: (id: string) => void
  deleteConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
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

    selectConversation: (id) => set({ currentId: id }),

    deleteConversation: (id) => {
      set((st) => {
        const conversations = { ...st.conversations }
        delete conversations[id]
        const order = st.order.filter((x) => x !== id)
        return { conversations, order, currentId: st.currentId === id ? (order[0] ?? '') : st.currentId }
      })
      persistSoon()
    },

    renameConversation: (id, title) => updateConv(id, (c) => ({ ...c, title })),

    setConversationModel: (id, modelId) => updateConv(id, (c) => ({ ...c, modelId })),

    setConversationAgent: (id, enabled) => updateConv(id, (c) => ({ ...c, agentEnabled: enabled })),

    appendMessage: (msg) =>
      updateConv(msg.conversationId, (c) => ({ ...c, messages: [...c.messages, msg] })),

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
        const currentId = st.currentId || order[0] || ''
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
