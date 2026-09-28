import { useEffect } from 'react'
import { useSettings } from './store/settings'
import { useChat } from './store/chat'
import { useUI } from './store/ui'
import { Sidebar } from './components/layout/Sidebar'
import { Header } from './components/layout/Header'
import { ModelRail } from './components/layout/ModelRail'
import { ChatView } from './components/chat/ChatView'
import { Composer } from './components/chat/Composer'
import { SettingsModal } from './components/settings/SettingsModal'
import { GitHubPanel } from './components/github/GitHubPanel'
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
      // Esc closes the GitHub drawer unless something modal has focus.
      if (e.key === 'Escape' && useUI.getState().githubOpen && !useUI.getState().publishSource) {
        const tag = (e.target as HTMLElement | null)?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') useUI.getState().closeGithub()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** First run: open with a fresh conversation so the empty state shows. */
function useBootstrapConversation() {
  useEffect(() => {
    const chat = useChat.getState()
    if (!chat.currentId || !chat.conversations[chat.currentId]) {
      chat.newConversation()
    }
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
  useBootstrapConversation()

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Header />
        <ChatView />
        <Composer />
      </main>
      <ModelRail />
      <GitHubPanel />
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
