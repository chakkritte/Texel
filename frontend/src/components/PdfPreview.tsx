import { useEffect, useState } from 'react'
import { getToken } from '../lib/api'

export default function PdfPreview({ url }: { url: string | null }) {
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
        if (!res.ok) throw new Error(`PDF unavailable (${res.status})`)
        const blob = await res.blob()
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setSrc(objectUrl)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'PDF unavailable')
      })

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [url])

  if (error) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-zinc-500">{error}</div>
  }
  if (!src) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-zinc-500">No PDF yet — compile to preview</div>
  }
  return <iframe src={src} title="PDF preview" className="h-full w-full border-0" />
}
