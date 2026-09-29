import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { placeMenu, type MenuAnchor, type Placement } from '../../lib/menuPlacement'

/** useLayoutEffect warns during SSR; fall back to useEffect on the server. */
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

export interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

/** Why a menu closed. Callers use it to decide where focus goes next. */
export type MenuCloseReason = 'select' | 'dismiss' | 'escape'

export interface MenuProps {
  /** Accessible name for the menu. */
  label: string
  items: MenuItem[]
  anchor: MenuAnchor
  /**
   * The element that opened the menu. When the menu hangs off a button
   * (`anchor.kind === 'rect'`) that button toggles its own menu, so a press on it is
   * not treated as "outside". It is also what scrolling is measured against.
   */
  opener: HTMLElement | null
  onClose: (reason: MenuCloseReason) => void
}

const ITEM = '[role="menuitem"]:not(:disabled)'

/**
 * A small, accessible popup menu (`role="menu"`).
 *
 * - Rendered in a portal with fixed coordinates, so no scrolling or clipping ancestor
 *   (the sidebar list, the header) can cut it off.
 * - Measured before it is shown, then placed by `placeMenu` (flips and clamps to the window).
 * - Keys: ↑ ↓ Home End move, Enter / Space choose, Esc or Tab close. Hovering an item
 *   focuses it, so there is only ever one highlighted row.
 * - Closes on an outside press, a resize, and any scroll that moves the opener; a scroll
 *   somewhere unrelated (a chat streaming in behind a header menu) leaves it open.
 *
 * Mount it while it should be open; it has no `open` prop.
 */
export function Menu({ label, items, anchor, opener, onClose }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [placed, setPlaced] = useState<Placement | null>(null)

  // Read the latest callback from document listeners without re-subscribing every render.
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  // First paint is invisible at 0,0 so the menu can be measured; this runs before the browser paints.
  useIsoLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement
    // offsetWidth/Height are layout sizes, so the entrance animation's scale can't skew them.
    setPlaced(
      placeMenu(anchor, { width: el.offsetWidth, height: el.offsetHeight }, { width: root.clientWidth, height: root.clientHeight }),
    )
  }, [anchor])

  const ready = placed !== null
  useEffect(() => {
    if (!ready) return
    // A hidden element cannot take focus, so wait until the menu is visible.
    ref.current?.querySelector<HTMLElement>(ITEM)?.focus({ preventScroll: true })
  }, [ready])

  useEffect(() => {
    const dismiss = () => closeRef.current('dismiss')
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (!t || ref.current?.contains(t)) return
      // The opening button toggles from its own click; dismissing here too would
      // close the menu and let that click reopen it.
      if (anchor.kind === 'rect' && opener?.contains(t)) return
      dismiss()
    }
    const onScroll = (e: Event) => {
      const t = e.target as Node | null
      if (!t || ref.current?.contains(t)) return
      // Only a scroller that carries the opener moves what the menu hangs off.
      if (!opener || t.contains(opener)) dismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [anchor, opener])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])
    const at = nodes.indexOf(document.activeElement as HTMLElement)
    // Negative indexes wrap, so -1 is "the last item".
    const focusAt = (n: number) => nodes[(n + nodes.length) % nodes.length]?.focus({ preventScroll: true })
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focusAt(at + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        focusAt(at <= 0 ? -1 : at - 1)
        break
      case 'Home':
        e.preventDefault()
        focusAt(0)
        break
      case 'End':
        e.preventDefault()
        focusAt(-1)
        break
      case 'Escape':
        e.preventDefault()
        // Don't let the app's own Esc handling (closing a drawer) also fire.
        e.stopPropagation()
        closeRef.current('escape')
        break
      case 'Tab':
        // The menu lives at the end of <body>; tabbing out of it would land somewhere
        // unrelated. Close it and let the caller put focus back where it came from.
        e.preventDefault()
        closeRef.current('escape')
        break
    }
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      className={`menu${placed?.flipped ? ' flipped' : ''}`}
      style={placed ? { left: placed.left, top: placed.top } : { left: 0, top: 0, visibility: 'hidden' }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={`menu-item${item.danger ? ' danger' : ''}`}
          disabled={item.disabled}
          onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
          onClick={() => {
            closeRef.current('select')
            item.onSelect()
          }}
        >
          {item.icon ? (
            <span className="menu-item-icon" aria-hidden="true">
              {item.icon}
            </span>
          ) : null}
          <span className="menu-item-label">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
