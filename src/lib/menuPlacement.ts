/**
 * Where a popup menu goes. Pure geometry with no DOM access, so the edge cases
 * (near a screen edge, taller than the room below, a tiny window) are testable
 * headlessly. All coordinates are viewport (`position: fixed`) coordinates.
 */

export interface Size {
  width: number
  height: number
}

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** What the menu hangs off: a button (drops below it) or the pointer (right-click). */
export type MenuAnchor =
  | { kind: 'rect'; rect: Rect; /** Which edge of the button the menu lines up with. Default 'start'. */ align?: 'start' | 'end' }
  | { kind: 'point'; x: number; y: number }

export interface Placement {
  left: number
  top: number
  /** True when the menu opens upward, so its entrance animation can grow from the bottom. */
  flipped: boolean
}

/** Space between a button and the menu that drops from it. */
export const MENU_GAP = 6
/** Closest a menu may get to the edge of the window. */
export const MENU_MARGIN = 8

/** Clamp into [lo, hi]; when the range is inverted (menu bigger than the window) the low edge wins. */
function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo
  return Math.max(lo, Math.min(v, hi))
}

export function placeMenu(
  anchor: MenuAnchor,
  menu: Size,
  viewport: Size,
  gap = MENU_GAP,
  margin = MENU_MARGIN,
): Placement {
  const maxLeft = viewport.width - menu.width - margin
  const maxTop = viewport.height - menu.height - margin

  if (anchor.kind === 'point') {
    // Like a native context menu: the corner sits on the pointer, and the menu
    // mirrors to the other side of it when it would run off the window.
    const flipX = anchor.x + menu.width > viewport.width - margin
    const flipY = anchor.y + menu.height > viewport.height - margin
    return {
      left: clamp(flipX ? anchor.x - menu.width : anchor.x, margin, maxLeft),
      top: clamp(flipY ? anchor.y - menu.height : anchor.y, margin, maxTop),
      flipped: flipY,
    }
  }

  const { rect } = anchor
  const roomBelow = viewport.height - margin - (rect.bottom + gap)
  const roomAbove = rect.top - gap - margin
  // Prefer dropping below. Flip up only when it does not fit below and there is
  // more room above; if it fits nowhere, use the roomier side (then clamp).
  const flipped = menu.height > roomBelow && roomAbove > roomBelow
  const top = flipped ? rect.top - gap - menu.height : rect.bottom + gap
  const left = anchor.align === 'end' ? rect.right - menu.width : rect.left
  return { left: clamp(left, margin, maxLeft), top: clamp(top, margin, maxTop), flipped }
}
