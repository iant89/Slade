import type { MenuAnchor } from '../../lib/menuPlacement'
import { useChat } from '../../store/chat'
import { useUI } from '../../store/ui'
import { Menu, type MenuItem } from '../common/Menu'
import { IconArchive, IconArchiveRestore, IconPencil } from '../icons'

/** What an open conversation menu is about, and what opened it. */
export interface ConversationMenuState {
  convId: string
  anchor: MenuAnchor
  opener: HTMLElement | null
}

const shorten = (s: string, max = 48) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)

/**
 * Archive a conversation and say so, with an Undo. Archiving the open chat moves the
 * view to another one, so the toast is what tells the user where it went; Undo brings
 * back both the conversation and (if it was open) the view.
 */
export function archiveWithUndo(convId: string): void {
  const chat = useChat.getState()
  const conv = chat.conversations[convId]
  if (!conv || conv.archived) return
  const wasOpen = chat.currentId === convId
  chat.archiveConversation(convId)
  useUI.getState().toast({
    kind: 'success',
    title: 'Conversation archived',
    detail: `“${shorten(conv.title)}” is under Archived in the sidebar.`,
    action: {
      label: 'Undo',
      onClick: () => {
        const now = useChat.getState()
        // It may have been deleted since; never point the view at a chat that is gone.
        if (!now.conversations[convId]) return
        now.unarchiveConversation(convId)
        if (wasOpen) now.selectConversation(convId)
      },
    },
  })
}

export function unarchiveWithToast(convId: string): void {
  const chat = useChat.getState()
  const conv = chat.conversations[convId]
  if (!conv || !conv.archived) return
  chat.unarchiveConversation(convId)
  useUI.getState().toast({
    kind: 'success',
    title: 'Conversation restored',
    detail: `“${shorten(conv.title)}” is back in your conversations.`,
  })
}

/** Put focus back on whatever opened the menu, if it is still on the page. */
function focusOpener(opener: HTMLElement | null): void {
  if (opener?.isConnected) opener.focus()
}

/**
 * The menu behind a conversation's name: Rename, and Archive (or Unarchive when it
 * already is). Both the header title and the sidebar rows open this one menu.
 */
export function ConversationMenu({
  state,
  onRename,
  onClose,
  returnFocus = focusOpener,
}: {
  state: ConversationMenuState
  onRename: (convId: string) => void
  onClose: () => void
  /**
   * Where focus goes after Esc, or after an action that leaves the chat on screen.
   * Defaults to the opener; the sidebar supplies a fallback for rows that disappear.
   */
  returnFocus?: (opener: HTMLElement | null) => void
}) {
  const conv = useChat((s) => s.conversations[state.convId])
  if (!conv) return null

  // Wait a frame so the list has re-rendered before deciding whether the opener survived.
  const afterAction = () => requestAnimationFrame(() => returnFocus(state.opener))

  const items: MenuItem[] = [
    // Rename hands focus to its own text field, so nothing is restored here.
    { id: 'rename', label: 'Rename', icon: <IconPencil size={15} />, onSelect: () => onRename(conv.id) },
    conv.archived
      ? {
          id: 'unarchive',
          label: 'Unarchive',
          icon: <IconArchiveRestore size={15} />,
          onSelect: () => {
            unarchiveWithToast(conv.id)
            afterAction()
          },
        }
      : {
          id: 'archive',
          label: 'Archive',
          icon: <IconArchive size={15} />,
          onSelect: () => {
            archiveWithUndo(conv.id)
            afterAction()
          },
        },
  ]

  return (
    <Menu
      label={`Options for ${conv.title}`}
      items={items}
      anchor={state.anchor}
      opener={state.opener}
      onClose={(reason) => {
        onClose()
        if (reason === 'escape') returnFocus(state.opener)
      }}
    />
  )
}
