import { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import Icon from '../shell/Icon'
import { getToken } from '../../lib/api'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

export type PdfHighlight = {
  page: number
  x: number
  y: number
  width?: number
  height?: number
}

type Props = {
  url: string | null
  onPageChange?: (page: number, total: number) => void
  /** Called with page number and click position in PDF points (top-left origin). */
  onInverseSearch?: (page: number, x: number, y: number) => void
  highlight?: PdfHighlight | null
  /** Show a compiling overlay over the preview while a build is running. */
  compiling?: boolean
}

function CompileOverlay({ active }: { active: boolean }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!active) {
      setVisible(false)
      return
    }
    // Avoid a jarring flash on very fast compiles.
    const timer = setTimeout(() => setVisible(true), 250)
    return () => clearTimeout(timer)
  }, [active])

  if (!visible) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--panel-3)]/55 backdrop-blur-[1px]"
    >
      <div className="serene-card flex items-center gap-3 px-5 py-4">
        <span
          className="material-symbols-outlined animate-spin text-[var(--accent)]"
          style={{ fontSize: 26 }}
        >
          progress_activity
        </span>
        <div>
          <div className="font-display text-sm font-semibold">Compiling…</div>
          <div className="text-[11px] text-[var(--muted)]">Rendering PDF preview</div>
        </div>
      </div>
    </div>
  )
}

function PageCanvas({
  pdf,
  pageNumber,
  scale,
  highlight,
  onInverseSearch,
  register,
}: {
  pdf: pdfjsLib.PDFDocumentProxy
  pageNumber: number
  scale: number
  highlight?: PdfHighlight | null
  onInverseSearch?: (page: number, x: number, y: number) => void
  register: (page: number, node: HTMLDivElement | null) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    let cancelled = false
    let task: ReturnType<pdfjsLib.PDFPageProxy['render']> | null = null
    ;(async () => {
      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale })
      const canvas = canvasRef.current
      if (!canvas || cancelled) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      task = page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      })
      await task.promise
      if (!cancelled) setSize({ width: viewport.width, height: viewport.height })
    })().catch(() => {
      /* cancelled renders are expected while zooming */
    })
    return () => {
      cancelled = true
      try {
        task?.cancel()
      } catch {
        /* ignore */
      }
    }
  }, [pdf, pageNumber, scale])

  useEffect(() => {
    register(pageNumber, wrapRef.current)
    return () => register(pageNumber, null)
  }, [pageNumber, register])

  function click(e: React.MouseEvent<HTMLDivElement>) {
    if (!onInverseSearch) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / scale
    const y = (e.clientY - rect.top) / scale
    onInverseSearch(pageNumber, x, y)
  }

  return (
    <div
      ref={wrapRef}
      data-page={pageNumber}
      onClick={click}
      className="relative pdf-page mx-auto shrink-0"
      style={{ width: size.width || undefined, height: size.height || undefined }}
    >
      <canvas ref={canvasRef} className="block" />
      {highlight && highlight.page === pageNumber && (
        <div
          className="synctex-marker"
          style={{
            left: highlight.x * scale,
            top: highlight.y * scale,
            width: (highlight.width ?? 2) * scale,
            height: (highlight.height ?? 14) * scale,
          }}
        />
      )}
      <span className="pointer-events-none absolute bottom-1 right-2 text-[10px] text-zinc-400">
        {pageNumber}
      </span>
    </div>
  )
}

export default function PdfViewer({
  url,
  onPageChange,
  onInverseSearch,
  highlight,
  compiling = false,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pagesRef = useRef<Map<number, HTMLDivElement>>(new Map())
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(1.1)
  const [fitWidth, setFitWidth] = useState(true)
  const [baseWidth, setBaseWidth] = useState(612)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const onPageChangeRef = useRef(onPageChange)
  onPageChangeRef.current = onPageChange

  const register = useCallback((pageNumber: number, node: HTMLDivElement | null) => {
    if (node) pagesRef.current.set(pageNumber, node)
    else pagesRef.current.delete(pageNumber)
  }, [])

  useEffect(() => {
    let cancelled = false
    setPdf(null)
    setPageCount(0)
    setError('')
    setPage(1)
    setBlobUrl(null)
    if (!url) return
    setLoading(true)

    ;(async () => {
      try {
        const token = getToken()
        const res = await fetch(url, {
          credentials: 'include',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        if (!res.ok) throw new Error(`PDF unavailable (${res.status})`)
        const data = new Uint8Array(await res.arrayBuffer())
        const created = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }))
        const doc = await pdfjsLib.getDocument({ data }).promise
        if (cancelled) return
        setPdf(doc)
        setPageCount(doc.numPages)
        setBlobUrl(created)
        onPageChangeRef.current?.(1, doc.numPages)
        const first = await doc.getPage(1)
        setBaseWidth(first.getViewport({ scale: 1 }).width)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load PDF')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      setPdf((current) => {
        current?.destroy()
        return null
      })
    }
  }, [url])

  // Fit-to-width on container resize.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !baseWidth) return
    const apply = () => {
      if (!fitWidth) return
      const available = el.clientWidth - 64
      setScale(Math.min(2, Math.max(0.4, available / baseWidth)))
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [baseWidth, fitWidth])

  useEffect(() => {
    if (!highlight) return
    const node = pagesRef.current.get(highlight.page)
    node?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setPage(highlight.page)
    onPageChangeRef.current?.(highlight.page, pageCount)
  }, [highlight, pageCount])

  const goToPage = useCallback((target: number) => {
    const clamped = Math.min(Math.max(1, target), Math.max(1, pageCount))
    const node = pagesRef.current.get(clamped)
    node?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setPage(clamped)
    onPageChange?.(clamped, pageCount)
  }, [pageCount, onPageChange])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const midpoint = el.scrollTop + el.clientHeight * 0.35
    let current = 1
    for (const [number, node] of pagesRef.current) {
      if (node.offsetTop <= midpoint) current = Math.max(current, number)
    }
    if (current !== page) {
      setPage(current)
      onPageChange?.(current, pageCount)
    }
  }, [page, pageCount, onPageChange])

  const zoom = (delta: number) => {
    setFitWidth(false)
    setScale((value) => Math.min(3, Math.max(0.4, Math.round((value + delta) * 100) / 100)))
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--panel)]">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--border)] px-2">
        <button
          onClick={() => goToPage(page - 1)}
          disabled={page <= 1}
          className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--panel-3)] disabled:opacity-40"
          title="Previous page"
        >
          <Icon name="chevron_left" size={18} />
        </button>
        <div className="flex items-center gap-1 text-xs text-[var(--ink-2)]">
          <input
            value={page}
            onChange={(e) => {
              const next = Number(e.target.value)
              if (Number.isFinite(next)) goToPage(next)
            }}
            className="w-9 rounded-md border border-[var(--border)] bg-[var(--panel)] px-1 py-0.5 text-center"
            aria-label="Page number"
          />
          <span className="text-[var(--muted)]">/ {pageCount || '–'}</span>
        </div>
        <button
          onClick={() => goToPage(page + 1)}
          disabled={page >= pageCount}
          className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--panel-3)] disabled:opacity-40"
          title="Next page"
        >
          <Icon name="chevron_right" size={18} />
        </button>

        <span className="mx-1 h-5 w-px bg-[var(--border)]" />

        <button
          onClick={() => zoom(-0.15)}
          className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--panel-3)]"
          title="Zoom out"
        >
          <Icon name="remove" size={18} />
        </button>
        <span className="w-11 text-center text-xs tabular-nums text-[var(--ink-2)]">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => zoom(0.15)}
          className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--panel-3)]"
          title="Zoom in"
        >
          <Icon name="add" size={18} />
        </button>
        <button
          onClick={() => setFitWidth(true)}
          className={`rounded-md p-1.5 ${
            fitWidth
              ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
              : 'text-[var(--muted)] hover:bg-[var(--panel-3)]'
          }`}
          title="Fit width"
        >
          <Icon name="fit_screen" size={18} />
        </button>

        <span className="flex-1" />

        <button
          onClick={() => scrollRef.current?.requestFullscreen?.()}
          className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--panel-3)]"
          title="Fullscreen"
        >
          <Icon name="fullscreen" size={18} />
        </button>
        {blobUrl && (
          <a
            href={blobUrl}
            download="output.pdf"
            className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--panel-3)]"
            title="Download PDF"
          >
            <Icon name="download" size={18} />
          </a>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full overflow-auto bg-[var(--panel-3)] px-6 py-5"
        >
        {loading && (
          <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
            Loading PDF…
          </div>
        )}
        {!loading && error && (
          <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
            {error}
          </div>
        )}
        {!loading && !error && !pdf && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-[var(--muted)]">
            <span>No PDF yet</span>
            <span className="text-xs">Compile to preview</span>
          </div>
        )}
        {pdf && (
          <div className="flex flex-col items-center gap-5">
            {Array.from({ length: pageCount }, (_, index) => (
              <PageCanvas
                key={`${index + 1}-${scale}`}
                pdf={pdf}
                pageNumber={index + 1}
                scale={scale}
                highlight={highlight}
                onInverseSearch={onInverseSearch}
                register={register}
              />
            ))}
          </div>
        )}
        </div>
        <CompileOverlay active={compiling} />
      </div>
    </div>
  )
}
