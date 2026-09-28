import { create } from 'zustand'
import type { Artifact } from '../types'
import { KEYS, loadRaw, saveJSON } from '../lib/storage'
import { PERSIST_LIMIT_BYTES, classifyArtifact, mimeFromName } from '../lib/mime'
import { base64ToBytes } from '../lib/github'

/* ------------------------------------------------------------------ */
/* Artifacts: binary lives as object URLs at runtime; small ones also  */
/* persist as data URLs so previews survive reloads.                   */
/* ------------------------------------------------------------------ */

function dataURLToBlob(dataURL: string): Blob | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataURL)
  if (!match) return null
  const mime = match[1] ?? 'application/octet-stream'
  const isBase64 = Boolean(match[2])
  const payload = match[3] ?? ''
  try {
    if (isBase64) {
      const bin = atob(payload)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new Blob([bytes], { type: mime })
    }
    return new Blob([decodeURIComponent(payload)], { type: mime })
  } catch {
    return null
  }
}

function hydrate(): Record<string, Artifact> {
  const stored = loadRaw<Artifact[]>(KEYS.artifacts, [])
  const byId: Record<string, Artifact> = {}
  for (const a of stored) {
    if (a.dataURL) {
      const blob = dataURLToBlob(a.dataURL)
      if (blob) a.blobUrl = URL.createObjectURL(blob)
    }
    byId[a.id] = a
  }
  return byId
}

let persistTimer: ReturnType<typeof setTimeout> | null = null

export interface ArtifactsState {
  byId: Record<string, Artifact>
  add: (a: Artifact) => void
  remove: (id: string) => void
  clearEphemeral: () => void
  clearAll: () => void
}

export const useArtifacts = create<ArtifactsState>((set, get) => {
  const persistSoon = () => {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      const list = Object.values(get().byId).filter((a) => !a.ephemeral && (a.dataURL || a.text))
      saveJSON(KEYS.artifacts, list)
    }, 500)
  }

  return {
    byId: hydrate(),
    add: (a) => {
      set((st) => ({ byId: { ...st.byId, [a.id]: a } }))
      persistSoon()
    },
    remove: (id) => {
      set((st) => {
        const byId = { ...st.byId }
        const a = byId[id]
        if (a?.blobUrl) URL.revokeObjectURL(a.blobUrl)
        delete byId[id]
        return { byId }
      })
      persistSoon()
    },
    clearEphemeral: () => {
      set((st) => {
        const byId: Record<string, Artifact> = {}
        for (const [id, a] of Object.entries(st.byId)) {
          if (a.ephemeral && a.blobUrl) URL.revokeObjectURL(a.blobUrl)
          if (!a.ephemeral) byId[id] = a
        }
        return { byId }
      })
    },
    clearAll: () => {
      for (const a of Object.values(get().byId)) {
        if (a.blobUrl) URL.revokeObjectURL(a.blobUrl)
      }
      set({ byId: {} })
      saveJSON(KEYS.artifacts, [])
    },
  }
})

/* ------------------------------------------------------------------ */
/* Ingestion: File → Artifact                                          */
/* ------------------------------------------------------------------ */

export async function artifactFromFile(file: File): Promise<Artifact> {
  const id = `art_${Math.random().toString(36).slice(2, 14)}`
  const mime = file.type || mimeFromName(file.name)
  const base: Artifact = {
    id,
    name: file.name || 'attachment',
    mime,
    size: file.size,
    kind: 'unknown',
    createdAt: Date.now(),
    provenance: { origin: 'user' },
    blobUrl: URL.createObjectURL(file),
    ephemeral: true,
  }
  const persistable = file.size <= PERSIST_LIMIT_BYTES
  if (persistable) {
    try {
      base.dataURL = await fileToDataURL(file)
      base.ephemeral = false
    } catch {
      /* keep ephemeral */
    }
  }
  const text = await maybeReadText(file, mime)
  if (text != null) base.text = text
  if (mime === 'text/csv' || file.name.toLowerCase().endsWith('.csv')) {
    const { parseCSV } = await import('../lib/csv')
    const { rows } = parseCSV(base.text ?? '')
    base.columns = rows[0] ?? []
    base.rows = rows.slice(1)
  }
  base.kind = classifyArtifact(base.name, base.mime)
  if (base.kind === 'audio') base.durationSec = await probeAudioDuration(base.blobUrl ?? base.dataURL)
  return base
}

/* ------------------------------------------------------------------ */
/* Ingestion: remote file (GitHub repo) → Artifact                     */
/* ------------------------------------------------------------------ */

export interface RemoteArtifactInput {
  name: string
  mime: string
  remote: Artifact['remote']
  /** Decoded text, when the file is textual. */
  text?: string
  /** Raw base64, when the file is binary. */
  base64?: string
}

/**
 * Build an artifact for a file that lives in a repository. Text files keep their
 * content inline (so they fold into the next prompt like an upload); small
 * binaries — images especially — keep a data URL so previews survive a reload.
 */
export async function artifactFromRemote(input: RemoteArtifactInput): Promise<Artifact> {
  const id = `art_${Math.random().toString(36).slice(2, 14)}`
  const artifact: Artifact = {
    id,
    name: input.name,
    mime: input.mime,
    size: input.text != null ? input.text.length : 0,
    kind: classifyArtifact(input.name, input.mime),
    createdAt: Date.now(),
    provenance: { origin: 'user' },
    remote: input.remote,
    text: input.text,
    ephemeral: true,
  }

  if (input.base64 != null) {
    const bytes = base64ToBytes(input.base64)
    artifact.size = bytes.byteLength
    const blob = new Blob([bytes], { type: input.mime })
    artifact.blobUrl = URL.createObjectURL(blob)
    if (bytes.byteLength <= PERSIST_LIMIT_BYTES) {
      try {
        artifact.dataURL = await fileToDataURL(blob)
        artifact.ephemeral = false
      } catch {
        /* keep ephemeral */
      }
    }
  } else if (input.text != null) {
    artifact.size = new TextEncoder().encode(input.text).byteLength
    if (artifact.size <= PERSIST_LIMIT_BYTES) artifact.ephemeral = false
  }

  if (artifact.kind === 'sheet' && artifact.text != null) {
    const { parseCSV } = await import('../lib/csv')
    const { rows } = parseCSV(artifact.text)
    artifact.columns = rows[0] ?? []
    artifact.rows = rows.slice(1)
  }
  if (artifact.kind === 'audio') artifact.durationSec = await probeAudioDuration(artifact.blobUrl ?? artifact.dataURL)
  return artifact
}


async function probeAudioDuration(url?: string): Promise<number | undefined> {
  if (!url) return undefined
  return new Promise((resolve) => {
    const a = document.createElement('audio')
    a.preload = 'metadata'
    a.onloadedmetadata = () => resolve(Number.isFinite(a.duration) ? a.duration : undefined)
    a.onerror = () => resolve(undefined)
    a.src = url
  })
}

async function maybeReadText(file: File, mime: string): Promise<string | null> {
  const textual =
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/x-yaml' ||
    mime === 'application/toml' ||
    /\.(ts|tsx|js|jsx|json|py|rs|go|java|c|h|cpp|sh|sql|yml|yaml|toml|md|txt|csv|html|css)$/i.test(file.name)
  if (!textual || file.size > 2_000_000) return null
  try {
    return await file.text()
  } catch {
    return null
  }
}

export function fileToDataURL(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
