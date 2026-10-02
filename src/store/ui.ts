import { create } from 'zustand'
import type { Toast } from '../types'
import { uid } from '../lib/id'

/** What the publish dialog is publishing. */
export type PublishSource =
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'message'; messageId: string }

export interface UIState {
  settingsOpen: boolean
  settingsTab: 'models' | 'defaults' | 'agent' | 'providers' | 'github' | 'appearance' | 'data'
  sidebarOpen: boolean
  railOpen: boolean
  /** GitHub context workspace drawer. */
  githubOpen: boolean
  githubTab: 'repos' | 'files' | 'search'
  /** Local file system workspace drawer. */
  filesOpen: boolean
  /** Cross-conversation Memory manager dialog and an optional message to remember. */
  memoryOpen: boolean
  memoryPrefill: string
  publishSource: PublishSource | null
  online: boolean
  toasts: Toast[]
  lightbox: { artifactId: string } | null
  /** Artifact ids queued in the composer for the next send. */
  pendingAttachmentIds: string[]
  dragActive: boolean
  /**
   * Counter bumped whenever any "Configure" affordance next to "Sign in with
   * GitHub" is clicked. Settings → GitHub watches it so it can do something
   * *useful* when the settings modal is already open on the GitHub tab (previously
   * the click would silently do nothing — the modal didn't re-open or move).
   */
  githubConfigRequest: number

  openSettings: (tab?: UIState['settingsTab']) => void
  /**
   * Like `openSettings('github')` but also closes the GitHub drawer, focuses
   * Settings → GitHub on its OAuth app block and highlights it. Use from any
   * "Configure" affordance sitting next to a "Sign in with GitHub" button.
   */
  configureGithub: () => void
  closeSettings: () => void
  setSettingsTab: (tab: UIState['settingsTab']) => void
  toggleSidebar: () => void
  toggleRail: () => void
  openGithub: (tab?: UIState['githubTab']) => void
  closeGithub: () => void
  toggleGithub: () => void
  setGithubTab: (tab: UIState['githubTab']) => void
  openFiles: () => void
  closeFiles: () => void
  toggleFiles: () => void
  openMemory: (prefill?: string) => void
  closeMemory: () => void
  openPublish: (source: PublishSource) => void
  closePublish: () => void
  setOnline: (v: boolean) => void
  toast: (t: Omit<Toast, 'id'>) => void
  dismissToast: (id: string) => void
  openLightbox: (artifactId: string) => void
  closeLightbox: () => void
  addPendingAttachment: (id: string) => void
  removePendingAttachment: (id: string) => void
  clearPendingAttachments: () => void
  setDragActive: (v: boolean) => void
}

export const useUI = create<UIState>((set) => ({
  settingsOpen: false,
  settingsTab: 'models',
  // Desktop starts with the sidebar open (it's a primary surface there); the
  // narrow layout starts with it closed, where it is an overlay drawer.
  sidebarOpen: typeof window !== 'undefined' ? window.innerWidth >= 900 : false,
  railOpen: false,
  githubOpen: false,
  githubTab: 'repos',
  filesOpen: false,
  memoryOpen: false,
  memoryPrefill: '',
  publishSource: null,
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  toasts: [],
  lightbox: null,
  pendingAttachmentIds: [],
  dragActive: false,
  githubConfigRequest: 0,

  openSettings: (tab) => set((st) => ({ settingsOpen: true, settingsTab: tab ?? st.settingsTab })),
  configureGithub: () =>
    set((st) => ({
      settingsOpen: true,
      settingsTab: 'github',
      // When the user asks to configure GitHub sign-in from inside the
      // drawer, close the drawer so the settings modal is the only thing on
      // screen — otherwise you end up with both panels overlapping and the
      // click can feel like it "disappeared" behind the drawer.
      githubOpen: false,
      // Bump the counter so Settings → GitHub scrolls/highlights its OAuth
      // block. We do this unconditionally (not only when the modal is
      // already open) because it's harmless on first open — the modal just
      // mounts scrolled and focused, which is exactly what the user meant by
      // "configure".
      githubConfigRequest: st.githubConfigRequest + 1,
    })),
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  toggleSidebar: () => set((st) => ({ sidebarOpen: !st.sidebarOpen })),
  toggleRail: () => set((st) => ({ railOpen: !st.railOpen })),
  openGithub: (tab) => set((st) => ({ githubOpen: true, filesOpen: false, githubTab: tab ?? st.githubTab })),
  closeGithub: () => set({ githubOpen: false }),
  toggleGithub: () => set((st) => ({ githubOpen: !st.githubOpen, filesOpen: st.githubOpen ? st.filesOpen : false })),
  setGithubTab: (tab) => set({ githubTab: tab }),
  openFiles: () => set({ filesOpen: true, githubOpen: false }),
  closeFiles: () => set({ filesOpen: false }),
  toggleFiles: () => set((st) => ({ filesOpen: !st.filesOpen, githubOpen: st.filesOpen ? st.githubOpen : false })),
  openMemory: (memoryPrefill = '') => set({ memoryOpen: true, memoryPrefill }),
  closeMemory: () => set({ memoryOpen: false, memoryPrefill: '' }),
  openPublish: (source) => set({ publishSource: source }),
  closePublish: () => set({ publishSource: null }),
  setOnline: (v) => set({ online: v }),
  toast: (t) =>
    set((st) => {
      const toast: Toast = { ...t, id: uid('toast') }
      const toasts = [...st.toasts, toast].slice(-4)
      // An error needs reading time; a toast with a button needs pressing time.
      const lifetime = t.kind === 'error' || t.action ? 7000 : 4200
      setTimeout(() => {
        useUI.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== toast.id) }))
      }, lifetime)
      return { toasts }
    }),
  dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
  openLightbox: (artifactId) => set({ lightbox: { artifactId } }),
  closeLightbox: () => set({ lightbox: null }),
  addPendingAttachment: (id) =>
    set((st) => ({
      pendingAttachmentIds: st.pendingAttachmentIds.includes(id) ? st.pendingAttachmentIds : [...st.pendingAttachmentIds, id],
    })),
  removePendingAttachment: (id) =>
    set((st) => ({ pendingAttachmentIds: st.pendingAttachmentIds.filter((x) => x !== id) })),
  clearPendingAttachments: () => set({ pendingAttachmentIds: [] }),
  setDragActive: (v) => set({ dragActive: v }),
}))
