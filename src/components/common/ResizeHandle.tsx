import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
  clampPanelWidth,
  edgeDistance,
  GHOST_ARM_MS,
  MIN_PANEL_W,
  snapRect,
  snapTargetWidth,
  zoneFor,
  type PanelSide,
} from '../../lib/panelResize'

export interface ResizeHandleProps {
  /** The side of the viewport the panel docks to. The handle sits on the panel's bottom corner: `right` → bottom-left, `left` → bottom-right. */
  side: PanelSide
  /** Panel element whose CSS custom property receives the live width. */
  panelRef: RefObject<HTMLElement | null>
  /** CSS custom property the panel's width resolves through. */
  varName: string
  /** Default (no override) width, used to detect "back to default". */
  fallback: number
  /** Committed width from settings, or undefined when the panel runs at its default. */
  width?: number
  /** Overlay drawers may span the whole viewport; grid panels leave the chat room. */
  overlay?: boolean
  min?: number
  label: string
  onCommit: (width: number | null) => void
}

interface GhostBox {
  left: number
  width: number
}

/**
 * Corner grip that resizes a panel, with edge-snapping:
 *
 * - Drag the panel's far edge; the width clamps to [min, snapTarget], so the
 *   snap sits at the top of the drag range instead of beyond it.
 * - Bring the dragged edge within the snap zone of the opposite viewport edge
 *   and hold: after a short dwell a ghost panel draws where the panel will go.
 * - Release while the ghost is up → the panel snaps flush. Drag away first →
 *   the ghost disappears and releasing keeps the free width.
 * - Escape during a drag cancels it; on the keyboard, arrows nudge, Home/End
 *   set min/full, Enter snaps, Backspace resets to the default width.
 */
export function ResizeHandle({
  side,
  panelRef,
  varName,
  fallback,
  width,
  overlay = false,
  min = MIN_PANEL_W,
  label,
  onCommit,
}: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false)
  const [near, setNear] = useState(false)
  const [ghost, setGhost] = useState<GhostBox | null>(null)
  const nearRef = useRef(false)
  const ghostRef = useRef(false)
  const start = useRef({ x: 0, w: 0 })
  const live = useRef(0)
  const armTimer = useRef<number | null>(null)

  const panel = () => panelRef.current
  // Render-safe (the panel is server-rendered by the smoke suite): only the
  // pointer/keyboard handlers ever need the real viewport.
  const geom = () => ({ side, overlay, viewportW: typeof window === 'undefined' ? 0 : window.innerWidth, min })
  const domWidth = () => Math.round(panel()?.getBoundingClientRect().width ?? fallback)

  const setVar = (w: number | null) => {
    const el = panel()
    if (!el) return
    if (w === null) el.style.removeProperty(varName)
    else el.style.setProperty(varName, `${w}px`)
  }

  const disarm = () => {
    if (armTimer.current !== null) window.clearTimeout(armTimer.current)
    armTimer.current = null
    ghostRef.current = false
    setGhost(null)
    if (nearRef.current) {
      nearRef.current = false
      setNear(false)
    }
  }

  // Unmount safety: a panel closed mid-drag must not leave its transition off.
  useEffect(() => () => disarm(), [])

  const commit = (w: number | null) => {
    onCommit(w === null || Math.abs(w - fallback) < 1 ? null : w)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { x: e.clientX, w: domWidth() }
    live.current = start.current.w
    panel()?.classList.add('resizing')
    // Flag the document so the app's global Escape (close drawer) stands down
    // while a drag owns the key — its window listener is registered earlier
    // than ours and would otherwise win the race.
    document.documentElement.dataset.resizing = 'true'
    setDragging(true)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!dragging) return
    const dx = e.clientX - start.current.x
    const g = geom()
    const w = clampPanelWidth(start.current.w + (side === 'right' ? -dx : dx), min, snapTargetWidth(g))
    live.current = w
    setVar(w)

    const isNear = zoneFor(edgeDistance(g.viewportW, w)) === 'near'
    if (isNear === nearRef.current) return
    nearRef.current = isNear
    setNear(isNear)
    if (!isNear) {
      if (armTimer.current !== null) window.clearTimeout(armTimer.current)
      armTimer.current = null
      if (ghostRef.current) {
        ghostRef.current = false
        setGhost(null)
      }
      return
    }
    // Held near the edge for a beat → the ghost panel promises the snap.
    armTimer.current = window.setTimeout(() => {
      armTimer.current = null
      if (!nearRef.current) return
      ghostRef.current = true
      const r = snapRect(geom())
      setGhost({ left: r.left, width: r.width })
    }, GHOST_ARM_MS)
  }

  const endDrag = (cancelled: boolean) => {
    if (cancelled) {
      live.current = start.current.w
      setVar(start.current.w)
      setDragging(false)
      panel()?.classList.remove('resizing')
      delete document.documentElement.dataset.resizing
      disarm()
      return
    }
    const snapped = ghostRef.current
    const g = geom()
    const target = snapped ? snapTargetWidth(g) : live.current
    if (snapped) setVar(target)
    // A release at the drag's starting width commits nothing: the stored width
    // (if any) already matches, and null would wrongly reset it to the default.
    if (snapped || Math.abs(target - start.current.w) >= 1) commit(target)
    setDragging(false)
    panel()?.classList.remove('resizing')
    delete document.documentElement.dataset.resizing
    disarm()
  }

  // Escape ends the drag before the pointer does; the later mouseup must not
  // commit the cancelled position.
  const onPointerUp = () => { if (dragging) endDrag(false) }
  const onPointerCancel = () => { if (dragging) endDrag(true) }

  // Escape mid-drag restores the pre-drag width and commits nothing.
  useEffect(() => {
    if (!dragging) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') endDrag(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging])

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const g = geom()
    const grow = side === 'right' ? e.key === 'ArrowLeft' : e.key === 'ArrowRight'
    const shrink = side === 'right' ? e.key === 'ArrowRight' : e.key === 'ArrowLeft'
    const step = (grow || shrink) && e.shiftKey ? 64 : 16
    const base = domWidth()
    if (grow) {
      e.preventDefault()
      commit(clampPanelWidth(base + step, min, snapTargetWidth(g)))
    } else if (shrink) {
      e.preventDefault()
      commit(clampPanelWidth(base - step, min, snapTargetWidth(g)))
    } else if (e.key === 'Home') {
      e.preventDefault()
      commit(min)
    } else if (e.key === 'End' || e.key === 'Enter') {
      // The snap is a keyboard affordance too.
      e.preventDefault()
      commit(snapTargetWidth(g))
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      commit(null)
    }
  }

  const current = width ?? fallback
  const max = snapTargetWidth(geom())

  return (
    <>
      <div
        role="separator"
        aria-label={`Resize ${label} panel`}
        aria-orientation="vertical"
        aria-valuenow={current}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={`${current} pixels`}
        tabIndex={0}
        className={`panel-resize-handle side-${side}${near ? ' near' : ''}${dragging ? ' active' : ''}`}
        title={`Drag to resize · hold near the ${side === 'right' ? 'left' : 'right'} edge to snap · Esc cancels`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={onKeyDown}
      />
      {ghost &&
        createPortal(
          <motion.div
            className="snap-ghost"
            style={{ left: ghost.left, width: ghost.width } as CSSProperties}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.14 }}
          >
            <span className="snap-ghost-label">
              Release to snap to the {side === 'right' ? 'left' : 'right'} edge
            </span>
          </motion.div>,
          document.body,
        )}
    </>
  )
}
