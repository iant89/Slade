/**
 * Panel-resize geometry: pure, DOM-free math for the corner drag-handles.
 *
 * A panel docks to one side of the viewport; its far edge is dragged. While the
 * dragged edge is within `EDGE_SNAP_ZONE` of the *opposite* viewport edge the
 * drag is "armed"; held there for `GHOST_ARM_MS` a ghost panel draws showing
 * the snap, and releasing commits it (dragging away first hides the ghost).
 * Grid panels (sidebar, model rail) keep `MAIN_MIN_W` of the viewport for the
 * chat column; overlay drawers may cover everything.
 */

export type PanelSide = 'left' | 'right'

/** How close the dragged edge must be to the opposite viewport edge to arm a snap. */
export const EDGE_SNAP_ZONE = 56
/** Dwell inside the zone before the ghost panel appears ("hold near it"). */
export const GHOST_ARM_MS = 1600
/** Narrowest a panel may be dragged. */
export const MIN_PANEL_W = 240
/** The chat column never shrinks below this under a resizing grid panel. */
export const MAIN_MIN_W = 340

export function clampPanelWidth(w: number, min: number, max: number): number {
  if (max < min) return Math.round(min)
  return Math.round(Math.max(min, Math.min(max, w)))
}

/**
 * Distance from the dragged edge to the viewport edge it would snap flush to.
 * Side-invariant: a right-docked panel's left edge sits at `vw - w` (distance
 * `vw - w` from x=0); a left-docked panel's right edge sits at `w` (the same
 * distance from x=vw).
 */
export function edgeDistance(viewportW: number, width: number): number {
  return viewportW - width
}

export type ZoneState = 'near' | 'far'

export function zoneFor(distance: number, zone: number = EDGE_SNAP_ZONE): ZoneState {
  return distance <= zone ? 'near' : 'far'
}

export interface SnapGeom {
  /** Which side of the viewport the panel docks to. */
  side: PanelSide
  /** Overlay drawers float above the app and may span it fully. */
  overlay: boolean
  viewportW: number
  min?: number
}

/** Width the panel takes when snapped flush against the opposite viewport edge. */
export function snapTargetWidth(g: SnapGeom): number {
  const min = g.min ?? MIN_PANEL_W
  const room = g.overlay ? g.viewportW : g.viewportW - MAIN_MIN_W
  return clampPanelWidth(Math.max(min, Math.min(room, g.viewportW)), min, g.viewportW)
}

/** Widest a free drag may go — it is the snap target, so a release never overshoots. */
export function maxDragWidth(g: SnapGeom): number {
  return snapTargetWidth(g)
}

/** Fixed-position rectangle the ghost preview draws (full height). */
export function snapRect(g: SnapGeom): { left: number; width: number } {
  const width = snapTargetWidth(g)
  return { left: g.side === 'right' ? g.viewportW - width : 0, width }
}
