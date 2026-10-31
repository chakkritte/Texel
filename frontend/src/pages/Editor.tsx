import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import Icon from '../components/shell/Icon'
import { api, getToken } from '../lib/api'
import { useAuth } from '../lib/auth'
import { diffWordsWithSpace } from 'diff'
import { PROVIDER_ORIGIN, useCollabDoc } from '../collab'
import type { ReviewState } from '../components/review'
import FilePreview from '../components/FilePreview'
import { fileIconName, isTexFile, isTextFile } from '../lib/fileTypes'
import CodeMirrorEditor, { type JumpTarget } from '../components/CodeMirrorEditor'
import FileTree, { type FileT, type FolderT, type TreeT } from '../components/FileTree'
import UploadDialog, { type UploadFolder } from '../components/UploadDialog'
import ProjectNameDialog from '../components/ProjectNameDialog'
import PdfViewer, { type PdfHighlight } from '../components/pdf/PdfViewer'
import HistoryPanel from '../components/history/HistoryPanel'
import CommentsPanel from '../components/history/CommentsPanel'
import ShareDialog from '../components/history/ShareDialog'
import { AiPanel, type AiRequest, type Selection } from '../components/ai'
import type { SelectionAction } from '../components/SelectionToolbar'
import IconRail, { type PanelTab } from '../components/shell/IconRail'
import StatusBar from '../components/shell/StatusBar'

const SELECTION_PROMPTS: Record<SelectionAction, string> = {
  explain:
    'Explain the selected text: what it does, how it fits the surrounding document, and anything worth improving.',
  rewrite:
    'Rewrite the selected text to be clearer and more concise while preserving meaning, LaTeX/BibTeX commands, labels, citations and formatting. Propose the change with propose_edit.',
  fix: 'Check the selected text for syntax or compile problems and propose a minimal fix with propose_edit.',
  translate:
    'Translate the selected text into academic English. Keep every LaTeX/BibTeX command, math expression, label, citation and reference unchanged. Propose the change with propose_edit.',
}

type Project = {
  id: string
  name: string
  main_file: string
  engine: string
  role: string
  ai_enabled: boolean
}

type Job = {
  id: string
  status: string
  exit_code: number | null
  error: string | null
  pdf_url: string | null
  log_url: string | null
}

function relativePath(file: FileT, tree: TreeT): string {
  const byId = new Map(tree.folders.map((folder) => [folder.id, folder]))
  const parts: string[] = [file.name]
  let folderId = file.folder_id
  while (folderId) {
    const folder = byId.get(folderId)
    if (!folder) break
    parts.unshift(folder.name)
    folderId = folder.parent_id
  }
  return parts.join('/')
}

const TAB_TITLES: Record<PanelTab, string> = {
  files: 'Files',
  history: 'History',
  comments: 'Comments',
  ai: 'AI assistant',
}

export default function Editor() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user, logout } = useAuth()

  const [project, setProject] = useState<Project | null>(null)
  const [tree, setTree] = useState<TreeT>({ folders: [], files: [] })
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadProgress, setUploadProgress] = useState('')
  const [renameFileTarget, setRenameFileTarget] = useState<FileT | null>(null)
  const [openTabs, setOpenTabs] = useState<FileT[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const active = openTabs.find((file) => file.id === activeId) ?? null
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [log, setLog] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [autoCompile, setAutoCompile] = useState(true)
  const [jump, setJump] = useState<JumpTarget | null>(null)
  const [sidebarTab, setSidebarTab] = useState<PanelTab>('files')
  const [fileFilter, setFileFilter] = useState('')
  const [cursor, setCursor] = useState<{ line: number; column: number } | null>(null)
  const [pdfSize, setPdfSize] = useState(44)
  const [pdfPage, setPdfPage] = useState({ page: 1, total: 0 })
  const [lastPdfUrl, setLastPdfUrl] = useState<string | null>(null)
  const [pdfHighlight, setPdfHighlight] = useState<PdfHighlight | null>(null)
  const [aiSelection, setAiSelection] = useState<Selection | null>(null)
  const [aiRequest, setAiRequest] = useState<AiRequest | null>(null)
  const [syncTex, setSyncTex] = useState(true)
  const [trackChanges, setTrackChanges] = useState(false)
  const [baseline, setBaseline] = useState('')
  const [review, setReview] = useState<ReviewState | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem('studio.theme')
    if (stored) return stored === 'dark'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })
  const compileInFlight = useRef(false)
  const lastCompiledRef = useRef('')
  const suppressNextHighlight = useRef(false)

  const uploadFolders = useMemo<UploadFolder[]>(() => {
    const byId = new Map(tree.folders.map((folder) => [folder.id, folder]))
    const pathOf = (folder: FolderT): string => {
      const parts: string[] = [folder.name]
      let parentId = folder.parent_id
      const seen = new Set<string>()
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId)
        const parent = byId.get(parentId)
        if (!parent) break
        parts.unshift(parent.name)
        parentId = parent.parent_id
      }
      return parts.join('/')
    }
    return tree.folders
      .map((folder) => ({ id: folder.id, label: pathOf(folder) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [tree.folders])

  const activeIsText = active ? isTextFile(active) : false
  const collab = useCollabDoc(activeIsText ? active?.id ?? null : null, content, {
    enabled: activeIsText,
    user: user ? { name: user.display_name || user.email } : undefined,
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('studio.theme', dark ? 'dark' : 'light')
  }, [dark])

  const loadContent = useCallback(async (file: FileT) => {
    setError('')
    const data = await api<{ content: string; seq: number }>(`/files/${file.id}/content`)
    setContent(data.content)
    setBaseline(data.content)
    setReview(null)
    setDirty(false)
    lastCompiledRef.current = data.content
    setLog(null)
    setCursor(null)
  }, [])

  // Selection context belongs to the file it was made in.
  useEffect(() => {
    setAiSelection(null)
    setAiRequest(null)
  }, [active?.id])

  function handleSelectionAction(action: SelectionAction, selection: Selection) {
    if (!project?.ai_enabled) return
    setAiSelection(selection)
    setSidebarTab('ai')
    setAiRequest({ prompt: SELECTION_PROMPTS[action], nonce: Date.now() })
  }

  async function openFile(file: FileT) {
    if (file.id === activeId) return
    if (dirty) {
      await save()
    } else if (collab.provider) {
      try {
        await collab.provider.flush()
      } catch {
        /* ignore */
      }
    }
    setOpenTabs((prev) => (prev.some((f) => f.id === file.id) ? prev : [...prev, file]))
    setActiveId(file.id)
    if (isTextFile(file)) {
      await loadContent(file)
    } else {
      setContent('')
      setDirty(false)
      setCursor(null)
      setLog(null)
      setReview(null)
    }
  }

  async function closeTab(fileId: string) {
    if (fileId === activeId && collab.provider) {
      try {
        await collab.provider.flush()
      } catch {
        /* ignore */
      }
    }
    const index = openTabs.findIndex((f) => f.id === fileId)
    const next = openTabs.filter((f) => f.id !== fileId)
    setOpenTabs(next)
    if (fileId === activeId) {
      const neighbor = next[Math.max(0, index - 1)] ?? next[0] ?? null
      setActiveId(neighbor?.id ?? null)
      if (neighbor) {
        await loadContent(neighbor)
      } else {
        setContent('')
        setDirty(false)
        setCursor(null)
      }
    }
  }

  useEffect(() => {
    if (!id) return
    let alive = true
    ;(async () => {
      try {
        const [p, t, latest] = await Promise.all([
          api<Project>(`/projects/${id}`),
          api<TreeT>(`/projects/${id}/tree`),
          api<Job | null>(`/projects/${id}/compiles/latest`).catch(() => null),
        ])
        if (!alive) return
        setProject(p)
        setTree(t)
        setJob(latest)
        setLastPdfUrl(null)
        const main =
          t.files.find((f) => f.name === p.main_file && f.kind === 'doc') ||
          t.files.find((f) => f.kind === 'doc')
        if (main) {
          setOpenTabs([main])
          setActiveId(main.id)
          await loadContent(main)
        }
        setLoaded(true)
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Failed to load project')
      }
    })()
    return () => {
      alive = false
    }
  }, [id, loadContent])

  useEffect(() => {
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return
    const timer = setTimeout(async () => {
      try {
        setJob(await api<Job>(`/compile/${job.id}`))
      } catch {
        /* keep polling */
      }
    }, 1500)
    return () => clearTimeout(timer)
  }, [job])

  useEffect(() => {
    if (!active) return
    const handler = (_event: unknown, transaction: { origin: unknown }) => {
      if (transaction.origin !== PROVIDER_ORIGIN) setDirty(true)
    }
    collab.text.observe(handler)
    return () => collab.text.unobserve(handler)
  }, [active?.id, collab.text])

  // Keep `content` in sync with the CRDT text (collab mode skips onChange).
  useEffect(() => {
    if (!collab.synced) return
    const update = () => setContent(collab.text.toString())
    update()
    collab.text.observe(update)
    return () => collab.text.unobserve(update)
  }, [collab.text, collab.synced, active?.id])

  // Track changes: diff against the baseline and render decorations.
  useEffect(() => {
    if (!trackChanges || !active || !isTextFile(active)) {
      setReview(null)
      return
    }
    const timer = setTimeout(() => {
      const parts = diffWordsWithSpace(baseline, content)
      let pos = 0
      const additions: { from: number; to: number }[] = []
      const deletions: { pos: number; text: string }[] = []
      for (const part of parts) {
        if (part.added) {
          additions.push({ from: pos, to: pos + part.value.length })
          pos += part.value.length
        } else if (part.removed) {
          deletions.push({ pos, text: part.value })
        } else {
          pos += part.value.length
        }
      }
      setReview({ additions, deletions })
    }, 250)
    return () => clearTimeout(timer)
  }, [content, trackChanges, baseline, active?.id])

  // Forward SyncTeX: follow the editor cursor in the PDF.
  useEffect(() => {
    if (!syncTex || !job || job.status !== 'success' || !active || !cursor) return
    // An inverse search (PDF click) moves the editor cursor. That jump must not
    // draw a highlight box back on the PDF. Consume the flag here in the effect
    // body: a timer left over from an earlier cursor move must not swallow it
    // before the jump update arrives.
    if (suppressNextHighlight.current) {
      suppressNextHighlight.current = false
      setPdfHighlight(null)
      return
    }
    const rel = relativePath(active, tree)
    const timer = setTimeout(async () => {
      // A PDF click landed while this timer was pending; skip drawing and let
      // the jump update consume the flag.
      if (suppressNextHighlight.current) {
        setPdfHighlight(null)
        return
      }
      try {
        const data = await api<{
          records: Array<{ page: number; x: number; y: number; W?: number; H?: number }>
        }>(
          `/compile/${job.id}/synctex/view?file=${encodeURIComponent(rel)}&line=${cursor.line}&column=${cursor.column}`
        )
        const record = data.records?.[0]
        if (record) {
          setPdfHighlight({
            page: record.page,
            x: record.x,
            y: record.y,
            width: record.W,
            height: record.H,
          })
        }
      } catch {
        /* no synctex match */
      }
    }, 450)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncTex, cursor?.line, cursor?.column, active?.id, job?.id, job?.status])

  async function inverseSearch(page: number, x: number, y: number) {
    if (!job || job.status !== 'success') return
    try {
      const match = await api<{ file: string; line: number; column?: number }>(
        `/compile/${job.id}/synctex/edit?page=${page}&x=${x}&y=${y}`
      )
      const base = match.file.split('/').pop()
      const target =
        tree.files.find((f) => f.kind === 'doc' && f.name === match.file) ||
        tree.files.find((f) => f.kind === 'doc' && base && f.name === base)
      if (!target) return
      // Jump to the source line without highlighting an area in the PDF.
      setPdfHighlight(null)
      suppressNextHighlight.current = true
      if (active?.id !== target.id) await openFile(target)
      setJump({
        line: match.line,
        column: Math.max(0, (match.column ?? 1) - 1),
        nonce: Date.now(),
      })
    } catch {
      /* no synctex match */
    }
  }

  const errorLines = useMemo(() => {
    if (!job?.error) return []
    return job.error
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((raw) => {
        const match = raw.match(/^(.+?):(\d+):\s*(.*)$/)
        return {
          raw,
          file: match?.[1] ?? null,
          line: match ? Number(match[2]) : null,
          message: match?.[3] ?? raw,
        }
      })
  }, [job?.error])

  useEffect(() => {
    // Auto-compile only when a .tex/.ltx source actually changed. Editing a
    // .bib/.sty/.txt file should not trigger a build on its own.
    if (!autoCompile || !dirty || !active || !id || !isTexFile(active)) return
    const timer = setTimeout(async () => {
      if (compileInFlight.current) return
      // Nothing actually changed since the last compile (e.g. an undo).
      if (content === lastCompiledRef.current) {
        setDirty(false)
        return
      }
      const ok = await save()
      if (!ok) return
      compileInFlight.current = true
      lastCompiledRef.current = content
      try {
        setJob(await api<Job>(`/projects/${id}/compile`, { method: 'POST' }))
      } catch {
        /* manual compile surfaces errors */
      } finally {
        compileInFlight.current = false
      }
    }, 2000)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, autoCompile, dirty, active, id])

  useEffect(() => {
    if (job?.pdf_url) setLastPdfUrl(`${job.pdf_url}?v=${job.id}`)
  }, [job?.pdf_url, job?.id])

  function toggleTrackChanges() {
    if (!trackChanges) {
      setBaseline(content)
      setReview(null)
      setTrackChanges(true)
    } else {
      setTrackChanges(false)
      setReview(null)
    }
  }

  function acceptAllChanges() {
    setBaseline(content)
    setReview(null)
  }

  async function rejectAllChanges() {
    const original = baseline
    setContent(original)
    setDirty(true)
    setReview(null)
    if (collab.synced) {
      const ytext = collab.text
      collab.ydoc.transact(() => {
        if (ytext.length) ytext.delete(0, ytext.length)
        ytext.insert(0, original)
      }, 'review-reject')
      await collab.provider?.flush()
    }
  }

  async function save(): Promise<boolean> {
    if (!active) return false
    setBusy('save')
    setError('')
    try {
      if (collab.provider) {
        await collab.provider.flush()
      } else {
        await api(`/files/${active.id}/content`, {
          method: 'PUT',
          body: JSON.stringify({ content }),
        })
      }
      setDirty(false)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
      return false
    } finally {
      setBusy('')
    }
  }

  async function compile() {
    if (!id) return
    setError('')
    setLog(null)
    setBusy('compile')
    try {
      if (collab.provider) await collab.provider.flush()
      if (dirty && !(await save())) return
      lastCompiledRef.current = content
      setJob(await api<Job>(`/projects/${id}/compile`, { method: 'POST' }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Compile failed')
    } finally {
      setBusy('')
    }
  }

  async function showLog() {
    if (!job) return
    try {
      setLog(await api<string>(`/compile/${job.id}/log`))
    } catch {
      setError('Could not load compile log')
    }
  }

  async function newFile() {
    if (!id) return
    const name = window.prompt('New file name (e.g. section.tex)')
    if (!name) return
    try {
      await api(`/projects/${id}/files`, {
        method: 'POST',
        body: JSON.stringify({ name, content: `% ${name}\n` }),
      })
      const t = await api<TreeT>(`/projects/${id}/tree`)
      setTree(t)
      const created = t.files.find((f) => f.name === name)
      if (created) await loadContent(created)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create file')
    }
  }

  async function uploadFiles(files: File[], folderId: string | null) {
    if (!id) throw new Error('No project is open')
    const query = folderId ? `?folder_id=${encodeURIComponent(folderId)}` : ''
    let firstId: string | null = null
    try {
      for (let index = 0; index < files.length; index += 1) {
        setUploadProgress(
          files.length > 1
            ? `Uploading ${index + 1} of ${files.length}…`
            : 'Uploading…',
        )
        const form = new FormData()
        form.append('upload', files[index])
        const created = await api<FileT>(`/projects/${id}/upload${query}`, {
          method: 'POST',
          body: form,
        })
        if (!firstId) firstId = created.id
      }
    } catch (err) {
      // Keep the tree in sync with whatever was uploaded before the failure.
      const current = await api<TreeT>(`/projects/${id}/tree`).catch(() => null)
      if (current) setTree(current)
      throw err
    } finally {
      setUploadProgress('')
    }

    const nextTree = await api<TreeT>(`/projects/${id}/tree`)
    setTree(nextTree)
    const first = firstId
      ? nextTree.files.find((file) => file.id === firstId)
      : undefined
    if (first) await openFile(first)
  }

  async function jumpToError(err: { file: string | null; line: number | null }) {
    if (!err.line) return
    const base = err.file?.split('/').pop()
    const target =
      tree.files.find((f) => f.kind === 'doc' && base && f.name === base) ||
      tree.files.find((f) => f.kind === 'doc' && err.file && f.name === err.file)
    if (!target) return
    if (active?.id !== target.id) await openFile(target)
    setJump({ line: err.line, column: 0, nonce: Date.now() })
  }

  async function moveProjectToTrash() {
    if (!id || !project || project.role !== 'owner') return
    if (
      !window.confirm(
        `Move project "${project.name}" to Trash? You can restore it later from the Projects page.`,
      )
    ) {
      return
    }
    try {
      await api(`/projects/${id}`, { method: 'DELETE' })
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move project to Trash')
    }
  }

  async function exportZip() {
    if (!id) return
    const res = await fetch(`${import.meta.env.BASE_URL}api/v1/projects/${id}/export-zip`, {
      credentials: 'include',
      headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
    })
    if (!res.ok) {
      setError('Export failed')
      return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${project?.name ?? 'project'}.zip`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function updateProject(patch: Partial<Project>) {
    if (!id) return
    try {
      setProject(
        await api<Project>(`/projects/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        })
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update project')
    }
  }

  async function syncCollabFromServer() {
    if (!active) return
    try {
      const data = await api<{ content: string }>(`/files/${active.id}/content`)
      setContent(data.content)
      if (collab.synced) {
        const ytext = collab.text
        collab.ydoc.transact(() => {
          if (ytext.length) ytext.delete(0, ytext.length)
          ytext.insert(0, data.content)
        }, 'ai-apply')
        await collab.provider?.flush()
      }
      setDirty(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sync AI edit')
    }
  }

  async function refreshTreeAndTabs(): Promise<TreeT | undefined> {
    if (!id) return
    const nextTree = await api<TreeT>(`/projects/${id}/tree`)
    setTree(nextTree)
    setOpenTabs((prev) => prev.map((f) => nextTree.files.find((n) => n.id === f.id) ?? f))
    return nextTree
  }

  async function moveFile(fileId: string, folderId: string | null) {
    try {
      await api(`/files/${fileId}`, {
        method: 'PATCH',
        body: JSON.stringify({ folder_id: folderId }),
      })
      await refreshTreeAndTabs()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move file')
    }
  }

  async function moveFolder(folderId: string, parentId: string | null) {
    try {
      await api(`/folders/${folderId}`, {
        method: 'PATCH',
        body: JSON.stringify({ parent_id: parentId }),
      })
      await refreshTreeAndTabs()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move folder')
    }
  }

  async function renameFile(file: FileT, name: string) {
    if (!id) throw new Error('No project is open')
    await api<FileT>(`/files/${file.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    })
    await refreshTreeAndTabs().catch(() => undefined)
    // The backend may have updated project.main_file when the main file was
    // renamed, so refresh the project metadata too.
    const fresh = await api<Project>(`/projects/${id}`).catch(() => null)
    if (fresh) setProject(fresh)
  }

  async function deleteFile(file: FileT) {
    if (!id) return
    const path = relativePath(file, tree)
    if (!window.confirm(`Delete "${path}"? This cannot be undone.`)) return
    try {
      // Flush pending collaborative text before removing the document.
      if (file.id === activeId && collab.provider) {
        try {
          await collab.provider.flush()
        } catch {
          /* delete anyway */
        }
      }
      await api(`/files/${file.id}`, { method: 'DELETE' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete file')
      return
    }

    const remaining = openTabs.filter((tab) => tab.id !== file.id)
    setOpenTabs(remaining)
    if (activeId === file.id) {
      const next = remaining[remaining.length - 1] ?? null
      setActiveId(next?.id ?? null)
      if (next && isTextFile(next)) {
        await loadContent(next)
      } else {
        setContent('')
        setDirty(false)
        setCursor(null)
        setReview(null)
        setLog(null)
      }
    }
    const nextTree = await refreshTreeAndTabs()
    // If the deleted file was the project's main document, point it at the
    // first remaining .tex so compiling does not fail on a missing file.
    if (
      id &&
      project &&
      nextTree &&
      (project.main_file === path || project.main_file === file.name)
    ) {
      const fallback = nextTree.files.find(
        (candidate) => candidate.kind === 'doc' && /\.(tex|ltx)$/i.test(candidate.name),
      )
      if (fallback) {
        const nextMain = relativePath(fallback, nextTree)
        try {
          await api(`/projects/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ main_file: nextMain }),
          })
          setProject((previous) =>
            previous ? { ...previous, main_file: nextMain } : previous,
          )
        } catch {
          /* leave the existing main_file if the update fails */
        }
      }
    }
  }

  async function refreshAfterRestore() {
    if (!id) return
    const nextTree = await api<TreeT>(`/projects/${id}/tree`)
    setTree(nextTree)
    setOpenTabs((prev) => prev.map((f) => nextTree.files.find((n) => n.id === f.id) ?? f))
    const target =
      (activeId && nextTree.files.find((f) => f.id === activeId)) ||
      nextTree.files.find((f) => f.kind === 'doc' && f.name === project?.main_file) ||
      nextTree.files.find((f) => f.kind === 'doc')
    if (target) {
      setOpenTabs((prev) => (prev.some((f) => f.id === target.id) ? prev : [...prev, target]))
      setActiveId(target.id)
      await loadContent(target)
    }
  }

  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = pdfSize
    const width = window.innerWidth
    const onMove = (ev: MouseEvent) => {
      const delta = ((startX - ev.clientX) / width) * 100
      setPdfSize(Math.min(65, Math.max(26, startWidth + delta)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const filteredTree = useMemo(() => {
    if (!fileFilter.trim()) return tree
    const q = fileFilter.trim().toLowerCase()
    return { folders: [], files: tree.files.filter((f) => f.name.toLowerCase().includes(q)) }
  }, [tree, fileFilter])

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
        {error || 'Loading project…'}
      </div>
    )
  }

  const currentPdfUrl = job?.pdf_url ? `${job.pdf_url}?v=${job.id}` : null
  // Keep the previous preview visible (dimmed) while a new build runs.
  const pdfUrl = currentPdfUrl ?? lastPdfUrl
  const compiling = job?.status === 'queued' || job?.status === 'running'
  const statusLabel = compiling
    ? 'Compiling…'
    : job?.status === 'success'
      ? 'Compiled'
      : job?.status === 'failed'
        ? 'Build failed'
        : 'Not compiled'
  const statusTone = compiling
    ? 'border-[var(--warn)] bg-[var(--warn-soft)] text-[var(--warn)]'
    : job?.status === 'success'
      ? 'border-[var(--ok)] bg-[var(--ok-soft)] text-[var(--ok)]'
      : job?.status === 'failed'
        ? 'border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]'
        : 'border-[var(--border)] text-[var(--muted)]'
  const initials = (user?.display_name || user?.email || 'U').slice(0, 1).toUpperCase()

  return (
    <div className="flex h-full flex-col bg-[var(--app-bg)] text-[var(--ink)]">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-2.5">
        <Link
          to="/"
          title="Back to projects"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--ink)]"
        >
          <Icon name="arrow_back" size={20} />
        </Link>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-secondary-container)] text-[var(--color-on-secondary-container)] doodle-border">
          <Icon name="edit_document" size={18} />
        </div>
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate font-display text-[13px] font-semibold">{project?.name}</span>
          <span className="truncate text-[10px] text-[var(--muted)]">
            Tectonic · {active?.name ?? 'no file'}
          </span>
        </div>

        <span
          className={`ml-2 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusTone}`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {statusLabel}
        </span>

        <span className="flex-1" />

        <label className="mr-1 flex items-center gap-1 text-[11px] text-[var(--muted)]">
          <input
            type="checkbox"
            checked={autoCompile}
            onChange={(e) => setAutoCompile(e.target.checked)}
          />
          Auto
        </label>
        {activeIsText && (
          <label className="mr-1 flex items-center gap-1 text-[11px] text-[var(--muted)]" title="Follow the cursor in the PDF">
            <input
              type="checkbox"
              checked={syncTex}
              onChange={(e) => setSyncTex(e.target.checked)}
            />
            Sync
          </label>
        )}

        <div
          className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[11px] font-semibold text-[var(--accent)]"
          title={user?.email}
        >
          {initials}
        </div>

        {id && <ShareDialog projectId={id} />}

        <button
          onClick={save}
          disabled={!activeIsText || busy !== ''}
          className="rounded-full border border-[var(--border-strong)] px-3.5 py-1.5 text-xs text-[var(--ink-2)] hover:bg-[var(--panel-3)] disabled:opacity-40"
        >
          Save
        </button>

        <button
          onClick={compile}
          disabled={busy !== ''}
          className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 py-1.5 text-xs font-semibold text-[var(--accent-ink)] shadow-sm transition-colors hover:bg-[var(--accent-2)] disabled:opacity-50"
        >
          <Icon name="play_arrow" size={16} />
          {compiling ? 'Compiling…' : 'Compile'}
        </button>

        <div className="relative">
          <button
            onClick={() => setMenuOpen((value) => !value)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--ink)]"
            title="Menu"
          >
            <Icon name="more_vert" size={20} />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] py-1 text-xs shadow-[var(--shadow-lg)]">
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    void exportZip()
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel-3)]"
                >
                  <Icon name="download" size={16} /> Export .zip
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    setDark(!dark)
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel-3)]"
                >
                  {dark ? <Icon name="light_mode" size={16} /> : <Icon name="dark_mode" size={16} />}
                  {dark ? 'Light theme' : 'Dark theme'}
                </button>
                {project?.role === 'owner' && (
                  <button
                    onClick={() => {
                      setMenuOpen(false)
                      void moveProjectToTrash()
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[var(--danger)] hover:bg-[var(--panel-3)]"
                  >
                    <Icon name="delete" size={16} /> Move to Trash
                  </button>
                )}
                <div className="my-1 border-t border-[var(--border)]" />
                <button
                  onClick={() => logout()}
                  className="w-full px-3 py-2 text-left text-[var(--danger)] hover:bg-[var(--panel-3)]"
                >
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <IconRail active={sidebarTab} onChange={setSidebarTab} />

        <aside
          className={`flex shrink-0 flex-col border-r border-[var(--border)] bg-[var(--panel-2)] ${
            sidebarTab === 'ai' ? 'w-[350px]' : 'w-[300px]'
          }`}
        >
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--border)] px-3">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              {TAB_TITLES[sidebarTab]}
            </span>
            {sidebarTab === 'files' && (
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => setUploadOpen(true)}
                  title="Upload files"
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--accent)] hover:bg-[var(--accent-soft)]"
                >
                  <Icon name="upload" size={15} /> Upload
                </button>
                <button
                  onClick={newFile}
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--accent)] hover:bg-[var(--accent-soft)]"
                >
                  <Icon name="add" size={16} /> New
                </button>
              </div>
            )}
          </div>

          {sidebarTab === 'files' && (
            <div className="shrink-0 border-b border-[var(--border)] px-2 py-1.5">
              <input
                value={fileFilter}
                onChange={(e) => setFileFilter(e.target.value)}
                placeholder="Filter files…"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs outline-none placeholder:text-[var(--muted-2)] focus:border-[var(--accent)]"
              />
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-auto">
            {sidebarTab === 'files' && (
              <FileTree
                tree={filteredTree}
                activeId={active?.id ?? null}
                onSelect={openFile}
                onMoveFile={moveFile}
                onMoveFolder={moveFolder}
                onRename={
                  project?.role === 'viewer'
                    ? undefined
                    : (file) => setRenameFileTarget(file)
                }
                onDelete={project?.role === 'viewer' ? undefined : deleteFile}
              />
            )}
            {sidebarTab === 'history' && id && (
              <HistoryPanel projectId={id} onRestored={refreshAfterRestore} />
            )}
            {sidebarTab === 'comments' && id && (
              <CommentsPanel projectId={id} fileId={active?.id ?? null} />
            )}
            {sidebarTab === 'ai' && id && project?.ai_enabled && (
              <AiPanel
                projectId={id}
                fileId={active?.id ?? null}
                selection={aiSelection}
                request={aiRequest}
                onRequestHandled={() => setAiRequest(null)}
                compileError={job?.error ? { jobId: job.id, message: job.error } : null}
                onJumpToError={(target) => {
                  void jumpToError(target)
                }}
                onApplied={() => syncCollabFromServer()}
              />
            )}
            {sidebarTab === 'ai' && project && !project.ai_enabled && (
              <div className="p-4 text-xs text-[var(--muted)]">AI is disabled for this project.</div>
            )}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col bg-[var(--panel)]">
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--border)] px-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {openTabs.map((file) => {
                const isActive = file.id === activeId
                return (
                  <div
                    key={file.id}
                    className={`group flex h-8 shrink-0 items-center gap-1 rounded-lg pl-2.5 pr-1 text-xs transition-colors ${
                      isActive
                        ? 'bg-[var(--panel-2)] text-[var(--ink)] shadow-[var(--shadow-sm)]'
                        : 'text-[var(--muted)] hover:bg-[var(--panel-3)]'
                    }`}
                  >
                    <button
                      onClick={() => void openFile(file)}
                      className="flex items-center gap-2"
                    >
                      <Icon
                        name={fileIconName(file)}
                        size={15}
                        className={isActive ? 'text-[var(--accent)]' : ''}
                      />
                      <span className="max-w-40 truncate">{file.name}</span>
                      {isActive && dirty && (
                        <span className="h-1.5 w-1.5 rounded-full bg-[var(--warn)]" />
                      )}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void closeTab(file.id)
                      }}
                      title="Close tab"
                      className="rounded-full p-0.5 text-[var(--muted-2)] opacity-0 hover:bg-[var(--panel-3)] hover:text-[var(--ink)] group-hover:opacity-100"
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                )
              })}
              {openTabs.length === 0 && (
                <span className="px-2 text-xs text-[var(--muted)]">No file open</span>
              )}
            </div>
            {activeIsText && (
              <>
            <button
              onClick={toggleTrackChanges}
              title="Track changes"
              className={`ml-1 flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] transition-colors ${
                trackChanges
                  ? 'bg-[var(--accent-soft)] text-[var(--color-on-secondary-container)]'
                  : 'text-[var(--muted)] hover:bg-[var(--panel-3)]'
              }`}
            >
              <Icon name="track_changes" size={14} /> Track
            </button>
            {trackChanges && review && review.additions.length + review.deletions.length > 0 && (
              <div className="flex shrink-0 items-center gap-1">
                <span className="rounded-full bg-[var(--warn-soft)] px-2 py-0.5 text-[10px] text-[var(--warn)]">
                  {review.additions.length + review.deletions.length} changes
                </span>
                <button
                  onClick={acceptAllChanges}
                  className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] hover:bg-[var(--panel-3)]"
                >
                  Accept
                </button>
                <button
                  onClick={() => void rejectAllChanges()}
                  className="rounded-full border border-[var(--danger)]/40 px-2 py-0.5 text-[10px] text-[var(--danger)] hover:bg-[var(--panel-3)]"
                >
                  Reject
                </button>
              </div>
            )}
              </>
            )}
            <span
              className="hidden items-center gap-1 rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--ink-2)] lg:inline-flex"
              title="Tectonic (XeTeX) engine"
            >
              <Icon name="bolt" size={14} /> Tectonic
            </span>
            <select
              value={project?.main_file}
              onChange={(e) => updateProject({ main_file: e.target.value })}
              className="hidden max-w-40 rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-[11px] text-[var(--ink-2)] md:block"
              title="Main file"
            >
              {tree.files
                .filter((f) => f.kind === 'doc' && /\.(tex|ltx)$/i.test(f.name))
                .map((f) => (
                  <option key={f.id} value={f.name}>
                    {f.name}
                  </option>
                ))}
            </select>
          </div>

          <div className="min-h-0 flex-1">
            {active ? (
              isTextFile(active) ? (
                <CodeMirrorEditor
                  key={`${active.id}-${dark ? 'd' : 'l'}`}
                  value={content}
                  ytext={collab.synced ? collab.text : null}
                  awareness={collab.synced ? collab.awareness : null}
                  jump={jump}
                  dark={dark}
                  review={review}
                  language={/\.(tex|ltx)$/i.test(active.name) ? 'stex' : 'plain'}
                  aiActions={Boolean(project?.ai_enabled)}
                  onSelectionChange={setAiSelection}
                  onSelectionAction={handleSelectionAction}
                  onCursor={(line, column) => setCursor({ line, column })}
                  onChange={(value) => {
                    setContent(value)
                    setDirty(true)
                  }}
                />
              ) : (
                <FilePreview file={active} />
              )
            ) : (
              <div className="p-6 text-sm text-[var(--muted)]">Select a file to open</div>
            )}
          </div>

          {(error || job?.error) && (
            <div className="max-h-36 shrink-0 overflow-auto border-t border-[var(--danger)]/30 bg-[var(--danger-soft)] px-4 py-2">
              <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-[var(--danger)]">
                <Icon name="error" size={16} />
                <span className="flex-1">{error || statusLabel}</span>
                {job && (
                  <button onClick={showLog} className="text-[11px] underline">
                    View log
                  </button>
                )}
              </div>
              {errorLines.length > 0 && (
                <ul className="space-y-0.5">
                  {errorLines.slice(0, 40).map((err, index) => (
                    <li key={index}>
                      <button
                        onClick={() => jumpToError(err)}
                        title={err.raw}
                        className={`w-full text-left font-[var(--font-mono)] text-[11px] text-[var(--danger)] ${
                          err.line ? 'hover:underline' : ''
                        }`}
                      >
                        {err.line ? `→ ${err.file}:${err.line}` : '•'} {err.message}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <StatusBar
            file={active?.name ?? null}
            line={cursor?.line ?? null}
            column={cursor?.column ?? null}
            engine="Tectonic"
            build={statusLabel}
            collab={collab.synced ? 'live' : collab.status}
            pdfPage={pdfPage.page}
            pdfTotal={pdfPage.total}
          />
        </main>

        <div
          onMouseDown={startResize}
          className="w-1.5 shrink-0 cursor-col-resize bg-[var(--border)] transition-colors hover:bg-[var(--accent-2)]"
          title="Drag to resize"
        />

        <section
          style={{ width: `${pdfSize}%` }}
          className="min-w-[320px] shrink-0 overflow-hidden bg-[var(--panel)]"
        >
          <PdfViewer
            url={pdfUrl}
            compiling={compiling}
            highlight={pdfHighlight}
            onInverseSearch={inverseSearch}
            onPageChange={(page, total) => setPdfPage({ page, total })}
          />
        </section>
      </div>

      {log !== null && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm">
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-[var(--shadow-lg)]">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
              <span className="text-sm font-semibold">Compile log</span>
              <button
                onClick={() => setLog(null)}
                className="rounded-md px-2 py-1 text-xs text-[var(--muted)] hover:bg-[var(--panel-3)]"
              >
                Close
              </button>
            </div>
            <pre className="overflow-auto p-4 font-[var(--font-mono)] text-[11px] leading-relaxed">
              {log}
            </pre>
          </div>
        </div>
      )}

      <UploadDialog
        open={uploadOpen}
        folders={uploadFolders}
        defaultFolderId={active?.folder_id ?? null}
        progress={uploadProgress}
        onClose={() => setUploadOpen(false)}
        onUpload={uploadFiles}
      />

      <ProjectNameDialog
        open={Boolean(renameFileTarget)}
        title="Rename file"
        initialName={renameFileTarget?.name ?? ''}
        submitLabel="Rename"
        onClose={() => setRenameFileTarget(null)}
        onSubmit={async (name) => {
          if (!renameFileTarget) return
          await renameFile(renameFileTarget, name)
        }}
      />
    </div>
  )
}
