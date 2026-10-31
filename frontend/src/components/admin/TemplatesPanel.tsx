import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import Icon from '../shell/Icon'
import { api } from '../../lib/api'
import type { AdminTemplate } from '../../lib/admin'
import TemplateDialog from './TemplateDialog'

export default function TemplatesPanel() {
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AdminTemplate | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['admin', 'templates'],
    queryFn: () => api<AdminTemplate[]>('/admin/templates'),
  })

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] })
    queryClient.invalidateQueries({ queryKey: ['templates'] })
  }

  async function removeTemplate(template: AdminTemplate) {
    if (
      !window.confirm(
        `Delete template "${template.name}"? Projects already created from it are not affected.`,
      )
    ) {
      return
    }
    setBusyId(template.id)
    setError('')
    try {
      await api(`/admin/templates/${template.id}`, { method: 'DELETE' })
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete template')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-[11px] text-[var(--muted)]">
          Custom templates appear in the template picker for every user. Built-in templates are
          read-only.
        </p>
        <button
          type="button"
          onClick={() => {
            setEditing(null)
            setDialogOpen(true)
          }}
          className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-2)]"
        >
          <Icon name="add" size={16} /> Add template
        </button>
      </div>

      {error && (
        <p className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
          {error}
        </p>
      )}

      {isLoading ? (
        <p className="text-sm text-[var(--muted)]">Loading templates…</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {templates.map((template) => (
            <div
              key={template.id}
              className="flex flex-col rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4"
            >
              <div className="flex items-start gap-2">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
                  <Icon name={template.builtin ? 'dashboard' : 'dashboard_customize'} size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{template.name}</div>
                  <div className="text-[11px] text-[var(--muted)]">
                    {template.engine} · {template.files.length} file
                    {template.files.length === 1 ? '' : 's'} · {template.main_file}
                  </div>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    template.builtin
                      ? 'bg-[var(--panel-3)] text-[var(--muted)]'
                      : 'bg-[var(--accent-soft)] text-[var(--accent)]'
                  }`}
                >
                  {template.builtin ? 'Built-in' : 'Custom'}
                </span>
              </div>
              <p className="mt-2 line-clamp-2 min-h-[2rem] text-xs text-[var(--muted)]">
                {template.description || 'No description.'}
              </p>
              {!template.builtin && (
                <div className="mt-auto flex justify-end gap-1 pt-3">
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(template)
                      setDialogOpen(true)
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--ink-2)] hover:bg-[var(--panel-3)]"
                  >
                    <Icon name="edit" size={14} /> Edit
                  </button>
                  <button
                    type="button"
                    disabled={busyId === template.id}
                    onClick={() => void removeTemplate(template)}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--danger)]/30 px-2 py-1 text-[11px] text-[var(--danger)] hover:bg-[var(--danger-soft)] disabled:opacity-40"
                  >
                    <Icon name="delete" size={14} /> Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <TemplateDialog
        open={dialogOpen}
        initial={editing}
        onClose={() => {
          setDialogOpen(false)
          setEditing(null)
        }}
        onSaved={refresh}
      />
    </div>
  )
}
