import { AnimatePresence, motion } from 'framer-motion'
import { useUI } from '../../store/ui'
import { IconAlert, IconCheck, IconX, IconZap } from '../icons'

const ICONS = {
  info: <IconZap size={15} />,
  success: <IconCheck size={15} />,
  warn: <IconAlert size={15} />,
  error: <IconAlert size={15} />,
} as const

export function Toasts() {
  const toasts = useUI((s) => s.toasts)
  const dismiss = useUI((s) => s.dismissToast)
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            className={`toast toast-${t.kind}`}
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          >
            <span className="toast-icon">{ICONS[t.kind]}</span>
            <span className="toast-body">
              <span className="toast-title">{t.title}</span>
              {t.detail && <span className="toast-detail">{t.detail}</span>}
            </span>
            {t.action ? (
              <button
                className="toast-action"
                type="button"
                onClick={() => {
                  // Dismiss first: the action may itself raise another toast.
                  dismiss(t.id)
                  t.action?.onClick()
                }}
              >
                {t.action.label}
              </button>
            ) : null}
            <button className="icon-btn" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
              <IconX size={13} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
