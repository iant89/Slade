/**
 * ARIA live-region announcer, shared by the plain chain and the orchestrator.
 * (Kept in its own module so both engines can announce without an import
 * cycle; `send.ts` re-exports the same functions.)
 */

let announceHandler: (() => void) | null = null
let announcement = ''

export function setAnnouncer(fn: () => void): void {
  announceHandler = fn
}

export function announceResponse(text: string): void {
  announcement = text
  announceHandler?.()
}

export function currentAnnouncement(): string {
  return announcement
}
