import { useEffect, useState } from 'react'
import { useSettings, providerById } from '../../store/settings'
import { useHealth, isRoutable } from '../../store/health'
import { useUI } from '../../store/ui'
import { formatCount, relativeCooldown } from '../../lib/format'
import { IconChevronDown, IconChevronRight, IconPin, IconX, IconZap } from '../icons'

function RailRow({ modelId }: { modelId: string }) {
  const settings = useSettings((s) => s.s)
  const health = useHealth((s) => s.byModel)
  const model = settings.models.find((m) => m.id === modelId)
  const [, force] = useState(0)

  // Re-render every second while any cooldown is ticking.
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  if (!model) return null
  const h = health[model.id]
  const provider = providerById(settings, model.provider)
  const cooling = h?.cooldownUntil && h.cooldownUntil > Date.now()
  const state = !model.enabled ? 'disabled' : h?.state === 'error' ? 'error' : cooling ? 'cooldown' : 'available'
  const isPinned = settings.pinnedModelId === model.id

  const move = (dir: -1 | 1) => {
    const s = useSettings.getState().s
    const ids = s.models.map((m) => m.id)
    const i = ids.indexOf(model.id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
    useSettings.getState().reorderModels(ids)
  }

  return (
    <div className={`rail-row state-${state}${model.enabled ? '' : ' off'}`}>
      <div className="rail-row-top">
        <span className={`state-dot ${state}`} aria-hidden="true" />
        <span className="rail-row-label" title={h?.lastError ? `${h.lastError.failure}: ${h.lastError.message}` : model.label}>
          {model.label}
        </span>
        <button
          className={`icon-btn small${isPinned ? ' pinned' : ''}`}
          onClick={() => useSettings.getState().pin(isPinned ? undefined : model.id)}
          aria-label={isPinned ? `Unpin ${model.label}` : `Pin ${model.label} as primary`}
          aria-pressed={isPinned}
          title={isPinned ? 'Unpin' : 'Pin as primary'}
          type="button"
        >
          <IconPin size={12} />
        </button>
      </div>
      <div className="rail-row-sub">
        <span className="rail-provider">{provider?.label ?? model.provider}</span>
        {h?.avgLatencyMs != null && (
          <span className="rail-latency">
            <IconZap size={10} /> {h.avgLatencyMs}ms
          </span>
        )}
        {model.costPer1kOut != null && model.costPer1kOut > 0 && (
          <span className="rail-cost">${model.costPer1kOut.toFixed(4)}/1k out</span>
        )}
      </div>
      <div className="rail-row-stats">
        <span title="Requests served">{formatCount(h?.totalRequests ?? 0)} req</span>
        <span title="Tokens generated">{formatCount(h?.totalTokensOut ?? 0)} tok</span>
        {state === 'cooldown' && h?.cooldownUntil && (
          <span className="rail-cooldown" title={h.lastError?.message}>
            cooling {relativeCooldown(h.cooldownUntil)}
          </span>
        )}
        {state === 'error' && <span className="rail-error">needs key / auth</span>}
        {state === 'available' && !isRoutable(h, true) && <span className="rail-cooldown">cooling</span>}
      </div>
      {provider?.kind === 'mock' && model.enabled && (
        <div className="rail-simulate">
          <label className="sr-only" htmlFor={`sim-${model.id}`}>
            Simulated behavior for {model.label}
          </label>
          <select
            id={`sim-${model.id}`}
            value={model.simulate ?? 'ok'}
            onChange={(e) => useSettings.getState().setModel(model.id, { simulate: e.target.value as never })}
          >
            <option value="ok">simulate: healthy</option>
            <option value="soft_rate_limit">simulate: rate limit</option>
            <option value="hard_quota">simulate: quota exhausted</option>
            <option value="timeout">simulate: mid-stream timeout</option>
            <option value="network">simulate: network error</option>
            <option value="auth">simulate: auth failure</option>
            <option value="bad_request">simulate: rejected request</option>
          </select>
        </div>
      )}
      <div className="rail-row-actions">
        <button className="icon-btn small" onClick={() => move(-1)} aria-label={`Move ${model.label} up in priority`} type="button">
          <IconChevronDown size={12} className="flip-v" />
        </button>
        <button className="icon-btn small" onClick={() => move(1)} aria-label={`Move ${model.label} down in priority`} type="button">
          <IconChevronDown size={12} />
        </button>
      </div>
    </div>
  )
}

export function ModelRail() {
  const settings = useSettings((s) => s.s)
  const railOpen = useUI((s) => s.railOpen)
  const toggleRail = useUI((s) => s.toggleRail)
  const strategy = settings.defaults.failoverStrategy

  return (
    <>
      {railOpen && <div className="drawer-backdrop only-mobile" onClick={toggleRail} aria-hidden="true" />}
      <aside className={`model-rail${railOpen ? ' open' : ''}`} aria-label="Model chain and health">
        <div className="rail-head">
          <h2>
            <IconChevronRight size={13} className="rail-head-icon" /> Model chain
          </h2>
          <button className="icon-btn only-mobile" onClick={toggleRail} aria-label="Close model panel" type="button">
            <IconX size={16} />
          </button>
        </div>
        <div className="rail-strategy">
          <label htmlFor="rail-strategy-select">Failover strategy</label>
          <div className="select-wrap">
            <select
              id="rail-strategy-select"
              value={strategy}
              onChange={(e) => useSettings.getState().setDefaults({ failoverStrategy: e.target.value as never })}
            >
              <option value="priority">Strict priority order</option>
              <option value="fastest">Fastest first</option>
              <option value="cheapest">Cheapest first</option>
            </select>
          </div>
        </div>
        <div className="rail-list">
          {settings.models.map((m) => (
            <RailRow key={m.id} modelId={m.id} />
          ))}
        </div>
        <p className="rail-foot">
          Slade walks this chain top-down. Cooldowns mask a model temporarily — your priority order never changes.
        </p>
      </aside>
    </>
  )
}
