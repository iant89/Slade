import { create } from 'zustand'
import type { Toast } from '../types'
import { uid } from '../lib/id'

export interface UIState {
  settingsOpen: boolean
  settingsTab: 'models' | 'defaults' | 'providers' | 'appearance' | 'data'
  sidebarOpen: boolean
  railOpen: boolean
  online: boolean
  toasts: Toast[]
  lightbox: { artifactId: string } | null
  /** Artifact ids queued in the composer for the next send. */
  pendingAttachmentIds: string[]
  dragActive: boolean

  openSettings: (tab?: UIState['settingsTab']) => void
  closeSettings: () => void
  setSettingsTab: (tab: UIState['settingsTab']) => void
  toggleSidebar: () => void
  toggleRail: () => void
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
  sidebarOpen: false,
  railOpen: false,
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  toasts: [],
  lightbox: null,
  pendingAttachmentIds: [],
  dragActive: false,

  openSettings: (tab) => set((st) => ({ settingsOpen: true, settingsTab: tab ?? st.settingsTab })),
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  toggleSidebar: () => set((st) => ({ sidebarOpen: !st.sidebarOpen })),
  toggleRail: () => set((st) => ({ railOpen: !st.railOpen })),
  setOnline: (v) => set({ online: v }),
  toast: (t) =>
    set((st) => {
      const toast: Toast = { ...t, id: uid('toast') }
      const toasts = [...st.toasts, toast].slice(-4)
      setTimeout(() => {
        useUI.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== toast.id) }))
      }, t.kind === 'error' ? 7000 : 4200)
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
