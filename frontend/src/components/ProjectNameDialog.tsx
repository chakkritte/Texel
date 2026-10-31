import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import Icon from './shell/Icon'

type Props = {
  open: boolean
  title: string
  initialName: string
  submitLabel?: string
  onClose: () => void
  /** Throw to show an error and keep the dialog open. */
  onSubmit: (name: string) => Promise<void>
}

export default function ProjectNameDialog({
  open,
  title,
  initialName,
  submitLabel = 'Save',
  onClose,
  onSubmit,
}: Props) {
  const [name, setName] = useState(initialName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setName(initialName)
    setError('')
    setBusy(false)
  }, [open, initialName])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  if (!open) return null

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = name.trim()
    if (!value || busy) return
    setBusy(true)
    setError('')
    try {
      await onSubmit(value)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the project name')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={() => {
        if (!busy) onClose()
      }}
    >
      <form
        onSubmit={submit}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-[var(--shadow-lg)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <Icon name="edit" size={18} className="text-[var(--accent)]" />
          <span className="flex-1 text-sm font-semibold">{title}</span>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--ink)] disabled:opacity-40"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="space-y-3 px-4 py-4">
          <input
            autoFocus
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          />
          {error && (
            <p className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-full border border-[var(--border)] px-3.5 py-1.5 text-xs text-[var(--ink-2)] hover:bg-[var(--panel-3)] disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-xs font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-2)] disabled:opacity-40"
            >
              {busy ? 'Saving…' : submitLabel}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
