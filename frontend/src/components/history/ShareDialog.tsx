import { useCallback, useEffect, useState } from 'react'
import {
  absoluteShareUrl,
  createShareLink,
  deleteShareLink,
  listShareLinks,
  type ShareLink,
  type ShareLinkCreated,
  type ShareRole,
} from '../../lib/history'

type ShareDialogProps = {
  projectId: string
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

function linkStatus(link: ShareLink): { label: string; className: string } {
  if (link.revoked_at) return { label: 'revoked', className: 'text-zinc-400' }
  if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) {
    return { label: 'expired', className: 'text-amber-600' }
  }
  return { label: 'active', className: 'text-emerald-700' }
}

export default function ShareDialog({ projectId }: ShareDialogProps) {
  const [open, setOpen] = useState(false)
  const [links, setLinks] = useState<ShareLink[]>([])
  const [role, setRole] = useState<ShareRole>('viewer')
  const [days, setDays] = useState('')
  const [created, setCreated] = useState<ShareLinkCreated | null>(null)
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setLinks(await listShareLinks(projectId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load share links')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  async function create() {
    setBusy(true)
    setError('')
    setCreated(null)
    setCopied(false)
    try {
      const expires = days.trim() ? Number(days) : null
      const link = await createShareLink(projectId, role, expires)
      setCreated(link)
      setLinks((current) => [link, ...current])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create share link')
    } finally {
      setBusy(false)
    }
  }

  async function remove(link: ShareLink) {
    if (!window.confirm('Revoke this share link? Anyone using it will lose access.')) return
    setBusy(true)
    setError('')
    try {
      await deleteShareLink(link.id)
      setLinks((current) => current.filter((item) => item.id !== link.id))
      if (created?.id === link.id) setCreated(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke share link')
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!created) return
    const url = absoluteShareUrl(created.url)
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      window.prompt('Copy this share link:', url)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-full border border-[var(--border-strong)] px-3.5 py-1.5 text-xs text-[var(--ink-2)] hover:bg-[var(--panel-3)]"
      >
        Share
      </button>

      {open && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-4 py-2">
              <span className="font-medium">Share project</span>
              <button
                onClick={() => setOpen(false)}
                className="text-sm text-zinc-500 hover:text-zinc-800"
              >
                Close
              </button>
            </div>

            <div className="space-y-3 overflow-auto p-4">
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs text-zinc-600">
                  <span className="mb-1 block">Access</span>
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as ShareRole)}
                    className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                  >
                    <option value="viewer">Viewer (read only)</option>
                    <option value="editor">Editor</option>
                  </select>
                </label>
                <label className="text-xs text-zinc-600">
                  <span className="mb-1 block">Expires in days (optional)</span>
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={days}
                    onChange={(e) => setDays(e.target.value)}
                    placeholder="never"
                    className="w-28 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                  />
                </label>
                <button
                  onClick={() => void create()}
                  disabled={busy}
                  className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  {busy ? 'Creating…' : 'Create link'}
                </button>
              </div>

              {created && (
                <div className="rounded border border-emerald-200 bg-emerald-50 p-2">
                  <p className="text-xs font-medium text-emerald-800">
                    Link created — copy it now, it will not be shown again.
                  </p>
                  <div className="mt-1 flex gap-1">
                    <input
                      readOnly
                      value={absoluteShareUrl(created.url)}
                      onFocus={(e) => e.currentTarget.select()}
                      className="min-w-0 flex-1 rounded border border-emerald-300 bg-white px-2 py-1 text-xs"
                    />
                    <button
                      onClick={() => void copy()}
                      className="shrink-0 rounded border border-emerald-400 px-2 py-1 text-xs text-emerald-800 hover:bg-emerald-100"
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}

              {error && <p className="text-xs text-red-600">{error}</p>}

              <div>
                <p className="mb-1 text-xs font-semibold uppercase text-zinc-500">
                  Existing links
                </p>
                {loading && links.length === 0 ? (
                  <p className="text-xs text-zinc-500">Loading…</p>
                ) : links.length === 0 ? (
                  <p className="text-xs text-zinc-500">No share links yet.</p>
                ) : (
                  <ul className="divide-y rounded border">
                    {links.map((link) => {
                      const status = linkStatus(link)
                      return (
                        <li
                          key={link.id}
                          className="flex items-center justify-between gap-2 px-2 py-1.5"
                        >
                          <div className="min-w-0 text-xs">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{link.role}</span>
                              <span className={status.className}>{status.label}</span>
                            </div>
                            <div className="text-zinc-500">
                              created {formatTime(link.created_at)}
                              {link.expires_at ? ` · expires ${formatTime(link.expires_at)}` : ''}
                            </div>
                          </div>
                          <button
                            onClick={() => void remove(link)}
                            disabled={busy}
                            className="shrink-0 text-xs text-red-600 hover:underline disabled:opacity-40"
                          >
                            Revoke
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
