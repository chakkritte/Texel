import { useEffect, useRef, useState } from 'react'
import Icon from './shell/Icon'

export type UploadFolder = { id: string; label: string }

type Props = {
  open: boolean
  folders: UploadFolder[]
  defaultFolderId?: string | null
  progress?: string
  onClose: () => void
  /** Uploads the given files; throw to show an error and keep the dialog open. */
  onUpload: (files: File[], folderId: string | null) => Promise<void>
}

type Mode = 'single' | 'multiple'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`
}

export default function UploadDialog({
  open,
  folders,
  defaultFolderId = null,
  progress = '',
  onClose,
  onUpload,
}: Props) {
  const [mode, setMode] = useState<Mode>('single')
  const [single, setSingle] = useState<File | null>(null)
  const [multiple, setMultiple] = useState<File[]>([])
  const [folderId, setFolderId] = useState(defaultFolderId ?? '')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const resetRef = useRef(false)

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (!open) {
      resetRef.current = false
      return
    }
    if (resetRef.current) return
    resetRef.current = true
    setMode('single')
    setSingle(null)
    setMultiple([])
    setFolderId(defaultFolderId ?? '')
    setError('')
    setSubmitting(false)
  }, [open, defaultFolderId])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, submitting, onClose])

  if (!open) return null

  const selected = mode === 'single' ? (single ? [single] : []) : multiple

  function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    // Copy the FileList before the input is cleared; it is live and would
    // otherwise be empty inside the React state updater.
    const incoming = Array.from(files)
    setError('')
    if (mode === 'single') {
      setSingle(incoming[0])
      return
    }
    setMultiple((previous) => {
      const seen = new Set(previous.map(fileKey))
      const next = [...previous]
      for (const file of incoming) {
        const key = fileKey(file)
        if (!seen.has(key)) {
          seen.add(key)
          next.push(file)
        }
      }
      return next
    })
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting || selected.length === 0) return
    setSubmitting(true)
    setError('')
    try {
      await onUpload(selected, folderId || null)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={() => {
        if (!submitting) onClose()
      }}
    >
      <form
        onSubmit={submit}
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-[var(--shadow-lg)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <Icon name="upload" size={18} className="text-[var(--accent)]" />
          <span className="text-sm font-semibold">Upload files</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--ink)] disabled:opacity-40"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-4">
          <div className="flex rounded-full border border-[var(--border)] bg-[var(--panel-2)] p-0.5 text-xs">
            {(
              [
                { id: 'single', label: 'Single file' },
                { id: 'multiple', label: 'Multiple files' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setMode(item.id)}
                className={`flex-1 rounded-full px-3 py-1.5 transition-colors ${
                  mode === item.id
                    ? 'bg-[var(--accent)] font-medium text-[var(--accent-ink)]'
                    : 'text-[var(--muted)] hover:text-[var(--ink)]'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <label className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--panel-2)] px-4 py-8 text-center hover:border-[var(--accent)]">
            <Icon name="upload_file" size={28} className="text-[var(--accent)]" />
            <span className="text-xs font-medium text-[var(--ink-2)]">
              {mode === 'single' ? 'Choose a file' : 'Choose one or more files'}
            </span>
            <span className="text-[10px] text-[var(--muted)]">
              {mode === 'single'
                ? 'A single file will be uploaded to the project.'
                : 'You can select several files at once and add more before uploading.'}
            </span>
            <input
              type="file"
              multiple={mode === 'multiple'}
              className="hidden"
              onChange={(event) => {
                addFiles(event.target.files)
                event.target.value = ''
              }}
            />
          </label>

          {selected.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-[var(--muted)]">
                <span>
                  {selected.length} file{selected.length === 1 ? '' : 's'} selected
                </span>
                {mode === 'multiple' && (
                  <button
                    type="button"
                    onClick={() => setMultiple([])}
                    className="text-[var(--danger)] hover:underline"
                  >
                    Clear all
                  </button>
                )}
              </div>
              <ul className="max-h-40 space-y-1 overflow-auto">
                {selected.map((file) => (
                  <li
                    key={fileKey(file)}
                    className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs"
                  >
                    <Icon name="description" size={15} className="shrink-0 text-[var(--muted)]" />
                    <span className="min-w-0 flex-1 truncate">{file.name}</span>
                    <span className="shrink-0 text-[10px] text-[var(--muted)]">
                      {formatSize(file.size)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      onClick={() => {
                        if (mode === 'single') setSingle(null)
                        else setMultiple((previous) => previous.filter((item) => item !== file))
                      }}
                      className="shrink-0 rounded p-0.5 text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--danger)]"
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--ink-2)]">Destination folder</label>
            <select
              value={folderId}
              onChange={(event) => setFolderId(event.target.value)}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-2 text-xs outline-none focus:border-[var(--accent)]"
            >
              <option value="">Project root</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.label}
                </option>
              ))}
            </select>
          </div>

          {error && (
            <p className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--border)] px-4 py-3">
          <span className="flex-1 text-[10px] text-[var(--muted)]">
            {progress || 'Text files up to 5 MB each.'}
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-full border border-[var(--border)] px-3.5 py-1.5 text-xs text-[var(--ink-2)] hover:bg-[var(--panel-3)] disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || selected.length === 0}
            className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 py-1.5 text-xs font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-2)] disabled:opacity-40"
          >
            <Icon name="upload" size={15} />
            {submitting
              ? progress || 'Uploading…'
              : selected.length > 1
                ? `Upload ${selected.length} files`
                : 'Upload'}
          </button>
        </div>
      </form>
    </div>
  )
}
