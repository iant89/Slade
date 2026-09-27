import { useEffect, useRef, useState } from 'react'
import { formatDuration } from '../../lib/format'
import { IconAudio, IconPause, IconPlay, IconExpand } from '../icons'
import { useUI } from '../../store/ui'

/* ------------------------------------------------------------------ */
/* Audio: inline player with waveform scrubber + playback speed        */
/* ------------------------------------------------------------------ */

const SPEEDS = [0.75, 1, 1.25, 1.5, 2]

export function AudioPlayer({ src, name, durationHint }: { src: string; name: string; durationHint?: number }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(durationHint ?? 0)
  const [speed, setSpeed] = useState(1)
  const [peaks, setPeaks] = useState<number[] | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const buf = await fetch(src).then((r) => r.arrayBuffer())
        const AC: typeof AudioContext | undefined =
          window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!AC || !alive) return
        const ctx = new AC()
        const decoded = await ctx.decodeAudioData(buf)
        const ch = decoded.getChannelData(0)
        const buckets = 140
        const size = Math.floor(ch.length / buckets)
        const next: number[] = []
        for (let i = 0; i < buckets; i++) {
          let peak = 0
          for (let j = 0; j < size; j += 16) {
            const v = Math.abs(ch[i * size + j] ?? 0)
            if (v > peak) peak = v
          }
          next.push(peak)
        }
        ctx.close()
        if (alive) setPeaks(next)
      } catch {
        /* waveform unavailable — scrubber still works */
      }
    })()
    return () => {
      alive = false
    }
  }, [src])

  useEffect(() => {
    const a = audioRef.current
    if (a) a.playbackRate = speed
  }, [speed])

  const toggle = async () => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) {
      try {
        await a.play()
      } catch {
        /* autoplay policy — user gesture should allow it */
      }
    } else a.pause()
  }

  const seekTo = (frac: number) => {
    const a = audioRef.current
    if (!a || !Number.isFinite(a.duration)) return
    a.currentTime = frac * a.duration
  }

  const frac = duration > 0 ? Math.min(1, time / duration) : 0

  return (
    <div className="audio-artifact">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration
          if (Number.isFinite(d)) setDuration(d)
        }}
        onEnded={() => setPlaying(false)}
      />
      <button className="audio-play icon-btn accent" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} type="button">
        {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
      </button>
      <div className="audio-main">
        <div className="audio-title">{name}</div>
        <div
          className={`waveform${peaks ? '' : ' flat'}`}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(frac * 100)}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') seekTo(Math.min(1, frac + 0.05))
            if (e.key === 'ArrowLeft') seekTo(Math.max(0, frac - 0.05))
          }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            seekTo((e.clientX - rect.left) / rect.width)
          }}
        >
          <canvas
            ref={(canvas) => {
              canvasRef.current = canvas
              if (!canvas) return
              const w = canvas.clientWidth * (window.devicePixelRatio || 1)
              const h = canvas.clientHeight * (window.devicePixelRatio || 1)
              canvas.width = w
              canvas.height = h
              const g = canvas.getContext('2d')
              if (!g) return
              g.clearRect(0, 0, w, h)
              const barCount = peaks?.length ?? 60
              const barW = w / barCount
              for (let i = 0; i < barCount; i++) {
                const p = peaks ? (peaks[i] ?? 0.1) : 0.25
                const bh = Math.max(2, p * h * 0.92)
                const x = i * barW + barW * 0.18
                const y = (h - bh) / 2
                g.fillStyle = i / barCount <= frac ? 'var(--accent)' : 'var(--border-strong)'
                g.beginPath()
                g.roundRect(x, y, Math.max(1.5, barW * 0.64), bh, 2)
                g.fill()
              }
            }}
            height={38}
          />
        </div>
        <div className="audio-row">
          <span className="audio-time">
            {formatDuration(time)} / {formatDuration(duration)}
          </span>
          <div className="speed-picker" role="group" aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <button
                key={s}
                className={`speed-chip${speed === s ? ' active' : ''}`}
                onClick={() => setSpeed(s)}
                type="button"
                aria-pressed={speed === s}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>
      </div>
      <span className="audio-kind-icon" aria-hidden="true">
        <IconAudio size={14} />
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Video: player with full-screen                                      */
/* ------------------------------------------------------------------ */

export function VideoPlayer({ src, name, maxHeight }: { src: string; name: string; maxHeight: number }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const openLightbox = useUI((s) => s.openLightbox)
  void openLightbox

  return (
    <div className="video-artifact" ref={wrapRef} style={{ maxHeight }}>
      <video src={src} controls preload="metadata" playsInline style={{ maxHeight }} aria-label={name} />
      <button
        className="video-fullscreen icon-btn"
        onClick={() => {
          const el = wrapRef.current
          if (el?.requestFullscreen) el.requestFullscreen().catch(() => {})
          else {
            // Fallback: open in a new tab for native controls + fullscreen.
            window.open(src, '_blank', 'noopener')
          }
        }}
        aria-label="Full screen"
        title="Full screen"
        type="button"
      >
        <IconExpand size={14} />
      </button>
    </div>
  )
}
