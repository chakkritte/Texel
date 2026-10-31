import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import Icon from '../components/shell/Icon'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import TemplatePicker from '../components/history/TemplatePicker'
import ProjectTagsDialog from '../components/ProjectTagsDialog'
import ProjectNameDialog from '../components/ProjectNameDialog'
import { tagInk, type ProjectTag } from '../lib/tags'

type Project = {
  id: string
  name: string
  engine: string
  role: string
  updated_at: string
  deleted_at?: string | null
  archived_at?: string | null
  tags?: ProjectTag[]
}

export default function Projects() {
  const { user, logout } = useAuth()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const fileInput = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [view, setView] = useState<'active' | 'archived' | 'trash'>('active')
  const [showTemplates, setShowTemplates] = useState(false)
  const [filterTag, setFilterTag] = useState<string | null>(null)
  const [tagProjectId, setTagProjectId] = useState<string | null>(null)
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null)
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'))

  function toggleTheme() {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('studio.theme', next ? 'dark' : 'light')
  }

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<Project[]>('/projects'),
  })

  const { data: trashed = [], isLoading: trashLoading } = useQuery({
    queryKey: ['projects', 'trash'],
    queryFn: () => api<Project[]>('/projects/trash'),
  })

  const { data: archived = [], isLoading: archivedLoading } = useQuery({
    queryKey: ['projects', 'archived'],
    queryFn: () => api<Project[]>('/projects/archived'),
  })

  function refreshLists() {
    queryClient.invalidateQueries({ queryKey: ['projects'] })
  }

  async function renameProject(projectId: string, name: string) {
    await api(`/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    })
    refreshLists()
  }

  async function copyProject(project: Project) {
    setMenuProjectId(null)
    setError('')
    try {
      const copy = await api<Project>(`/projects/${project.id}/copy`, { method: 'POST' })
      refreshLists()
      navigate(`/projects/${copy.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not copy project')
    }
  }

  async function setArchived(project: Project, archived: boolean) {
    setMenuProjectId(null)
    setError('')
    try {
      await api(`/projects/${project.id}/${archived ? 'archive' : 'unarchive'}`, {
        method: 'POST',
      })
      refreshLists()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update project')
    }
  }

  const allTags = useMemo(() => {
    const byName = new Map<string, ProjectTag>()
    for (const project of projects) {
      for (const tag of project.tags ?? []) {
        if (!byName.has(tag.name)) byName.set(tag.name, tag)
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [projects])

  const visibleProjects = filterTag
    ? projects.filter((project) =>
        (project.tags ?? []).some((tag) => tag.name === filterTag),
      )
    : projects

  const tagProject = tagProjectId
    ? projects.find((project) => project.id === tagProjectId) ?? null
    : null

  async function create(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError('')
    try {
      const project = await api<Project>('/projects', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      setName('')
      navigate(`/projects/${project.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create project')
    } finally {
      setBusy(false)
    }
  }

  async function importZip(file: File) {
    const fallback = file.name.replace(/\.zip$/i, '')
    const projectName = window.prompt('Project name', fallback) || fallback
    setBusy(true)
    setError('')
    let createdId: string | null = null
    try {
      // Create the project without the starter main.tex: the zip provides all
      // files, so the import result should not contain one unless it is in it.
      const project = await api<{ id: string }>('/projects', {
        method: 'POST',
        body: JSON.stringify({ name: projectName, create_main: false }),
      })
      createdId = project.id
      const form = new FormData()
      form.append('upload', file)
      await api(`/projects/${project.id}/import-zip`, { method: 'POST', body: form })
      navigate(`/projects/${project.id}`)
    } catch (err) {
      // Don't leave an empty project behind when the zip is rejected.
      if (createdId) {
        await api(`/projects/${createdId}`, { method: 'DELETE' }).catch(() => {})
      }
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  async function moveToTrash(project: Project) {
    if (project.role !== 'owner') return
    if (
      !window.confirm(
        `Move project "${project.name}" to Trash? You can restore it later from Trash.`,
      )
    ) {
      return
    }
    setDeletingId(project.id)
    setError('')
    try {
      await api(`/projects/${project.id}`, { method: 'DELETE' })
      refreshLists()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move project to Trash')
    } finally {
      setDeletingId(null)
    }
  }

  async function restoreProject(project: Project) {
    setDeletingId(project.id)
    setError('')
    try {
      await api(`/projects/${project.id}/restore`, { method: 'POST' })
      refreshLists()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restore project')
    } finally {
      setDeletingId(null)
    }
  }

  async function purgeProject(project: Project) {
    if (
      !window.confirm(
        `Permanently delete project "${project.name}" and all of its files? This cannot be undone.`,
      )
    ) {
      return
    }
    setDeletingId(project.id)
    setError('')
    try {
      await api(`/projects/${project.id}/permanent`, { method: 'DELETE' })
      refreshLists()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete project')
    } finally {
      setDeletingId(null)
    }
  }

  const initials = (user?.display_name || user?.email || 'U').slice(0, 1).toUpperCase()

  return (
    <div className="min-h-full bg-[var(--app-bg)] text-[var(--ink)]">
      <header className="flex h-14 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-5">
        <div className="doodle-border flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-secondary-container)] text-[var(--color-on-secondary-container)]">
          <Icon name="edit_document" size={18} />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="font-display text-sm font-semibold">SGtech LaTeX Studio</span>
          <span className="text-[10px] text-[var(--muted)]">office.sgtech.nu.ac.th/studio</span>
        </div>
        <span className="flex-1" />
        {user?.is_admin && (
          <Link
            to="/admin"
            className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--ink-2)] hover:bg-[var(--panel-3)] hover:text-[var(--ink)]"
          >
            <Icon name="admin_panel_settings" size={16} /> Admin
          </Link>
        )}
        <button
          onClick={toggleTheme}
          title="Toggle theme"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--ink)]"
        >
          {dark ? <Icon name="light_mode" size={18} /> : <Icon name="dark_mode" size={18} />}
        </button>
        <div
          className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[11px] font-semibold text-[var(--accent)]"
          title={user?.email}
        >
          {initials}
        </div>
        <button
          onClick={() => logout()}
          className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--ink)]"
        >
          <Icon name="logout" size={16} /> Sign out
        </button>
      </header>

      <main className="mx-auto w-full max-w-5xl px-6 py-8">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight">Projects</h1>
            <p className="mt-1 text-xs text-[var(--muted)]">
              {view === 'active'
                ? 'Create a project, import a .zip, or start from a template.'
                : view === 'archived'
                  ? 'Archived projects are hidden from the main list but stay fully editable.'
                  : 'Projects in Trash keep their files until you delete them permanently.'}
            </p>
          </div>
          <div className="flex rounded-full border border-[var(--border)] bg-[var(--panel)] p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setView('active')}
              className={`rounded-full px-3 py-1.5 transition-colors ${
                view === 'active'
                  ? 'bg-[var(--accent)] font-medium text-[var(--accent-ink)]'
                  : 'text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
            >
              Projects
            </button>
            <button
              type="button"
              onClick={() => setView('archived')}
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 transition-colors ${
                view === 'archived'
                  ? 'bg-[var(--accent)] font-medium text-[var(--accent-ink)]'
                  : 'text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
            >
              <Icon name="archive" size={14} /> Archived
              {archived.length > 0 ? ` (${archived.length})` : ''}
            </button>
            <button
              type="button"
              onClick={() => setView('trash')}
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 transition-colors ${
                view === 'trash'
                  ? 'bg-[var(--accent)] font-medium text-[var(--accent-ink)]'
                  : 'text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
            >
              <Icon name="delete" size={14} /> Trash
              {trashed.length > 0 ? ` (${trashed.length})` : ''}
            </button>
          </div>
        </div>

        {error && (
          <p className="mb-4 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
            {error}
          </p>
        )}

        {view === 'active' ? (
          <>
            <form
              onSubmit={create}
              className="serene-card mb-6 flex flex-wrap items-center gap-2 p-3"
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="New project name"
                className="min-w-[220px] flex-1 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none placeholder:text-[var(--muted-2)] focus:border-[var(--accent)]"
              />
              <button
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] shadow-sm hover:bg-[var(--accent-2)] disabled:opacity-50"
              >
                <Icon name="add" size={16} /> Create
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) importZip(file)
                }}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-4 py-2 text-sm text-[var(--ink-2)] hover:bg-[var(--panel-3)] disabled:opacity-50"
              >
                <Icon name="upload" size={16} /> Import .zip
              </button>
              <button
                type="button"
                onClick={() => setShowTemplates((value) => !value)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-sm ${
                  showTemplates
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'border-[var(--border)] text-[var(--ink-2)] hover:bg-[var(--panel-3)]'
                }`}
              >
                <Icon name="grid_view" size={16} /> Templates
              </button>
            </form>

            {showTemplates && (
              <div className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 shadow-[var(--shadow-sm)]">
                <TemplatePicker
                  onCreated={(created) => {
                    queryClient.invalidateQueries({ queryKey: ['projects'] })
                    navigate(`/projects/${created.id}`)
                  }}
                />
              </div>
            )}

            {allTags.length > 0 && (
              <div className="mb-4 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[11px] text-[var(--muted)]">Tags:</span>
                <button
                  type="button"
                  onClick={() => setFilterTag(null)}
                  className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                    filterTag
                      ? 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--ink)]'
                      : 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                  }`}
                >
                  All
                </button>
                {allTags.map((tag) => {
                  const active = filterTag === tag.name
                  return (
                    <button
                      key={tag.name}
                      type="button"
                      onClick={() => setFilterTag(active ? null : tag.name)}
                      className="rounded-full border px-2 py-0.5 text-[11px] transition-colors"
                      style={
                        active
                          ? {
                              backgroundColor: tag.color,
                              borderColor: tag.color,
                              color: tagInk(tag.color),
                            }
                          : { borderColor: tag.color, color: tag.color }
                      }
                    >
                      {tag.name}
                    </button>
                  )
                })}
              </div>
            )}

            {isLoading ? (
              <p className="text-sm text-[var(--muted)]">Loading…</p>
            ) : projects.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--panel)] px-6 py-14 text-center">
                <Icon name="description" size={32} className="mx-auto mb-3 text-[var(--muted-2)]" />
                <p className="text-sm font-medium">No projects yet</p>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Create your first project above, or import an existing .zip.
                </p>
              </div>
            ) : visibleProjects.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--panel)] px-6 py-10 text-center">
                <p className="text-sm font-medium">No projects match this tag</p>
                <button
                  type="button"
                  onClick={() => setFilterTag(null)}
                  className="mt-1 text-xs text-[var(--accent)] hover:underline"
                >
                  Show all projects
                </button>
              </div>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {visibleProjects.map((p) => (
                  <li key={p.id} className="group/card relative">
                    <Link
                      to={`/projects/${p.id}`}
                      className="serene-card group flex h-full flex-col p-4 pr-11 transition-all hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]"
                    >
                      <div className="mb-3 flex items-center gap-2.5">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
                          <Icon name="description" size={18} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{p.name}</div>
                          <div className="text-[11px] text-[var(--muted)]">
                            {p.engine} · {p.role}
                          </div>
                        </div>
                        {p.role !== 'owner' && (
                          <Icon name="arrow_forward"
                            size={16}
                            className="text-[var(--muted-2)] opacity-0 transition-opacity group-hover:opacity-100"
                          />
                        )}
                      </div>
                      {(p.tags ?? []).length > 0 && (
                        <div className="mb-3 flex flex-wrap gap-1">
                          {(p.tags ?? []).map((tag) => (
                            <span
                              key={tag.id}
                              className="max-w-full truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                              style={{ backgroundColor: tag.color, color: tagInk(tag.color) }}
                            >
                              {tag.name}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="mt-auto text-[11px] text-[var(--muted-2)]">
                        Updated {new Date(p.updated_at).toLocaleString()}
                      </div>
                    </Link>
                    <button
                      type="button"
                      onClick={() =>
                        setMenuProjectId(menuProjectId === p.id ? null : p.id)
                      }
                      title={`Project actions for ${p.name}`}
                      aria-label={`Project actions for ${p.name}`}
                      className="absolute right-2 top-2 z-20 rounded-md p-1.5 text-[var(--muted)] opacity-0 transition-opacity hover:bg-[var(--panel-3)] hover:text-[var(--ink)] focus-visible:opacity-100 group-hover/card:opacity-100 max-md:opacity-100"
                    >
                      <Icon name="more_vert" size={18} />
                    </button>
                    {menuProjectId === p.id && (
                      <>
                        <div
                          className="fixed inset-0 z-10"
                          onClick={() => setMenuProjectId(null)}
                        />
                        <div className="absolute right-2 top-10 z-20 w-44 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] py-1 text-xs shadow-[var(--shadow-lg)]">
                          {p.role === 'owner' && (
                            <button
                              type="button"
                              onClick={() => {
                                setMenuProjectId(null)
                                setRenameTarget({ id: p.id, name: p.name })
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel-3)]"
                            >
                              <Icon name="edit" size={15} /> Rename
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void copyProject(p)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel-3)]"
                          >
                            <Icon name="content_copy" size={15} /> Make a copy
                          </button>
                          {p.role === 'owner' && (
                            <button
                              type="button"
                              onClick={() => {
                                setMenuProjectId(null)
                                setTagProjectId(p.id)
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel-3)]"
                            >
                              <Icon name="label" size={15} /> Organize tags
                            </button>
                          )}
                          {p.role === 'owner' && (
                            <>
                              <button
                                type="button"
                                onClick={() => void setArchived(p, true)}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel-3)]"
                              >
                                <Icon name="archive" size={15} /> Archive
                              </button>
                              <div className="my-1 border-t border-[var(--border)]" />
                              <button
                                type="button"
                                onClick={() => {
                                  setMenuProjectId(null)
                                  void moveToTrash(p)
                                }}
                                disabled={deletingId === p.id}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[var(--danger)] hover:bg-[var(--panel-3)] disabled:opacity-40"
                              >
                                <Icon name="delete" size={15} /> Move to Trash
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : view === 'archived' ? (
          archivedLoading ? (
            <p className="text-sm text-[var(--muted)]">Loading Archived…</p>
          ) : archived.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--panel)] px-6 py-14 text-center">
              <Icon name="archive" size={32} className="mx-auto mb-3 text-[var(--muted-2)]" />
              <p className="text-sm font-medium">No archived projects</p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                Projects you archive from the menu will appear here.
              </p>
            </div>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {archived.map((p) => (
                <li key={p.id} className="group/card relative">
                  <Link
                    to={`/projects/${p.id}`}
                    className="serene-card group flex h-full flex-col p-4 pr-11 transition-all hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]"
                  >
                    <div className="mb-3 flex items-center gap-2.5">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--panel-3)] text-[var(--muted)]">
                        <Icon name="archive" size={18} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{p.name}</div>
                        <div className="text-[11px] text-[var(--muted)]">
                          {p.engine} · {p.role}
                        </div>
                      </div>
                    </div>
                    {(p.tags ?? []).length > 0 && (
                      <div className="mb-3 flex flex-wrap gap-1">
                        {(p.tags ?? []).map((tag) => (
                          <span
                            key={tag.id}
                            className="max-w-full truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                            style={{ backgroundColor: tag.color, color: tagInk(tag.color) }}
                          >
                            {tag.name}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="mt-auto text-[11px] text-[var(--muted-2)]">
                      Archived{' '}
                      {p.archived_at ? new Date(p.archived_at).toLocaleString() : 'recently'}
                    </div>
                  </Link>
                  <button
                    type="button"
                    onClick={() => setMenuProjectId(menuProjectId === p.id ? null : p.id)}
                    title={`Project actions for ${p.name}`}
                    aria-label={`Project actions for ${p.name}`}
                    className="absolute right-2 top-2 z-20 rounded-md p-1.5 text-[var(--muted)] opacity-0 transition-opacity hover:bg-[var(--panel-3)] hover:text-[var(--ink)] focus-visible:opacity-100 group-hover/card:opacity-100 max-md:opacity-100"
                  >
                    <Icon name="more_vert" size={18} />
                  </button>
                  {menuProjectId === p.id && (
                    <>
                      <div
                        className="fixed inset-0 z-10"
                        onClick={() => setMenuProjectId(null)}
                      />
                      <div className="absolute right-2 top-10 z-20 w-44 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] py-1 text-xs shadow-[var(--shadow-lg)]">
                        <button
                          type="button"
                          onClick={() => void copyProject(p)}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel-3)]"
                        >
                          <Icon name="content_copy" size={15} /> Make a copy
                        </button>
                        {p.role === 'owner' && (
                          <>
                            <button
                              type="button"
                              onClick={() => void setArchived(p, false)}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel-3)]"
                            >
                              <Icon name="unarchive" size={15} /> Unarchive
                            </button>
                            <div className="my-1 border-t border-[var(--border)]" />
                            <button
                              type="button"
                              onClick={() => {
                                setMenuProjectId(null)
                                void moveToTrash(p)
                              }}
                              disabled={deletingId === p.id}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[var(--danger)] hover:bg-[var(--panel-3)] disabled:opacity-40"
                            >
                              <Icon name="delete" size={15} /> Move to Trash
                            </button>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : trashLoading ? (
          <p className="text-sm text-[var(--muted)]">Loading Trash…</p>
        ) : trashed.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--panel)] px-6 py-14 text-center">
            <Icon name="delete" size={32} className="mx-auto mb-3 text-[var(--muted-2)]" />
            <p className="text-sm font-medium">Trash is empty</p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Projects you move to Trash will appear here until you restore or delete them.
            </p>
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {trashed.map((p) => (
              <li key={p.id} className="serene-card flex flex-col p-4">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--danger-soft)] text-[var(--danger)]">
                    <Icon name="delete" size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{p.name}</div>
                    <div className="text-[11px] text-[var(--muted)]">
                      Deleted{' '}
                      {p.deleted_at ? new Date(p.deleted_at).toLocaleString() : 'recently'}
                    </div>
                  </div>
                </div>
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
                  <button
                    type="button"
                    onClick={() => void restoreProject(p)}
                    disabled={deletingId === p.id}
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--ink-2)] hover:bg-[var(--panel-3)] disabled:opacity-40"
                  >
                    <Icon name="restore" size={14} /> Restore
                  </button>
                  <button
                    type="button"
                    onClick={() => void purgeProject(p)}
                    disabled={deletingId === p.id}
                    className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-[var(--danger)] hover:bg-[var(--danger-soft)] disabled:opacity-40"
                  >
                    <Icon name="delete_forever" size={14} />
                    {deletingId === p.id ? 'Deleting…' : 'Delete permanently'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>

      <ProjectTagsDialog
        open={Boolean(tagProject)}
        projectId={tagProject?.id ?? ''}
        projectName={tagProject?.name ?? ''}
        tags={tagProject?.tags ?? []}
        onClose={() => setTagProjectId(null)}
        onChanged={refreshLists}
      />

      <ProjectNameDialog
        open={Boolean(renameTarget)}
        title="Rename project"
        initialName={renameTarget?.name ?? ''}
        submitLabel="Rename"
        onClose={() => setRenameTarget(null)}
        onSubmit={async (name) => {
          if (!renameTarget) return
          await renameProject(renameTarget.id, name)
        }}
      />
    </div>
  )
}
