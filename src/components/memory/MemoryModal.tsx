import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { MAX_MEMORY_ENTRY_CHARS } from '../../types'
import { formatDateTime } from '../../lib/format'
import { useMemory } from '../../store/memory'
import { useUI } from '../../store/ui'
import { Modal } from '../common/Modal'
import { IconBrain, IconCheck, IconPencil, IconPlus, IconTrash, IconX } from '../icons'

export function MemoryModal() {
  const open = useUI((s) => s.memoryOpen)
  const prefill = useUI((s) => s.memoryPrefill)
  const close = useUI((s) => s.closeMemory)
  const entries = useMemory((s) => s.entries)
  const addMemory = useMemory((s) => s.addMemory)
  const updateMemory = useMemory((s) => s.updateMemory)
  const deleteMemory = useMemory((s) => s.deleteMemory)
  const toast = useUI((s) => s.toast)
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')

  useEffect(() => {
    if (open) {
      setDraft(prefill)
      setEditingId(null)
      setEditDraft('')
    }
  }, [open, prefill])

  const add = (event: FormEvent) => {
    event.preventDefault()
    const entry = addMemory(draft)
    if (!entry) {
      toast({ kind: 'error', title: 'Memory not added', detail: `Add a note under ${MAX_MEMORY_ENTRY_CHARS.toLocaleString()} characters.` })
      return
    }
    setDraft('')
    toast({ kind: 'success', title: 'Memory added', detail: 'Slade will use it as context in future conversations.' })
  }

  const saveEdit = (event: FormEvent, id: string) => {
    event.preventDefault()
    if (!updateMemory(id, editDraft)) {
      toast({ kind: 'error', title: 'Memory not updated', detail: 'The note must contain text and fit within the character limit.' })
      return
    }
    setEditingId(null)
    setEditDraft('')
    toast({ kind: 'success', title: 'Memory updated' })
  }

  const remove = (id: string) => {
    if (!window.confirm('Delete this memory? Slade will no longer use it in future conversations.')) return
    deleteMemory(id)
    if (editingId === id) {
      setEditingId(null)
      setEditDraft('')
    }
    toast({ kind: 'info', title: 'Memory deleted' })
  }

  return (
    <Modal open={open} onClose={close} labelledBy="memory-title" className="memory-dialog">
      <div className="memory-modal">
        <header className="memory-header">
          <span className="memory-mark" aria-hidden="true"><IconBrain size={18} /></span>
          <div>
            <h2 id="memory-title">Memory</h2>
            <p>Notes saved here are shared across conversations and added to relevant model context.</p>
          </div>
        </header>

        <form className="memory-compose" onSubmit={add}>
          <label htmlFor="memory-new-entry">What should Slade remember?</label>
          <textarea
            id="memory-new-entry"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="A durable preference, project detail, or recurring issue…"
            maxLength={MAX_MEMORY_ENTRY_CHARS}
            rows={4}
          />
          <div className="memory-compose-footer">
            <span className="memory-char-count">{draft.length.toLocaleString()} / {MAX_MEMORY_ENTRY_CHARS.toLocaleString()}</span>
            <button className="btn primary small" type="submit" disabled={!draft.trim() || draft.length > MAX_MEMORY_ENTRY_CHARS}>
              <IconPlus size={13} /> Add to Memory
            </button>
          </div>
        </form>

        <section className="memory-list-section" aria-labelledby="memory-list-title">
          <div className="memory-list-head">
            <h3 id="memory-list-title">Saved memories</h3>
            <span>{entries.length} {entries.length === 1 ? 'entry' : 'entries'}</span>
          </div>
          {entries.length === 0 ? (
            <div className="memory-empty">
              <IconBrain size={20} />
              <p>No memories yet. Add a note here, or use <strong>Remember</strong> on a chat message.</p>
            </div>
          ) : (
            <ul className="memory-list">
              {entries.map((entry) => (
                <li className="memory-entry" key={entry.id}>
                  {editingId === entry.id ? (
                    <form className="memory-edit-form" onSubmit={(event) => saveEdit(event, entry.id)}>
                      <textarea
                        aria-label="Edit memory"
                        value={editDraft}
                        onChange={(event) => setEditDraft(event.target.value)}
                        maxLength={MAX_MEMORY_ENTRY_CHARS}
                        rows={4}
                        autoFocus
                      />
                      <div className="memory-entry-actions">
                        <button className="btn ghost small" type="button" onClick={() => { setEditingId(null); setEditDraft('') }}>
                          <IconX size={12} /> Cancel
                        </button>
                        <button className="btn primary small" type="submit" disabled={!editDraft.trim()}>
                          <IconCheck size={12} /> Save
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <p className="memory-entry-content">{entry.content}</p>
                      <div className="memory-entry-footer">
                        <time dateTime={new Date(entry.updatedAt).toISOString()}>{entry.updatedAt !== entry.createdAt ? 'Updated' : 'Added'} {formatDateTime(entry.updatedAt)}</time>
                        <div className="memory-entry-actions">
                          <button
                            className="btn ghost small"
                            type="button"
                            onClick={() => { setEditingId(entry.id); setEditDraft(entry.content) }}
                            aria-label="Edit memory"
                          >
                            <IconPencil size={12} /> Edit
                          </button>
                          <button className="btn ghost small danger" type="button" onClick={() => remove(entry.id)} aria-label="Delete memory">
                            <IconTrash size={12} /> Delete
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  )
}
