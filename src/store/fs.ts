import { create } from 'zustand'
import { z } from 'zod'
import type { Artifact, ArtifactSource, FsFile, FsFileEncoding, FsOpRecord, RemoteSource } from '../types'
import { KEYS, loadRaw, removeKey, saveJSON } from '../lib/storage'
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
import { useChat } from './chat'
import { useUI } from './ui'

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Temporary owner for files imported before the first chat has been created. */
const LEGACY_WORKSPACE_ID = '__slade_legacy_workspace__'

export interface FsWorkspace {
  files: Record<string, FsFile>
  deletedRemotes: Record<string, RemoteSource>
  selectedPath: string | null
}

function emptyWorkspace(): FsWorkspace {
  return { files: {}, deletedRemotes: {}, selectedPath: null }
}

function hashPath(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** Artifact ids include the workspace so same-named files in different chats cannot overwrite each other. */
export function fsArtifactId(path: string, conversationId?: string): string {
  return `art_fs_${hashPath(`${conversationId ?? ''}\u0000${path}`)}`
}

function byteSizeOf(content: string, encoding: FsFileEncoding = 'utf8'): number {
  if (encoding === 'base64') {
    const clean = content.replace(/=+$/, '')
    return Math.floor((clean.length * 3) / 4)
  }
  return new TextEncoder().encode(content).byteLength
}

function buildArtifactForFsFile(file: FsFile): Artifact {
  const id = fsArtifactId(file.path, file.conversationId)
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
    conversationId: file.conversationId,
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

function workspaceFor(workspaces: Record<string, FsWorkspace>, conversationId: string): FsWorkspace {
  return workspaces[conversationId] ?? emptyWorkspace()
}

function normalizeOwnerId(conversationId: string | undefined, fallbackId: string): string {
  return conversationId && conversationId !== LEGACY_WORKSPACE_ID ? conversationId : fallbackId
}

function persistWorkspaces(workspaces: Record<string, FsWorkspace>): void {
  const list = Object.entries(workspaces).flatMap(([conversationId, workspace]) =>
    Object.values(workspace.files).map((file) => ({
      ...file,
      conversationId: conversationId === LEGACY_WORKSPACE_ID ? undefined : conversationId,
    })),
  )
  list.sort(
    (a, b) =>
      (a.conversationId ?? '').localeCompare(b.conversationId ?? '') || a.path.localeCompare(b.path),
  )
  saveJSON(KEYS.fs, list)
}

/**
 * Read the new scoped file list, or upgrade the old global list on first load.
 * Legacy files that already carry a conversation id retain that owner; older
 * unscoped files are assigned to the currently open conversation.
 */
export function hydrateWorkspaces(defaultConversationId: string): Record<string, FsWorkspace> {
  const currentRaw = loadRaw<unknown>(KEYS.fs, null)
  let parsed = z.array(fsFileSchema).safeParse(currentRaw)
  let migrated = false

  if (!parsed.success) {
    const legacyRaw = loadRaw<unknown>(KEYS.fsLegacy, [])
    parsed = z.array(fsFileSchema).safeParse(legacyRaw)
    migrated = parsed.success
  }

  const byConversation: Record<string, FsWorkspace> = {}
  const list = parsed.success ? (parsed.data as FsFile[]) : []
  for (const file of list) {
    const path = tryNormalizeFsPath(file.path)
    if (!path) continue
    const ownerId = normalizeOwnerId(file.conversationId, defaultConversationId)
    const workspace = byConversation[ownerId] ?? emptyWorkspace()
    workspace.files[path] = {
      ...file,
      path,
      name: fsBaseName(path),
      conversationId: ownerId === LEGACY_WORKSPACE_ID ? undefined : ownerId,
    }
    byConversation[ownerId] = workspace
  }

  if (migrated && typeof localStorage !== 'undefined') {
    persistWorkspaces(byConversation)
    removeKey(KEYS.fsLegacy)
  }
  return byConversation
}

function stateWorkspace(state: Pick<FsState, 'workspaces' | 'currentConversationId'>, conversationId?: string): FsWorkspace {
  const ownerId = conversationId ?? state.currentConversationId
  return workspaceFor(state.workspaces, ownerId)
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface FsSearchHit {
  file: FsFile
  pathMatch: boolean
  lines: { line: number; text: string }[]
}

export interface FsWorkspaceSnapshot {
  conversationId: string
  files: Record<string, FsFile>
  deletedRemotes: Record<string, RemoteSource>
  selectedPath: string | null
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
  /** Current conversation's files, keyed by normalized path (convenience projection). */
  files: Record<string, FsFile>
  /** All isolated conversation workspaces, keyed by conversation id. */
  workspaces: Record<string, FsWorkspace>
  /** Conversation whose workspace is currently projected in `files`. */
  currentConversationId: string
  /** Files with an upstream Git remote that were deleted in the current workspace. */
  deletedRemotes: Record<string, RemoteSource>
  /** Path currently open in the Files workspace drawer. */
  selectedPath: string | null
  /** Filter/search query in the Files workspace drawer. */
  filter: string

  /* Conversation workspace management */
  setCurrentConversation: (conversationId: string) => void
  forkWorkspace: (sourceConversationId: string, targetConversationId: string) => void
  getWorkspace: (conversationId?: string) => FsWorkspaceSnapshot
  listAllFiles: () => FsFile[]
  getDeletedRemotes: (conversationId?: string) => Record<string, RemoteSource>

  /* File system operations (default to the current conversation) */
  writeFile: (path: string, content: string, opts?: WriteFileOptions) => FsFile
  appendFile: (path: string, content: string, opts?: WriteFileOptions) => FsFile
  readFile: (path: string, conversationId?: string) => FsFile | undefined
  exists: (path: string, conversationId?: string) => boolean
  deleteFile: (path: string, conversationId?: string) => boolean
  deleteDirectory: (dirPath: string, conversationId?: string) => number
  moveFile: (fromPath: string, toPath: string, source?: ArtifactSource, conversationId?: string) => FsFile | null
  listFiles: (dirPrefix?: string, conversationId?: string) => FsFile[]
  search: (query: string, conversationId?: string) => FsSearchHit[]

  /* Agent & Artifact bridge */
  applyAgentOutput: (
    markdown: string,
    meta: {
      source: ArtifactSource
      conversationId?: string
      messageId?: string
    },
  ) => FsOpRecord[]
  saveArtifact: (artifact: Artifact, targetPath?: string, conversationId?: string) => FsFile | null
  toArtifact: (path: string, conversationId?: string) => Artifact | null
  attachFile: (path: string, opts?: { silent?: boolean; conversationId?: string }) => Artifact | null
  setFileRemote: (path: string, remote: RemoteSource, dirty: boolean, conversationId?: string) => boolean

  /* Bulk, Git sync & UI state */
  markSyncedWithRemote: (
    repo: string,
    ref: string,
    committedPaths: readonly string[],
    fileShas?: Record<string, string>,
    deletedPaths?: readonly string[],
    conversationId?: string,
  ) => void
  importFiles: (entries: FsFile[], conversationId?: string) => void
  clearWorkspace: (conversationId?: string) => void
  clearAll: () => void
  selectFile: (path: string | null, conversationId?: string) => void
  setFilter: (v: string) => void
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

const chatAtStartup = useChat.getState()
const initialConversationId = chatAtStartup.currentId || LEGACY_WORKSPACE_ID
const initialWorkspaces = hydrateWorkspaces(initialConversationId)
const initialWorkspace = workspaceFor(initialWorkspaces, initialConversationId)

export const useFs = create<FsState>((set, get) => {
  const updateWorkspace = (
    conversationId: string,
    update: (workspace: FsWorkspace) => FsWorkspace,
    persist = true,
  ) => {
    set((state) => {
      const nextWorkspace = update(workspaceFor(state.workspaces, conversationId))
      const workspaces = { ...state.workspaces, [conversationId]: nextWorkspace }
      if (persist) persistWorkspaces(workspaces)
      return state.currentConversationId === conversationId
        ? {
            workspaces,
            files: nextWorkspace.files,
            deletedRemotes: nextWorkspace.deletedRemotes,
            selectedPath: nextWorkspace.selectedPath,
          }
        : { workspaces }
    })
  }

  return {
    files: initialWorkspace.files,
    workspaces: initialWorkspaces,
    currentConversationId: initialConversationId,
    deletedRemotes: initialWorkspace.deletedRemotes,
    selectedPath: initialWorkspace.selectedPath,
    filter: '',

    setCurrentConversation: (rawConversationId) => {
      const conversationId = rawConversationId || LEGACY_WORKSPACE_ID
      set((state) => {
        let workspaces = state.workspaces
        // If the app had no conversation when it loaded, carry any old
        // unscoped files into the first real chat rather than hiding them.
        if (conversationId !== LEGACY_WORKSPACE_ID && state.currentConversationId === LEGACY_WORKSPACE_ID) {
          const legacy = workspaces[LEGACY_WORKSPACE_ID]
          if (legacy && (Object.keys(legacy.files).length > 0 || Object.keys(legacy.deletedRemotes).length > 0)) {
            const target = workspaceFor(workspaces, conversationId)
            const files = { ...legacy.files, ...target.files }
            for (const [path, file] of Object.entries(files)) {
              files[path] = { ...file, conversationId }
            }
            workspaces = {
              ...workspaces,
              [conversationId]: {
                ...target,
                files,
                deletedRemotes: { ...legacy.deletedRemotes, ...target.deletedRemotes },
              },
              [LEGACY_WORKSPACE_ID]: emptyWorkspace(),
            }
            persistWorkspaces(workspaces)
          }
        }
        const workspace = workspaceFor(workspaces, conversationId)
        return {
          workspaces,
          currentConversationId: conversationId,
          files: workspace.files,
          deletedRemotes: workspace.deletedRemotes,
          selectedPath: workspace.selectedPath,
        }
      })
    },

    forkWorkspace: (sourceConversationId, targetConversationId) => {
      if (!targetConversationId || sourceConversationId === targetConversationId) return
      set((state) => {
        const source = workspaceFor(state.workspaces, sourceConversationId)
        const existingTarget = workspaceFor(state.workspaces, targetConversationId)
        const files = { ...source.files, ...existingTarget.files }
        for (const [path, file] of Object.entries(files)) {
          files[path] = { ...file, conversationId: targetConversationId }
        }
        const workspaces = {
          ...state.workspaces,
          [targetConversationId]: {
            ...existingTarget,
            files,
            deletedRemotes: { ...source.deletedRemotes, ...existingTarget.deletedRemotes },
            selectedPath: null,
          },
        }
        persistWorkspaces(workspaces)
        const target = workspaces[state.currentConversationId]
        return state.currentConversationId === targetConversationId && target
          ? { workspaces, files: target.files, deletedRemotes: target.deletedRemotes, selectedPath: target.selectedPath }
          : { workspaces }
      })
    },

    getWorkspace: (conversationId) => {
      const state = get()
      const ownerId = conversationId ?? state.currentConversationId
      const workspace = workspaceFor(state.workspaces, ownerId)
      return {
        conversationId: ownerId,
        files: workspace.files,
        deletedRemotes: workspace.deletedRemotes,
        selectedPath: workspace.selectedPath,
      }
    },

    listAllFiles: () =>
      Object.entries(get().workspaces)
        .flatMap(([conversationId, workspace]) =>
          Object.values(workspace.files).map((file) => ({
            ...file,
            conversationId: conversationId === LEGACY_WORKSPACE_ID ? undefined : conversationId,
          })),
        )
        .sort(
          (a, b) =>
            (a.conversationId ?? '').localeCompare(b.conversationId ?? '') || a.path.localeCompare(b.path),
        ),

    getDeletedRemotes: (conversationId) => {
      const state = get()
      return stateWorkspace(state, conversationId).deletedRemotes
    },

    writeFile: (rawPath, content, opts) => {
      const path = normalizeFsPath(rawPath)
      const encoding: FsFileEncoding = opts?.encoding ?? 'utf8'
      const size = byteSizeOf(content, encoding)
      if (size > MAX_FS_FILE_BYTES) {
        throw new FsError('too_large', `File "${path}" exceeds the 5 MB local file system limit.`, path)
      }

      const state = get()
      const conversationId = opts?.conversationId ?? state.currentConversationId
      const workspace = workspaceFor(state.workspaces, conversationId)
      const name = fsBaseName(path)
      const mime = opts?.mime || mimeFromName(name, encoding === 'base64' ? 'application/octet-stream' : 'text/plain')
      const kind = classifyArtifact(name, mime)
      const now = Date.now()
      const source: ArtifactSource = opts?.source ?? { origin: 'user' }
      const existing = workspace.files[path]
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
        conversationId: conversationId === LEGACY_WORKSPACE_ID ? undefined : conversationId,
        messageId: opts?.messageId ?? existing?.messageId,
        remote,
        dirty,
      }

      updateWorkspace(conversationId, (current) => {
        const next = { ...current.files, [path]: file }
        const nextDeleted = { ...current.deletedRemotes }
        delete nextDeleted[path]
        return { ...current, files: next, deletedRemotes: nextDeleted }
      })

      if (opts?.syncArtifact) {
        const artifact = buildArtifactForFsFile(file)
        useArtifacts.getState().add(artifact)
      }

      return file
    },

    appendFile: (rawPath, extraContent, opts) => {
      const path = normalizeFsPath(rawPath)
      const state = get()
      const conversationId = opts?.conversationId ?? state.currentConversationId
      const existing = workspaceFor(state.workspaces, conversationId).files[path]
      let combined = extraContent
      if (existing && existing.encoding !== 'base64') {
        const sep =
          existing.content.length === 0 || existing.content.endsWith('\n') || extraContent.startsWith('\n')
            ? ''
            : '\n'
        combined = `${existing.content}${sep}${extraContent}`
      }
      return get().writeFile(path, combined, { ...opts, conversationId })
    },

    readFile: (rawPath, conversationId) => {
      const path = tryNormalizeFsPath(rawPath)
      if (!path) return undefined
      const state = get()
      return workspaceFor(state.workspaces, conversationId ?? state.currentConversationId).files[path]
    },

    exists: (rawPath, conversationId) => {
      const path = tryNormalizeFsPath(rawPath)
      if (!path) return false
      const state = get()
      const files = workspaceFor(state.workspaces, conversationId ?? state.currentConversationId).files
      return Object.prototype.hasOwnProperty.call(files, path)
    },

    deleteFile: (rawPath, conversationId) => {
      const path = tryNormalizeFsPath(rawPath)
      if (!path) return false
      const state = get()
      const ownerId = conversationId ?? state.currentConversationId
      const workspace = workspaceFor(state.workspaces, ownerId)
      if (!Object.prototype.hasOwnProperty.call(workspace.files, path)) return false
      updateWorkspace(ownerId, (current) => {
        const next = { ...current.files }
        const nextDeleted = { ...current.deletedRemotes }
        const removed = next[path]
        if (removed?.remote) nextDeleted[path] = removed.remote
        delete next[path]
        return {
          ...current,
          files: next,
          deletedRemotes: nextDeleted,
          selectedPath: current.selectedPath === path ? null : current.selectedPath,
        }
      })
      return true
    },

    deleteDirectory: (rawDirPath, conversationId) => {
      const dir = tryNormalizeFsPath(rawDirPath)
      if (!dir) return 0
      const state = get()
      const ownerId = conversationId ?? state.currentConversationId
      const workspace = workspaceFor(state.workspaces, ownerId)
      const prefix = `${dir}/`
      const toRemove = Object.keys(workspace.files).filter((path) => path === dir || path.startsWith(prefix))
      if (toRemove.length === 0) return 0
      updateWorkspace(ownerId, (current) => {
        const next = { ...current.files }
        const nextDeleted = { ...current.deletedRemotes }
        for (const path of toRemove) {
          const removed = next[path]
          if (removed?.remote) nextDeleted[path] = removed.remote
          delete next[path]
        }
        const clearSelection =
          current.selectedPath && (current.selectedPath === dir || current.selectedPath.startsWith(prefix))
        return {
          ...current,
          files: next,
          deletedRemotes: nextDeleted,
          selectedPath: clearSelection ? null : current.selectedPath,
        }
      })
      return toRemove.length
    },

    moveFile: (fromRawPath, toRawPath, source, conversationId) => {
      const fromPath = tryNormalizeFsPath(fromRawPath)
      const toPath = tryNormalizeFsPath(toRawPath)
      if (!fromPath || !toPath) return null
      const state = get()
      const ownerId = conversationId ?? state.currentConversationId
      const workspace = workspaceFor(state.workspaces, ownerId)
      const existing = workspace.files[fromPath]
      if (!existing) return null
      if (fromPath === toPath) return existing

      const toName = fsBaseName(toPath)
      const mime = mimeFromName(toName, existing.mime)
      const kind = classifyArtifact(toName, mime)
      const targetExisting = workspace.files[toPath]
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

      updateWorkspace(ownerId, (current) => {
        const next = { ...current.files }
        const nextDeleted = { ...current.deletedRemotes }
        if (existing.remote) nextDeleted[fromPath] = existing.remote
        delete nextDeleted[toPath]
        delete next[fromPath]
        next[toPath] = moved
        return {
          ...current,
          files: next,
          deletedRemotes: nextDeleted,
          selectedPath: current.selectedPath === fromPath ? toPath : current.selectedPath,
        }
      })
      return moved
    },

    listFiles: (dirPrefix, conversationId) => {
      const state = get()
      const files = Object.values(
        workspaceFor(state.workspaces, conversationId ?? state.currentConversationId).files,
      ).sort((a, b) => a.path.localeCompare(b.path))
      if (!dirPrefix) return files
      const norm = tryNormalizeFsPath(dirPrefix)
      if (!norm) return []
      const prefix = `${norm}/`
      return files.filter((file) => file.path === norm || file.path.startsWith(prefix))
    },

    search: (query, conversationId) => {
      const q = query.trim().toLowerCase()
      if (!q) return []
      const hits: FsSearchHit[] = []
      const sorted = get().listFiles(undefined, conversationId)
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
        if (pathMatch || lines.length > 0) hits.push({ file, pathMatch, lines })
      }
      return hits
    },

    applyAgentOutput: (markdown, meta) => {
      const actions = extractFsActions(markdown)
      if (actions.length === 0) return []
      const conversationId = meta.conversationId ?? get().currentConversationId
      const records: FsOpRecord[] = []

      for (const action of actions) {
        const at = Date.now()
        try {
          if (action.op === 'write') {
            const existed = get().exists(action.path, conversationId)
            // Skip no-op writes when the exact content is already stored in this chat's workspace.
            const prev = get().readFile(action.path, conversationId)
            if (prev && prev.encoding !== 'base64' && prev.content === action.content) {
              useArtifacts.getState().add(buildArtifactForFsFile(prev))
              continue
            }
            const written = get().writeFile(action.path, action.content, {
              source: meta.source,
              conversationId,
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
            const existed = get().exists(action.path, conversationId)
            const written = get().appendFile(action.path, action.content, {
              source: meta.source,
              conversationId,
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
            const deleted = get().deleteFile(action.path, conversationId)
            if (deleted) records.push({ op: 'delete', path: action.path, at })
          } else if (action.op === 'move') {
            const moved = get().moveFile(action.fromPath, action.toPath, meta.source, conversationId)
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

    saveArtifact: (artifact, targetPath, conversationId) => {
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
          conversationId: conversationId ?? get().currentConversationId,
          syncArtifact: true,
        })
        return saved
      } catch {
        return null
      }
    },

    toArtifact: (rawPath, conversationId) => {
      const file = get().readFile(rawPath, conversationId)
      if (!file) return null
      const artifact = buildArtifactForFsFile(file)
      useArtifacts.getState().add(artifact)
      return artifact
    },

    attachFile: (rawPath, opts) => {
      const artifact = get().toArtifact(rawPath, opts?.conversationId)
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

    setFileRemote: (rawPath, remote, dirty, conversationId) => {
      const path = tryNormalizeFsPath(rawPath)
      if (!path) return false
      const state = get()
      const ownerId = conversationId ?? state.currentConversationId
      const workspace = workspaceFor(state.workspaces, ownerId)
      const file = workspace.files[path]
      if (!file) return false
      updateWorkspace(ownerId, (current) => ({
        ...current,
        files: { ...current.files, [path]: { ...file, remote, dirty } },
      }))
      return true
    },

    markSyncedWithRemote: (repo, ref, committedPaths, fileShas, deletedPaths, conversationId) => {
      const ownerId = conversationId ?? get().currentConversationId
      updateWorkspace(ownerId, (workspace) => {
        const next = { ...workspace.files }
        for (const rawPath of committedPaths) {
          const path = tryNormalizeFsPath(rawPath)
          if (!path || !next[path]) continue
          const current = next[path]!
          const sha = fileShas?.[path] ?? current.remote?.sha
          const url = `https://github.com/${repo}/blob/${encodeURIComponent(ref)}/${path
            .split('/')
            .map(encodeURIComponent)
            .join('/')}`
          next[path] = {
            ...current,
            remote: { kind: 'github', repo, ref, path, url, sha },
            dirty: false,
          }
        }
        const nextDeleted = { ...workspace.deletedRemotes }
        for (const deletedPath of deletedPaths ?? []) {
          const norm = tryNormalizeFsPath(deletedPath)
          if (norm) delete nextDeleted[norm]
        }
        return { ...workspace, files: next, deletedRemotes: nextDeleted }
      })
    },

    importFiles: (entries, conversationId) => {
      const state = get()
      const fallbackId = conversationId ?? state.currentConversationId
      set((current) => {
        const workspaces = { ...current.workspaces }
        for (const file of entries) {
          const path = tryNormalizeFsPath(file.path)
          if (!path) continue
          const ownerId = normalizeOwnerId(file.conversationId, fallbackId)
          const workspace = workspaceFor(workspaces, ownerId)
          workspaces[ownerId] = {
            ...workspace,
            files: {
              ...workspace.files,
              [path]: {
                ...file,
                path,
                name: fsBaseName(path),
                conversationId: ownerId === LEGACY_WORKSPACE_ID ? undefined : ownerId,
              },
            },
          }
        }
        persistWorkspaces(workspaces)
        const active = workspaceFor(workspaces, current.currentConversationId)
        return {
          workspaces,
          files: active.files,
          deletedRemotes: active.deletedRemotes,
          selectedPath: active.selectedPath,
        }
      })
    },

    clearWorkspace: (conversationId) => {
      const state = get()
      const ownerId = conversationId ?? state.currentConversationId
      updateWorkspace(ownerId, () => emptyWorkspace())
    },

    clearAll: () => {
      set((state) => ({
        workspaces: {},
        files: {},
        deletedRemotes: {},
        selectedPath: null,
        currentConversationId: state.currentConversationId,
      }))
      saveJSON(KEYS.fs, [])
      removeKey(KEYS.fsLegacy)
    },

    selectFile: (path, conversationId) => {
      const state = get()
      const ownerId = conversationId ?? state.currentConversationId
      const norm = path ? tryNormalizeFsPath(path) : null
      updateWorkspace(ownerId, (workspace) => ({ ...workspace, selectedPath: norm }), false)
    },

    setFilter: (value) => set({ filter: value }),
  }
})

// Keep the drawer's convenience projection in sync when the selected chat changes.
useChat.subscribe((state, previous) => {
  if (state.currentId !== previous.currentId) useFs.getState().setCurrentConversation(state.currentId)
})
