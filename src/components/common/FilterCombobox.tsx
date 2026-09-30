import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconChevronDown, IconLoader, IconSearch } from '../icons'

/** useLayoutEffect warns during SSR; fall back to useEffect on the server. */
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

export interface ComboboxOption {
  /** Stable identity + the value handed back to `onSelect`. */
  value: string
  /** Plain text used for type-to-filter matching. */
  text: string
  /** What the row shows. */
  label: ReactNode
  /** Small muted second line. */
  hint?: ReactNode
}

interface FilterComboboxProps {
  /** Currently selected option value, if any. */
  value?: string
  options: ComboboxOption[]
  onSelect: (value: string) => void

  placeholder: string
  /** Accessible name for the listbox (the trigger is named by its content). */
  ariaLabel: string
  filterPlaceholder?: string
  /** Tooltip on the trigger button. */
  title?: string
  /** Small leading glyph inside the trigger. */
  icon?: ReactNode

  /** Shown when the base option list is empty (before filtering). */
  empty?: ReactNode
  /** Extra row above the list — errors, refresh hints, … */
  notice?: ReactNode
  loading?: boolean
  loadingText?: string
  /** Query-dependent rows computed by the caller (e.g. "open owner/repo"). */
  extras?: (filterText: string) => ComboboxOption[]

  /** Minimum popover width in px (it also never exceeds the viewport). */
  minWidth?: number
  className?: string
}

const matches = (o: ComboboxOption, q: string) =>
  !q || o.text.toLowerCase().includes(q)

/**
 * Generic type-to-filter combobox: a trigger button plus a portaled popover
 * with a filter input, keyboard navigation (↑/↓/Enter/Esc) and click-outside
 * dismissal. The popover opens upward by default — it is meant for controls
 * that sit at the bottom of a surface (like the composer) — and flips below
 * the trigger when there is not enough room above.
 */
export function FilterCombobox({
  value,
  options,
  onSelect,
  placeholder,
  ariaLabel,
  filterPlaceholder,
  title,
  icon,
  empty,
  notice,
  loading,
  loadingText,
  extras,
  minWidth = 280,
  className = '',
}: FilterComboboxProps) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const [rect, setRect] = useState<{
    left: number
    width: number
    /** Popover bottom offset from the viewport bottom (opens upward). */
    bottom: number
    /** Popover top offset from the viewport top (opens downward). */
    top: number
    placement: 'up' | 'down'
  } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const q = filter.trim().toLowerCase()

  const filtered = useMemo(() => {
    // While loading, the visible list is just the loading row — never let
    // the keyboard pick an option the user cannot see.
    if (loading) return []
    const base = q ? options.filter((o) => matches(o, q)) : options
    if (!extras) return base
    const extra = q ? extras(q) : []
    if (extra.length === 0) return base
    const seen = new Set(extra.map((e) => e.value))
    return [...extra, ...base.filter((o) => !seen.has(o.value))]
  }, [options, q, extras, loading])

  // Keep the highlight inside the list as options change underneath it.
  const activeIndex = filtered.length > 0 ? Math.min(active, filtered.length - 1) : -1

  // Anchor the popover to the trigger in viewport coordinates; open it above
  // (composer-style) unless the space up there is clearly insufficient.
  useIsoLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (!r) return
      const spaceAbove = r.top
      const spaceBelow = window.innerHeight - r.bottom
      const placement: 'up' | 'down' = spaceAbove >= 300 || spaceAbove >= spaceBelow ? 'up' : 'down'
      setRect({
        left: r.left,
        width: r.width,
        bottom: window.innerHeight - r.bottom + 6,
        top: r.bottom + 6,
        placement,
      })
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
      if (popRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Keep the highlighted row visible while arrowing through the list.
  useEffect(() => {
    if (!open || activeIndex < 0) return
    const row = listRef.current?.children[activeIndex] as HTMLElement | undefined
    row?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  const openPopover = () => {
    setFilter('')
    const i = value ? options.findIndex((o) => o.value === value) : -1
    setActive(i >= 0 ? i : 0)
    setOpen(true)
  }

  const pick = (v: string) => {
    onSelect(v)
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
      setActive((a) => (filtered.length === 0 ? 0 : Math.min(filtered.length - 1, a + 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const opt = filtered[activeIndex]
      if (opt) pick(opt.value)
    }
  }

  const selected = options.find((o) => o.value === value)

  // Width: at least `minWidth`, never wider than the viewport, and never
  // narrower than the trigger. Left edge clamped so it stays on screen.
  const popWidth = rect
    ? Math.max(rect.width, Math.min(minWidth, window.innerWidth - 16))
    : minWidth
  const popLeft = rect ? Math.min(Math.max(8, rect.left), window.innerWidth - popWidth - 8) : 0

  return (
    <div className={`combobox${className ? ` ${className}` : ''}${open ? ' open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="combobox-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title ?? ariaLabel}
        onClick={() => (open ? setOpen(false) : openPopover())}
        onKeyDown={onKeyDown}
      >
        {icon ? <span className="cb-icon">{icon}</span> : null}
        <span className="combobox-value">
          <span className={selected ? 'cb-label' : 'cb-label combobox-placeholder'}>
            {selected ? selected.label : placeholder}
          </span>
        </span>
        <IconChevronDown size={13} className="cb-caret" />
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={popRef}
            className="combobox-pop"
            style={
              rect.placement === 'up'
                ? { bottom: rect.bottom, left: popLeft, width: popWidth }
                : { top: rect.top, left: popLeft, width: popWidth }
            }
          >
            <label className="combobox-filter">
              <IconSearch size={13} />
              <input
                ref={filterRef}
                value={filter}
                placeholder={filterPlaceholder ?? `Filter…`}
                aria-label={filterPlaceholder ?? `Filter ${ariaLabel}`}
                spellCheck={false}
                onChange={(e) => {
                  setFilter(e.target.value)
                  setActive(0)
                }}
                onKeyDown={onKeyDown}
              />
            </label>
            {notice ? <div className="combobox-notice">{notice}</div> : null}
            <ul className="combobox-list" role="listbox" aria-label={ariaLabel} ref={listRef}>
              {loading ? (
                <li className="combobox-empty combobox-loading">
                  <IconLoader size={13} /> {loadingText ?? 'Loading…'}
                </li>
              ) : null}
              {!loading &&
                filtered.map((o, i) => (
                  <li
                    key={o.value}
                    role="option"
                    aria-selected={value === o.value}
                    className={`combobox-opt${i === activeIndex ? ' active' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(o.value)}
                  >
                    <span className="opt-label">
                      <span className="opt-main">{o.label}</span>
                      {value === o.value ? <span className="opt-check">✓</span> : null}
                    </span>
                    {o.hint != null ? <span className="opt-hint">{o.hint}</span> : null}
                  </li>
                ))}
              {!loading && filtered.length === 0 && (
                <li className="combobox-empty">
                  {options.length === 0 ? empty : <>No matches for “{filter.trim()}”.</>}
                </li>
              )}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  )
}
