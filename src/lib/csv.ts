/**
 * Minimal RFC-4180-ish CSV parser + sorting helpers for spreadsheet previews.
 */
export function parseCSV(text: string, delimiter?: string): { rows: string[][] } {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const d = delimiter ?? (autoDetectDelimiter(text))

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"' && field === '') {
      inQuotes = true
    } else if (ch === d) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') rows.push(row)
  }
  return { rows }
}

function autoDetectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const candidates = [',', '\t', ';', '|']
  let best = ','
  let bestCount = 0
  for (const c of candidates) {
    const count = firstLine.split(c).length - 1
    if (count > bestCount) {
      best = c
      bestCount = count
    }
  }
  return best
}

export type SortDir = 'asc' | 'desc' | null

/** Compare two cells numerically when both parse as numbers, else lexically. */
export function compareCells(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
}
