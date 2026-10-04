import { useEffect } from 'react'
import { useSettings } from './store/settings'
import { useUI } from './store/ui'
import { Sidebar } from './components/layout/Sidebar'
import { Header } from './components/layout/Header'
import { ModelRail } from './components/layout/ModelRail'
import { ChatView } from './components/chat/ChatView'
import { Composer } from './components/chat/Composer'
import { SettingsModal } from './components/settings/SettingsModal'
import { GitHubPanel } from './components/github/GitHubPanel'
import { FilesPanel } from './components/fs/FilesPanel'
import { MemoryModal } from './components/memory/MemoryModal'
import { PublishDialog } from './components/github/PublishDialog'
import { Lightbox } from './components/artifacts/Lightbox'
import { Toasts } from './components/common/Toasts'
import { IconPaperclip, IconWifiOff } from './components/icons'

/** Applies theme, density, font size, motion and code-theme to the document. */
function useAppearanceEffects() {
  const appearance = useSettings((s) => s.s.appearance)

  useEffect(() => {
    const root = document.documentElement
    const mq = window.matchMedia('(prefers-color-scheme: light)')

    const apply = () => {
      const resolved =
        appearance.theme === 'system' ? (mq.matches ? 'light' : 'dark') : appearance.theme
      root.dataset.theme = resolved
      root.dataset.density = appearance.density
      root.dataset.codeTheme = appearance.codeTheme === 'auto' ? resolved : appearance.codeTheme
      root.style.setProperty('--app-font-size', `${appearance.fontSize}px`)
      root.dataset.reduceMotion = appearance.reduceMotion || mqReduced() ? 'true' : 'false'
    }
    const mqReduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

    apply()
    mq.addEventListener('change', apply)
    const rm = window.matchMedia('(prefers-reduced-motion: reduce)')
    rm.addEventListener('change', apply)
    return () => {
      mq.removeEventListener('change', apply)
      rm.removeEventListener('change', apply)
    }
  }, [appearance])
}

function useOnlineEffects() {
  useEffect(() => {
    const on = () => useUI.getState().setOnline(true)
    const off = () => useUI.getState().setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
}

function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
      // A shortcut must not open a drawer behind a dialog or tear down the
      // parent Settings dialog while its nested picker is active.
      if (dialogs.length > 0 && (e.key === 'Escape' || (meta && (e.key !== ',' || dialogs.length > 1)))) {
        if (meta && [',', 'j', 'g', 'e'].includes(e.key.toLowerCase())) e.preventDefault()
        return
      }
      if (meta && e.key === ',') {
        e.preventDefault()
        const ui = useUI.getState()
        if (ui.settingsOpen) ui.closeSettings()
        else ui.openSettings()
      }
      if (meta && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        useUI.getState().toggleSidebar()
      }
      if (meta && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        useUI.getState().toggleGithub()
      }
      if (meta && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        useUI.getState().toggleFiles()
      }
      // Esc closes the GitHub or Files drawer unless something modal has focus
      // — and unless a resize drag owns the key (see ResizeHandle).
      if (e.key === 'Escape' && document.documentElement.dataset.resizing) return
      if (e.key === 'Escape' && (useUI.getState().githubOpen || useUI.getState().filesOpen) && !useUI.getState().publishSource) {
        const tag = (e.target as HTMLElement | null)?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          const panel = useUI.getState().githubOpen ? 'github' : 'files'
          useUI.getState().closeGithub()
          useUI.getState().closeFiles()
          // A drawer's close button disappears when it closes; return keyboard
          // users to the control that opened it instead of leaving focus on body.
          document.querySelector<HTMLButtonElement>(`[data-panel-toggle="${panel}"]`)?.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function DragDropOverlay() {
  const active = useUI((s) => s.dragActive)
  if (!active) return null
  return (
    <div className="drag-overlay" aria-hidden="true">
      <div className="drag-overlay-card">
        <IconPaperclip size={22} />
        <span>Drop files to attach</span>
        <small>Images, code, CSVs, docs, audio, video — all become artifact cards</small>
      </div>
    </div>
  )
}

export default function App() {
  useAppearanceEffects()
  useOnlineEffects()
  useHotkeys()

  // Root-level state classes drive the animated sidebar / rail collapse.
  const sidebarOpen = useUI((s) => s.sidebarOpen)
  const railOpen = useUI((s) => s.railOpen)

  return (
    <div className={`app${sidebarOpen ? ' sidebar-open' : ''}${railOpen ? ' rail-open' : ''}`}>
      <Sidebar />
      <main className="main">
        <Header />
        {/* The scrollable chat panel: messages, then the session's GitHub cards. */}
        <ChatView />
        <Composer />
      </main>
      <ModelRail />
      <FilesPanel />
      <GitHubPanel />
      <MemoryModal />
      <SettingsModal />
      <PublishDialog />
      <Lightbox />
      <Toasts />
      <DragDropOverlay />
      <OfflineWatcher />
    </div>
  )
}

function OfflineWatcher() {
  const online = useUI((s) => s.online)
  if (online) return null
  return (
    <div className="offline-chip" role="alert">
      <IconWifiOff size={13} /> Offline
    </div>
  )
}
