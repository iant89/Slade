import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useUI } from '../../store/ui'
import { useArtifacts } from '../../store/artifacts'
import { artifactUrl, downloadUrl } from '../../lib/clipboard'
import { IconDownload, IconX, IconPlus, IconChevronRight } from '../icons'

/**
 * Full-resolution image lightbox with zoom (wheel/buttons/double-click),
 * pan (drag), and download.
 */
export function Lightbox() {
  const openId = useUI((s) => s.lightbox?.artifactId)
  const close = useUI((s) => s.closeLightbox)
  const artifact = useArtifacts((s) => (openId ? s.byId[openId] : undefined))
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const backdropRef = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    setScale(1)
    setTx(0)
    setTy(0)
  }, [openId])

  /**
   * The close button and the image vanish when the lightbox unmounts; without a
   * handoff, a keyboard user is dumped at <body>. Close through this so focus
   * returns to whoever opened the preview.
   */
  const closeAndRestore = useCallback(() => {
    close()
    const el = openerRef.current
    openerRef.current = null
    requestAnimationFrame(() => {
      if (el?.isConnected) el.focus()
    })
  }, [close])

  // A React onWheel prop is attached passively at the root, so preventDefault()
  // there logs a console intervention error. A manual non-passive listener can
  // actually stop the page behind from scrolling.
  useEffect(() => {
    const el = backdropRef.current
    if (!openId || !el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setScale((s) => Math.min(8, Math.max(1, s * (e.deltaY < 0 ? 1.15 : 0.87))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [openId])

  useEffect(() => {
    if (!openId) return
    // Remember the opener while it still exists (the first effect run happens
    // right after the click that opened us).
    openerRef.current = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAndRestore()
      if (e.key === '+' || e.key === '=') setScale((s) => Math.min(8, s * 1.2))
      if (e.key === '-') setScale((s) => Math.max(1, s / 1.2))
      if (e.key === '0') {
        setScale(1)
        setTx(0)
        setTy(0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId, closeAndRestore])

  if (!openId || !artifact) return null
  const src = artifactUrl(artifact)
  if (!src) return null

  return createPortal(
    <AnimatePresence>
      <motion.div
        ref={backdropRef}
        className="lightbox-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) closeAndRestore()
        }}
      >
        <motion.img
          className="lightbox-img"
          src={src}
          alt={artifact.name}
          draggable={false}
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})`, cursor: scale > 1 ? 'grab' : 'zoom-in' }}
          onDoubleClick={() => {
            setScale((s) => (s > 1 ? 1 : 2.5))
            if (scale > 1) {
              setTx(0)
              setTy(0)
            }
          }}
          onMouseDown={(e) => {
            drag.current = { x: e.clientX, y: e.clientY, tx, ty }
            try {
              e.currentTarget.setPointerCapture((e.nativeEvent as PointerEvent).pointerId)
            } catch {
              /* capture unavailable — drag still works within the image */
            }
          }}
          onMouseMove={(e) => {
            if (!drag.current) return
            setTx(drag.current.tx + (e.clientX - drag.current.x))
            setTy(drag.current.ty + (e.clientY - drag.current.y))
          }}
          onMouseUp={() => (drag.current = null)}
        />
        <div className="lightbox-bar">
          <span className="lightbox-name">{artifact.name}</span>
          <div className="lightbox-actions">
            <button className="icon-btn" onClick={() => setScale((s) => Math.min(8, s * 1.25))} aria-label="Zoom in">
              <IconPlus size={15} />
            </button>
            <button
              className="icon-btn"
              onClick={() => {
                setScale((s) => Math.max(1, s / 1.25))
              }}
              aria-label="Zoom out"
            >
              <span style={{ transform: 'rotate(45deg)', display: 'inline-flex' }}>
                <IconPlus size={15} />
              </span>
            </button>
            <span className="lightbox-zoom">{Math.round(scale * 100)}%</span>
            <button className="icon-btn" onClick={() => downloadUrl(src, artifact.name)} aria-label="Download image">
              <IconDownload size={15} />
            </button>
            <button className="icon-btn" onClick={closeAndRestore} aria-label="Close lightbox" type="button">
              <IconX size={16} />
            </button>
          </div>
        </div>
        <span className="lightbox-hint">
          <IconChevronRight size={12} /> scroll to zoom · drag to pan · double-click to reset
        </span>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}
