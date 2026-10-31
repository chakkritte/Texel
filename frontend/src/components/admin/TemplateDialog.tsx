import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import Icon from '../shell/Icon'
import { api } from '../../lib/api'
import type { AdminTemplate } from '../../lib/admin'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type Props = {
  open: boolean
  initial: AdminTemplate | null
  onClose: () => void
  onSaved: () => void
}

export default function TemplateDialog({ open, initial, onClose, onSaved }: Props) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [engine, setEngine] = useState('pdflatex')
  const [mainFile, setMainFile] = useState('')
  const [zipFile, setZipFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const openedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!open) {
      openedFor.current = null
      return
    }
    const key = initial?.id ?? 'new'
    if (openedFor.current === key) return
    openedFor.current = key
    setError('')
    setBusy(false)
    setZipFile(null)
    if (initial) {
      setName(initial.name)
      setDescription(initial.description)
      setEngine(initial.engine)
      setMainFile(initial.main_file)
    } else {
      setName('')
      setDescription('')
      setEngine('pdflatex')
      setMainFile('')
    }
  }, [open, initial])

  if (!open) return null

  const existingFiles = initial?.files.map((file) => file.name) ?? []

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const cleanName = name.trim()
    if (!cleanName) {
      setError('Template name is required.')
      return
    }
    if (!initial && !zipFile) {
      setError('Choose a .zip file containing the template files.')
      return
    }

    setBusy(true)
    setError('')
    try {
      if (zipFile) {
        const form = new FormData()
        form.append('upload', zipFile)
        form.append('name', cleanName)
        form.append('description', description.trim())
        form.append('engine', engine)
        if (mainFile.trim()) form.append('main_file', mainFile.trim())
        await api(
          initial
            ? `/admin/templates/${initial.id}/import-zip`
            : '/admin/templates/import-zip',
          { method: initial ? 'PUT' : 'POST', body: form },
        )
      } else if (initial) {
        await api(`/admin/templates/${initial.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: cleanName,
            description: description.trim(),
            engine,
            ...(mainFile.trim() ? { main_file: mainFile.trim() } : {}),
          }),
        })
      }
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save template')
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
        className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-[var(--shadow-lg)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <Icon name="dashboard_customize" size={18} className="text-[var(--accent)]" />
          <span className="flex-1 text-sm font-semibold">
            {initial ? 'Edit template' : 'Add template'}
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--panel-3)] disabled:opacity-40"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-4">
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-[var(--ink-2)]">Template name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-[var(--ink-2)]">Description</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              maxLength={4000}
              className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-[var(--ink-2)]">Engine</span>
              <select
                value={engine}
                onChange={(event) => setEngine(event.target.value)}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-2 text-sm outline-none focus:border-[var(--accent)]"
              >
                <option value="pdflatex">pdflatex</option>
                <option value="xelatex">xelatex</option>
                <option value="lualatex">lualatex</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-[var(--ink-2)]">Main file</span>
              <input
                value={mainFile}
                onChange={(event) => setMainFile(event.target.value)}
                placeholder="Auto-detect (main.tex)"
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-2 font-[var(--font-mono)] text-xs outline-none placeholder:text-[var(--muted-2)] focus:border-[var(--accent)]"
              />
            </label>
          </div>

          {initial && !zipFile && existingFiles.length > 0 && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2">
              <div className="mb-1 text-[11px] font-medium text-[var(--ink-2)]">
                Current files
              </div>
              <div className="flex flex-wrap gap-1">
                {existingFiles.map((file) => (
                  <span
                    key={file}
                    className="rounded-md bg-[var(--panel)] px-1.5 py-0.5 font-[var(--font-mono)] text-[10px] text-[var(--muted)]"
                  >
                    {file}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <span className="text-[11px] font-medium text-[var(--ink-2)]">
              {initial ? 'Replace files (.zip)' : 'Template files (.zip)'}
            </span>
            <label className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--panel-2)] px-4 py-7 text-center hover:border-[var(--accent)]">
              <Icon name="folder_zip" size={28} className="text-[var(--accent)]" />
              <span className="text-xs font-medium text-[var(--ink-2)]">
                {zipFile ? zipFile.name : 'Choose a .zip file'}
              </span>
              <span className="text-[10px] text-[var(--muted)]">
                {zipFile
                  ? formatSize(zipFile.size)
                  : 'Upload the template folder as a .zip. Text files and images (PNG, JPG, SVG, PDF) are supported, max 20 MB.'}
              </span>
              <input
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(event) => {
                  const selected = event.target.files?.[0] ?? null
                  setZipFile(selected)
                  setError('')
                  // A replacement zip usually has a different file set; let the
                  // backend auto-detect the main file unless the user typed one.
                  if (selected && initial && mainFile === initial.main_file) setMainFile('')
                  event.target.value = ''
                }}
              />
            </label>
            {zipFile && (
              <button
                type="button"
                onClick={() => setZipFile(null)}
                className="text-[11px] text-[var(--danger)] hover:underline"
              >
                Remove selected zip
              </button>
            )}
            {initial && (
              <p className="text-[10px] text-[var(--muted)]">
                Leave the zip empty to keep the current files and only update the details above.
                Uploading a new zip replaces all template files.
              </p>
            )}
          </div>

          {error && (
            <p className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
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
            disabled={busy}
            className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-xs font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-2)] disabled:opacity-40"
          >
            {busy ? 'Saving…' : initial ? 'Save changes' : 'Create template'}
          </button>
        </div>
      </form>
    </div>
  )
}
