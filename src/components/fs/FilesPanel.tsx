import { useMemo, useRef, useState } from 'react'
import type { FsFile } from '../../types'
import { useFs } from '../../store/fs'
import { useGitHub } from '../../store/github'
import { useSettings } from '../../store/settings'
import { useUI } from '../../store/ui'
import { formatBytes } from '../../lib/format'
import { parseCSV } from '../../lib/csv'
import { downloadUrl } from '../../lib/clipboard'
import { guessLanguage } from '../../lib/github'
import { buildFsTree, fsExt, isFsError, type FsDirNode } from '../../lib/fs'
import { fileToDataURL } from '../../store/artifacts'
import { createFsArchive, readFsArchive } from '../../lib/fs-archive'
import { CodeArtifact } from '../artifacts/CodeArtifact'
import { SheetTable } from '../artifacts/SheetTable'
import { Markdown } from '../chat/Markdown'
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCode,
  IconDownload,
  IconArchiveExport,
  IconArchiveRestore,
  IconExternal,
  IconFile,
  IconFileText,
  IconFolder,
  IconGitCommit,
  IconGithub,
  IconImage,
  IconPaperclip,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTable,
  IconTrash,
  IconUpload,
  IconX,
} from '../icons'

function FileKindIcon({ file }: { file: FsFile }) {
  const ext = fsExt(file.path)
  const icon = file.kind === 'image'
    ? <IconImage size={13} />
    : file.kind === 'sheet' || ext === 'csv' || ext === 'tsv'
      ? <IconTable size={13} />
      : file.kind === 'code'
        ? <IconCode size={13} />
        : file.kind === 'doc'
          ? <IconFileText size={13} />
          : <IconFile size={13} />
  return <span className={`fs-kind-icon ${file.kind}`}>{icon}</span>
}

/**
 * Local file system workspace drawer: inspect files stored by agents, create or
 * upload files, edit them in place, attach them to the composer, or publish
 * them to GitHub.
 */
export function FilesPanel() {
  const open = useUI((s) => s.filesOpen)
  const close = useUI((s) => s.closeFiles)
  const closeAndFocus = () => {
    close()
    document.querySelector<HTMLButtonElement>('[data-panel-toggle="files"]')?.focus()
  }
  const openSettings = useUI((s) => s.openSettings)
  const openPublish = useUI((s) => s.openPublish)
  const toast = useUI((s) => s.toast)

  const filesMap = useFs((s) => s.files)
  const deletedRemotes = useFs((s) => s.deletedRemotes)
  const selectedPath = useFs((s) => s.selectedPath)
  const filter = useFs((s) => s.filter)
  const useLocalFs = useSettings((s) => s.s.agent.useLocalFs ?? true)

  const ghToken = useGitHub((s) => s.token)
  const activeRepo = useGitHub((s) => s.activeRepo)
  const activeBranch = useGitHub((s) => s.activeBranch)
  const ghTree = useGitHub((s) => s.tree)
  const ghPublishing = useGitHub((s) => s.publishing)

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [newContent, setNewContent] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  const [committing, setCommitting] = useState(false)
  const [commitRepo, setCommitRepo] = useState('')
  const [commitBranch, setCommitBranch] = useState('')
  const [commitNewBranch, setCommitNewBranch] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const [pullingRepo, setPullingRepo] = useState(false)

  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [rawView, setRawView] = useState(false)
  const [archiveBusy, setArchiveBusy] = useState<'export' | 'import' | null>(null)
  const [archiveProgress, setArchiveProgress] = useState(0)
  const uploadRef = useRef<HTMLInputElement>(null)
  const archiveRef = useRef<HTMLInputElement>(null)

  const files = useMemo(
    () => Object.values(filesMap).sort((a, b) => a.path.localeCompare(b.path)),
    [filesMap],
  )
  const totalBytes = useMemo(() => files.reduce((acc, f) => acc + f.size, 0), [files])
  const deletedCount = useMemo(() => Object.keys(deletedRemotes).length, [deletedRemotes])
  const dirtyCount = useMemo(
    () => files.filter((f) => f.dirty || !f.remote).length + deletedCount,
    [files, deletedCount],
  )
  const treeRoot = useMemo(() => buildFsTree(files), [files])
  const searchHits = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return null
    const hits: { file: FsFile; lines: { line: number; text: string }[] }[] = []
    for (const file of files) {
      const pathMatch = file.path.toLowerCase().includes(q)
      const lines: { line: number; text: string }[] = []
      if (file.encoding === 'utf8' && file.content) {
        const rawLines = file.content.split(/\r?\n/)
        for (let i = 0; i < rawLines.length; i++) {
          const lineText = rawLines[i]!
          if (lineText.toLowerCase().includes(q)) {
            lines.push({ line: i + 1, text: lineText.slice(0, 200) })
            if (lines.length >= 6) break
          }
        }
      }
      if (pathMatch || lines.length > 0) {
        hits.push({ file, lines })
      }
    }
    return hits
  }, [filter, files])

  if (!open) return null

  const selectedFile = selectedPath ? filesMap[selectedPath] : undefined

  const openFile = (path: string) => {
    useFs.getState().selectFile(path)
    setEditing(false)
    setRenaming(false)
  }

  const startEdit = (file: FsFile) => {
    setEditDraft(file.content)
    setEditing(true)
    setRenaming(false)
  }

  const saveEdit = () => {
    if (!selectedFile) return
    useFs.getState().writeFile(selectedFile.path, editDraft, {
      source: { origin: 'user' },
      syncArtifact: true,
    })
    setEditing(false)
    toast({ kind: 'success', title: `Saved ${selectedFile.path}` })
  }

  const startRename = (file: FsFile) => {
    setRenameDraft(file.path)
    setRenaming(true)
    setEditing(false)
  }

  const saveRename = () => {
    if (!selectedFile) return
    const target = renameDraft.trim()
    if (!target || target === selectedFile.path) {
      setRenaming(false)
      return
    }
    const moved = useFs.getState().moveFile(selectedFile.path, target, { origin: 'user' })
    if (!moved) {
      toast({ kind: 'error', title: 'Invalid file path', detail: target })
      return
    }
    setRenaming(false)
    toast({ kind: 'success', title: `Moved to ${moved.path}` })
  }

  const createNewFile = () => {
    setCreateError(null)
    try {
      const created = useFs.getState().writeFile(newPath, newContent, {
        source: { origin: 'user' },
        syncArtifact: true,
      })
      setCreating(false)
      setNewPath('')
      setNewContent('')
      useFs.getState().selectFile(created.path)
      toast({ kind: 'success', title: `Created ${created.path}` })
    } catch (err) {
      setCreateError(isFsError(err) ? err.message : err instanceof Error ? err.message : String(err))
    }
  }

  const handleUpload = async (fileList: FileList | null) => {
    if (!fileList?.length) return
    let count = 0
    for (const f of Array.from(fileList)) {
      try {
        const isText =
          f.type.startsWith('text/') ||
          f.type === 'application/json' ||
          /\.(ts|tsx|js|jsx|json|py|rs|go|java|c|h|cpp|sh|sql|yml|yaml|toml|md|txt|csv|html|css|svg|xml)$/i.test(
            f.name,
          )
        if (isText) {
          const text = await f.text()
          const saved = useFs.getState().writeFile(f.name, text, {
            mime: f.type || undefined,
            source: { origin: 'user' },
            syncArtifact: true,
          })
          useFs.getState().selectFile(saved.path)
          count++
        } else {
          const dataUrl = await fileToDataURL(f)
          const base64 = dataUrl.split(',')[1] ?? ''
          const saved = useFs.getState().writeFile(f.name, base64, {
            encoding: 'base64',
            mime: f.type || undefined,
            source: { origin: 'user' },
            syncArtifact: true,
          })
          useFs.getState().selectFile(saved.path)
          count++
        }
      } catch (err) {
        toast({
          kind: 'error',
          title: `Couldn't store ${f.name}`,
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (count > 0) {
      toast({
        kind: 'success',
        title: count === 1 ? '1 file stored in local FS' : `${count} files stored in local FS`,
      })
    }
  }

  const exportWorkspace = async () => {
    if (!files.length || archiveBusy) return
    setArchiveBusy('export')
    setArchiveProgress(0)
    try {
      const blob = await createFsArchive(files, setArchiveProgress)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `slade-workspace-${new Date().toISOString().slice(0, 10)}.zip`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
      toast({ kind: 'success', title: 'Workspace exported', detail: `${files.length} files · ${formatBytes(totalBytes)}` })
    } catch (err) {
      toast({ kind: 'error', title: 'Could not export workspace', detail: err instanceof Error ? err.message : String(err) })
    } finally {
      setArchiveBusy(null)
      setArchiveProgress(0)
    }
  }

  const importWorkspace = async (file: File | undefined) => {
    if (!file || archiveBusy) return
    setArchiveBusy('import')
    try {
      const archive = await readFsArchive(file)
      if (!archive.entries.length) {
        toast({
          kind: 'error',
          title: 'No importable files found',
          detail: archive.skippedUnsafe || archive.skippedLarge
            ? `${archive.skippedUnsafe} unsafe and ${archive.skippedLarge} oversized files skipped.`
            : 'The zip archive is empty.',
        })
        return
      }

      const existing = useFs.getState().files
      const conflicts = archive.entries.filter((entry) => Boolean(existing[entry.path])).length
      if (conflicts > 0 && !window.confirm(
        `This archive contains ${archive.entries.length} files, including ${conflicts} that already exist. Replace the existing files?`,
      )) return

      let imported = 0
      let failed = 0
      for (const entry of archive.entries) {
        try {
          useFs.getState().writeFile(entry.path, entry.content, {
            encoding: entry.encoding,
            mime: entry.mime,
            source: { origin: 'user' },
            syncArtifact: true,
          })
          imported++
        } catch {
          failed++
        }
      }
      const firstPath = archive.entries.find((entry) => useFs.getState().files[entry.path])?.path
      if (firstPath) useFs.getState().selectFile(firstPath)
      const skipped = archive.skippedUnsafe + archive.skippedLarge
      toast({
        kind: failed || skipped ? 'info' : 'success',
        title: `Imported ${imported} file${imported === 1 ? '' : 's'}`,
        detail: [
          conflicts ? `${conflicts} existing file${conflicts === 1 ? '' : 's'} replaced` : '',
          failed ? `${failed} files could not be stored` : '',
          skipped ? `${skipped} unsafe or oversized entries skipped` : '',
        ].filter(Boolean).join(' · ') || file.name,
      })
    } catch (err) {
      toast({ kind: 'error', title: 'Could not import zip archive', detail: err instanceof Error ? err.message : String(err) })
    } finally {
      setArchiveBusy(null)
      if (archiveRef.current) archiveRef.current.value = ''
    }
  }

  const downloadFile = (file: FsFile) => {
    const url =
      file.encoding === 'base64'
        ? `data:${file.mime};base64,${file.content}`
        : `data:${file.mime};charset=utf-8,${encodeURIComponent(file.content)}`
    downloadUrl(url, file.name)
  }

  const publishFile = (file: FsFile) => {
    const art = useFs.getState().toArtifact(file.path)
    if (art) openPublish({ kind: 'artifact', artifactId: art.id })
  }

  const toggleDir = (dirPath: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return next
    })
  }

  const renderDir = (node: FsDirNode, depth: number): React.ReactNode[] => {
    const rows: React.ReactNode[] = []
    if (node.path) {
      const isCollapsed = collapsed.has(node.path)
      rows.push(
        <li key={`d:${node.path}`}>
          <button
            className="gh-tree-row dir"
            style={{ paddingLeft: 8 + depth * 13 }}
            onClick={() => toggleDir(node.path)}
            aria-expanded={!isCollapsed}
            type="button"
          >
            {isCollapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
            <span className="gh-tree-name">{node.name}/</span>
          </button>
        </li>,
      )
      if (isCollapsed) return rows
    }

    for (const dir of node.dirs) {
      rows.push(...renderDir(dir, node.path ? depth + 1 : depth))
    }

    for (const file of node.files) {
      const isSelected = selectedPath === file.path
      const originLabel = file.updatedBy.origin === 'user' ? 'you' : file.updatedBy.modelLabel
      rows.push(
        <li key={`f:${file.path}`}>
          <div
            className={`gh-tree-row${isSelected ? ' active' : ''}`}
            style={{ paddingLeft: 8 + (node.path ? depth + 1 : depth) * 13 + 8 }}
          >
            <button
              className="gh-tree-open"
              onClick={() => openFile(file.path)}
              title={`${file.path} · v${file.version} · ${originLabel}`}
              type="button"
            >
              <FileKindIcon file={file} />
              <span className="gh-tree-name">{file.name}</span>
              {file.remote ? (
                <span
                  className={`fs-git-badge${file.dirty ? ' dirty' : ' synced'}`}
                  title={
                    file.dirty
                      ? `Modified locally since ${file.remote.repo}@${file.remote.ref}`
                      : `Synced with ${file.remote.repo}@${file.remote.ref}`
                  }
                >
                  {file.dirty ? 'M' : 'git'}
                </span>
              ) : null}
              {file.version > 1 ? <span className="fs-version-badge">v{file.version}</span> : null}
              <span className="gh-tree-size">{formatBytes(file.size)}</span>
            </button>
            <button
              className="icon-btn small"
              onClick={() => useFs.getState().attachFile(file.path)}
              aria-label={`Attach ${file.path} to the next message`}
              title="Attach to next message"
              type="button"
            >
              <IconPaperclip size={12} />
            </button>
            <button
              className="icon-btn small"
              onClick={() => {
                useFs.getState().deleteFile(file.path)
                toast({ kind: 'info', title: `Deleted ${file.path}` })
              }}
              aria-label={`Delete ${file.path}`}
              title="Delete file"
              type="button"
            >
              <IconTrash size={12} />
            </button>
          </div>
        </li>,
      )
    }
    return rows
  }

  return (
    <>
      <div className="gh-drawer-backdrop only-mobile" onClick={closeAndFocus} aria-hidden="true" />
      <aside className="github-drawer files-drawer" aria-label="Local file system">
        <header className="gh-head fs-drawer-head">
          <h2>
            <span className="fs-brand-mark"><IconFolder size={15} /></span> Workspace
          </h2>
          <span className="gh-identity">Local files</span>
          {files.length > 0 || deletedCount > 0 ? (
            <button
              className="btn ghost small"
              onClick={() => {
                setCommitting((c) => !c)
                setCommitRepo(activeRepo ?? useGitHub.getState().publishDefaults.repo ?? '')
                setCommitBranch(activeBranch ?? useGitHub.getState().publishDefaults.branch ?? '')
                setCommitMessage(
                  `Update ${dirtyCount || files.length} file${(dirtyCount || files.length) === 1 ? '' : 's'} (via Slade)`,
                )
              }}
              title="Commit local file system changes to a GitHub repository"
              type="button"
            >
              <IconGitCommit size={12} /> Commit{dirtyCount > 0 ? ` (${dirtyCount})` : ''}
            </button>
          ) : null}
          <input
            ref={uploadRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void handleUpload(e.target.files)
              e.target.value = ''
            }}
          />
          <input
            ref={archiveRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(e) => void importWorkspace(e.target.files?.[0])}
          />
          <button className="icon-btn" onClick={closeAndFocus} aria-label="Close local file system" type="button">
            <IconX size={16} />
          </button>
        </header>

        <div className="gh-tabpanel">
          <div className="gh-tab-body">
            <section className="fs-workspace-intro" aria-label="Workspace overview">
              <div className="fs-workspace-copy">
                <div className="fs-workspace-kicker"><span className="fs-live-dot" /> YOUR WORKSPACE</div>
                <h3>{files.length ? 'Everything in its right place.' : 'A fresh space for your next idea.'}</h3>
                <p>Files your agents create, plus anything you bring into the workspace.</p>
              </div>
              <div className="fs-workspace-stats">
                <div><strong>{files.length}</strong><span>files</span></div>
                <div><strong>{formatBytes(totalBytes)}</strong><span>in workspace</span></div>
                <div><strong>{dirtyCount}</strong><span>unsynced</span></div>
              </div>
            </section>

            <div className="fs-toolbar" aria-label="Workspace actions">
              <div className="fs-toolbar-main">
                <button
                  className="btn primary small"
                  onClick={() => { setCreating((value) => !value); setCreateError(null) }}
                  title="Create a new file in the local file system"
                  type="button"
                >
                  <IconPlus size={13} /> New file
                </button>
                <button className="btn ghost small" onClick={() => uploadRef.current?.click()} type="button">
                  <IconUpload size={13} /> Upload
                </button>
                <button
                  className="btn ghost small"
                  disabled={Boolean(archiveBusy)}
                  onClick={() => archiveRef.current?.click()}
                  title="Import a zip archive into this workspace"
                  type="button"
                >
                  <IconArchiveRestore className="fs-zip-import-icon" size={15} /> Import ZIP
                </button>
                <button
                  className="btn ghost small"
                  disabled={!files.length || Boolean(archiveBusy)}
                  onClick={() => void exportWorkspace()}
                  title="Download all workspace files as a zip archive"
                  type="button"
                >
                  <IconArchiveExport className="fs-zip-export-icon" size={15} /> Export ZIP
                </button>
              </div>
              {archiveBusy ? (
                <span className="fs-archive-status" role="status">
                  <span className="spin">◌</span>
                  {archiveBusy === 'export' ? `Packing ${Math.round(archiveProgress)}%` : 'Reading archive…'}
                </span>
              ) : null}
            </div>

            {activeRepo ? (
              <div className="fs-git-bar">
                <span className="fs-git-repo" title={`Connected GitHub repository: ${activeRepo}@${activeBranch ?? 'HEAD'}`}>
                  <IconGithub size={12} /> <strong>{activeRepo}</strong>
                  {activeBranch ? <code>@{activeBranch}</code> : null}
                </span>
                <div className="gh-row">
                  <button
                    className="btn ghost small"
                    disabled={pullingRepo || !ghTree}
                    onClick={async () => {
                      setPullingRepo(true)
                      await useGitHub.getState().pullTreeToFs({ prefix: filter.trim() || undefined })
                      setPullingRepo(false)
                    }}
                    title="Pull text files from the open GitHub repository into Local Files"
                    type="button"
                  >
                    <IconDownload size={12} /> {pullingRepo ? 'Pulling…' : 'Pull repo'}
                  </button>
                  {files.length > 0 || deletedCount > 0 ? (
                    <button
                      className="btn primary small"
                      onClick={() => {
                        setCommitting((c) => !c)
                        setCommitRepo(activeRepo)
                        setCommitBranch(activeBranch ?? '')
                        setCommitMessage(
                          `Update ${dirtyCount || files.length} file${(dirtyCount || files.length) === 1 ? '' : 's'} (via Slade)`,
                        )
                      }}
                      title="Commit local files to this GitHub repository"
                      type="button"
                    >
                      <IconGitCommit size={12} /> Push{dirtyCount > 0 ? ` (${dirtyCount})` : ''}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {committing ? (
              <div className="fs-create-card fs-commit-card">
                <div className="gh-row" style={{ justifyContent: 'space-between' }}>
                  <strong>
                    <IconGitCommit size={13} /> Commit Local Files to GitHub
                  </strong>
                  <span className="gh-muted">
                    {dirtyCount > 0 ? `${dirtyCount} changed` : `${files.length} file${files.length === 1 ? '' : 's'}`}
                    {deletedCount > 0 ? ` (${deletedCount} deleted)` : ''}
                  </span>
                </div>
                <div className="publish-grid">
                  <label className="gh-field">
                    <span>Repository</span>
                    <input
                      className="gh-input mono"
                      value={commitRepo}
                      placeholder="owner/repo"
                      onChange={(e) => setCommitRepo(e.target.value)}
                    />
                  </label>
                  <label className="gh-field">
                    <span>Base branch</span>
                    <input
                      className="gh-input mono"
                      value={commitBranch}
                      placeholder="default branch"
                      onChange={(e) => setCommitBranch(e.target.value)}
                    />
                  </label>
                </div>
                <label className="gh-field">
                  <span>New branch (optional — leave blank to commit directly to base branch)</span>
                  <input
                    className="gh-input mono"
                    value={commitNewBranch}
                    placeholder="e.g. slade/update-files"
                    onChange={(e) => setCommitNewBranch(e.target.value)}
                  />
                </label>
                <label className="gh-field">
                  <span>Commit message</span>
                  <input
                    className="gh-input"
                    value={commitMessage}
                    placeholder="Describe the changes…"
                    onChange={(e) => setCommitMessage(e.target.value)}
                  />
                </label>
                {!ghToken ? (
                  <p className="gh-muted">
                    Not signed in to GitHub —{' '}
                    <button className="link-btn" onClick={() => openSettings('github')} type="button">
                      connect in Settings → GitHub
                    </button>
                  </p>
                ) : null}
                <div className="gh-row">
                  <button className="btn ghost small" onClick={() => setCommitting(false)} type="button">
                    Cancel
                  </button>
                  <button
                    className="btn primary small"
                    disabled={ghPublishing || !commitRepo.trim() || !commitMessage.trim()}
                    onClick={async () => {
                      const res = await useGitHub.getState().commitFsToGitHub({
                        repo: commitRepo,
                        branch: commitBranch || undefined,
                        newBranch: commitNewBranch || undefined,
                        message: commitMessage,
                      })
                      if (res) {
                        setCommitting(false)
                        setCommitNewBranch('')
                      }
                    }}
                    type="button"
                  >
                    <IconGitCommit size={12} /> {ghPublishing ? 'Committing…' : 'Commit & Push'}
                  </button>
                </div>
              </div>
            ) : null}

            {creating ? (
              <div className="fs-create-card">
                <label className="gh-field">
                  <span>File path</span>
                  <input
                    className="gh-input mono"
                    value={newPath}
                    placeholder="src/index.ts or notes/plan.md"
                    autoFocus
                    spellCheck={false}
                    onChange={(e) => setNewPath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setCreating(false)
                    }}
                  />
                </label>
                <label className="gh-field">
                  <span>Contents</span>
                  <textarea
                    className="gh-input mono"
                    rows={5}
                    value={newContent}
                    placeholder="File contents…"
                    onChange={(e) => setNewContent(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && newPath.trim()) {
                        e.preventDefault()
                        createNewFile()
                      }
                    }}
                  />
                </label>
                {createError ? <div className="gh-error" role="alert">{createError}</div> : null}
                <div className="gh-row">
                  <button className="btn ghost small" onClick={() => setCreating(false)} type="button">
                    Cancel
                  </button>
                  <button
                    className="btn primary small"
                    disabled={!newPath.trim()}
                    onClick={createNewFile}
                    type="button"
                  >
                    <IconCheck size={12} /> Save file
                  </button>
                </div>
              </div>
            ) : null}

            <div className="gh-search-inline">
              <IconSearch size={13} />
              <input
                className="gh-input"
                value={filter}
                placeholder={`Filter ${files.length || ''} files or search contents…`}
                aria-label="Filter local files"
                onChange={(e) => useFs.getState().setFilter(e.target.value)}
              />
            </div>

            {files.length === 0 && !creating ? (
              <div className="gh-empty">
                <IconFolder size={22} />
                <strong>No files stored yet</strong>
                <span>
                  Agents automatically store files they emit here (such as <code>```ts:src/app.ts</code> or{' '}
                  <code>```csv:sales.csv</code>) and read existing files as workspace context.
                </span>
                <div className="gh-row" style={{ marginTop: 8 }}>
                  <button className="btn primary small" onClick={() => setCreating(true)} type="button">
                    <IconPlus size={12} /> New file
                  </button>
                  <button className="btn ghost small" onClick={() => uploadRef.current?.click()} type="button">
                    <IconUpload size={12} /> Upload
                  </button>
                </div>
              </div>
            ) : null}

            {files.length > 0 ? (
              <div className="gh-tree-wrap">
                {searchHits ? (
                  <ul className="gh-tree">
                    {searchHits.map((hit) => (
                      <li key={hit.file.path}>
                        <div
                          className={`gh-tree-row${selectedPath === hit.file.path ? ' active' : ''}`}
                          style={{ paddingLeft: 8 }}
                        >
                          <button
                            className="gh-tree-open"
                            onClick={() => openFile(hit.file.path)}
                            title={hit.file.path}
                            type="button"
                          >
                            <FileKindIcon file={hit.file} />
                            <span className="gh-tree-name">{hit.file.path}</span>
                            {hit.file.version > 1 ? <span className="fs-version-badge">v{hit.file.version}</span> : null}
                            <span className="gh-tree-size">{formatBytes(hit.file.size)}</span>
                          </button>
                          <button
                            className="icon-btn small"
                            onClick={() => useFs.getState().attachFile(hit.file.path)}
                            aria-label={`Attach ${hit.file.path}`}
                            title="Attach to next message"
                            type="button"
                          >
                            <IconPaperclip size={12} />
                          </button>
                        </div>
                        {hit.lines.length > 0 ? (
                          <div className="fs-search-lines">
                            {hit.lines.slice(0, 2).map((l) => (
                              <button
                                key={l.line}
                                className="fs-search-line"
                                onClick={() => openFile(hit.file.path)}
                                type="button"
                              >
                                <span className="fs-line-num">:{l.line}</span>
                                <code>{l.text}</code>
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </li>
                    ))}
                    {searchHits.length === 0 ? (
                      <li className="gh-muted gh-tree-none">No files or contents match “{filter}”.</li>
                    ) : null}
                  </ul>
                ) : (
                  <ul className="gh-tree">{renderDir(treeRoot, 0)}</ul>
                )}
              </div>
            ) : null}

            {selectedFile ? (
              <div className="gh-preview fs-preview">
                <div className="gh-preview-head">
                  {renaming ? (
                    <div className="gh-row" style={{ flex: 1 }}>
                      <input
                        className="gh-input mono"
                        value={renameDraft}
                        aria-label="New file path"
                        autoFocus
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveRename()
                          if (e.key === 'Escape') setRenaming(false)
                        }}
                      />
                      <button className="btn primary small" onClick={saveRename} type="button">
                        Save
                      </button>
                      <button className="btn ghost small" onClick={() => setRenaming(false)} type="button">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="gh-preview-path" title={selectedFile.path}>
                        {selectedFile.path}
                      </span>
                      <span className="gh-muted">
                        v{selectedFile.version} · {formatBytes(selectedFile.size)}
                      </span>
                      {selectedFile.encoding !== 'base64' && !editing ? (
                        <button
                          className="icon-btn small"
                          onClick={() => startEdit(selectedFile)}
                          aria-label={`Edit ${selectedFile.path}`}
                          title="Edit file"
                          type="button"
                        >
                          <IconPencil size={12} />
                        </button>
                      ) : null}
                      <button
                        className="icon-btn small"
                        onClick={() => startRename(selectedFile)}
                        aria-label={`Rename or move ${selectedFile.path}`}
                        title="Rename / move file"
                        type="button"
                      >
                        <IconFolder size={12} />
                      </button>
                      <button
                        className="icon-btn small"
                        onClick={() => downloadFile(selectedFile)}
                        aria-label={`Download ${selectedFile.path}`}
                        title="Download file"
                        type="button"
                      >
                        <IconDownload size={12} />
                      </button>
                      <button
                        className="icon-btn small"
                        onClick={() => publishFile(selectedFile)}
                        aria-label={`Publish ${selectedFile.path} to GitHub`}
                        title="Publish to GitHub"
                        type="button"
                      >
                        <IconGithub size={12} />
                      </button>
                      <button
                        className="btn primary small"
                        onClick={() => useFs.getState().attachFile(selectedFile.path)}
                        type="button"
                      >
                        <IconPaperclip size={12} /> Attach
                      </button>
                      <button
                        className="btn ghost small"
                        onClick={() => useFs.getState().selectFile(null)}
                        type="button"
                      >
                        Close
                      </button>
                    </>
                  )}
                </div>

                <div className="fs-preview-sub">
                  <span>
                    Updated by{' '}
                    <strong>
                      {selectedFile.updatedBy.origin === 'user' ? 'you' : selectedFile.updatedBy.modelLabel}
                    </strong>
                    {selectedFile.remote ? (
                      <>
                        {' '}
                        ·{' '}
                        <a
                          href={selectedFile.remote.url}
                          target="_blank"
                          rel="noreferrer"
                          className="link-btn"
                          title={`Open ${selectedFile.remote.path} on GitHub`}
                        >
                          {selectedFile.remote.repo}@{selectedFile.remote.ref} <IconExternal size={10} />
                        </a>{' '}
                        <span className={`fs-git-badge${selectedFile.dirty ? ' dirty' : ' synced'}`}>
                          {selectedFile.dirty ? 'modified' : 'synced'}
                        </span>
                      </>
                    ) : null}
                  </span>
                  <span className="gh-row">
                    {selectedFile.remote ? (
                      <button
                        className="link-btn"
                        onClick={() =>
                          void useGitHub.getState().pullFileToFs(selectedFile.path, {
                            repo: selectedFile.remote!.repo,
                            ref: selectedFile.remote!.ref,
                          })
                        }
                        title="Pull latest version of this file from GitHub"
                        type="button"
                      >
                        <IconRefresh size={11} /> Pull latest
                      </button>
                    ) : null}
                    {selectedFile.path.toLowerCase().endsWith('.md') && !editing ? (
                      <button className="link-btn" onClick={() => setRawView((v) => !v)} type="button">
                        {rawView ? 'Rendered view' : 'Raw Markdown'}
                      </button>
                    ) : null}
                  </span>
                </div>

                {editing ? (
                  <div className="fs-editor">
                    <textarea
                      className="gh-input mono fs-editor-ta"
                      rows={12}
                      value={editDraft}
                      aria-label={`Edit contents of ${selectedFile.path}`}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault()
                          saveEdit()
                        }
                        if (e.key === 'Escape') setEditing(false)
                      }}
                    />
                    <div className="fs-editor-actions">
                      <button className="btn ghost small" onClick={() => setEditing(false)} type="button">
                        Cancel
                      </button>
                      <button className="btn primary small" onClick={saveEdit} type="button">
                        <IconCheck size={12} /> Save changes
                      </button>
                    </div>
                  </div>
                ) : (
                  <PreviewBody file={selectedFile} rawView={rawView} />
                )}
              </div>
            ) : null}
          </div>
        </div>

        <footer className="gh-foot">
          <div className="gh-row" style={{ justifyContent: 'space-between' }}>
            <p className="gh-foot-note" style={{ margin: 0 }}>
              Agent workspace access: <strong>{useLocalFs ? 'enabled' : 'off'}</strong> ·{' '}
              <button className="link-btn" onClick={() => openSettings('agent')} type="button">
                Agent settings
              </button>
            </p>
            {files.length > 0 ? (
              <button
                className="link-btn"
                onClick={() => {
                  useFs.getState().clearAll()
                  toast({ kind: 'info', title: 'Cleared local file system' })
                }}
                type="button"
              >
                Clear all
              </button>
            ) : null}
          </div>
        </footer>
      </aside>
    </>
  )
}

function PreviewBody({ file, rawView }: { file: FsFile; rawView: boolean }) {
  if (file.encoding === 'base64') {
    if (file.kind === 'image') {
      return <img className="gh-preview-img" src={`data:${file.mime};base64,${file.content}`} alt={file.path} />
    }
    return (
      <div className="gh-empty">
        <strong>Binary file ({file.mime})</strong>
        <span>{formatBytes(file.size)} — use Download to save to disk or Attach to send as context.</span>
      </div>
    )
  }

  if (file.kind === 'sheet') {
    const { rows } = parseCSV(file.content)
    return <SheetTable columns={rows[0] ?? []} rows={rows.slice(1)} maxHeight={320} />
  }

  if (file.path.toLowerCase().endsWith('.md') && !rawView) {
    return (
      <div className="gh-preview-md">
        <Markdown text={file.content} />
      </div>
    )
  }

  return (
    <CodeArtifact
      code={file.content}
      lang={guessLanguage(file.path)}
      name={file.name}
      maxHeight={340}
    />
  )
}
