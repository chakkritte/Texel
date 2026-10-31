import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import Icon from './shell/Icon'
import { api } from '../lib/api'
import { TAG_COLORS, tagInk, type ProjectTag } from '../lib/tags'

type Props = {
  open: boolean
  projectId: string
  projectName: string
  tags: ProjectTag[]
  onClose: () => void
  onChanged: () => void
}

export default function ProjectTagsDialog({
  open,
  projectId,
  projectName,
  tags,
  onClose,
  onChanged,
}: Props) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(TAG_COLORS[0])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setName('')
    setColor(TAG_COLORS[0])
    setError('')
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  if (!open) return null

  async function addTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const label = name.trim()
    if (!label || busy) return
    setBusy(true)
    setError('')
    try {
      await api(`/projects/${projectId}/tags`, {
        method: 'POST',
        body: JSON.stringify({ name: label, color }),
      })
      setName('')
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add tag')
    } finally {
      setBusy(false)
    }
  }

  async function removeTag(tag: ProjectTag) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api(`/tags/${tag.id}`, { method: 'DELETE' })
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove tag')
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
      <div
        role="dialog"
        aria-label={`Organize tags for ${projectName}`}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-[var(--shadow-lg)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <Icon name="label" size={18} className="text-[var(--accent)]" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">Organize tags</div>
            <div className="truncate text-[11px] text-[var(--muted)]">{projectName}</div>
          </div>
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

        <div className="space-y-4 px-4 py-4">
          <div>
            <div className="mb-1.5 text-[11px] font-medium text-[var(--ink-2)]">
              Current tags
            </div>
            {tags.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[var(--border)] px-3 py-3 text-xs text-[var(--muted)]">
                No tags yet. Add one below to colour-code this project.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <span
                    key={tag.id}
                    className="inline-flex items-center gap-1 rounded-full py-1 pl-2.5 pr-1 text-[11px] font-medium"
                    style={{ backgroundColor: tag.color, color: tagInk(tag.color) }}
                  >
                    {tag.name}
                    <button
                      type="button"
                      onClick={() => void removeTag(tag)}
                      disabled={busy}
                      aria-label={`Remove tag ${tag.name}`}
                      title={`Remove ${tag.name}`}
                      className="rounded-full p-0.5 hover:bg-black/20 disabled:opacity-40"
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <form onSubmit={addTag} className="space-y-2.5">
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-[var(--ink-2)]">New tag</label>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={50}
                placeholder="e.g. Thesis, Physics, Urgent"
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none placeholder:text-[var(--muted-2)] focus:border-[var(--accent)]"
              />
            </div>
            <div className="space-y-1">
              <span className="text-[11px] font-medium text-[var(--ink-2)]">Colour</span>
              <div className="flex flex-wrap gap-1.5">
                {TAG_COLORS.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    onClick={() => setColor(swatch)}
                    aria-label={`Use colour ${swatch}`}
                    aria-pressed={color === swatch}
                    className={`h-7 w-7 rounded-full transition-transform hover:scale-110 ${
                      color === swatch
                        ? 'ring-2 ring-[var(--ink)] ring-offset-2 ring-offset-[var(--panel)]'
                        : ''
                    }`}
                    style={{ backgroundColor: swatch }}
                  />
                ))}
              </div>
            </div>

            {error && (
              <p className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="rounded-full border border-[var(--border)] px-3.5 py-1.5 text-xs text-[var(--ink-2)] hover:bg-[var(--panel-3)] disabled:opacity-40"
              >
                Done
              </button>
              <button
                type="submit"
                disabled={busy || !name.trim()}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 py-1.5 text-xs font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-2)] disabled:opacity-40"
              >
                <Icon name="add" size={15} /> Add tag
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
