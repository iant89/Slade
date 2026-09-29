import { create } from 'zustand'
import { z } from 'zod'
import type { Artifact, ArtifactSource, FsFile, FsFileEncoding, FsOpRecord, RemoteSource } from '../types'
import { KEYS, loadRaw, saveJSON } from '../lib/storage'
import { fsFileSchema } from '../lib/schemas'
import { classifyArtifact, mimeFromName } from '../lib/mime'
import { parseCSV } from '../lib/csv'
import {
  extractFsActions,
  fsBaseName,
  MAX_FS_FILE_BYTES,
  normalizeFsPath,
  tryNormalizeFsPath,
  FsError,
} from '../lib/fs'
import { useArtifacts } from './artifacts'
import { useUI } from './ui'

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function hashPath(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

export function fsArtifactId(path: string): string {
  return `art_fs_${hashPath(path)}`
}

function byteSizeOf(content: string, encoding: FsFileEncoding = 'utf8'): number {
  if (encoding === 'base64') {
    const clean = content.replace(/=+$/, '')
    return Math.floor((clean.length * 3) / 4)
  }
  return new TextEncoder().encode(content).byteLength
}

function buildArtifactForFsFile(file: FsFile): Artifact {
  const id = fsArtifactId(file.path)
  const isBase64 = file.encoding === 'base64'
  const dataURL = isBase64
    ? `data:${file.mime};base64,${file.content}`
    : `data:${file.mime};charset=utf-8,${encodeURIComponent(file.content)}`

  const artifact: Artifact = {
    id,
    name: file.name,
    mime: file.mime,
    size: file.size,
    kind: file.kind,
    createdAt: file.updatedAt,
    provenance: file.updatedBy,
    remote: file.remote,
    localPath: file.path,
    dataURL,
    text: isBase64 ? undefined : file.content,
    ephemeral: false,
  }

  if (file.kind === 'sheet' && !isBase64) {
    const { rows } = parseCSV(file.content)
    artifact.columns = rows[0] ?? []
    artifact.rows = rows.slice(1)
  }

  return artifact
}

function hydrate(): Record<string, FsFile> {
  const raw = loadRaw<unknown>(KEYS.fs, [])
  const parsed = z.array(fsFileSchema).safeParse(raw)
  const list = parsed.success ? (parsed.data as FsFile[]) : []
  const byPath: Record<string, FsFile> = {}
  for (const f of list) {
    const norm = tryNormalizeFsPath(f.path)
    if (norm) byPath[norm] = { ...f, path: norm, name: fsBaseName(norm) }
  }
  return byPath
}

function persistFiles(files: Record<string, FsFile>): void {
  const list = Object.values(files).sort((a, b) => a.path.localeCompare(b.path))
  saveJSON(KEYS.fs, list)
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface FsSearchHit {
  file: FsFile
  pathMatch: boolean
  lines: { line: number; text: string }[]
}

export interface WriteFileOptions {
  encoding?: FsFileEncoding
  mime?: string
  source?: ArtifactSource
  conversationId?: string
  messageId?: string
  remote?: RemoteSource
  dirty?: boolean
  /** When true, also creates/updates the corresponding Artifact in useArtifacts. */
  syncArtifact?: boolean
}

export interface FsState {
  /** All files in the local file system, keyed by normalized path. */
  files: Record<string, FsFile>
  /** Files with an upstream Git remote that were deleted locally since last sync. */
  deletedRemotes: Record<string, RemoteSource>
  /** Path currently open in the Files workspace drawer. */
  selectedPath: string | null
  /** Filter/search query in the Files workspace drawer. */
  filter: string

  /* File system operations */
  writeFile: (path: string, content: string, opts?: WriteFileOptions) => FsFile
  appendFile: (path: string, content: string, opts?: WriteFileOptions) => FsFile
  readFile: (path: string) => FsFile | undefined
  exists: (path: string) => boolean
  deleteFile: (path: string) => boolean
  deleteDirectory: (dirPath: string) => number
  moveFile: (fromPath: string, toPath: string, source?: ArtifactSource) => FsFile | null
  listFiles: (dirPrefix?: string) => FsFile[]
  search: (query: string) => FsSearchHit[]

  /* Agent & Artifact bridge */
  applyAgentOutput: (
    markdown: string,
    meta: {
      source: ArtifactSource
      conversationId?: string
      messageId?: string
    },
  ) => FsOpRecord[]
  saveArtifact: (artifact: Artifact, targetPath?: string) => FsFile | null
  toArtifact: (path: string) => Artifact | null
  attachFile: (path: string, opts?: { silent?: boolean }) => Artifact | null

  /* Bulk, Git sync & UI state */
  markSyncedWithRemote: (
    repo: string,
    ref: string,
    committedPaths: readonly string[],
    fileShas?: Record<string, string>,
    deletedPaths?: readonly string[],
  ) => void
  importFiles: (entries: FsFile[]) => void
  clearAll: () => void
  selectFile: (path: string | null) => void
  setFilter: (v: string) => void
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export const useFs = create<FsState>((set, get) => ({
  files: hydrate(),
  deletedRemotes: {},
  selectedPath: null,
  filter: '',

  writeFile: (rawPath, content, opts) => {
    const path = normalizeFsPath(rawPath)
    const encoding: FsFileEncoding = opts?.encoding ?? 'utf8'
    const size = byteSizeOf(content, encoding)
    if (size > MAX_FS_FILE_BYTES) {
      throw new FsError('too_large', `File "${path}" exceeds the 5 MB local file system limit.`, path)
    }

    const name = fsBaseName(path)
    const mime = opts?.mime || mimeFromName(name, encoding === 'base64' ? 'application/octet-stream' : 'text/plain')
    const kind = classifyArtifact(name, mime)
    const now = Date.now()
    const source: ArtifactSource = opts?.source ?? { origin: 'user' }
    const existing = get().files[path]
    const remote = opts?.remote ?? existing?.remote
    const dirty =
      opts?.dirty !== undefined
        ? opts.dirty
        : opts?.remote
          ? false
          : existing?.remote
            ? existing.content !== content || Boolean(existing.dirty)
            : true

    const file: FsFile = {
      path,
      name,
      content,
      encoding,
      mime,
      kind,
      size,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      createdBy: existing?.createdBy ?? source,
      updatedBy: source,
      version: opts?.remote && !existing ? 1 : existing ? existing.version + (opts?.remote && existing.content === content ? 0 : 1) : 1,
      conversationId: opts?.conversationId ?? existing?.conversationId,
      messageId: opts?.messageId ?? existing?.messageId,
      remote,
      dirty,
    }

    set((st) => {
      const next = { ...st.files, [path]: file }
      const nextDeleted = { ...st.deletedRemotes }
      delete nextDeleted[path]
      persistFiles(next)
      return { files: next, deletedRemotes: nextDeleted }
    })

    if (opts?.syncArtifact) {
      const artifact = buildArtifactForFsFile(file)
      useArtifacts.getState().add(artifact)
    }

    return file
  },

  appendFile: (rawPath, extraContent, opts) => {
    const path = normalizeFsPath(rawPath)
    const existing = get().files[path]
    let combined = extraContent
    if (existing && existing.encoding !== 'base64') {
      const sep =
        existing.content.length === 0 || existing.content.endsWith('\n') || extraContent.startsWith('\n')
          ? ''
          : '\n'
      combined = `${existing.content}${sep}${extraContent}`
    }
    return get().writeFile(path, combined, opts)
  },

  readFile: (rawPath) => {
    const path = tryNormalizeFsPath(rawPath)
    if (!path) return undefined
    return get().files[path]
  },

  exists: (rawPath) => {
    const path = tryNormalizeFsPath(rawPath)
    if (!path) return false
    return Object.prototype.hasOwnProperty.call(get().files, path)
  },

  deleteFile: (rawPath) => {
    const path = tryNormalizeFsPath(rawPath)
    if (!path || !Object.prototype.hasOwnProperty.call(get().files, path)) return false
    set((st) => {
      const next = { ...st.files }
      const nextDeleted = { ...st.deletedRemotes }
      const removed = next[path]
      if (removed?.remote) nextDeleted[path] = removed.remote
      delete next[path]
      persistFiles(next)
      return {
        files: next,
        deletedRemotes: nextDeleted,
        selectedPath: st.selectedPath === path ? null : st.selectedPath,
      }
    })
    return true
  },

  deleteDirectory: (rawDirPath) => {
    const dir = tryNormalizeFsPath(rawDirPath)
    if (!dir) return 0
    const prefix = `${dir}/`
    const current = get().files
    const toRemove = Object.keys(current).filter((k) => k === dir || k.startsWith(prefix))
    if (toRemove.length === 0) return 0
    set((st) => {
      const next = { ...st.files }
      const nextDeleted = { ...st.deletedRemotes }
      for (const k of toRemove) {
        const removed = next[k]
        if (removed?.remote) nextDeleted[k] = removed.remote
        delete next[k]
      }
      persistFiles(next)
      const clearSel = st.selectedPath && (st.selectedPath === dir || st.selectedPath.startsWith(prefix))
      return {
        files: next,
        deletedRemotes: nextDeleted,
        selectedPath: clearSel ? null : st.selectedPath,
      }
    })
    return toRemove.length
  },

  moveFile: (fromRawPath, toRawPath, source) => {
    const fromPath = tryNormalizeFsPath(fromRawPath)
    const toPath = tryNormalizeFsPath(toRawPath)
    if (!fromPath || !toPath) return null
    const existing = get().files[fromPath]
    if (!existing) return null
    if (fromPath === toPath) return existing

    const toName = fsBaseName(toPath)
    const mime = mimeFromName(toName, existing.mime)
    const kind = classifyArtifact(toName, mime)
    const targetExisting = get().files[toPath]
    const moved: FsFile = {
      ...existing,
      path: toPath,
      name: toName,
      mime,
      kind,
      updatedAt: Date.now(),
      updatedBy: source ?? existing.updatedBy,
      version: (targetExisting?.version ?? existing.version) + 1,
      remote: existing.remote
        ? {
            ...existing.remote,
            path: toPath,
            url: `https://github.com/${existing.remote.repo}/blob/${encodeURIComponent(existing.remote.ref)}/${toPath}`,
          }
        : undefined,
      dirty: existing.remote ? true : existing.dirty,
    }

    set((st) => {
      const next = { ...st.files }
      const nextDeleted = { ...st.deletedRemotes }
      if (existing.remote) nextDeleted[fromPath] = existing.remote
      delete nextDeleted[toPath]
      delete next[fromPath]
      next[toPath] = moved
      persistFiles(next)
      return {
        files: next,
        deletedRemotes: nextDeleted,
        selectedPath: st.selectedPath === fromPath ? toPath : st.selectedPath,
      }
    })
    return moved
  },

  listFiles: (dirPrefix) => {
    const all = Object.values(get().files).sort((a, b) => a.path.localeCompare(b.path))
    if (!dirPrefix) return all
    const norm = tryNormalizeFsPath(dirPrefix)
    if (!norm) return []
    const prefix = `${norm}/`
    return all.filter((f) => f.path === norm || f.path.startsWith(prefix))
  },

  search: (query) => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const hits: FsSearchHit[] = []
    const sorted = get().listFiles()
    for (const file of sorted) {
      const pathMatch = file.path.toLowerCase().includes(q)
      const lines: { line: number; text: string }[] = []
      if (file.encoding !== 'base64' && file.content) {
        const rawLines = file.content.split(/\r?\n/)
        for (let i = 0; i < rawLines.length && lines.length < 5; i++) {
          if (rawLines[i]!.toLowerCase().includes(q)) {
            lines.push({ line: i + 1, text: rawLines[i]!.slice(0, 180) })
          }
        }
      }
      if (pathMatch || lines.length > 0) {
        hits.push({ file, pathMatch, lines })
      }
    }
    return hits
  },

  applyAgentOutput: (markdown, meta) => {
    const actions = extractFsActions(markdown)
    if (actions.length === 0) return []
    const records: FsOpRecord[] = []

    for (const action of actions) {
      const at = Date.now()
      try {
        if (action.op === 'write') {
          const existed = get().exists(action.path)
          // Skip no-op writes when the exact content is already stored at the
          // same path (e.g. when synthesis echoes a worker's file block verbatim).
          const prev = get().readFile(action.path)
          if (prev && prev.encoding !== 'base64' && prev.content === action.content) {
            const art = buildArtifactForFsFile(prev)
            useArtifacts.getState().add(art)
            continue
          }
          const written = get().writeFile(action.path, action.content, {
            source: meta.source,
            conversationId: meta.conversationId,
            messageId: meta.messageId,
            syncArtifact: true,
          })
          records.push({
            op: existed ? 'update' : 'create',
            path: written.path,
            size: written.size,
            version: written.version,
            at,
          })
        } else if (action.op === 'append') {
          const existed = get().exists(action.path)
          const written = get().appendFile(action.path, action.content, {
            source: meta.source,
            conversationId: meta.conversationId,
            messageId: meta.messageId,
            syncArtifact: true,
          })
          records.push({
            op: existed ? 'update' : 'create',
            path: written.path,
            size: written.size,
            version: written.version,
            at,
          })
        } else if (action.op === 'delete') {
          const deleted = get().deleteFile(action.path)
          if (deleted) {
            records.push({ op: 'delete', path: action.path, at })
          }
        } else if (action.op === 'move') {
          const moved = get().moveFile(action.fromPath, action.toPath, meta.source)
          if (moved) {
            records.push({
              op: 'move',
              fromPath: action.fromPath,
              path: moved.path,
              size: moved.size,
              version: moved.version,
              at,
            })
          }
        }
      } catch {
        /* ignore invalid paths or oversized files in agent output */
      }
    }

    return records
  },

  saveArtifact: (artifact, targetPath) => {
    const rawPath = targetPath ?? artifact.localPath ?? artifact.remote?.path ?? artifact.name
    const path = tryNormalizeFsPath(rawPath)
    if (!path) return null

    let content = artifact.text ?? ''
    let encoding: FsFileEncoding = 'utf8'

    if (artifact.text == null && artifact.dataURL) {
      const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(artifact.dataURL)
      if (match) {
        if (match[2]) {
          encoding = 'base64'
          content = match[3] ?? ''
        } else {
          content = decodeURIComponent(match[3] ?? '')
        }
      } else {
        return null
      }
    } else if (artifact.text == null) {
      return null
    }

    try {
      const saved = get().writeFile(path, content, {
        encoding,
        mime: artifact.mime,
        source: artifact.provenance,
        remote: artifact.remote,
        dirty: false,
      })
      useArtifacts.getState().add({ ...artifact, localPath: saved.path })
      return saved
    } catch {
      return null
    }
  },

  toArtifact: (rawPath) => {
    const file = get().readFile(rawPath)
    if (!file) return null
    const artifact = buildArtifactForFsFile(file)
    useArtifacts.getState().add(artifact)
    return artifact
  },

  attachFile: (rawPath, opts) => {
    const artifact = get().toArtifact(rawPath)
    if (!artifact) return null
    if (!opts?.silent) {
      useUI.getState().addPendingAttachment(artifact.id)
      useUI.getState().toast({
        kind: 'success',
        title: `${artifact.name} attached`,
        detail: `${artifact.localPath ?? artifact.name} · queued for your next message.`,
      })
    }
    return artifact
  },

  markSyncedWithRemote: (repo, ref, committedPaths, fileShas, deletedPaths) => {
    set((st) => {
      const next = { ...st.files }
      for (const rawPath of committedPaths) {
        const path = tryNormalizeFsPath(rawPath)
        if (!path || !next[path]) continue
        const cur = next[path]!
        const sha = fileShas?.[path] ?? cur.remote?.sha
        const url = `https://github.com/${repo}/blob/${encodeURIComponent(ref)}/${path
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`
        next[path] = {
          ...cur,
          remote: {
            kind: 'github',
            repo,
            ref,
            path,
            url,
            sha,
          },
          dirty: false,
        }
      }
      const nextDeleted = { ...st.deletedRemotes }
      for (const delPath of deletedPaths ?? []) {
        const norm = tryNormalizeFsPath(delPath)
        if (norm) delete nextDeleted[norm]
      }
      persistFiles(next)
      return { files: next, deletedRemotes: nextDeleted }
    })
  },

  importFiles: (entries) => {
    set((st) => {
      const next = { ...st.files }
      for (const f of entries) {
        const norm = tryNormalizeFsPath(f.path)
        if (norm) next[norm] = { ...f, path: norm, name: fsBaseName(norm) }
      }
      persistFiles(next)
      return { files: next }
    })
  },

  clearAll: () => {
    set({ files: {}, deletedRemotes: {}, selectedPath: null })
    saveJSON(KEYS.fs, [])
  },

  selectFile: (path) => {
    const norm = path ? tryNormalizeFsPath(path) : null
    set({ selectedPath: norm })
  },

  setFilter: (v) => set({ filter: v }),
}))
