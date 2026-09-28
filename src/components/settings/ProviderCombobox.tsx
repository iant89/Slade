import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AddableProvider } from '../../lib/modelCatalog'
import { IconChevronDown, IconSearch } from '../icons'

/** useLayoutEffect warns during SSR; fall back to useEffect on the server. */
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

/** Providers offered by "Add a model" (the mock simulator is not addable). */
export const ADDABLE_PROVIDERS: {
  id: AddableProvider
  label: string
  hint: string
}[] = [
  { id: 'openai', label: 'OpenAI', hint: 'GPT-5.x flagships' },
  { id: 'anthropic', label: 'Anthropic', hint: 'Claude Opus & Sonnet' },
  { id: 'google', label: 'Google Gemini', hint: 'Gemini 3 family' },
  { id: 'openrouter', label: 'OpenRouter', hint: 'One key, hundreds of models' },
  { id: 'openai-compatible', label: 'OpenAI-compatible', hint: 'DeepSeek, Moonshot, Z.ai, Ollama… custom URL' },
]

/**
 * Filterable provider dropdown (combobox). Opens a fixed-position popover so
 * it is never clipped by the scrolling settings pane; type-to-filter, arrow
 * keys to move, Enter to pick, Esc to close.
 */
export function ProviderCombobox({
  value,
  onChange,
}: {
  value: AddableProvider | null
  onChange: (p: AddableProvider) => void
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const selected = ADDABLE_PROVIDERS.find((p) => p.id === value) ?? null

  const options = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return ADDABLE_PROVIDERS
    return ADDABLE_PROVIDERS.filter(
      (p) => p.label.toLowerCase().includes(q) || p.hint.toLowerCase().includes(q) || p.id.includes(q),
    )
  }, [filter])

  // Anchor the popover to the trigger in viewport coordinates.
  useIsoLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (r) setRect({ top: r.bottom + 6, left: r.left, width: r.width })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    // Focus the filter as soon as the popover exists.
    requestAnimationFrame(() => filterRef.current?.focus())
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (filterRef.current?.parentElement?.contains(t)) return
      if (listRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const openPopover = () => {
    setFilter('')
    setActive(value ? ADDABLE_PROVIDERS.findIndex((p) => p.id === value) : 0)
    setOpen(true)
  }

  const pick = (id: AddableProvider) => {
    onChange(id)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openPopover()
      }
      return
    }
    if (e.key === 'Escape') {
      e.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(options.length - 1, a + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const opt = options[active]
      if (opt) pick(opt.id)
    }
  }

  return (
    <div className={`combobox${open ? ' open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="combobox-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPopover())}
        onKeyDown={onKeyDown}
      >
        <span className="combobox-value">
          {selected ? (
            <>
              <strong>{selected.label}</strong>
              <span className="combobox-value-hint">{selected.hint}</span>
            </>
          ) : (
            <span className="combobox-placeholder">Select a provider…</span>
          )}
        </span>
        <IconChevronDown size={14} className="cb-caret" />
      </button>

      {open &&
        rect &&
        createPortal(
          <div className="combobox-pop" style={{ top: rect.top, left: rect.left, width: Math.max(rect.width, 280) }}>
            <label className="combobox-filter">
              <IconSearch size={13} />
              <input
                ref={filterRef}
                value={filter}
                placeholder="Filter providers…"
                aria-label="Filter providers"
                spellCheck={false}
                onChange={(e) => {
                  setFilter(e.target.value)
                  setActive(0)
                }}
                onKeyDown={onKeyDown}
              />
            </label>
            <ul className="combobox-list" role="listbox" aria-label="Providers" ref={listRef}>
              {options.map((p, i) => (
                <li
                  key={p.id}
                  role="option"
                  aria-selected={value === p.id}
                  className={`combobox-opt${i === active ? ' active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(p.id)}
                >
                  <span className="opt-label">
                    {p.label}
                    {value === p.id ? <span className="opt-check"> ✓</span> : null}
                  </span>
                  <span className="opt-hint">{p.hint}</span>
                </li>
              ))}
              {options.length === 0 && <li className="combobox-empty">No provider matches “{filter}”.</li>}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  )
}
