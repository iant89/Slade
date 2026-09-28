import { useEffect, useMemo, useState } from 'react'
import { Modal } from '../common/Modal'
import { IconSearch } from '../icons'
import {
  CATALOG_AS_OF,
  STRENGTH_LABEL,
  catalogFor,
  formatCtx,
  formatPrice,
  type AddableProvider,
  type CatalogModel,
  type Strength,
} from '../../lib/modelCatalog'
import { supportedProvider } from '../../lib/providerCatalog'

type SortKey = 'apiModel' | 'label' | 'contextWindow' | 'costPer1kIn' | 'costPer1kOut'
type SortDir = 'asc' | 'desc'

const COLUMNS: {
  key: SortKey
  label: string
  numeric?: boolean
  /** Direction used the first time a column is sorted. */
  defaultDir: SortDir
}[] = [
  { key: 'label', label: 'Model', defaultDir: 'asc' },
  { key: 'apiModel', label: 'Model ID', defaultDir: 'asc' },
  { key: 'contextWindow', label: 'Context', numeric: true, defaultDir: 'desc' },
  { key: 'costPer1kIn', label: 'In $/1k', numeric: true, defaultDir: 'asc' },
  { key: 'costPer1kOut', label: 'Out $/1k', numeric: true, defaultDir: 'asc' },
]

function compare(a: CatalogModel, b: CatalogModel, key: SortKey): number {
  const va = a[key]
  const vb = b[key]
  if (va == null && vb == null) return 0
  if (va == null) return 1 // unknown costs sink to the bottom either direction
  if (vb == null) return -1
  if (typeof va === 'number' && typeof vb === 'number') return va - vb
  return String(va).localeCompare(String(vb), undefined, { sensitivity: 'base' })
}

/**
 * The filterable, sortable catalogue table. Exported separately from the modal
 * shell so tests can render it without a portal.
 */
export function ModelPickerTable({
  provider,
  onPick,
}: {
  provider: AddableProvider
  onPick: (model: CatalogModel) => void
}) {
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'contextWindow', dir: 'desc' })

  // Fresh view whenever the dialog opens for a different provider.
  useEffect(() => {
    setFilter('')
    setSort({ key: 'contextWindow', dir: 'desc' })
  }, [provider])

  const all = useMemo(() => catalogFor(provider), [provider])

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const filtered = q
      ? all.filter((m) => {
          const haystack = [m.apiModel, m.label, m.note, ...m.strengths.map((s) => STRENGTH_LABEL[s])]
            .join(' ')
            .toLowerCase()
          return haystack.includes(q)
        })
      : all
    const sorted = [...filtered].sort((a, b) => compare(a, b, sort.key))
    if (sort.dir === 'desc') sorted.reverse()
    // `reverse` also flips the "unknown costs last" sentinel in compare(); redo
    // it after reversing so missing prices stay at the bottom in both orders.
    if (sort.dir === 'desc') {
      const known = sorted.filter((m) => m[sort.key] != null)
      const unknown = sorted.filter((m) => m[sort.key] == null)
      return [...known, ...unknown]
    }
    return sorted
  }, [all, filter, sort])

  const toggleSort = (key: SortKey) => {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: COLUMNS.find((c) => c.key === key)?.defaultDir ?? 'asc' },
    )
  }

  return (
    <>
      <label className="model-picker-search">
        <IconSearch size={14} />
        <input
          value={filter}
          placeholder="Filter by name, ID, strength…"
          aria-label="Filter models"
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="model-picker-count">
          {rows.length} of {all.length}
        </span>
      </label>

      <div className="model-picker-table-wrap" tabIndex={0}>
        <table className="model-picker-table">
          <thead>
            <tr>
              {COLUMNS.map((c) => {
                const isSorted = sort.key === c.key
                return (
                  <th
                    key={c.key}
                    aria-sort={isSorted ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                    className={c.numeric ? 'num' : undefined}
                  >
                    <button
                      type="button"
                      className={`th-sort${isSorted ? ` sorted-${sort.dir}` : ''}`}
                      onClick={() => toggleSort(c.key)}
                      title={`Sort by ${c.label}`}
                    >
                      {c.label}
                      <span className="sort-caret" aria-hidden="true" />
                    </button>
                  </th>
                )
              })}
              <th>Strengths</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr
                key={m.apiModel}
                tabIndex={0}
                className="pick-row"
                aria-label={`Use ${m.label} (${m.apiModel})`}
                onClick={() => onPick(m)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onPick(m)
                  }
                }}
              >
                <td>
                  <span className="pick-label">{m.label}</span>
                  <span className="pick-note">{m.note}</span>
                </td>
                <td className="mono">{m.apiModel}</td>
                <td className="num">
                  <span className="ctx-chip">{formatCtx(m.contextWindow)}</span>
                </td>
                <td className="num">{formatPrice(m.costPer1kIn)}</td>
                <td className="num">{formatPrice(m.costPer1kOut)}</td>
                <td>
                  <span className="tag-row">
                    {m.strengths.map((s: Strength) => (
                      <span key={s} className="tag">
                        {STRENGTH_LABEL[s]}
                      </span>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr className="pick-empty">
                <td colSpan={COLUMNS.length + 1}>No curated model matches “{filter}”.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

/**
 * "Browse models" dialog: a filterable, sortable table of the curated
 * catalogue for one provider. Selecting a row hands the model back to the
 * Add-model form, which copies its ID into the Model ID field.
 */
export function ModelPickerModal({
  open,
  provider,
  onClose,
  onPick,
}: {
  open: boolean
  provider: AddableProvider
  onClose: () => void
  onPick: (model: CatalogModel) => void
}) {
  const providerLabel = supportedProvider(provider)?.label ?? provider

  return (
    <Modal open={open} onClose={onClose} labelledBy="model-picker-title" className="nested-modal">
      <div className="model-picker">
        <h3 id="model-picker-title" className="model-picker-title">
          Browse models <span className="model-picker-provider">· {providerLabel}</span>
        </h3>
        <p className="settings-note">
          Curated for <strong>high context windows</strong> and strength at <strong>programming, problem solving</strong>{' '}
          and agentic work. Select a row to copy its model ID into the field.
        </p>

        <ModelPickerTable provider={provider} onPick={onPick} />

        <p className="model-picker-foot">
          Snapshot verified {CATALOG_AS_OF}; providers occasionally rename or retire IDs, so the Model ID field stays
          editable. Prices are approximate list prices per 1k tokens.
        </p>
      </div>
    </Modal>
  )
}
