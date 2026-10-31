import { useEffect, useState } from 'react'
import { cloneTemplate, listTemplates, type ProjectLite, type Template } from '../../lib/history'

type TemplatePickerProps = {
  onCreated: (project: ProjectLite) => void
}

export default function TemplatePicker({ onCreated }: TemplatePickerProps) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const list = await listTemplates()
        if (!alive) return
        setTemplates(list)
        if (list.length > 0) {
          setSelectedId(list[0].id)
          setName(list[0].name)
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Could not load templates')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const selected = templates.find((template) => template.id === selectedId) ?? null

  function choose(template: Template) {
    setSelectedId(template.id)
    setName(template.name)
    setError('')
  }

  async function create() {
    if (!selected) return
    setBusy(true)
    setError('')
    try {
      const project = await cloneTemplate(selected.id, name.trim() || selected.name)
      onCreated(project)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create project from template')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return <p className="text-sm text-zinc-500">Loading templates…</p>
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Start from a template</h2>
        <p className="text-xs text-zinc-500">
          Creates a new project owned by you with all template files.
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        {templates.map((template) => {
          const active = template.id === selectedId
          return (
            <button
              key={template.id}
              type="button"
              onClick={() => choose(template)}
              className={`rounded-lg border bg-white p-3 text-left transition ${
                active
                  ? 'border-emerald-500 ring-2 ring-emerald-200'
                  : 'border-zinc-200 hover:border-zinc-300'
              }`}
            >
              <div className="text-sm font-medium">{template.name}</div>
              <div className="mt-1 text-xs text-zinc-500">{template.description}</div>
              <div className="mt-2 text-[11px] uppercase tracking-wide text-zinc-400">
                {template.engine}
              </div>
            </button>
          )
        })}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-48 flex-1 text-xs text-zinc-600">
          <span className="mb-1 block">Project name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={selected?.name || 'New project'}
            className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={() => void create()}
          disabled={!selected || busy || !name.trim()}
          className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create from template'}
        </button>
      </div>
    </div>
  )
}
