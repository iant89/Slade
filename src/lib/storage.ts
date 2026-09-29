import type { ZodType } from 'zod'

export const KEYS = {
  settings: 'slade.settings.v1',
  conversations: 'slade.conversations.v1',
  health: 'slade.health.v1',
  artifacts: 'slade.artifacts.v1',
  /** GitHub connection + workspace state (never part of the export bundle). */
  github: 'slade.github.v1',
  /** Local file system workspace used by agents and users to store files. */
  fs: 'slade.fs.v1',
} as const

/** Load and zod-validate a JSON value from localStorage; fall back on any error. */
export function loadJSON<T>(key: string, schema: ZodType<T>, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    const res = schema.safeParse(parsed)
    if (res.success) return res.data as T
    console.warn(`[slade] stored value for ${key} failed validation; using defaults`)
    return fallback
  } catch {
    return fallback
  }
}

/** Load raw JSON without validation (callers validate with zod themselves). */
export function loadRaw<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (err) {
    // Quota exceeded — drop the heaviest key (artifacts) and retry once.
    console.warn('[slade] localStorage write failed', err)
    try {
      localStorage.removeItem(KEYS.artifacts)
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* give up silently; session still works in memory */
    }
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* noop */
  }
}
