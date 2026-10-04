import { create } from 'zustand'
import type { Artifact, ArtifactSource, FsFile, FsOpRecord } from '../types'
import { useShell } from '../lib/shell'
import { extractFsActions, formatFsContextForAgent, fsBaseName } from '../lib/fs'
import { classifyArtifact, mimeFromName } from '../lib/mime'
import { useArtifacts } from './artifacts'
import { uid } from '../lib/id'

export interface DiskEntry { path: string; size: number; updatedAt: number }
export interface DiskFile extends FsFile { revision: string }
export class DiskError extends Error { constructor(public status: number, message: string) { super(message) } }
export type WorkspaceSession = { token: string; root: string; observedFiles?: Record<string, DiskFile> }
export const workspaceSession = (): WorkspaceSession => ({ token: useShell.getState().token, root: useShell.getState().root })
export function assertWorkspaceSession(session: WorkspaceSession) {
  const now = useShell.getState()
  if (now.token !== session.token || now.root !== session.root) throw new Error('Workspace connection changed. Retry the operation in the intended workspace.')
}
export const useDiskFs = create<{
  entries: DiskEntry[]; files: Record<string, DiskFile>; selectedPath: string | null; truncated: boolean; revision: number
}>(() => ({ entries: [], files: {}, selectedPath: null, truncated: false, revision: 0 }))

useShell.subscribe((state, previous) => {
  if (state.token !== previous.token || state.root !== previous.root) useDiskFs.setState({ entries: [], files: {}, selectedPath: null, truncated: false, revision: 0 })
})

async function api<T>(path: string, body?: unknown, session = workspaceSession()): Promise<T> {
  assertWorkspaceSession(session)
  if (!session.token) throw new DiskError(503, 'Disk workspace is disconnected.')
  const response = await fetch(`/api/shell/files/${path}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${session.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  })
  const value = await response.json().catch(() => ({ error: 'Invalid disk backend response.' }))
  assertWorkspaceSession(session)
  if (!response.ok) throw new DiskError(response.status, value.error || `Disk request failed (${response.status}).`)
  return value as T
}

function decodeFile(value: { path: string; content: string; encoding: 'utf8' | 'base64'; size: number; updatedAt: number; revision: string }, source: ArtifactSource = { origin: 'user' }): DiskFile {
  const name = fsBaseName(value.path)
  const mime = mimeFromName(name, value.encoding === 'utf8' ? 'text/plain' : 'application/octet-stream')
  return { ...value, name, mime, kind: classifyArtifact(name, mime), createdAt: value.updatedAt, createdBy: source, updatedBy: source, version: 1 }
}
function remember(file: DiskFile) {
  useDiskFs.setState((s) => ({ files: { ...s.files, [file.path]: file }, entries: [...s.entries.filter((e) => e.path !== file.path), { path: file.path, size: file.size, updatedAt: file.updatedAt }].sort((a, b) => a.path.localeCompare(b.path)), revision: s.revision + 1 }))
  return file
}
export async function refreshDiskTree(session = workspaceSession()) {
  const tree = await api<{ files: DiskEntry[]; truncated: boolean }>('tree', undefined, session)
  useDiskFs.setState((s) => ({ entries: tree.files, truncated: tree.truncated, files: Object.fromEntries(Object.entries(s.files).filter(([path, f]) => tree.files.some((e) => e.path === path && e.updatedAt === f.updatedAt && e.size === f.size))), revision: s.revision + 1 }))
  return tree.files
}
export async function readDiskFile(path: string, session = workspaceSession()): Promise<DiskFile> {
  return remember(decodeFile(await api(`read?path=${encodeURIComponent(path)}`, undefined, session)))
}
export async function maybeReadDiskFile(path: string, session = workspaceSession()): Promise<DiskFile | null> {
  try { return await readDiskFile(path, session) } catch (error) { if (error instanceof DiskError && error.status === 404) return null; throw error }
}
export async function writeDiskFile(path: string, content: string, encoding: 'utf8' | 'base64', expectedRevision: string | null, source?: ArtifactSource, session = workspaceSession()) {
  return remember(decodeFile(await api('change', { op: 'write', path, content, encoding, expectedRevision }, session), source))
}
export async function deleteDiskFile(file: DiskFile, session = workspaceSession()) {
  await api('change', { op: 'delete', path: file.path, expectedRevision: file.revision }, session)
  useDiskFs.setState((s) => { const files = { ...s.files }; delete files[file.path]; return { files, entries: s.entries.filter((e) => e.path !== file.path), selectedPath: s.selectedPath === file.path ? null : s.selectedPath, revision: s.revision + 1 } })
}
export async function moveDiskFile(file: DiskFile, toPath: string, session = workspaceSession()) {
  const moved = decodeFile(await api('change', { op: 'move', path: file.path, toPath, expectedRevision: file.revision }, session))
  useDiskFs.setState((s) => { const files = { ...s.files }; delete files[file.path]; return { files, entries: s.entries.filter((e) => e.path !== file.path), selectedPath: toPath } })
  return remember(moved)
}
export function diskArtifact(file: DiskFile): Artifact {
  const artifact: Artifact = { id: uid('art_disk'), name: file.name, kind: file.kind, mime: file.mime, size: file.size, createdAt: Date.now(), provenance: file.updatedBy, localPath: file.path,
    text: file.encoding === 'utf8' ? file.content : undefined,
    dataURL: file.encoding === 'base64' ? `data:${file.mime};base64,${file.content}` : undefined }
  useArtifacts.getState().add(artifact)
  return artifact
}

export async function diskWorkspaceContext(query: string, session = workspaceSession()): Promise<string> {
  const entries = await refreshDiskTree(session)
  const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 2)
  const ranked = [...entries].sort((a, b) => {
    const score = (path: string) => (/readme|roadmap|milestones|package.json/i.test(path) ? 5 : 0) + terms.filter((t) => path.toLowerCase().includes(t)).length
    return score(b.path) - score(a.path)
  })
  const files: DiskFile[] = []
  let bytes = 0
  for (const entry of ranked.slice(0, 20)) {
    if (entry.size > 32_000 || bytes + entry.size > 64_000) continue
    const file = await readDiskFile(entry.path, session)
    if (file.encoding === 'utf8') { files.push(file); bytes += file.size }
  }
  session.observedFiles = Object.fromEntries(files.map((file) => [file.path, file]))
  return `CONNECTED DISK WORKSPACE: ${JSON.stringify(session.root)}. This is the same checkout used by bash and the Files panel; all conversations share it. Browser workspace files are inactive and are NOT imported automatically. Filename-tagged file blocks and write/append/move/delete directives persist to this disk checkout after your response. Use bash for other operations. Do not repeat already-applied writes or append/move/delete operations in later summaries. fs:pull is unavailable in disk mode; use git via bash or the reviewed browser import.\n\nDisk file listing${useDiskFs.getState().truncated || entries.length > 1000 ? ' (truncated)' : ''}:\n${entries.slice(0, 1000).map((f) => `${f.path} (${f.size} bytes)`).join('\n')}\n\n${formatFsContextForAgent(files, { queryHint: query, maxFileChars: 32_000, maxTotalChars: 64_000 })}`
}

export async function applyDiskAgentOutput(markdown: string, source: ArtifactSource, session = workspaceSession(), alreadyApplied = new Set<string>(), signal?: AbortSignal): Promise<FsOpRecord[]> {
  assertWorkspaceSession(session)
  const records: FsOpRecord[] = []
  // Capture cached revisions before refresh/read so stale generated edits conflict.
  const baseline: Record<string, DiskFile | undefined> = { ...(session.observedFiles ?? useDiskFs.getState().files) }
  for (const action of extractFsActions(markdown)) {
    signal?.throwIfAborted()
    if (alreadyApplied.has(JSON.stringify(action))) continue
    assertWorkspaceSession(session)
    if (action.op === 'pull') throw new Error('fs:pull is not supported in disk mode. Use bash/git or reviewed browser import.')
    const path = action.op === 'move' ? action.fromPath : action.path
    const currentDisk = await maybeReadDiskFile(path, session)
    // When a model had a context snapshot, never replace an existing file it
    // wasn't shown merely because a UI read populated the shared cache later.
    if (session.observedFiles && !baseline[path] && currentDisk) {
      if (action.op === 'write' && currentDisk.encoding === 'utf8' && currentDisk.content === action.content) continue
      throw new Error(`Disk file ${path} was not included in the model's file context. Inspect/edit it with bash instead of overwriting it blindly.`)
    }
    const previous = baseline[path] ?? currentDisk
    signal?.throwIfAborted()
    if (action.op === 'delete') {
      if (previous) { await deleteDiskFile(previous, session); records.push({ op: 'delete', path, at: Date.now() }); delete baseline[path] }
    } else if (action.op === 'move') {
      if (!previous) throw new Error(`Cannot move missing disk file: ${path}`)
      const moved = await moveDiskFile(previous, action.toPath, session)
      delete baseline[path]; baseline[moved.path] = moved
      records.push({ op: 'move', fromPath: path, path: moved.path, at: Date.now() })
    } else {
      if (action.op === 'append' && previous?.encoding === 'base64') throw new Error(`Cannot append text to binary file: ${path}`)
      const content = action.op === 'append' ? (previous?.content ?? '') + action.content : action.content
      // Still verify on disk before treating repeated writes as no-ops.
      const current = await maybeReadDiskFile(path, session)
      if (current?.encoding === 'utf8' && current.content === content) { baseline[path] = current; continue }
      signal?.throwIfAborted()
      const written = await writeDiskFile(path, content, 'utf8', previous?.revision ?? null, source, session)
      baseline[path] = written
      records.push({ op: previous ? 'update' : 'create', path, size: written.size, at: Date.now() })
    }
  }
  if (session.observedFiles) session.observedFiles = Object.fromEntries(Object.entries(baseline).filter((entry): entry is [string, DiskFile] => Boolean(entry[1])))
  return records
}


export interface DiskImportRow { file: FsFile; disk: DiskFile | null; selected: boolean; identical: boolean; result?: string }
/** Read-only review: conflicts are never selected automatically. */
export async function reviewDiskImport(files: FsFile[], session = workspaceSession()): Promise<DiskImportRow[]> {
  const rows: DiskImportRow[] = []
  for (const file of files) {
    try {
      const disk = await maybeReadDiskFile(file.path, session)
      const identical = Boolean(disk && disk.content === file.content && disk.encoding === (file.encoding ?? 'utf8'))
      rows.push({ file: { ...file }, disk, identical, selected: !disk })
    } catch (cause) {
      rows.push({ file: { ...file }, disk: null, identical: false, selected: false, result: `Cannot import: ${cause instanceof Error ? cause.message : 'Review failed'}` })
    }
  }
  return rows
}
