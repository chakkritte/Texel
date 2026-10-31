import { useCallback, useEffect, useState } from 'react'
import { createVersion, listVersions, restoreVersion, type Version } from '../../lib/history'

type HistoryPanelProps = {
  projectId: string
  onRestored?: () => void
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

export default function HistoryPanel({ projectId, onRestored }: HistoryPanelProps) {
  const [versions, setVersions] = useState<Version[]>([])
  const [label, setLabel] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setVersions(await listVersions(projectId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load history')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  async function save() {
    setBusy('save')
    setError('')
    try {
      await createVersion(projectId, label.trim() || undefined)
      setLabel('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save version')
    } finally {
      setBusy(null)
    }
  }

  async function restore(version: Version) {
    const name = version.label || `version ${version.id.slice(0, 8)}`
    if (!window.confirm(`Restore ${name}? Current file contents will be replaced.`)) return
    setBusy(version.id)
    setError('')
    try {
      await restoreVersion(version.id)
      await load()
      onRestored?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restore version')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase text-zinc-500">History</span>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="text-xs text-emerald-700 hover:underline disabled:opacity-40"
          >
            Refresh
          </button>
        </div>
        <div className="mt-2 flex gap-1">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Version label (optional)"
            className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-xs"
          />
          <button
            onClick={() => void save()}
            disabled={busy !== null}
            className="shrink-0 rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && versions.length === 0 ? (
          <p className="p-3 text-xs text-zinc-500">Loading history…</p>
        ) : versions.length === 0 ? (
          <p className="p-3 text-xs text-zinc-500">No saved versions yet.</p>
        ) : (
          <ul className="divide-y">
            {versions.map((version) => (
              <li key={version.id} className="px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {version.label || 'Untitled version'}
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {formatTime(version.created_at)} · {version.file_count} file
                      {version.file_count === 1 ? '' : 's'}
                    </div>
                  </div>
                  <button
                    onClick={() => void restore(version)}
                    disabled={busy !== null}
                    className="shrink-0 rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-40"
                  >
                    {busy === version.id ? 'Restoring…' : 'Restore'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
