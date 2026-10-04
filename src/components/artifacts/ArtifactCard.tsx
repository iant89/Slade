import { useEffect, useState, type ComponentType } from 'react'
import { motion } from 'framer-motion'
import type { Artifact, FsFile } from '../../types'
import { useArtifacts } from '../../store/artifacts'
import { useFs } from '../../store/fs'
import { useShell } from '../../lib/shell'
import { useDiskFs, maybeReadDiskFile, writeDiskFile, workspaceSession } from '../../store/diskFs'
import { useSettings } from '../../store/settings'
import { useUI } from '../../store/ui'
import { formatBytes } from '../../lib/format'
import { kindLabel } from '../../lib/mime'
import { artifactUrl, copyText, downloadUrl } from '../../lib/clipboard'
import { tryNormalizeFsPath } from '../../lib/fs'
import {
  IconAudio,
  IconArchive,
  IconChevronDown,
  IconCode,
  IconCopy,
  IconDownload,
  IconExpand,
  IconExternal,
  IconFile,
  IconFileText,
  IconFolder,
  IconGithub,
  IconImage,
  IconPin,
  IconTable,
  IconVideo,
} from '../icons'
import { BashArtifactCard } from './BashArtifactCard'
import { CodeArtifact } from './CodeArtifact'
import { SheetTable } from './SheetTable'
import { AudioPlayer, VideoPlayer } from './media'

const KIND_ICON: Record<Artifact['kind'], typeof IconFile> = {
  image: IconImage,
  code: IconCode,
  doc: IconFileText,
  sheet: IconTable,
  audio: IconAudio,
  video: IconVideo,
  archive: IconArchive,
  unknown: IconFile,
}

function artifactMatchesFile(artifact: Artifact, file: FsFile): boolean {
  if (artifact.text != null && file.encoding !== 'base64') return artifact.text === file.content
  if (!artifact.dataURL) return false
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(artifact.dataURL)
  if (!match) return false
  if (match[2]) return file.encoding === 'base64' && file.content === match[3]
  if (file.encoding === 'base64') return false
  try {
    return file.content === decodeURIComponent(match[3] ?? '')
  } catch {
    return false
  }
}

export function ArtifactCard({
  artifactId,
  conversationId,
  peek = false,
}: {
  artifactId: string
  conversationId?: string
  /**
   * Show the preview whatever the collapse preference says. The composer's
   * queued-attachment chip is a look at what is about to be sent rather than a
   * card in the transcript — it already drops the footer — so it keeps the
   * preview that makes the chip worth showing.
   */
  peek?: boolean
}) {
  const artifact = useArtifacts((s) => s.byId[artifactId])
  const prefs = useSettings((s) => s.s.artifacts)
  const activeConversationId = useFs((s) => s.currentConversationId)
  const workspaceId = conversationId ?? activeConversationId
  const targetFsPath = artifact ? (artifact.localPath ?? tryNormalizeFsPath(artifact.name) ?? undefined) : undefined
  const diskConnected = useShell((s) => Boolean(s.token))
  const diskFile = useDiskFs((s) => targetFsPath ? s.files[targetFsPath] : undefined)
  const browserFile = useFs((s) => (targetFsPath ? s.workspaces[workspaceId]?.files[targetFsPath] : undefined))
  const storedFile = diskConnected ? diskFile : browserFile
  const storedInFs = Boolean(
    artifact && storedFile && ((!diskConnected && artifact.conversationId === workspaceId) || artifactMatchesFile(artifact, storedFile)),
  )

  // Cards arrive closed; a peek (the composer chip) is the one that does not.
  const [collapsed, setCollapsed] = useState(peek ? false : prefs.collapsedByDefault)
  useEffect(() => {
    if (prefs.collapsedByDefault && !peek) setCollapsed(true)
  }, [prefs.collapsedByDefault, artifactId, peek])

  if (!artifact) {
    return (
      <div className="artifact-card skeleton-card" aria-busy="true">
        <div className="artifact-head dim">
          <span className="artifact-icon skeleton" />
          <span className="artifact-name skeleton skeleton-text" />
        </div>
        <div className="artifact-body skeleton-body" style={{ height: 120 }} />
      </div>
    )
  }

  if (artifact.bashExecution) {
    return <BashArtifactCard key={artifact.id} execution={artifact.bashExecution} peek={peek} />
  }

  const kind = artifact.kind
  const Icon = KIND_ICON[kind]
  const src = artifactUrl(artifact)
  const expandedByDefault = kind === 'image' && prefs.autoExpandImages && !prefs.collapsedByDefault
  const isCollapsed = collapsed && !expandedByDefault
  // A minimal card is its name and nothing else: the subtitle (kind, size,
  // provenance, origin) and the footer actions are off, the preview stays.
  const minimal = Boolean(artifact.minimal)

  const provenance =
    artifact.provenance.origin === 'user' ? 'From you' : `From ${artifact.provenance.modelLabel}`

  return (
    <motion.figure
      className={`artifact-card kind-${kind}`}
      initial={{ opacity: 0, y: 8, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      aria-label={`Artifact: ${artifact.name}`}
    >
      <div className="artifact-head">
        <span className={`artifact-icon kind-${kind}`}>
          <Icon size={15} />
        </span>
        <span className="artifact-meta">
          <span className="artifact-name" title={artifact.name}>
            {artifact.name}
          </span>
          {minimal ? null : (
            <span className="artifact-sub">
              {kindLabel(kind)} · {formatBytes(artifact.size)} · {provenance}
              {artifact.localPath ? (
                <>
                  {' '}
                  ·{' '}
                  <span className="artifact-remote" title={`Local file system path: ${artifact.localPath}`}>
                    {artifact.localPath}
                  </span>
                </>
              ) : null}
              {artifact.remote ? (
                <>
                  {' '}
                  ·{' '}
                  <span className="artifact-remote" title={`${artifact.remote.path} @ ${artifact.remote.ref}`}>
                    {artifact.remote.repo}@{artifact.remote.ref}
                  </span>
                </>
              ) : null}
            </span>
          )}
        </span>
        <div className="artifact-head-actions">
          {kind !== 'audio' && (
            <button
              className="icon-btn"
              onClick={() => setCollapsed((c) => !c)}
              aria-expanded={!isCollapsed}
              aria-label={isCollapsed ? 'Expand preview' : 'Collapse preview'}
              title={isCollapsed ? 'Expand preview' : 'Collapse preview'}
              type="button"
            >
              <IconChevronDown size={14} className={isCollapsed ? '' : 'flip-v'} />
            </button>
          )}
        </div>
      </div>

      {!isCollapsed && (
        <div className="artifact-body">
          <Body artifact={artifact} src={src} maxHeight={prefs.maxPreviewHeight} />
        </div>
      )}

      {minimal ? null : (
        <ArtifactActions
          artifact={artifact}
          src={src}
          storedInFs={storedInFs}
          targetFsPath={targetFsPath}
          workspaceId={workspaceId}
        />
      )}
    </motion.figure>
  )
}

/**
 * The row of actions under a card: copy a reference, revise it with the model,
 * push it to GitHub, save it into Local Files, open it on GitHub, download it.
 *
 * Every one of them is an icon with a tooltip. A card is narrow and the row is
 * up to six buttons wide, so the words live in the tooltip (and in the button's
 * accessible name) instead of on the button. A minimal card (the Memory Added
 * card) leaves all of them out.
 */
function ArtifactActions({
  artifact,
  src,
  storedInFs,
  targetFsPath,
  workspaceId,
}: {
  artifact: Artifact
  src?: string
  storedInFs: boolean
  targetFsPath?: string
  workspaceId: string
}) {
  const toast = useUI((s) => s.toast)
  return (
    <figcaption className="artifact-foot icon-actions">
      <button
        className="artifact-action is-icon"
        onClick={async () => {
          const ok = await copyText(`${artifact.name} (${artifact.mime}, ${formatBytes(artifact.size)})`)
          toast({ kind: ok ? 'success' : 'error', title: ok ? 'Reference copied' : 'Copy failed' })
        }}
        aria-label="Copy reference"
        title={`Copy reference — ${artifact.name} (${artifact.mime}, ${formatBytes(artifact.size)})`}
        type="button"
      >
        <IconCopy size={13} />
      </button>
      <button
        className="artifact-action is-icon"
        onClick={() => {
          toast({ kind: 'info', title: `${artifact.name} attached`, detail: 'It will be sent with your next message as context.' })
          window.dispatchEvent(new CustomEvent('slade:attach-artifact', { detail: artifact.id }))
        }}
        aria-label="Revise"
        title="Revise — attach this file and send it back to the model with your next message"
        type="button"
      >
        <IconPin size={13} />
      </button>
      <button
        className="artifact-action is-icon"
        onClick={() => useUI.getState().openPublish({ kind: 'artifact', artifactId: artifact.id })}
        aria-label="Push to GitHub"
        title="Push to GitHub — a commit, a gist, an issue or a pull request"
        type="button"
      >
        <IconGithub size={13} />
      </button>
      <button
        className="artifact-action is-icon"
        onClick={async () => {
          if (useShell.getState().token) {
            const session = workspaceSession()
            const path = targetFsPath ?? artifact.name
            try {
              if (!storedInFs) {
                let content = artifact.text
                let encoding: 'utf8' | 'base64' = 'utf8'
                if (content == null && artifact.dataURL) {
                  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(artifact.dataURL)
                  if (match) { encoding = match[2] ? 'base64' : 'utf8'; content = match[2] ? match[3] : decodeURIComponent(match[3] ?? '') }
                }
                if (content == null) throw new Error('This artifact has no file content available to save.')
                const existing = await maybeReadDiskFile(path, session)
                if (existing && (existing.content !== content || existing.encoding !== encoding) && !window.confirm(`Overwrite the existing disk file ${path} with this artifact?`)) return
                await writeDiskFile(path, content, encoding, existing?.revision ?? null, artifact.provenance, session)
              }
              useDiskFs.setState({ selectedPath: path })
              useUI.getState().openFiles()
            } catch (error) { toast({ kind: 'error', title: 'Could not save to disk', detail: error instanceof Error ? error.message : String(error) }) }
            return
          }
          if (storedInFs && targetFsPath) {
            useFs.getState().selectFile(targetFsPath, workspaceId)
            useUI.getState().openFiles()
            return
          }
          const saved = useFs.getState().saveArtifact(artifact, targetFsPath, workspaceId)
          if (saved) {
            useFs.getState().selectFile(saved.path, workspaceId)
            useUI.getState().openFiles()
            toast({ kind: 'success', title: `Saved ${saved.path} to Local Files` })
          } else {
            toast({ kind: 'error', title: `Couldn't save ${artifact.name} to Local Files` })
          }
        }}
        aria-label={storedInFs ? 'Open in Files' : 'Save'}
        title={
          storedInFs
            ? `Open in Files — ${targetFsPath ?? artifact.name} is already in Local Files`
            : `Save ${artifact.name} to Local Files`
        }
        type="button"
      >
        <IconFolder size={13} />
      </button>
      {artifact.remote ? (
        <a
          className="artifact-action is-icon"
          href={artifact.remote.url}
          target="_blank"
          rel="noreferrer"
          aria-label="Open on GitHub"
          title={`Open on GitHub — ${artifact.remote.path} @ ${artifact.remote.ref}`}
        >
          <IconExternal size={13} />
        </a>
      ) : null}
      {src && (
        <button
          className="artifact-action is-icon"
          onClick={() => downloadUrl(src, artifact.name)}
          aria-label="Download"
          title={`Download ${artifact.name}`}
          type="button"
        >
          <IconDownload size={13} />
        </button>
      )}
    </figcaption>
  )
}

function Body({ artifact, src, maxHeight }: { artifact: Artifact; src?: string; maxHeight: number }) {
  switch (artifact.kind) {
    case 'image':
      return src ? <ImageBody artifact={artifact} src={src} maxHeight={maxHeight} /> : <MissingBody name={artifact.name} />
    case 'code':
      return <CodeArtifact code={artifact.text ?? ''} lang={langFor(artifact)} name={artifact.name} maxHeight={maxHeight} />
    case 'sheet':
      return artifact.columns ? (
        <SheetTable columns={artifact.columns} rows={artifact.rows ?? []} maxHeight={maxHeight} />
      ) : (
        <MissingBody name={artifact.name} note="Spreadsheet preview unavailable for this format." />
      )
    case 'doc':
      return <DocBody artifact={artifact} src={src} maxHeight={maxHeight} />
    case 'audio':
      return src ? <AudioPlayer src={src} name={artifact.name} durationHint={artifact.durationSec} /> : <MissingBody name={artifact.name} />
    case 'video':
      return src ? <VideoPlayer src={src} name={artifact.name} maxHeight={maxHeight} /> : <MissingBody name={artifact.name} />
    default:
      return (
        <div className="artifact-generic">
          <IconArchive size={28} />
          <div className="artifact-generic-text">
            <span className="artifact-generic-title">No inline preview</span>
            <span className="artifact-generic-sub">
              {artifact.mime} · {formatBytes(artifact.size)} — use Download to save this file.
            </span>
          </div>
        </div>
      )
  }
}

function langFor(a: Artifact): string {
  const ext = a.name.includes('.') ? a.name.split('.').pop()! : ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
    sh: 'bash', yml: 'yaml', yaml: 'yaml', md: 'markdown', json: 'json',
    html: 'xml', svg: 'xml', css: 'css', sql: 'sql', toml: 'ini', txt: '',
  }
  return map[ext.toLowerCase()] ?? ''
}

function ImageBody({ artifact, src, maxHeight }: { artifact: Artifact; src: string; maxHeight: number }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <button
      className="image-artifact"
      onClick={() => useUI.getState().openLightbox(artifact.id)}
      style={{ maxHeight }}
      aria-label={`Zoom image ${artifact.name}`}
      type="button"
    >
      {!loaded && <div className="img-skeleton" />}
      <img src={src} alt={artifact.name} loading="lazy" onLoad={() => setLoaded(true)} onError={() => setLoaded(true)} />
      <span className="image-zoom-hint">
        <IconExpand size={13} /> Click to zoom
      </span>
    </button>
  )
}

function DocBody({ artifact, src, maxHeight }: { artifact: Artifact; src?: string; maxHeight: number }) {
  const mime = artifact.mime
  const name = artifact.name
  if (mime === 'application/pdf' && src) {
    return (
      <div className="pdf-artifact">
        <iframe src={src} title={name} style={{ height: Math.min(maxHeight, 480) }} />
        <div className="pdf-actions">
          <a className="artifact-action" href={src} target="_blank" rel="noreferrer">
            <IconFileText size={12} /> Open full document
          </a>
        </div>
      </div>
    )
  }
  if (artifact.text != null) {
    if (name.toLowerCase().endsWith('.md')) {
      return (
        <div className="doc-artifact md" style={{ maxHeight }}>
          <MarkdownPreview text={artifact.text} />
        </div>
      )
    }
    return (
      <pre className="doc-artifact plain" style={{ maxHeight }} tabIndex={0}>
        {artifact.text}
      </pre>
    )
  }
  return <MissingBody name={name} note="Preview not supported for this document format." />
}

function MarkdownPreview({ text }: { text: string }) {
  // Lazy import avoids a static cycle (Markdown → ArtifactCard → Markdown).
  const [Md, setMd] = useState<null | ComponentType<{ text: string }>>(null)
  useEffect(() => {
    let alive = true
    import('../chat/Markdown').then(({ Markdown }) => {
      if (alive) setMd(() => Markdown)
    })
    return () => {
      alive = false
    }
  }, [])
  if (!Md) return <div className="skeleton-body" style={{ height: 80 }} />
  return <Md text={text} />
}

export function MissingBody({ name, note }: { name: string; note?: string }) {
  return (
    <div className="artifact-generic">
      <IconFile size={26} />
      <div className="artifact-generic-text">
        <span className="artifact-generic-title">{name}</span>
        <span className="artifact-generic-sub">{note ?? 'Preview unavailable — download to view.'}</span>
      </div>
    </div>
  )
}
