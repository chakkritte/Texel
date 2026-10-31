import { useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../components/shell/Icon'
import { useAuth } from '../lib/auth'

export default function Login() {
  const login = useAuth((s) => s.login)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await login(email, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-full items-center justify-center bg-[var(--app-bg)] px-4 py-10">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-[var(--accent)] opacity-[0.08] blur-3xl" />
        <div className="absolute -bottom-24 -right-24 h-72 w-72 rounded-full bg-[var(--accent-2)] opacity-[0.08] blur-3xl" />
      </div>

      <div className="serene-card relative w-full max-w-sm p-8">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="doodle-border flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-secondary-container)] text-[var(--color-on-secondary-container)]">
            <Icon name="edit_document" size={20} />
          </div>
          <div>
            <div className="text-sm font-semibold">SGtech LaTeX Studio</div>
            <div className="text-[10px] text-[var(--muted)]">Collaborative LaTeX with AI</div>
          </div>
        </div>

        <h1 className="font-display text-xl font-bold tracking-tight">Welcome back</h1>
        <p className="mb-5 mt-1 text-xs text-[var(--muted)]">Sign in to continue to your projects.</p>

        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--ink-2)]">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@sgtech.nu.ac.th"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none placeholder:text-[var(--muted-2)] focus:border-[var(--accent)]"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--ink-2)]">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none placeholder:text-[var(--muted-2)] focus:border-[var(--accent)]"
            />
          </div>
          {error && (
            <p className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
              {error}
            </p>
          )}
          <button
            disabled={busy}
            className="w-full rounded-full bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--accent-ink)] shadow-sm transition-colors hover:bg-[var(--accent-2)] disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-[var(--muted)]">
          No account?{' '}
          <Link to="/register" className="font-medium text-[var(--accent)] underline-offset-2 hover:underline">
            Create one
          </Link>
        </p>
      </div>
    </div>
  )
}
