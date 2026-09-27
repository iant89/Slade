import { memo, useMemo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ArtifactSource } from '../../types'
import { useArtifacts } from '../../store/artifacts'
import { ArtifactCard } from '../artifacts/ArtifactCard'
import { CopyButton } from '../artifacts/CodeArtifact'
import { mimeFromName, classifyArtifact } from '../../lib/mime'

/* ------------------------------------------------------------------ */
/* Model-emitted artifacts: fenced blocks with a filename info string  */
/* (```csv:sales_q3.csv) become full artifact cards in the thread.     */
/* ------------------------------------------------------------------ */

function hashId(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/**
 * Model-emitted artifact, stable per (message, filename). While the code
 * block is still streaming, the same artifact is updated in place so the
 * card grows live instead of being re-created every token.
 */
function ensureArtifactFromCode(
  fileName: string,
  _lang: string,
  code: string,
  provenance: ArtifactSource,
  messageId: string,
): string {
  const store = useArtifacts.getState()
  const id = `art_gen_${messageId}_${hashId(fileName)}`
  const existing = store.byId[id]
  if (existing) {
    if (existing.text !== code) store.add({ ...existing, text: code, size: code.length })
    return id
  }
  const mime = mimeFromName(fileName, 'text/plain')
  const kind = classifyArtifact(fileName, mime)
  store.add({
    id,
    name: fileName,
    mime,
    size: code.length,
    kind,
    createdAt: Date.now(),
    provenance,
    text: code,
  })
  if (kind === 'sheet') {
    import('../../lib/csv').then(({ parseCSV }) => {
      const { rows } = parseCSV(code)
      const cur = useArtifacts.getState().byId[id]
      if (cur) useArtifacts.getState().add({ ...cur, columns: rows[0] ?? [], rows: rows.slice(1) })
    })
  }
  return id
}

/* ------------------------------------------------------------------ */
/* Code block with copy button                                         */
/* ------------------------------------------------------------------ */

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (typeof node === 'object' && 'props' in (node as unknown as Record<string, unknown>)) {
    return nodeText((node as unknown as { props?: { children?: ReactNode } }).props?.children)
  }
  return ''
}

function isBlockCode(children: ReactNode, className?: string): boolean {
  if (className?.includes('language-')) return true
  return nodeText(children).includes('\n')
}

/* ------------------------------------------------------------------ */
/* Main renderer                                                       */
/* ------------------------------------------------------------------ */

export interface MarkdownProps {
  text: string
  /** When provided, ```lang:filename blocks in AI output become artifact cards. */
  provenance?: ArtifactSource
  messageId?: string
}

export const Markdown = memo(function Markdown({ text, provenance, messageId }: MarkdownProps) {
  const components = useMemo(() => {
    return {
      pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
      code: ({ className, children }: { className?: string; children?: ReactNode }) => {
        const raw = nodeText(children)
        const langMatch = /language-([\w+#-]+)/.exec(className ?? '')
        const token = langMatch?.[1] ?? ''
        const colon = token.indexOf(':')
        const fileName = colon >= 0 ? token.slice(colon + 1) : ''
        const lang = colon >= 0 ? token.slice(0, colon) : token

        if (fileName && provenance && messageId) {
          const artifactId = ensureArtifactFromCode(fileName, lang, raw, provenance, messageId)
          return <ArtifactCard artifactId={artifactId} />
        }

        if (isBlockCode(children, className) && (className || raw.includes('\n'))) {
          return (
            <div className="code-block">
              <div className="code-block-bar">
                <span className="code-lang">{(lang || 'text').toUpperCase()}</span>
                <CopyButton text={raw} small />
              </div>
              <pre className="hljs" tabIndex={0}>
                <code className={className}>{children}</code>
              </pre>
            </div>
          )
        }
        return <code className="inline-code">{children}</code>
      },
      a: ({ href, children }: { href?: string; children?: ReactNode }) => (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      ),
      table: ({ children }: { children?: ReactNode }) => (
        <div className="md-table-wrap" tabIndex={0}>
          <table>{children}</table>
        </div>
      ),
    }
  }, [provenance, messageId])

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

export const StreamingMarkdown = memo(function StreamingMarkdown({ text, provenance, messageId }: MarkdownProps) {
  return <Markdown text={text} provenance={provenance} messageId={messageId} />
})
