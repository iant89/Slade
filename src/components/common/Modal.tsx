import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { IconX } from '../icons'

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface ModalProps {
  open: boolean
  onClose: () => void
  labelledBy?: string
  children: ReactNode
  variant?: 'sheet' | 'lightbox'
  /** Extra class on the backdrop, e.g. to layer a modal above another modal. */
  className?: string
}

/**
 * Open modals, outermost first. Escape only closes the topmost one, so a
 * dialog opened from inside another dialog doesn't dismiss both at once.
 */
const modalStack: symbol[] = []

/**
 * Accessible modal shell: portal, focus trap, Esc to close, spring motion.
 * Centered dialog on desktop, full-screen sheet on small screens (CSS).
 */
export function Modal({ open, onClose, labelledBy, children, variant = 'sheet', className }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    const node = ref.current
    const previouslyFocused = document.activeElement as HTMLElement | null
    const token = Symbol('modal')
    modalStack.push(token)

    // Focus the first focusable element inside the dialog.
    const focusFrame = requestAnimationFrame(() => {
      const first = node?.querySelector<HTMLElement>(FOCUSABLE)
      first?.focus()
    })

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (modalStack[modalStack.length - 1] !== token) return
        e.stopPropagation()
        closeRef.current()
        return
      }
      if (e.key !== 'Tab' || !node || modalStack[modalStack.length - 1] !== token) return
      const focusables = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      )
      if (focusables.length === 0) {
        e.preventDefault()
        node.focus()
        return
      }
      const first = focusables[0]!
      if (!node.contains(document.activeElement)) {
        e.preventDefault()
        ;(e.shiftKey ? focusables[focusables.length - 1] : first)?.focus()
        return
      }
      const last = focusables[focusables.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prevOverflow
      const i = modalStack.indexOf(token)
      if (i !== -1) modalStack.splice(i, 1)
      previouslyFocused?.focus?.()
    }
  }, [open])

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className={`modal-backdrop modal-${variant}${className ? ` ${className}` : ''}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose()
          }}
        >
          <motion.div
            ref={ref}
            className="modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy}
            tabIndex={-1}
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.985 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.9 }}
          >
            {children}
            <button className="modal-close icon-btn" onClick={onClose} aria-label="Close dialog">
              <IconX size={18} />
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
