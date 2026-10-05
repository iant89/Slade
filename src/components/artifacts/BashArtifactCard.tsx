import { useId, useState } from 'react'
import type { BashExecution } from '../../types'
import { useSettings } from '../../store/settings'
import { formatExecutionDuration } from '../../lib/format'
import { IconChevronDown, IconChevronRight, IconTerminal } from '../icons'

/** An execution record, not a runnable shell or a preview of a shell script. */
export function BashArtifactCard({ execution, peek = false }: { execution: BashExecution; peek?: boolean }) {
  const prefs = useSettings((s) => s.s.artifacts)
  const [expanded, setExpanded] = useState(peek || !prefs.collapsedByDefault)
  const bodyId = useId()
  const running = execution.status === 'running'
  const failed = execution.status === 'failed'
  const subtitle = running
    ? 'Running…'
    : execution.isMock
      ? 'Simulated execution'
      : `${failed ? 'Failed' : 'Finished'}, ${formatExecutionDuration(execution.finishedAt - execution.startedAt)}`

  return (
    <figure className={`artifact-card bash-artifact is-${execution.status}`} aria-label="Bash command">
      <button
        type="button"
        className="artifact-head bash-artifact-head"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={bodyId}
        title={expanded ? 'Collapse command and output' : 'Expand command and output'}
      >
        <span className="bash-terminal-icon" aria-hidden="true">
          <IconTerminal size={16} />
        </span>
        <span className="artifact-meta">
          <span className="artifact-name">Bash</span>
          <span className="artifact-sub" role="status" aria-live="polite">{subtitle}</span>
        </span>
        <span className="bash-chevron" aria-hidden="true">
          {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        </span>
      </button>
      <div id={bodyId} hidden={!expanded} className="bash-artifact-details">
        <section className="bash-command" aria-label="Executed command">
          <div className="bash-panel-label">Command</div>
          <pre style={{ maxHeight: prefs.maxPreviewHeight }}><code>{execution.command}</code></pre>
        </section>
        <section className="bash-output" aria-label="Command output" aria-busy={running}>
          <div className="bash-panel-label">Output</div>
          <pre style={{ maxHeight: prefs.maxPreviewHeight }}><code>{execution.output || (running ? 'Waiting for output…' : 'No output.')}</code></pre>
        </section>
      </div>
    </figure>
  )
}
