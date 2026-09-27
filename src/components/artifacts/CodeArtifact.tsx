import { useMemo } from 'react'
import { createLowlight, common } from 'lowlight'
import { toHtml } from 'hast-util-to-html'
import { copyText } from '../../lib/clipboard'
import { IconCheck, IconCopy } from '../icons'

const lowlight = createLowlight(common)

/** Syntax-highlighted, scrollable code preview with copy button. */
export function CodeArtifact({
  code,
  lang,
  name,
  maxHeight,
}: {
  code: string
  lang?: string
  name?: string
  maxHeight?: number
}) {
  const highlighted = useMemo(() => {
    const l = (lang ?? '').toLowerCase()
    try {
      if (l && lowlight.registered(l)) return toHtml(lowlight.highlight(l, code))
      // Try by filename extension for artifacts.
      if (name) {
        const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
        if (ext && lowlight.registered(ext)) return toHtml(lowlight.highlight(ext, code))
      }
    } catch {
      /* fall through to plain */
    }
    return null
  }, [code, lang, name])

  return (
    <div className="code-artifact" style={{ maxHeight }}>
      <div className="code-artifact-bar">
        <span className="code-lang">{(lang ?? 'code').toUpperCase()}</span>
        <CopyButton text={code} small />
      </div>
      <pre className="code-artifact-pre">
        {highlighted ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </div>
  )
}

export function CopyButton({ text, small, label = 'Copy' }: { text: string; small?: boolean; label?: string }) {
  // Tiny inline component with its own copied state.
  return (
    <button
      className={`copy-btn${small ? ' small' : ''}`}
      onClick={async (e) => {
        e.stopPropagation()
        const ok = await copyText(text)
        const btn = e.currentTarget
        btn.classList.add('copied')
        btn.setAttribute('aria-label', ok ? 'Copied' : 'Copy failed')
        setTimeout(() => btn.classList.remove('copied'), 1400)
      }}
      aria-label={label}
      title={label}
      type="button"
    >
      <span className="copy-idle">
        <IconCopy size={small ? 12 : 14} />
      </span>
      <span className="copy-done">
        <IconCheck size={small ? 12 : 14} />
      </span>
    </button>
  )
}
