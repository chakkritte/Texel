import { useEffect, useState } from 'react'
import Icon from './shell/Icon'
import PdfViewer from './pdf/PdfViewer'
import { BASE, getToken } from '../lib/api'
import type { FileT } from './FileTree'
import { isImageFile, isPdfFile } from '../lib/fileTypes'

export function fileDownloadUrl(fileId: string): string {
  return `${BASE}api/v1/files/${fileId}/download`
}

function useBlobUrl(url: string | null) {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    setSrc(null)
    setError('')
    if (!url) return

    const token = getToken()
    fetch(url, {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Preview unavailable (${res.status})`)
        const blob = await res.blob()
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setSrc(objectUrl)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Preview unavailable')
      })

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [url])

  return { src, error }
}

export function ImagePreview({ file }: { file: FileT }) {
  const { src, error } = useBlobUrl(fileDownloadUrl(file.id))

  if (error) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">{error}</div>
  }
  if (!src) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">Loading preview…</div>
  }
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-[var(--panel-3)] p-6">
      <img
        src={src}
        alt={file.name}
        className="max-h-full max-w-full rounded-lg bg-white object-contain shadow-[var(--shadow-md)]"
      />
    </div>
  )
}

export function BinaryInfo({ file }: { file: FileT }) {
  const [busy, setBusy] = useState(false)

  async function download() {
    setBusy(true)
    try {
      const token = getToken()
      const res = await fetch(fileDownloadUrl(file.id), {
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = file.name
      anchor.click()
      URL.revokeObjectURL(url)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--panel)] text-sm text-[var(--muted)]">
      <Icon name="draft" size={42} className="text-[var(--muted-2)]" />
      <div className="font-display text-base font-semibold text-[var(--ink)]">{file.name}</div>
      <div>
        {(file.size / 1024).toFixed(1)} KB · {file.mime || 'binary'}
      </div>
      <button
        onClick={download}
        disabled={busy}
        className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-[var(--accent-ink)] disabled:opacity-50"
      >
        <Icon name="download" size={16} /> Download
      </button>
    </div>
  )
}

export default function FilePreview({ file }: { file: FileT }) {
  if (isImageFile(file)) return <ImagePreview file={file} />
  if (isPdfFile(file)) return <PdfViewer url={fileDownloadUrl(file.id)} />
  return <BinaryInfo file={file} />
}
