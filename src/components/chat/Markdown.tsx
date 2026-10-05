import { memo, useMemo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ArtifactSource, BashExecution } from '../../types'
import { useArtifacts } from '../../store/artifacts'
import { ArtifactCard } from '../artifacts/ArtifactCard'
import { CopyButton } from '../artifacts/CodeArtifact'
import { mimeFromName, classifyArtifact } from '../../lib/mime'
import { fsBaseName, looksLikeFilePath, tryNormalizeFsPath } from '../../lib/fs'

/** Info-string languages that mean "this fence is a shell command", not a file. */
const SHELL_FENCE_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'shellscript', 'fish', 'ksh', 'csh'])

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
  conversationId?: string,
): string {
  const store = useArtifacts.getState()
  const localPath = tryNormalizeFsPath(fileName) ?? undefined
  const displayName = localPath ? fsBaseName(localPath) : fileName
  const id = `art_gen_${messageId}_${hashId(localPath ?? fileName)}`
  const existing = store.byId[id]
  if (existing) {
    if (existing.text !== code || existing.localPath !== localPath) {
      store.add({
        ...existing,
        text: code,
        size: code.length,
        localPath: localPath ?? existing.localPath,
        conversationId: conversationId ?? existing.conversationId,
      })
    }
    return id
  }
  const mime = mimeFromName(displayName, 'text/plain')
  const kind = classifyArtifact(displayName, mime)
  store.add({
    id,
    name: displayName,
    mime,
    size: code.length,
    kind,
    createdAt: Date.now(),
    provenance,
    localPath,
    conversationId,
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

/**
 * A colon-tagged shell fence whose "filename" is a command (` ```bash:ls `),
 * not a path (` ```bash:scripts/setup.sh `). Those used to land as Document
 * cards because `ls` has no extension and the fallback MIME is text/plain.
 */
function isShellCommandFence(lang: string, fileName: string): boolean {
  return Boolean(fileName) && SHELL_FENCE_LANGS.has(lang.toLowerCase()) && !looksLikeFilePath(fileName)
}

/**
 * Reuse the same id the file-artifact path would have used for this token, so a
 * conversation that already persisted `ls` as a document upgrades in place.
 */
function ensureBashArtifactFromCode(
  command: string,
  output: string,
  provenance: ArtifactSource,
  messageId: string,
  conversationId?: string,
): string {
  const store = useArtifacts.getState()
  const id = `art_gen_${messageId}_${hashId(tryNormalizeFsPath(command) ?? command)}`
  const existing = store.byId[id]
  const startedAt = existing?.bashExecution?.startedAt ?? existing?.createdAt ?? Date.now()
  const previous = existing?.bashExecution
  const finishedAt = previous && previous.status !== 'running' ? previous.finishedAt : startedAt
  const execution: BashExecution = {
    command,
    output,
    startedAt,
    finishedAt,
    status: 'finished',
    exitCode: 0,
    isMock: true,
  }
  if (
    existing?.bashExecution?.command === command &&
    existing.bashExecution.output === output &&
    existing.bashExecution.status === 'finished'
  ) {
    return id
  }
  store.add({
    ...(existing ?? {
      id,
      createdAt: startedAt,
      provenance,
    }),
    id,
    name: 'Bash',
    mime: 'text/plain',
    size: output.length,
    kind: 'code',
    bashExecution: execution,
    conversationId: conversationId ?? existing?.conversationId,
    localPath: undefined,
    text: output,
  })
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
  conversationId?: string
}

export const Markdown = memo(function Markdown({ text, provenance, messageId, conversationId }: MarkdownProps) {
  const components = useMemo(() => {
    return {
      pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
      code: ({ className, children }: { className?: string; children?: ReactNode }) => {
        const raw = nodeText(children)
        // The info string carries the filename after a colon (```csv:sales_q3.csv),
        // so the capture must include ':' — and '.'/'/' for path-like names —
        // or the artifact never registers and the fence renders as a plain
        // code block.
        const langMatch = /language-([\w+#.:/-]+)/.exec(className ?? '')
        const token = langMatch?.[1] ?? ''
        const fsWriteMatch = /^fs:(?:write|create|save|update|append):(.+)$/i.exec(token)
        const colon = token.indexOf(':')
        // An `fs:` directive that *names* a file without carrying its contents:
        // delete, move, and — the one that used to leak — pull. A pull reads a
        // file out of the connected repository into Local Files; the file is not
        // the model's output, so it must not become an artifact card in the
        // message. What actually happened is already on the record: the GitHub
        // read card says which repository paths were fetched, and the run's file
        // summary says they were pulled.
        const isFsCmd = /^fs:(?:delete|rm|remove|move|rename|pull|fetch|checkout)(?::|$)/i.test(token)
        if (isFsCmd) return null
        const fileName = fsWriteMatch ? fsWriteMatch[1]! : colon >= 0 ? token.slice(colon + 1) : ''
        const lang = fsWriteMatch ? '' : colon >= 0 ? token.slice(0, colon) : token

        if (fileName && provenance && messageId) {
          const artifactId = isShellCommandFence(lang, fileName)
            ? ensureBashArtifactFromCode(fileName, raw, provenance, messageId, conversationId)
            : ensureArtifactFromCode(fileName, lang, raw, provenance, messageId, conversationId)
          return <ArtifactCard artifactId={artifactId} conversationId={conversationId} />
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
  }, [provenance, messageId, conversationId])

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

export const StreamingMarkdown = memo(function StreamingMarkdown({ text, provenance, messageId, conversationId }: MarkdownProps) {
  return <Markdown text={text} provenance={provenance} messageId={messageId} conversationId={conversationId} />
})
