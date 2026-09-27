import { useRef, useState } from 'react'
import type { ModelDef, ProviderId } from '../../types'
import { useSettings, DEFAULT_SETTINGS } from '../../store/settings'
import { useHealth } from '../../store/health'
import { useChat } from '../../store/chat'
import { useArtifacts } from '../../store/artifacts'
import { useUI } from '../../store/ui'
import { adapterFor } from '../../providers/registry'
import { exportBundleSchema, settingsSchema } from '../../lib/schemas'
import { downloadUrl } from '../../lib/clipboard'
import { formatCount } from '../../lib/format'
import { uid } from '../../lib/id'
import { Modal } from '../common/Modal'
import { FieldRow, SegmentedControl, SelectRow, SectionTitle, SliderRow, Toggle } from '../common/controls'
import {
  IconDatabase,
  IconGrip,
  IconKey,
  IconLayers,
  IconPalette,
  IconPlus,
  IconSliders,
  IconTrash,
  IconChevronDown,
  IconDownload,
  IconCheck,
  IconAlert,
} from '../icons'

type Tab = 'models' | 'defaults' | 'providers' | 'appearance' | 'data'

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'models', label: 'Models', icon: <IconLayers size={15} /> },
  { id: 'defaults', label: 'Defaults', icon: <IconSliders size={15} /> },
  { id: 'providers', label: 'Providers', icon: <IconKey size={15} /> },
  { id: 'appearance', label: 'Appearance', icon: <IconPalette size={15} /> },
  { id: 'data', label: 'Data', icon: <IconDatabase size={15} /> },
]

export function SettingsModal() {
  const open = useUI((s) => s.settingsOpen)
  const tab = useUI((s) => s.settingsTab)
  const setOpen = useUI((s) => s.closeSettings)
  const setTab = useUI((s) => s.setSettingsTab)
  const close = useUI((s) => s.closeSettings)

  return (
    <Modal open={open} onClose={close} labelledBy="settings-title">
      <div className="settings-layout">
        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          <h2 id="settings-title" className="settings-title">
            Settings
          </h2>
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`settings-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
              type="button"
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>
        <div className="settings-content" role="tabpanel" aria-label={`${tab} settings`}>
          {tab === 'models' && <ModelsTab />}
          {tab === 'defaults' && <DefaultsTab />}
          {tab === 'providers' && <ProvidersTab />}
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'data' && <DataTab />}
        </div>
      </div>
      {/* accessible close button for SRs that skip the decorative one */}
      <button className="sr-only" onClick={() => setOpen()} type="button">
        Close settings
      </button>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Models tab                                                          */
/* ------------------------------------------------------------------ */

function ModelsTab() {
  const models = useSettings((s) => s.s.models)
  const health = useHealth((s) => s.byModel)
  const { reorderModels, setModel, removeModel, addModel } = useSettings.getState()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const dragIndex = useRef<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  const onDrop = (to: number) => {
    const from = dragIndex.current
    setDragOver(null)
    dragIndex.current = null
    if (from == null || from === to) return
    const ids = models.map((m) => m.id)
    const [moved] = ids.splice(from, 1)
    ids.splice(to, 0, moved!)
    reorderModels(ids)
  }

  return (
    <div>
      <SectionTitle>Priority chain</SectionTitle>
      <p className="settings-note">
        Slade walks enabled models top-down on failure. Drag to reorder (or use the arrow buttons).
      </p>
      <div className="model-list">
        {models.map((m, i) => {
          const h = health[m.id]
          const isOpen = expanded === m.id
          return (
            <div
              key={m.id}
              className={`model-row${dragOver === i ? ' drag-over' : ''}${m.enabled ? '' : ' off'}`}
              draggable
              onDragStart={() => (dragIndex.current = i)}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(i)
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => {
                e.preventDefault()
                onDrop(i)
              }}
            >
              <div className="model-row-main">
                <span className="model-grip" aria-hidden="true">
                  <IconGrip size={14} />
                </span>
                <Toggle
                  checked={m.enabled}
                  onChange={(v) => setModel(m.id, { enabled: v })}
                  label={`${i + 1}. ${m.label}`}
                  hint={`${adapterFor(m.provider).label} · ${m.apiModel}${h ? ` · ${formatCount(h.totalRequests)} req · ${formatCount(h.totalTokensOut)} tok out` : ''}`}
                />
                <button
                  className="icon-btn"
                  aria-expanded={isOpen}
                  aria-label={`Configure ${m.label}`}
                  onClick={() => setExpanded(isOpen ? null : m.id)}
                  type="button"
                >
                  <IconChevronDown size={14} className={isOpen ? 'flip-v' : ''} />
                </button>
              </div>

              {isOpen && (
                <div className="model-config">
                  <FieldRow label="Display name">
                    <input value={m.label} onChange={(e) => setModel(m.id, { label: e.target.value })} />
                  </FieldRow>
                  <FieldRow label="Model ID (sent to provider)">
                    <input value={m.apiModel} onChange={(e) => setModel(m.id, { apiModel: e.target.value })} />
                  </FieldRow>
                  {m.provider === 'openai-compatible' && (
                    <FieldRow label="Base URL" hint="Any OpenAI-compatible endpoint (Groq, OpenRouter, Ollama…)">
                      <input
                        value={m.baseURL ?? ''}
                        placeholder="https://api.groq.com/openai/v1"
                        onChange={(e) => setModel(m.id, { baseURL: e.target.value })}
                      />
                    </FieldRow>
                  )}
                  <SliderRow
                    label="Temperature override"
                    value={m.overrides?.temperature ?? -1}
                    min={-1}
                    max={2}
                    step={0.05}
                    format={(v) => (v < 0 ? 'use default' : v.toFixed(2))}
                    onChange={(v) =>
                      setModel(m.id, {
                        overrides: { ...m.overrides, temperature: v < 0 ? undefined : v },
                      })
                    }
                  />
                  <SliderRow
                    label="Max tokens override"
                    value={m.overrides?.maxTokens ?? -1}
                    min={-1}
                    max={64000}
                    step={128}
                    format={(v) => (v < 0 ? 'use default' : String(v))}
                    onChange={(v) =>
                      setModel(m.id, {
                        overrides: { ...m.overrides, maxTokens: v < 0 ? undefined : v },
                      })
                    }
                  />
                  <FieldRow label="System prompt override">
                    <textarea
                      rows={2}
                      value={m.overrides?.systemPrompt ?? ''}
                      placeholder="Leave empty to use the default"
                      onChange={(e) =>
                        setModel(m.id, {
                          overrides: { ...m.overrides, systemPrompt: e.target.value || undefined },
                        })
                      }
                    />
                  </FieldRow>
                  {m.provider === 'mock' && (
                    <SelectRow
                      label="Simulated behavior"
                      value={m.simulate ?? 'ok'}
                      hint="Make this model fail on its next request to watch failover live"
                      options={[
                        { value: 'ok', label: 'Healthy' },
                        { value: 'soft_rate_limit', label: 'Rate limit (soft)' },
                        { value: 'hard_quota', label: 'Quota exhausted (hard)' },
                        { value: 'timeout', label: 'Timeout mid-stream' },
                        { value: 'network', label: 'Network error' },
                        { value: 'auth', label: 'Auth failure' },
                        { value: 'bad_request', label: 'Rejected request (HTTP 400)' },
                      ]}
                      onChange={(v) => setModel(m.id, { simulate: v })}
                    />
                  )}
                  <div className="model-config-foot">
                    <span className="settings-note">
                      {m.costPer1kOut != null ? `$${m.costPer1kOut.toFixed(4)} / 1k out` : 'cost n/a'}
                      {m.contextWindow ? ` · ${formatCount(m.contextWindow)} ctx` : ''}
                    </span>
                    <button
                      className="btn small danger"
                      onClick={() => {
                        removeModel(m.id)
                        useHealth.getState().removeModel(m.id)
                      }}
                      type="button"
                    >
                      <IconTrash size={12} /> Remove
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {adding ? (
        <AddModelForm
          onCancel={() => setAdding(false)}
          onAdd={(def) => {
            addModel(def)
            setAdding(false)
          }}
        />
      ) : (
        <button className="btn ghost add-model" onClick={() => setAdding(true)} type="button">
          <IconPlus size={14} /> Add a model
        </button>
      )}
    </div>
  )
}

function AddModelForm({ onAdd, onCancel }: { onAdd: (def: ModelDef) => void; onCancel: () => void }) {
  const [label, setLabel] = useState('')
  const [provider, setProvider] = useState<Exclude<ProviderId, 'mock'>>('openai')
  const [apiModel, setApiModel] = useState('')
  const [baseURL, setBaseURL] = useState('')

  return (
    <div className="add-model-form">
      <FieldRow label="Display name">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="GPT-4o mini" />
      </FieldRow>
      <FieldRow label="Provider">
        <select value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="google">Google Gemini</option>
          <option value="openai-compatible">OpenAI-compatible (custom URL)</option>
        </select>
      </FieldRow>
      <FieldRow label="Model ID">
        <input value={apiModel} onChange={(e) => setApiModel(e.target.value)} placeholder="gpt-4o-mini" />
      </FieldRow>
      {provider === 'openai-compatible' && (
        <FieldRow label="Base URL">
          <input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://…/v1" />
        </FieldRow>
      )}
      <div className="msg-edit-actions">
        <button className="btn ghost" onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!label.trim() || !apiModel.trim()}
          onClick={() =>
            onAdd({
              id: uid('model'),
              label: label.trim(),
              provider,
              apiModel: apiModel.trim(),
              baseURL: baseURL.trim() || undefined,
              enabled: true,
            })
          }
          type="button"
        >
          Add model
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Defaults tab                                                        */
/* ------------------------------------------------------------------ */

function DefaultsTab() {
  const defaults = useSettings((s) => s.s.defaults)
  const set = useSettings.getState().setDefaults
  return (
    <div>
      <SectionTitle>Generation</SectionTitle>
      <SliderRow label="Temperature" value={defaults.temperature} min={0} max={2} step={0.05} onChange={(v) => set({ temperature: v })} format={(v) => v.toFixed(2)} />
      <SliderRow label="Top-p" value={defaults.topP} min={0} max={1} step={0.01} onChange={(v) => set({ topP: v })} format={(v) => v.toFixed(2)} />
      <SliderRow label="Max output tokens" value={defaults.maxTokens} min={128} max={64000} step={128} onChange={(v) => set({ maxTokens: v })} />
      <FieldRow label="Default system prompt">
        <textarea rows={4} value={defaults.systemPrompt} onChange={(e) => set({ systemPrompt: e.target.value })} />
      </FieldRow>

      <SectionTitle>Streaming & feel</SectionTitle>
      <Toggle checked={defaults.stream} onChange={(v) => set({ stream: v })} label="Stream responses" hint="Token-by-token rendering" />
      <Toggle checked={defaults.typingIndicator} onChange={(v) => set({ typingIndicator: v })} label="Typing indicator" hint="Animated dots while waiting for the first token" />
      <SelectRow
        label="Auto-scroll"
        value={defaults.autoScroll}
        options={[
          { value: 'smooth', label: 'Smooth follow' },
          { value: 'instant', label: 'Instant follow' },
          { value: 'off', label: 'Off' },
        ]}
        onChange={(v) => set({ autoScroll: v })}
        hint="Yields the moment you scroll up"
      />

      <SectionTitle>Failover</SectionTitle>
      <SelectRow
        label="Strategy"
        value={defaults.failoverStrategy}
        options={[
          { value: 'priority', label: 'Strict priority order' },
          { value: 'fastest', label: 'Fastest first (measured latency)' },
          { value: 'cheapest', label: 'Cheapest first ($/1k tokens)' },
        ]}
        onChange={(v) => set({ failoverStrategy: v })}
      />
      <SliderRow
        label="First-token timeout"
        value={defaults.firstTokenTimeoutMs / 1000}
        min={15}
        max={300}
        step={5}
        format={(v) => `${v}s`}
        onChange={(v) => set({ firstTokenTimeoutMs: v * 1000 })}
        hint="How long to wait for a model's first token. Keep this generous — reasoning models (Gemini 2.5, o-series) think before they answer."
      />
      <SliderRow
        label="Stream timeout"
        value={defaults.requestTimeoutMs / 1000}
        min={10}
        max={300}
        step={5}
        format={(v) => `${v}s`}
        onChange={(v) => set({ requestTimeoutMs: v * 1000 })}
        hint="Idle time between chunks once a model is already streaming, before it counts as stalled"
      />

      <SectionTitle>Artifacts</SectionTitle>
      <ArtifactPrefs />
    </div>
  )
}

function ArtifactPrefs() {
  const prefs = useSettings((s) => s.s.artifacts)
  const set = useSettings.getState().setArtifactsPrefs
  return (
    <>
      <Toggle checked={prefs.collapsedByDefault} onChange={(v) => set({ collapsedByDefault: v })} label="Collapse artifact cards by default" />
      <Toggle checked={prefs.autoExpandImages} onChange={(v) => set({ autoExpandImages: v })} label="Auto-expand images" />
      <SliderRow label="Max preview height" value={prefs.maxPreviewHeight} min={160} max={800} step={20} onChange={(v) => set({ maxPreviewHeight: v })} format={(v) => `${v}px`} />
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Providers tab                                                       */
/* ------------------------------------------------------------------ */

const PROVIDER_LIST: { id: ProviderId; label: string; hint: string; keyUrl?: string }[] = [
  { id: 'openai', label: 'OpenAI', hint: 'GPT-4o and friends', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic', hint: 'Claude models', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'google', label: 'Google Gemini', hint: 'Gemini models', keyUrl: 'https://aistudio.google.com/app/apikey' },
  { id: 'openai-compatible', label: 'OpenAI-compatible', hint: 'Groq, OpenRouter, Together, Ollama…' },
  { id: 'mock', label: 'Built-in simulator', hint: 'No key needed — powers the demo models' },
]

type TestState = { ok: boolean; message: string } | 'testing' | null

function ProvidersTab() {
  const providers = useSettings((s) => s.s.providers)
  const setProvider = useSettings.getState().setProvider
  const [show, setShow] = useState<Record<string, boolean>>({})
  const [tests, setTests] = useState<Record<string, TestState>>({})

  const test = async (pid: ProviderId) => {
    setTests((t) => ({ ...t, [pid]: 'testing' }))
    const adapter = adapterFor(pid)
    const cfg = providers[pid] ?? { apiKey: '' }
    // Test against a model the user actually has configured, so the result
    // means "this chain can answer", not "this key can list a catalogue".
    const models = useSettings.getState().s.models
    const configured = models.find((m) => m.provider === pid && m.enabled) ?? models.find((m) => m.provider === pid)
    const res = await adapter.testKey(cfg.apiKey, cfg.baseURL, configured)
    setTests((t) => ({ ...t, [pid]: { ok: res.ok, message: res.message } }))
    if (res.ok) {
      for (const m of models) {
        if (m.provider === pid) useHealth.getState().markHealthy(m.id)
      }
    }
  }

  return (
    <div>
      <SectionTitle>API keys</SectionTitle>
      <p className="settings-note">
        Keys are stored locally in your browser only, are masked on screen, and are never logged or sent anywhere except
        the provider you choose.
      </p>
      {PROVIDER_LIST.map((p) => {
        const cfg = providers[p.id] ?? { apiKey: '' }
        const t = tests[p.id] ?? null
        const isMock = p.id === 'mock'
        return (
          <div key={p.id} className="provider-row">
            <div className="provider-head">
              <strong>{p.label}</strong>
              <span className="provider-hint">{p.hint}</span>
            </div>
            {!isMock && (
              <div className="provider-key-row">
                <input
                  type={show[p.id] ? 'text' : 'password'}
                  value={cfg.apiKey}
                  placeholder="sk-…"
                  aria-label={`${p.label} API key`}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setProvider(p.id, { apiKey: e.target.value })}
                />
                <button className="btn ghost" onClick={() => setShow((s) => ({ ...s, [p.id]: !s[p.id] }))} type="button">
                  {show[p.id] ? 'Hide' : 'Show'}
                </button>
                <button className="btn primary" onClick={() => void test(p.id)} disabled={t === 'testing'} type="button">
                  {t === 'testing' ? 'Testing…' : 'Test'}
                </button>
              </div>
            )}
            {p.id === 'openai-compatible' && (
              <FieldRow label="Default base URL" hint="Used by openai-compatible models without their own URL">
                <input
                  value={cfg.baseURL ?? ''}
                  placeholder="https://api.groq.com/openai/v1"
                  onChange={(e) => setProvider(p.id, { baseURL: e.target.value })}
                />
              </FieldRow>
            )}
            {t && t !== 'testing' && (
              <div className={`provider-test ${t.ok ? 'ok' : 'fail'}`} role="status">
                {t.ok ? <IconCheck size={12} /> : <IconAlert size={12} />} {t.message}
              </div>
            )}
            {p.keyUrl && (
              <a className="link-btn" href={p.keyUrl} target="_blank" rel="noreferrer">
                Get a key ↗
              </a>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Appearance tab                                                      */
/* ------------------------------------------------------------------ */

function AppearanceTab() {
  const appearance = useSettings((s) => s.s.appearance)
  const set = useSettings.getState().setAppearance
  return (
    <div>
      <SectionTitle>Theme</SectionTitle>
      <SegmentedControl
        label="Color theme"
        value={appearance.theme}
        options={[
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
          { value: 'system', label: 'System' },
        ]}
        onChange={(v) => set({ theme: v })}
      />
      <SelectRow
        label="Code theme"
        value={appearance.codeTheme}
        options={[
          { value: 'auto', label: 'Match app theme' },
          { value: 'light', label: 'Always light' },
          { value: 'dark', label: 'Always dark' },
        ]}
        onChange={(v) => set({ codeTheme: v })}
      />
      <SectionTitle>Layout</SectionTitle>
      <SliderRow label="Font size" value={appearance.fontSize} min={12} max={20} step={1} onChange={(v) => set({ fontSize: v })} format={(v) => `${v}px`} />
      <SelectRow
        label="Message density"
        value={appearance.density}
        options={[
          { value: 'compact', label: 'Compact' },
          { value: 'cozy', label: 'Cozy' },
          { value: 'roomy', label: 'Roomy' },
        ]}
        onChange={(v) => set({ density: v })}
      />
      <SectionTitle>Behavior</SectionTitle>
      <Toggle checked={appearance.enterToSend} onChange={(v) => set({ enterToSend: v })} label="Enter sends message" hint="Off: Enter makes a newline, Ctrl+Enter sends" />
      <Toggle checked={appearance.reduceMotion} onChange={(v) => set({ reduceMotion: v })} label="Reduce motion" hint="Also honors your OS reduced-motion preference" />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Data tab                                                            */
/* ------------------------------------------------------------------ */

function DataTab() {
  const toast = useUI((s) => s.toast)
  const fileRef = useRef<HTMLInputElement>(null)

  const exportAll = () => {
    const settings = useSettings.getState().s
    const chat = useChat.getState()
    const conversations = chat.order.map((id) => chat.conversations[id]).filter(Boolean)
    const artifacts = Object.values(useArtifacts.getState().byId).filter((a) => !a.ephemeral && (a.dataURL || a.text))
    const bundle = { app: 'slade' as const, version: 1, exportedAt: Date.now(), settings, conversations, artifacts }
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    downloadUrl(URL.createObjectURL(blob), `slade-backup-${new Date().toISOString().slice(0, 10)}.json`)
    toast({ kind: 'success', title: 'Exported settings, conversations & artifacts' })
  }

  const importFile = async (file: File) => {
    try {
      const parsed = exportBundleSchema.safeParse(JSON.parse(await file.text()))
      if (!parsed.success) {
        toast({ kind: 'error', title: 'Import failed', detail: 'That file is not a valid Slade backup.' })
        return
      }
      const bundle = parsed.data
      if (bundle.settings) {
        const s = settingsSchema.parse(bundle.settings)
        useSettings.getState().replaceAll(s)
      }
      if (bundle.conversations) {
        // Rehydrate generated artifacts' blob URLs where possible, then import.
        for (const a of bundle.artifacts ?? []) {
          useArtifacts.getState().add({ ...a, ephemeral: a.ephemeral ?? false })
        }
        useChat.getState().importConversations(bundle.conversations)
      }
      toast({ kind: 'success', title: 'Import complete' })
    } catch (err) {
      toast({ kind: 'error', title: 'Import failed', detail: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div>
      <SectionTitle>Backup</SectionTitle>
      <div className="data-actions">
        <button className="btn ghost" onClick={exportAll} type="button">
          <IconDownload size={14} /> Export everything as JSON
        </button>
        <button className="btn ghost" onClick={() => fileRef.current?.click()} type="button">
          Import backup…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void importFile(f)
            e.target.value = ''
          }}
        />
      </div>

      <SectionTitle>Danger zone</SectionTitle>
      <div className="data-actions">
        <button
          className="btn danger"
          onClick={() => {
            if (confirm('Delete all conversations? This cannot be undone.')) {
              useChat.getState().clearAllConversations()
              toast({ kind: 'success', title: 'Conversation history cleared' })
            }
          }}
          type="button"
        >
          <IconTrash size={14} /> Clear conversation history
        </button>
        <button
          className="btn danger"
          onClick={() => {
            if (confirm('Reset all settings to defaults? Conversations are kept.')) {
              useSettings.getState().resetSettings()
              toast({ kind: 'success', title: 'Settings reset to defaults' })
            }
          }}
          type="button"
        >
          <IconTrash size={14} /> Reset settings
        </button>
      </div>
      <p className="settings-note">
        Everything lives in your browser's local storage. Nothing is sent anywhere except to the providers you configure,
        and only for the messages you send.
      </p>
      <p className="settings-note">
        Factory models: {DEFAULT_SETTINGS.models.length} · {DEFAULT_SETTINGS.models.filter((m) => m.enabled).length}{' '}
        enabled by default.
      </p>
    </div>
  )
}
