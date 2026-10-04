import { useMemo, useState } from 'react'
import { useGitHub } from '../../store/github'
import { formatBytes } from '../../lib/format'
import { extOf, guessLanguage, type GitHubTreeEntry } from '../../lib/github'
import { CodeArtifact } from '../artifacts/CodeArtifact'
import { Markdown } from '../chat/Markdown'
import { GhEmpty, GhError, Spinner } from './bits'
import { OpenPullRequestButton } from './OpenPullRequest'
import {
  IconChevronDown,
  IconChevronRight,
  IconCode,
  IconDownload,
  IconExternal,
  IconFile,
  IconFolder,
  IconImage,
  IconPaperclip,
  IconRefresh,
} from '../icons'

const RENDER_LIMIT = 600

interface DirNode {
  name: string
  path: string
  dirs: DirNode[]
  files: GitHubTreeEntry[]
}

function buildTree(entries: GitHubTreeEntry[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: [], files: [] }
  const dirs = new Map<string, DirNode>([['', root]])

  const ensureDir = (path: string): DirNode => {
    const existing = dirs.get(path)
    if (existing) return existing
    const parts = path.split('/')
    const name = parts[parts.length - 1]!
    const parent = ensureDir(parts.slice(0, -1).join('/'))
    const node: DirNode = { name, path, dirs: [], files: [] }
    parent.dirs.push(node)
    dirs.set(path, node)
    return node
  }

  for (const e of entries) {
    if (e.type !== 'blob') continue
    const i = e.path.lastIndexOf('/')
    const dirPath = i < 0 ? '' : e.path.slice(0, i)
    ensureDir(dirPath).files.push(e)
  }

  const sort = (node: DirNode) => {
    node.dirs.sort((a, b) => a.name.localeCompare(b.name))
    node.files.sort((a, b) => a.path.localeCompare(b.path))
    node.dirs.forEach(sort)
  }
  sort(root)
  return root
}

function FileIcon({ path }: { path: string }) {
  const ext = extOf(path)
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico'].includes(ext)) return <IconImage size={13} />
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'css', 'html', 'json', 'yml', 'yaml', 'sql', 'sh'].includes(ext))
    return <IconCode size={13} />
  return <IconFile size={13} />
}

/**
 * Files tab: the browsing half of the context workspace.
 *
 * Reading is *free* here — nothing is attached until you press attach, so
 * clicking around a repo never silently grows the next prompt.
 */
export function FileBrowser() {
  const {
    activeRepo,
    activeBranch,
    branches,
    tree,
    treeLoading,
    treeError,
    treeFilter,
    preview,
    previewLoading,
    previewError,
    repos,
  } = useGitHub()
  const setBranch = useGitHub((s) => s.setBranch)
  const setTreeFilter = useGitHub((s) => s.setTreeFilter)
  const refreshTree = useGitHub((s) => s.refreshTree)
  const openFile = useGitHub((s) => s.openFile)
  const closeFile = useGitHub((s) => s.closeFile)
  const attachFile = useGitHub((s) => s.attachFile)
  const pullFileToFs = useGitHub((s) => s.pullFileToFs)
  const pullTreeToFs = useGitHub((s) => s.pullTreeToFs)
  const openRepo = useGitHub((s) => s.openRepo)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [attachBusy, setAttachBusy] = useState<string | null>(null)
  const [pullBusy, setPullBusy] = useState(false)

  const filter = treeFilter.trim().toLowerCase()
  const treeRoot = useMemo(() => (tree ? buildTree(tree.entries) : null), [tree])

  const matches = useMemo(() => {
    if (!tree || !filter) return null
    return tree.entries
      .filter((e) => e.type === 'blob' && e.path.toLowerCase().includes(filter))
      .sort((a, b) => {
        const aBase = a.path.split('/').pop()?.toLowerCase().includes(filter) ? 0 : 1
        const bBase = b.path.split('/').pop()?.toLowerCase().includes(filter) ? 0 : 1
        return aBase - bBase || a.path.localeCompare(b.path)
      })
  }, [tree, filter])

  if (!activeRepo) {
    return (
      <div className="gh-tab-body">
        <GhEmpty title="No repository open" detail="Pick one in the Repos tab — then its files are one click from the prompt." />
      </div>
    )
  }

  const repoMeta = repos.find((r) => r.full_name === activeRepo)

  const attach = async (path: string) => {
    setAttachBusy(path)
    await attachFile(path)
    setAttachBusy(null)
  }

  const pullOne = async (path: string) => {
    setAttachBusy(path)
    await pullFileToFs(path)
    setAttachBusy(null)
  }

  const pullAll = async () => {
    setPullBusy(true)
    await pullTreeToFs({ prefix: treeFilter.trim() || undefined })
    setPullBusy(false)
  }

  const toggleDir = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  let rendered = 0
  const renderDir = (node: DirNode, depth: number) => {
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
      if (rendered > RENDER_LIMIT) break
      rows.push(...renderDir(dir, node.path ? depth + 1 : depth))
    }
    for (const file of node.files) {
      if (rendered > RENDER_LIMIT) break
      rendered++
      const name = file.path.split('/').pop() ?? file.path
      rows.push(
        <li key={`f:${file.path}`}>
          <div className={`gh-tree-row${preview?.path === file.path ? ' active' : ''}`} style={{ paddingLeft: 8 + depth * 13 + 14 }}>
            <button className="gh-tree-open" onClick={() => void openFile(file.path)} title={file.path} type="button">
              <FileIcon path={file.path} />
              <span className="gh-tree-name">{name}</span>
              {file.size != null ? <span className="gh-tree-size">{formatBytes(file.size)}</span> : null}
            </button>
            <button
              className="icon-btn small"
              onClick={() => void pullOne(file.path)}
              disabled={attachBusy === file.path}
              aria-label={`Save ${file.path} to Local Files`}
              title="Save to Local Files"
              type="button"
            >
              <IconFolder size={12} />
            </button>
            <button
              className="icon-btn small"
              onClick={() => void attach(file.path)}
              disabled={attachBusy === file.path}
              aria-label={`Attach ${file.path} to the next message`}
              title="Attach to the next message"
              type="button"
            >
              {attachBusy === file.path ? <Spinner /> : <IconPaperclip size={12} />}
            </button>
          </div>
        </li>,
      )
    }
    return rows
  }

  return (
    <div className="gh-tab-body gh-files">
      <div className="gh-row wrap">
        <select
          className="gh-select"
          value={activeRepo}
          aria-label="Repository"
          onChange={(e) => void openRepo(e.target.value)}
        >
          <option value={activeRepo}>{activeRepo}</option>
          {repos
            .filter((r) => r.full_name !== activeRepo)
            .slice(0, 100)
            .map((r) => (
              <option key={r.full_name} value={r.full_name}>
                {r.full_name}
              </option>
            ))}
        </select>
        <select className="gh-select" value={activeBranch ?? ''} aria-label="Branch" onChange={(e) => void setBranch(e.target.value)}>
          {[activeBranch, ...branches.map((b) => b.name)]
            .filter((b, i, arr): b is string => Boolean(b) && arr.indexOf(b) === i)
            .map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
        </select>
        <button className="icon-btn small" onClick={() => void refreshTree()} aria-label="Reload file tree" title="Reload" type="button">
          <IconRefresh size={13} />
        </button>
        <button
          className="btn ghost small"
          onClick={() => void pullAll()}
          disabled={pullBusy || !tree}
          title="Pull text files from this repository into Local Files so agents can read and modify them"
          type="button"
        >
          {pullBusy ? <Spinner /> : <IconDownload size={12} />} Pull to Local Files
        </button>
        {/* The branch being browsed becomes the head; the card in the chat is what you merge from. */}
        <OpenPullRequestButton />
      </div>

      <div className="gh-search-inline">
        <input
          className="gh-input"
          value={treeFilter}
          placeholder={`Filter ${tree ? tree.entries.length.toLocaleString() : ''} files…`}
          aria-label="Filter files by path"
          onChange={(e) => setTreeFilter(e.target.value)}
        />
      </div>

      {repoMeta?.description ? <p className="gh-muted gh-repo-desc">{repoMeta.description}</p> : null}
      {treeLoading ? <Spinner label={`Loading ${activeRepo}@${activeBranch}…`} /> : null}
      {treeError ? <GhError onRetry={() => void refreshTree()}>{treeError}</GhError> : null}
      {tree?.truncated ? (
        <p className="gh-muted">GitHub truncated this tree — the file list is partial. Use the filter with a search instead.</p>
      ) : null}

      <div className="gh-tree-wrap">
        {matches ? (
          <ul className="gh-tree">
            {matches.slice(0, RENDER_LIMIT).map((f) => (
              <li key={f.path}>
                <div className={`gh-tree-row${preview?.path === f.path ? ' active' : ''}`} style={{ paddingLeft: 8 }}>
                  <button className="gh-tree-open" onClick={() => void openFile(f.path)} title={f.path} type="button">
                    <FileIcon path={f.path} />
                    <span className="gh-tree-name">{f.path}</span>
                    {f.size != null ? <span className="gh-tree-size">{formatBytes(f.size)}</span> : null}
                  </button>
                  <button
                    className="icon-btn small"
                    onClick={() => void pullOne(f.path)}
                    disabled={attachBusy === f.path}
                    aria-label={`Save ${f.path} to Local Files`}
                    title="Save to Local Files"
                    type="button"
                  >
                    <IconFolder size={12} />
                  </button>
                  <button
                    className="icon-btn small"
                    onClick={() => void attach(f.path)}
                    disabled={attachBusy === f.path}
                    aria-label={`Attach ${f.path}`}
                    title="Attach to the next message"
                    type="button"
                  >
                    <IconPaperclip size={12} />
                  </button>
                </div>
              </li>
            ))}
            {matches.length === 0 ? <li className="gh-muted gh-tree-none">No file path matches “{treeFilter}”.</li> : null}
            {matches.length > RENDER_LIMIT ? (
              <li className="gh-muted gh-tree-none">Showing {RENDER_LIMIT} of {matches.length} matches — narrow the filter.</li>
            ) : null}
          </ul>
        ) : treeRoot ? (
          <ul className="gh-tree">{renderDir(treeRoot, 0)}</ul>
        ) : null}
      </div>

      {preview || previewLoading || previewError ? (
        <div className="gh-preview">
          <div className="gh-preview-head">
            <span className="gh-preview-path" title={preview?.path ?? ''}>
              {preview?.path ?? 'Loading…'}
            </span>
            {preview ? <span className="gh-muted">{formatBytes(preview.size)}</span> : null}
            {preview ? (
              <a
                className="icon-btn small"
                href={`https://github.com/${activeRepo}/blob/${encodeURIComponent(preview.ref)}/${preview.path
                  .split('/')
                  .map(encodeURIComponent)
                  .join('/')}`}
                target="_blank"
                rel="noreferrer"
                aria-label="Open on GitHub"
                title="Open on GitHub"
              >
                <IconExternal size={13} />
              </a>
            ) : null}
            <button
              className="btn ghost small"
              disabled={!preview || attachBusy === preview.path}
              onClick={() => preview && void pullOne(preview.path)}
              title="Save this file into Local Files"
              type="button"
            >
              <IconFolder size={12} /> Save to Files
            </button>
            <button
              className="btn primary small"
              disabled={!preview || attachBusy === preview.path}
              onClick={() => preview && void attach(preview.path)}
              type="button"
            >
              <IconPaperclip size={12} /> Attach
            </button>
            <button className="btn ghost small" onClick={closeFile} type="button">
              Close
            </button>
          </div>
          {previewLoading ? <Spinner label="Fetching file…" /> : null}
          {previewError ? <GhError>{previewError}</GhError> : null}
          {preview?.text != null ? (
            preview.path.endsWith('.md') ? (
              <div className="gh-preview-md">
                <Markdown text={preview.text} />
              </div>
            ) : (
              <CodeArtifact code={preview.text} lang={guessLanguage(preview.path)} name={preview.path.split('/').pop() ?? ''} maxHeight={340} />
            )
          ) : null}
          {preview?.dataURL && preview.mime.startsWith('image/') ? (
            <img className="gh-preview-img" src={preview.dataURL} alt={preview.path} />
          ) : null}
          {preview && preview.text == null && !preview.dataURL ? (
            <GhEmpty title="No inline preview" detail={`${preview.mime} · ${formatBytes(preview.size)} — attach it and the model can still read the metadata, or open it on GitHub.`} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
