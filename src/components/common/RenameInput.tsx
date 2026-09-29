import { useEffect, useRef } from 'react'

/**
 * A one-line inline editor for a name. Focuses itself with the whole text selected.
 * Enter or blur submits, Escape cancels (IME composition is respected, so Enter that
 * confirms a candidate does not submit). Exactly one of `onSubmit` / `onCancel` fires
 * per edit: Enter can unmount the field, which may blur it on the way out.
 *
 * `onSubmit` also receives blank or unchanged text; the caller decides what that means.
 */
export function RenameInput({
  initial,
  label,
  className,
  maxLength,
  onSubmit,
  onCancel,
}: {
  initial: string
  label: string
  className?: string
  maxLength?: number
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const settled = useRef(false)

  useEffect(() => {
    const el = ref.current
    el?.focus()
    el?.select()
  }, [])

  const settle = (commit: boolean) => {
    if (settled.current) return
    settled.current = true
    if (commit) onSubmit(ref.current?.value ?? initial)
    else onCancel()
  }

  return (
    <input
      ref={ref}
      className={className}
      defaultValue={initial}
      aria-label={label}
      maxLength={maxLength}
      autoComplete="off"
      // A press in the field must not reach a clickable row behind it.
      onClick={(e) => e.stopPropagation()}
      onBlur={() => settle(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          settle(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          settle(false)
        }
      }}
    />
  )
}
