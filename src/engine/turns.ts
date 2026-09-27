import type { Artifact, ChatTurn, Conversation, Message } from '../types'
import { useArtifacts, fileToDataURL } from '../store/artifacts'
import { formatBytes } from '../lib/format'

/**
 * Convert a conversation into provider-agnostic chat turns.
 *
 * Artifact continuity: attachments ride along with every attempt, so a model
 * that picks up mid-thread still receives the full referenced set.
 */
export async function buildTurns(
  conversation: Conversation,
  opts?: { upToMessageId?: string; maxFoldedChars?: number },
): Promise<ChatTurn[]> {
  const store = useArtifacts.getState()
  const maxFolded = opts?.maxFoldedChars ?? 60_000
  let foldedBudget = maxFolded

  const stopIdx = opts?.upToMessageId
    ? conversation.messages.findIndex((m) => m.id === opts.upToMessageId)
    : conversation.messages.length - 1
  const visible = stopIdx >= 0 ? conversation.messages.slice(0, stopIdx + 1) : conversation.messages

  const turns: ChatTurn[] = []
  for (const msg of visible) {
    if (msg.status === 'error' && !msg.content) continue
    if (msg.role === 'assistant') {
      if (msg.content.trim()) turns.push({ role: 'assistant', text: msg.content })
      continue
    }
    const { text, images, textFiles, binaryNotes } = await foldAttachments(msg, store.byId)
    turns.push({ role: 'user', text, images, textFiles, binaryNotes })
  }

  // Fold text files into the final user turn text (budget-capped).
  const lastUser = [...turns].reverse().find((t) => t.role === 'user')
  if (lastUser) {
    const parts: string[] = []
    for (const f of lastUser.textFiles ?? []) {
      if (foldedBudget <= 0) break
      const body = f.content.slice(0, foldedBudget)
      foldedBudget -= body.length
      parts.push(`\n\n--- attached file: ${f.name} ---\n\`\`\`\n${body}\n\`\`\`\n`)
    }
    for (const note of lastUser.binaryNotes ?? []) parts.push(`\n\n[attachment: ${note}]`)
    if (parts.length) lastUser.text = (lastUser.text ?? '') + parts.join('')
    delete lastUser.textFiles
    delete lastUser.binaryNotes
  }

  return turns
}

async function foldAttachments(
  msg: Message,
  byId: Record<string, Artifact>,
): Promise<Pick<ChatTurn, 'text' | 'images' | 'textFiles' | 'binaryNotes'>> {
  const images: { mime: string; dataURL: string; name: string }[] = []
  const textFiles: { name: string; content: string }[] = []
  const binaryNotes: string[] = []

  for (const id of msg.attachmentIds ?? []) {
    const a = byId[id]
    if (!a) continue
    if (a.kind === 'image') {
      let dataURL = a.dataURL
      if (!dataURL && a.blobUrl) {
        try {
          const blob = await fetch(a.blobUrl).then((r) => r.blob())
          dataURL = await fileToDataURL(blob)
        } catch {
          dataURL = undefined
        }
      }
      if (dataURL) images.push({ mime: a.mime, dataURL, name: a.name })
      else binaryNotes.push(`${a.name} (image, ${formatBytes(a.size)})`)
      continue
    }
    if (a.text != null) {
      textFiles.push({ name: a.name, content: a.text })
      continue
    }
    binaryNotes.push(`${a.name} (${a.mime}, ${formatBytes(a.size)})`)
  }

  return { text: msg.content, images, textFiles, binaryNotes }
}
