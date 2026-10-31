import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import Icon from '../shell/Icon'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import type { AdminUser } from '../../lib/admin'

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString()
}

export default function UsersPanel() {
  const queryClient = useQueryClient()
  const { user: me } = useAuth()
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api<AdminUser[]>('/admin/users'),
  })

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return users
    return users.filter(
      (user) =>
        user.email.toLowerCase().includes(needle) ||
        user.display_name.toLowerCase().includes(needle),
    )
  }, [users, search])

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
  }

  async function patchUser(user: AdminUser, patch: Record<string, unknown>) {
    setBusyId(user.id)
    setError('')
    try {
      await api(`/admin/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update user')
    } finally {
      setBusyId(null)
    }
  }

  async function removeAccess(user: AdminUser) {
    if (
      !window.confirm(
        `Remove access for ${user.email}? Their projects and files are kept, and access can be restored later.`,
      )
    ) {
      return
    }
    await patchUser(user, { is_active: false })
  }

  async function restoreAccess(user: AdminUser) {
    await patchUser(user, { is_active: true })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search users…"
          className="min-w-[220px] flex-1 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm outline-none placeholder:text-[var(--muted-2)] focus:border-[var(--accent)]"
        />
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-2)]"
        >
          <Icon name="person_add" size={16} /> Add user
        </button>
      </div>

      <p className="text-[11px] text-[var(--muted)]">
        Removing access disables sign-in but keeps the user&apos;s projects, comments and history.
      </p>

      {error && (
        <p className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
          {error}
        </p>
      )}

      {isLoading ? (
        <p className="text-sm text-[var(--muted)]">Loading users…</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--panel)]">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="border-b border-[var(--border)] text-[11px] uppercase tracking-wide text-[var(--muted)]">
              <tr>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Projects</th>
                <th className="px-3 py-2 font-medium">Joined</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((user) => {
                const self = user.id === me?.id
                const busy = busyId === user.id
                return (
                  <tr key={user.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-[var(--ink)]">{user.display_name || '—'}</div>
                      <div className="text-[11px] text-[var(--muted)]">{user.email}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          user.is_admin
                            ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                            : 'bg-[var(--panel-3)] text-[var(--muted)]'
                        }`}
                      >
                        {user.is_admin ? 'Admin' : 'User'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          user.is_active
                            ? 'bg-[var(--ok-soft)] text-[var(--ok)]'
                            : 'bg-[var(--danger-soft)] text-[var(--danger)]'
                        }`}
                      >
                        {user.is_active ? 'Active' : 'Removed'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-[var(--ink-2)]">{user.project_count}</td>
                    <td className="px-3 py-2.5 text-[var(--muted)]">{formatDate(user.created_at)}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void patchUser(user, { is_admin: !user.is_admin })}
                          className="rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--ink-2)] hover:bg-[var(--panel-3)] disabled:opacity-40"
                        >
                          {user.is_admin ? 'Make user' : 'Make admin'}
                        </button>
                        {user.is_active ? (
                          <button
                            type="button"
                            disabled={busy || self}
                            title={self ? 'You cannot remove your own access' : 'Remove access'}
                            onClick={() => void removeAccess(user)}
                            className="rounded-md border border-[var(--danger)]/30 px-2 py-1 text-[11px] text-[var(--danger)] hover:bg-[var(--danger-soft)] disabled:opacity-40"
                          >
                            Remove access
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void restoreAccess(user)}
                            className="rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:opacity-40"
                          >
                            Restore access
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-[var(--muted)]">
                    No users match your search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <AddUserDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onCreated={() => {
          refresh()
          setShowAdd(false)
        }}
      />
    </div>
  )
}

function AddUserDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
}) {
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!open) return null

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api('/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          email,
          password,
          display_name: displayName,
          is_admin: isAdmin,
        }),
      })
      setEmail('')
      setDisplayName('')
      setPassword('')
      setIsAdmin(false)
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create user')
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
          <Icon name="person_add" size={18} className="text-[var(--accent)]" />
          <span className="flex-1 text-sm font-semibold">Add user</span>
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
        <div className="space-y-3 px-4 py-4">
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-[var(--ink-2)]">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-[var(--ink-2)]">Display name</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-[var(--ink-2)]">Password</span>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            />
            <span className="text-[10px] text-[var(--muted)]">At least 8 characters.</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-[var(--ink-2)]">
            <input
              type="checkbox"
              checked={isAdmin}
              onChange={(event) => setIsAdmin(event.target.checked)}
            />
            Grant administrator rights
          </label>
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
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-xs font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-2)] disabled:opacity-40"
            >
              {busy ? 'Adding…' : 'Add user'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
