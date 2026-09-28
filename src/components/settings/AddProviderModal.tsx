import { Modal } from '../common/Modal'
import { IconPlus } from '../icons'
import { addableProviders, type SupportedProvider } from '../../lib/providerCatalog'
import type { ProviderId } from '../../types'

/**
 * The picker list. Exported separately from the modal shell so tests can
 * render it without a portal (same pattern as ModelPickerTable).
 */
export function ProviderPickerList({ onPick }: { onPick: (kind: ProviderId) => void }) {
  const all = addableProviders()
  return (
    <ul className="provider-pick-list">
      {all.map((p: SupportedProvider) => (
        <li key={p.kind} className="provider-pick-row">
          <button
            type="button"
            className="provider-pick-main"
            aria-label={`Add ${p.label}`}
            onClick={() => onPick(p.kind)}
          >
            <span className="provider-pick-label">
              {p.label}
              {p.noKey ? <span className="provider-pick-free">no key needed</span> : null}
            </span>
            <span className="provider-pick-hint">{p.hint}</span>
          </button>
          {p.keyUrl && (
            <a className="link-btn" href={p.keyUrl} target="_blank" rel="noreferrer" tabIndex={0}>
              Get a key ↗
            </a>
          )}
          <span className="provider-pick-add" aria-hidden="true">
            <IconPlus size={14} />
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * "Add a provider" dialog: every provider kind Slade can talk to, one row
 * each. Picking a row creates a new provider connection (own key, own base
 * URL, own models) — including a second connection to a kind that is already
 * configured, e.g. a personal and a work OpenAI account, or Groq *and*
 * Ollama as two separate OpenAI-compatible endpoints.
 */
export function AddProviderModal({
  open,
  onClose,
  onPick,
}: {
  open: boolean
  onClose: () => void
  onPick: (kind: ProviderId) => void
}) {
  return (
    <Modal open={open} onClose={onClose} labelledBy="add-provider-title" className="nested-modal">
      <div className="add-provider">
        <h3 id="add-provider-title" className="model-picker-title">
          Add a provider
        </h3>
        <p className="settings-note">
          Every provider Slade supports, one row each. Each connection gets its <strong>own API key</strong> and its
          own models — add the same kind twice for two accounts, or several OpenAI-compatible endpoints (Groq,
          DeepSeek, Ollama…) side by side.
        </p>

        <ProviderPickerList onPick={onPick} />

        <p className="model-picker-foot">
          Keys are stored locally in your browser, masked on screen, and sent only to the provider they belong to.
        </p>
      </div>
    </Modal>
  )
}
