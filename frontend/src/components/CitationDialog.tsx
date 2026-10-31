import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import Icon from './shell/Icon'
import { formatBibEntry, type BibEntry } from '../lib/bibtex'

type Props = {
  open: boolean
  entries: BibEntry[]
  initialKeys: string[]
  onClose: () => void
  onSave: (keys: string[]) => void
}

export default function CitationDialog({
  open,
  entries,
  initialKeys,
  onClose,
  onSave,
}: Props) {
  const [selected, setSelected] = useState<string[]>(initialKeys)
  const [query, setQuery] = useState('')
  const [manual, setManual] = useState('')

  useEffect(() => {
    if (!open) return
    setSelected(initialKeys)
    setQuery('')
    setManual('')
    // Reset only when the dialog opens; initialKeys is a snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return entries
    return entries.filter((entry) =>
      [entry.key, entry.title, entry.author, entry.year]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle)),
    )
  }, [entries, query])

  if (!open) return null

  function toggle(key: string) {
    setSelected((previous) =>
      previous.includes(key)
        ? previous.filter((item) => item !== key)
        : [...previous, key],
    )
  }

  function addManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const key = manual.trim()
    if (!key) return
    if (!selected.includes(key)) setSelected((previous) => [...previous, key])
    setManual('')
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Citation picker"
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-[var(--shadow-lg)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <Icon name="menu_book" size={18} className="text-[var(--accent)]" />
          <span className="flex-1 text-sm font-semibold">Citation picker</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--panel-3)]"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-4">
          <div className="flex flex-wrap gap-1">
            {selected.length === 0 ? (
              <span className="text-xs text-[var(--muted)]">No keys selected.</span>
            ) : (
              selected.map((key) => (
                <span
                  key={key}
                  className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-soft)] py-1 pl-2.5 pr-1 text-[11px] text-[var(--accent)]"
                >
                  {key}
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    aria-label={`Remove ${key}`}
                    className="rounded-full p-0.5 hover:bg-black/10"
                  >
                    <Icon name="close" size={12} />
                  </button>
                </span>
              ))
            )}
          </div>

          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search .bib entries by key, title or author…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          />

          <div className="max-h-64 overflow-auto rounded-lg border border-[var(--border)]">
            {filtered.length === 0 ? (
              <p className="px-3 py-4 text-xs text-[var(--muted)]">
                {entries.length === 0
                  ? 'No .bib entries found in this project. Add a key manually below.'
                  : 'No entries match your search.'}
              </p>
            ) : (
              filtered.map((entry) => {
                const checked = selected.includes(entry.key)
                return (
                  <label
                    key={entry.key}
                    className="flex cursor-pointer items-start gap-2 border-b border-[var(--border)] px-3 py-2 text-xs last:border-0 hover:bg-[var(--panel-2)]"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(entry.key)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="font-[var(--font-mono)] text-[11px] text-[var(--accent)]">
                        {entry.key}
                      </span>
                      <span className="ml-2 text-[var(--ink-2)]">
                        {formatBibEntry(entry)}
                      </span>
                    </span>
                  </label>
                )
              })
            )}
          </div>

          <form onSubmit={addManual} className="flex items-center gap-2">
            <input
              value={manual}
              onChange={(event) => setManual(event.target.value)}
              placeholder="Add a key manually"
              className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 font-[var(--font-mono)] text-xs outline-none focus:border-[var(--accent)]"
            />
            <button
              type="submit"
              disabled={!manual.trim()}
              className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--panel-3)] disabled:opacity-40"
            >
              Add
            </button>
          </form>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-[var(--border)] px-3.5 py-1.5 text-xs text-[var(--ink-2)] hover:bg-[var(--panel-3)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(selected)}
            disabled={selected.length === 0}
            className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-xs font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-2)] disabled:opacity-40"
          >
            Save citation
          </button>
        </div>
      </div>
    </div>
  )
}
