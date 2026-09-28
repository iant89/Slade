import type { ReactNode } from 'react'
import { IconAlert, IconGithub, IconLoader } from '../icons'

/** Small shared pieces for the GitHub workspace + publish dialog. */

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="gh-spinner" role="status" aria-live="polite">
      <IconLoader size={13} />
      {label ? <span>{label}</span> : null}
    </span>
  )
}

export function GhError({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className="gh-error" role="alert">
      <IconAlert size={14} />
      <span>{children}</span>
      {onRetry ? (
        <button className="btn ghost small" onClick={onRetry} type="button">
          Retry
        </button>
      ) : null}
    </div>
  )
}

export function GhEmpty({ title, detail, icon }: { title: string; detail?: string; icon?: ReactNode }) {
  return (
    <div className="gh-empty">
      {icon ?? <IconGithub size={20} />}
      <strong>{title}</strong>
      {detail ? <span>{detail}</span> : null}
    </div>
  )
}

export function ScopeChip({ scope, missing }: { scope: string; missing?: boolean }) {
  return (
    <span className={`gh-chip${missing ? ' missing' : ''}`} title={missing ? `This token was not granted "${scope}"` : scope}>
      {scope}
    </span>
  )
}
