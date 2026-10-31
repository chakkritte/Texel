import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import Icon from '../components/shell/Icon'
import UsersPanel from '../components/admin/UsersPanel'
import TemplatesPanel from '../components/admin/TemplatesPanel'
import { useAuth } from '../lib/auth'

type Tab = 'users' | 'templates'

export default function Admin() {
  const { user } = useAuth()
  const [tab, setTab] = useState<Tab>('users')

  if (!user?.is_admin) return <Navigate to="/" replace />

  return (
    <div className="min-h-full bg-[var(--app-bg)] text-[var(--ink)]">
      <header className="flex h-14 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-5">
        <Link
          to="/"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--ink)]"
          title="Back to projects"
        >
          <Icon name="arrow_back" size={18} />
        </Link>
        <div className="flex flex-col leading-tight">
          <span className="font-display text-sm font-semibold">Administration</span>
          <span className="text-[10px] text-[var(--muted)]">Users and project templates</span>
        </div>
        <span className="flex-1" />
        <span className="text-[11px] text-[var(--muted)]">{user.email}</span>
      </header>

      <main className="mx-auto w-full max-w-6xl px-6 py-8">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight">Administration</h1>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Manage accounts, administrator rights and templates available to all users.
            </p>
          </div>
          <div className="flex rounded-full border border-[var(--border)] bg-[var(--panel)] p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setTab('users')}
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 transition-colors ${
                tab === 'users'
                  ? 'bg-[var(--accent)] font-medium text-[var(--accent-ink)]'
                  : 'text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
            >
              <Icon name="group" size={14} /> Users
            </button>
            <button
              type="button"
              onClick={() => setTab('templates')}
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 transition-colors ${
                tab === 'templates'
                  ? 'bg-[var(--accent)] font-medium text-[var(--accent-ink)]'
                  : 'text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
            >
              <Icon name="dashboard_customize" size={14} /> Templates
            </button>
          </div>
        </div>

        {tab === 'users' ? <UsersPanel /> : <TemplatesPanel />}
      </main>
    </div>
  )
}
