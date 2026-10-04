import { useState } from 'react'
import { useFs } from '../../store/fs'
import { reviewDiskImport, writeDiskFile, workspaceSession, type DiskImportRow } from '../../store/diskFs'

/** An explicit copy, never an automatic migration or a deletion of browser data. */
export function DiskImportReview({ conversationId, onDone }: { conversationId: string; onDone: () => void }) {
  const [rows, setRows] = useState<DiskImportRow[]>([])
  const [busy, setBusy] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const [error, setError] = useState('')
  const [session] = useState(workspaceSession)
  async function review() {
    setBusy(true); setError(''); setRows([]); setReviewed(false)
    try {
      const result = await reviewDiskImport(useFs.getState().listFiles(undefined, conversationId), session)
      setRows(result); setReviewed(true)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Review failed. Nothing was imported.') }
    finally { setBusy(false) }
  }
  async function importSelected() {
    setBusy(true); setError('')
    const result = [...rows]
    try {
      for (let i = 0; i < result.length; i++) {
        const row = result[i]!
        if (!row.selected) continue
        try {
          await writeDiskFile(row.file.path, row.file.content, row.file.encoding ?? 'utf8', row.disk?.revision ?? null, { origin: 'user' }, session)
          result[i] = { ...row, selected: false, result: 'Imported' }
        } catch (cause) { result[i] = { ...row, selected: false, result: cause instanceof Error ? cause.message : 'Import failed' } }
        setRows([...result])
      }
    } finally { setBusy(false) }
  }
  const count = rows.filter((r) => r.selected).length
  return (
    <section className="disk-import" aria-label="Review browser file import">
      <h3>Import browser files</h3>
      <p>Copy files from this conversation’s browser workspace to the shared disk checkout. Browser originals remain untouched. Existing disk files are unchecked by default. Review differences before selecting an overwrite.</p>
      <div className="disk-toolbar">
        <button className="btn small" type="button" disabled={busy} onClick={() => void review()}>{busy ? 'Working…' : 'Review current browser files'}</button>
        <button className="btn ghost small" type="button" disabled={busy} onClick={onDone}>Close import</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {reviewed && !rows.length && <p>No browser files in this conversation.</p>}
      {rows.map((row, index) => (
        <div key={row.file.path} className="disk-import-row">
          <label><input type="checkbox" checked={row.selected} disabled={busy || row.identical || Boolean(row.result)} onChange={(event) => setRows((all) => all.map((item, i) => i === index ? { ...item, selected: event.target.checked } : item))} /> {row.file.path}</label>
          <p role={row.result ? 'status' : undefined}>{row.result ?? (row.identical ? 'Identical — no change needed' : row.disk ? 'Conflict — select only to overwrite the reviewed disk version' : 'New file')}</p>
          {!row.identical && <details><summary>Review contents{row.disk ? ' / differences' : ''}</summary>
            <h4>Browser version</h4><pre>{row.file.encoding === 'base64' ? `[Binary file, ${row.file.size} bytes]` : row.file.content.slice(0, 12000)}</pre>
            {row.disk && <><h4>Disk version</h4><pre>{row.disk.encoding === 'base64' ? `[Binary file, ${row.disk.size} bytes]` : row.disk.content.slice(0, 12000)}</pre></>}
            <p>Text previews are limited to 12,000 characters; the full selected file is copied.</p>
          </details>}
        </div>
      ))}
      {reviewed && <button className="btn" type="button" disabled={busy || !count} onClick={() => void importSelected()}>Import selected ({count})</button>}
      {reviewed && <p>Disk revisions are checked again on import. Changed files are rejected, not overwritten. Review again after any conflict.</p>}
    </section>
  )
}
