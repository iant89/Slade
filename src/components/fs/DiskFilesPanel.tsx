import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useShell } from '../../lib/shell'
import { useUI } from '../../store/ui'
import { useSettings } from '../../store/settings'
import { useChat } from '../../store/chat'
import { useDiskFs, refreshDiskTree, readDiskFile, writeDiskFile, moveDiskFile, deleteDiskFile, diskArtifact, type DiskFile } from '../../store/diskFs'
import { formatBytes } from '../../lib/format'
import { downloadUrl } from '../../lib/clipboard'
import { fileToDataURL } from '../../store/artifacts'
import { ResizeHandle } from '../common/ResizeHandle'
import { IconFolder, IconX } from '../icons'
import { DiskImportReview } from './DiskImportReview'

export function DiskFilesPanel() {
  const root = useShell((s) => s.root)
  const token = useShell((s) => s.token)
  const open = useUI((s) => s.filesOpen)
  const conversationId = useChat((s) => s.currentId)
  const entries = useDiskFs((s) => s.entries)
  const selectedPath = useDiskFs((s) => s.selectedPath)
  const truncated = useDiskFs((s) => s.truncated)
  const width = useSettings((s) => s.s.layout?.filesW)
  const ref = useRef<HTMLElement>(null)
  const uploadRef = useRef<HTMLInputElement>(null)
  const [filter, setFilter] = useState('')
  const [file, setFile] = useState<DiskFile | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [newContent, setNewContent] = useState('')
  const dirty = Boolean(file && draft !== file.content)
  const close = () => {
    if (dirty && !window.confirm('Discard unsaved disk edits and close Files?')) return
    useUI.getState().closeFiles()
    document.querySelector<HTMLButtonElement>('[data-panel-toggle="files"]')?.focus()
  }
  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : 'Disk operation failed.')
  async function act(fn: () => Promise<void>) {
    setBusy(true); setError('')
    try { await fn() } catch (cause) { fail(cause) } finally { setBusy(false) }
  }
  useEffect(() => {
    if (!open) return
    let active = true
    void refreshDiskTree().catch((cause) => { if (active) fail(cause) })
    const refresh = () => void refreshDiskTree().catch((cause) => { if (active) fail(cause) })
    window.addEventListener('focus', refresh)
    return () => { active = false; window.removeEventListener('focus', refresh) }
  }, [open, token, root])
  useEffect(() => {
    let active = true
    setFile(null); setDraft('')
    if (selectedPath && open) {
      void readDiskFile(selectedPath).then((loaded) => { if (active) { setFile(loaded); setDraft(loaded.content); setError('') } }).catch((cause) => { if (active) fail(cause) })
    }
    return () => { active = false }
  }, [selectedPath, token, root, open])
  if (!open) return null
  const select = (path: string) => {
    if (dirty && !window.confirm('Discard unsaved edits?')) return
    useDiskFs.setState({ selectedPath: path })
  }
  const stale = file && entries.some((entry) => entry.path === file.path && (entry.updatedAt !== file.updatedAt || entry.size !== file.size))
  return (
    <>
      <div className="gh-drawer-backdrop only-mobile" onClick={close} aria-hidden="true" />
      <aside className="github-drawer files-drawer disk-files" ref={ref} aria-label="Local disk file system" style={width ? ({ '--gh-w': `${width}px` } as CSSProperties) : undefined}>
        <header className="gh-head fs-drawer-head"><h2><IconFolder size={15} /> Workspace</h2><span className="gh-identity">Disk checkout</span><button className="icon-btn" type="button" onClick={close} aria-label="Close files"><IconX size={15} /></button></header>
        <div className="disk-workspace-body">
          <p className="disk-root" title={root}>{root}</p>
          <p className="settings-intro-hint">Shared with bash and all connected conversations. Browser files stay separate until you import them. Disconnect in Settings → Agent to return to browser storage.</p>
          <div className="disk-toolbar">
            <button className="btn small" type="button" disabled={busy} onClick={() => void act(async () => { await refreshDiskTree() })}>Refresh</button>
            <button className="btn small" type="button" disabled={busy} onClick={() => setCreating(!creating)}>New file</button>
            <button className="btn small" type="button" disabled={busy} onClick={() => uploadRef.current?.click()}>Upload</button>
            <button className="btn small" type="button" disabled={busy} onClick={() => setImporting(!importing)}>Import browser files</button>
          </div>
          <input ref={uploadRef} type="file" hidden onChange={(event) => {
            const upload = event.target.files?.[0]; event.target.value = ''; if (!upload) return
            const path = window.prompt('Relative destination path (existing files are not overwritten):', upload.name)
            if (!path) return
            void act(async () => {
              if (upload.size > 5_000_000) throw new Error('Upload exceeds the 5 MB file limit.')
              const data = await fileToDataURL(upload)
              const saved = await writeDiskFile(path, data.slice(data.indexOf(',') + 1), 'base64', null)
              select(saved.path)
            })
          }} />
          {error && <p className="disk-error" role="alert">{error} No browser-storage fallback was used.</p>}
          {importing && <DiskImportReview key={`${root}:${conversationId}`} conversationId={conversationId} onDone={() => { setImporting(false); void act(async () => { await refreshDiskTree() }) }} />}
          {creating && <form className="disk-create" onSubmit={(event) => { event.preventDefault(); void act(async () => {
            const saved = await writeDiskFile(newPath, newContent, 'utf8', null)
            setCreating(false); setNewPath(''); setNewContent(''); select(saved.path)
          }) }}>
            <label>Relative file path<input className="input" required value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="src/example.ts" /></label>
            <label>Contents<textarea value={newContent} onChange={(e) => setNewContent(e.target.value)} /></label>
            <button className="btn small" type="submit" disabled={busy}>Create on disk</button>
          </form>}
          <label className="sr-only" htmlFor="disk-file-filter">Filter disk file paths</label>
          <input id="disk-file-filter" className="input" placeholder="Filter file paths…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <p className="settings-intro-hint">{entries.length} files{truncated ? ' · listing truncated' : ''} · common generated/secret paths and symlinks excluded · editor limit 5 MB</p>
          <ul className="disk-file-list">{entries.filter((entry) => entry.path.toLowerCase().includes(filter.toLowerCase())).map((entry) => <li key={entry.path}>
            <button className={`gh-tree-row${selectedPath === entry.path ? ' active' : ''}`} type="button" disabled={busy} onClick={() => select(entry.path)}><span className="gh-tree-name">{entry.path}</span><span className="gh-tree-size">{formatBytes(entry.size)}</span></button>
          </li>)}</ul>
          {file && file.path === selectedPath && <section className="disk-editor" aria-label={`Edit ${file.path}`}>
            <h3>{file.path}{dirty ? ' · unsaved' : ''}</h3>
            {stale && <p role="status">This file changed on disk. Reload to inspect the new version. Saving a stale revision will be rejected.</p>}
            <div className="disk-toolbar">
              <button className="btn small" type="button" disabled={busy || !dirty || file.encoding === 'base64'} onClick={() => void act(async () => {
                const saved = await writeDiskFile(file.path, draft, 'utf8', file.revision)
                setFile(saved); setDraft(saved.content)
              })}>Save</button>
              <button className="btn small" type="button" disabled={busy} onClick={() => {
                if (dirty && !window.confirm('Discard edits and reload the disk version?')) return
                void act(async () => { const loaded = await readDiskFile(file.path); setFile(loaded); setDraft(loaded.content) })
              }}>Reload disk version</button>
              <button className="btn small" type="button" disabled={busy || dirty} onClick={() => void act(async () => {
                const latest = await readDiskFile(file.path); const artifact = diskArtifact(latest)
                useUI.getState().addPendingAttachment(artifact.id)
                useUI.getState().toast({ kind: 'success', title: `${latest.name} attached` })
              })}>Attach</button>
              <button className="btn small" type="button" disabled={busy || dirty} onClick={() => void act(async () => {
                const latest = await readDiskFile(file.path)
                const url = latest.encoding === 'base64' ? `data:${latest.mime};base64,${latest.content}` : URL.createObjectURL(new Blob([latest.content], { type: latest.mime }))
                downloadUrl(url, latest.name)
                if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 1000)
              })}>Download</button>
              <button className="btn small" type="button" disabled={busy || dirty} onClick={() => {
                const path = window.prompt('New relative path (will not overwrite an existing file):', file.path)
                if (path && path !== file.path) void act(async () => { await moveDiskFile(file, path) })
              }}>Rename</button>
              <button className="btn danger small" type="button" disabled={busy} onClick={() => {
                if (window.confirm(`Delete ${file.path} from the actual disk checkout? This cannot be undone in Slade.`)) void act(async () => { await deleteDiskFile(file); setFile(null) })
              }}>Delete</button>
            </div>
            {file.encoding === 'base64' ? <p>Binary file — attach or download to view.</p> : <textarea aria-label={`Contents of ${file.path}`} spellCheck={false} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} />}
          </section>}
        </div>
        <ResizeHandle side="right" overlay panelRef={ref} varName="--gh-w" fallback={470} width={width} label="Files" onCommit={(value) => useSettings.getState().setLayoutWidth('filesW', value)} />
      </aside>
    </>
  )
}
