import { useEffect, useState, type ComponentType } from 'react'
import { motion } from 'framer-motion'
import type { Artifact } from '../../types'
import { useArtifacts } from '../../store/artifacts'
import { useSettings } from '../../store/settings'
import { useUI } from '../../store/ui'
import { formatBytes } from '../../lib/format'
import { kindLabel } from '../../lib/mime'
import { artifactUrl, copyText, downloadUrl } from '../../lib/clipboard'
import {
  IconAudio,
  IconArchive,
  IconChevronDown,
  IconCode,
  IconDownload,
  IconExpand,
  IconExternal,
  IconFile,
  IconFileText,
  IconGithub,
  IconImage,
  IconPin,
  IconTable,
  IconVideo,
} from '../icons'
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

export function ArtifactCard({ artifactId }: { artifactId: string }) {
  const artifact = useArtifacts((s) => s.byId[artifactId])
  const prefs = useSettings((s) => s.s.artifacts)
  const toast = useUI((s) => s.toast)

  const [collapsed, setCollapsed] = useState(prefs.collapsedByDefault)
  useEffect(() => {
    if (prefs.collapsedByDefault) setCollapsed(true)
  }, [prefs.collapsedByDefault, artifactId])

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

  const kind = artifact.kind
  const Icon = KIND_ICON[kind]
  const src = artifactUrl(artifact)
  const expandedByDefault = kind === 'image' && prefs.autoExpandImages && !prefs.collapsedByDefault
  const isCollapsed = collapsed && !expandedByDefault

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
          <span className="artifact-sub">
            {kindLabel(kind)} · {formatBytes(artifact.size)} · {provenance}
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

      <figcaption className="artifact-foot">
        <button
          className="artifact-action"
          onClick={async () => {
            const ok = await copyText(`${artifact.name} (${artifact.mime}, ${formatBytes(artifact.size)})`)
            toast({ kind: ok ? 'success' : 'error', title: ok ? 'Reference copied' : 'Copy failed' })
          }}
          type="button"
        >
          Copy reference
        </button>
        <button
          className="artifact-action"
          onClick={() => {
            useUI
              .getState()
              .toast({ kind: 'info', title: `${artifact.name} attached`, detail: 'It will be sent with your next message as context.' })
            window.dispatchEvent(new CustomEvent('slade:attach-artifact', { detail: artifact.id }))
          }}
          type="button"
          title="Send this artifact back to the model as context"
        >
          <IconPin size={12} /> Send back to model
        </button>
        <button
          className="artifact-action"
          onClick={() => useUI.getState().openPublish({ kind: 'artifact', artifactId: artifact.id })}
          title="Publish this artifact to GitHub as a gist, a commit or an issue"
          type="button"
        >
          <IconGithub size={12} /> Publish to GitHub
        </button>
        {artifact.remote ? (
          <a
            className="artifact-action"
            href={artifact.remote.url}
            target="_blank"
            rel="noreferrer"
            title={`Open ${artifact.remote.path} on GitHub`}
          >
            <IconExternal size={12} /> GitHub
          </a>
        ) : null}
        {src && (
          <button className="artifact-action" onClick={() => downloadUrl(src, artifact.name)} type="button">
            <IconDownload size={12} /> Download
          </button>
        )}
      </figcaption>
    </motion.figure>
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
