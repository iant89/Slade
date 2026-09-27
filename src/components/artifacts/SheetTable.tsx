import { useMemo, useState } from 'react'
import type { SortDir } from '../../lib/csv'
import { compareCells } from '../../lib/csv'
import { IconChevronDown } from '../icons'

const PREVIEW_ROWS = 60

/** Interactive, sortable spreadsheet preview (CSV / TSV artifacts). */
export function SheetTable({
  columns,
  rows,
  maxHeight,
}: {
  columns: string[]
  rows: string[][]
  maxHeight?: number
}) {
  const [sortCol, setSortCol] = useState<number | null>(null)
  const [dir, setDir] = useState<SortDir>(null)
  const [expanded, setExpanded] = useState(false)

  const sortedRows = useMemo(() => {
    if (sortCol == null || dir == null) return rows
    const copy = [...rows]
    copy.sort((a, b) => {
      const av = a[sortCol] ?? ''
      const bv = b[sortCol] ?? ''
      const cmp = compareCells(av, bv)
      return dir === 'asc' ? cmp : -cmp
    })
    return copy
  }, [rows, sortCol, dir])

  const shown = expanded ? sortedRows.slice(0, 2000) : sortedRows.slice(0, PREVIEW_ROWS)
  const numericCols = useMemo(() => {
    const set = new Set<number>()
    for (let c = 0; c < columns.length; c++) {
      let allNumeric = true
      for (const row of rows.slice(0, 40)) {
        const v = row[c] ?? ''
        if (v !== '' && !Number.isFinite(Number(v))) {
          allNumeric = false
          break
        }
      }
      if (allNumeric) set.add(c)
    }
    return set
  }, [columns.length, rows])

  const clickHeader = (i: number) => {
    if (sortCol !== i) {
      setSortCol(i)
      setDir('asc')
    } else if (dir === 'asc') setDir('desc')
    else {
      setSortCol(null)
      setDir(null)
    }
  }

  return (
    <div className="sheet-wrap" style={{ maxHeight }}>
      <div className="sheet-scroll" tabIndex={0} role="region" aria-label="Spreadsheet preview">
        <table className="sheet-table">
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={i} onClick={() => clickHeader(i)} aria-sort={sortCol === i ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className={`sheet-th-btn${sortCol === i ? ' sorted' : ''}`}>
                    {c || `Column ${i + 1}`}
                    <IconChevronDown
                      size={12}
                      className={`sheet-caret${dir === 'asc' ? ' up' : ''}${sortCol === i ? ' show' : ''}`}
                    />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, ri) => (
              <tr key={ri}>
                {columns.map((_, ci) => (
                  <td key={ci} className={numericCols.has(ci) ? 'num' : ''}>
                    {row[ci] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sortedRows.length > PREVIEW_ROWS && (
        <div className="sheet-foot">
          Showing {shown.length} of {sortedRows.length} rows
          {!expanded && (
            <button className="link-btn" onClick={() => setExpanded(true)} type="button">
              Load more
            </button>
          )}
        </div>
      )}
    </div>
  )
}
