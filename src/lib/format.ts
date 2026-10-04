export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  return sameDay
    ? formatTime(ts)
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + formatTime(ts)
}

export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec)) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Rough token estimate — good enough for a soft composer counter. */
export const estimateTokens = (text: string): number => Math.max(0, Math.ceil(text.length / 4))

export function relativeCooldown(until: number, now = Date.now()): string {
  const s = Math.max(0, Math.ceil((until - now) / 1000))
  if (s < 60) return `${s}s`
  return `${Math.ceil(s / 60)}m`
}

/** Compact wall-clock duration for command executions (input in milliseconds). */
export function formatExecutionDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  const duration = Math.max(0, ms)
  if (duration < 1000) return `${Math.floor(duration)}ms`
  if (duration < 60_000) return `${Number((Math.floor(duration / 10) / 100).toFixed(2))}s`
  const minutes = Math.floor(duration / 60_000)
  const seconds = Math.floor((duration % 60_000) / 1000)
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
}
