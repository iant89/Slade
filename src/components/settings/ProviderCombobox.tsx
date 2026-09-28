import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSettings } from '../../store/settings'
import { useUI } from '../../store/ui'
import { supportedProvider } from '../../lib/providerCatalog'
import { IconChevronDown, IconSearch } from '../icons'

/** useLayoutEffect warns during SSR; fall back to useEffect on the server. */
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

/**
 * Filterable provider dropdown (combobox) for the "Add a model" form.
 *
 * Lists the *configured* provider instances (Settings → Providers) — a model
 * can only be added onto a provider that exists — excluding the built-in
 * simulator, whose models ship with the app. Opens a fixed-position popover
 * so it is never clipped by the scrolling settings pane; type-to-filter,
 * arrow keys to move, Enter to pick, Esc to close.
 */
export function ProviderCombobox({
  value,
  onChange,
}: {
  value: string | null
  onChange: (id: string) => void
}) {
  const providers = useSettings((s) => s.s.providers)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const selected = providers.find((p) => p.id === value) ?? null

  // Simulator models are not addable (they ship with the app), so the
  // simulator provider is not offered here either.
  const options = useMemo(() => {
    const addable = providers.filter((p) => p.kind !== 'mock')
    const q = filter.trim().toLowerCase()
    if (!q) return addable
    return addable.filter((p) => {
      const kindLabel = supportedProvider(p.kind)?.label ?? p.kind
      return (
        p.label.toLowerCase().includes(q) ||
        kindLabel.toLowerCase().includes(q) ||
        (supportedProvider(p.kind)?.hint.toLowerCase().includes(q) ?? false) ||
        p.kind.includes(q)
      )
    })
  }, [providers, filter])

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
    setActive(value ? providers.findIndex((p) => p.id === value) : 0)
    setOpen(true)
  }

  const pick = (id: string) => {
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

  const gotoProviders = () => {
    setOpen(false)
    // Hand the user to the Providers tab, where the "Add a provider" dialog lives.
    useUI.getState().setSettingsTab('providers')
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
              <span className="combobox-value-hint">{supportedProvider(selected.kind)?.label ?? selected.kind}</span>
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
                  <span className="opt-hint">{supportedProvider(p.kind)?.label ?? p.kind}</span>
                </li>
              ))}
              {options.length === 0 && (
                <li className="combobox-empty">
                  {providers.some((p) => p.kind !== 'mock') ? (
                    `No provider matches “${filter}”.`
                  ) : (
                    <>
                      No providers configured yet.{' '}
                      <button className="link-btn" type="button" onClick={gotoProviders}>
                        Add a provider first
                      </button>
                    </>
                  )}
                </li>
              )}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  )
}
