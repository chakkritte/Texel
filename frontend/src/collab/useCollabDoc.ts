/**
 * React hook that owns the Y.Doc / Awareness / provider lifecycle for a file.
 *
 * Usage with `y-codemirror.next` (see docs/phase2-integration.md):
 *
 * ```tsx
 * const { ydoc, awareness, status } = useCollabDoc(file.id, initialContent)
 * const ytext = ydoc.getText('content')
 * // extensions: [..., yCollab(ytext, awareness)]
 * ```
 *
 * Important: do NOT insert `initialContent` into the Y.Text before the first
 * sync. The server initialises the CRDT from `documents.content` and returns
 * it in the sync response; pre-seeding would duplicate the text. The hook only
 * uses `initialContent` as a fallback when the server reports an empty
 * document (or when collaboration is disabled).
 */

import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'

import { HttpYjsProvider, type CollabStatus } from './httpProvider'

export type UseCollabDocOptions = {
  /** Presence payload exposed to other clients as awareness field `user`. */
  user?: Record<string, unknown>
  /** Set to false to keep a local-only Y.Doc (no network provider). */
  enabled?: boolean
  /** Override the collab API base (defaults to `<BASE_URL>collab/v1`). */
  baseUrl?: string
  pollTimeout?: number
  clientId?: string
}

export type UseCollabDocResult = {
  /** The Y.Doc to connect to CodeMirror / other bindings. */
  ydoc: Y.Doc
  /** Awareness instance (pass the same one to `yCollab`). */
  awareness: Awareness
  /** Y.Text named "content" (convenience). */
  text: Y.Text
  provider: HttpYjsProvider | null
  status: CollabStatus
  synced: boolean
}

type ActiveCollab = {
  doc: Y.Doc
  awareness: Awareness
  provider: HttpYjsProvider
}

export function useCollabDoc(
  fileId: string | null | undefined,
  initialContent = '',
  options: UseCollabDocOptions = {},
): UseCollabDocResult {
  const enabled = options.enabled !== false

  // A stable local-only document, used when disabled or before the effect runs.
  const fallbackRef = useRef<{ doc: Y.Doc; awareness: Awareness } | null>(null)
  if (fallbackRef.current === null) {
    const doc = new Y.Doc()
    fallbackRef.current = { doc, awareness: new Awareness(doc) }
  }

  const [active, setActive] = useState<ActiveCollab | null>(null)
  const [status, setStatus] = useState<CollabStatus>('offline')
  const [synced, setSynced] = useState(false)

  const initialRef = useRef(initialContent)
  initialRef.current = initialContent
  const userRef = useRef(options.user)
  userRef.current = options.user
  const { baseUrl, pollTimeout, clientId } = options

  // Local-only mode: seed the fallback Y.Text (used by read-only/preview UIs).
  useEffect(() => {
    if (enabled && fileId) return
    const text = fallbackRef.current!.doc.getText('content')
    if (text.length === 0 && initialContent) {
      text.insert(0, initialContent)
    }
  }, [enabled, fileId, initialContent])

  useEffect(() => {
    if (!enabled || !fileId) {
      setActive(null)
      setStatus('offline')
      setSynced(false)
      return
    }

    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    const provider = new HttpYjsProvider({
      docId: fileId,
      doc,
      awareness,
      user: userRef.current,
      baseUrl,
      pollTimeout,
      clientId,
    })

    setStatus(provider.status)
    setSynced(false)
    setActive({ doc, awareness, provider })

    const unsubscribeStatus = provider.onStatus((next) => setStatus(next))
    const unsubscribeSync = provider.onSync(() => {
      setSynced(true)
      // The server had no CRDT state (fresh/empty document): fall back to the
      // Phase 1 plain text once. This insertion is pushed back to the server.
      if (!provider.hasServerState && initialRef.current) {
        const text = doc.getText('content')
        if (text.length === 0) text.insert(0, initialRef.current)
      }
    })

    provider.connect()

    return () => {
      unsubscribeStatus()
      unsubscribeSync()
      provider.destroy()
      awareness.destroy()
      doc.destroy()
      setActive((current) => (current?.provider === provider ? null : current))
    }
    // The provider is recreated when the file changes (or explicit transport
    // parameters change); initialContent/user are intentionally read via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, enabled, baseUrl, pollTimeout, clientId])

  if (active) {
    return {
      ydoc: active.doc,
      awareness: active.awareness,
      text: active.doc.getText('content'),
      provider: active.provider,
      status,
      synced,
    }
  }

  const fallback = fallbackRef.current!
  return {
    ydoc: fallback.doc,
    awareness: fallback.awareness,
    text: fallback.doc.getText('content'),
    provider: null,
    status: 'offline',
    synced: false,
  }
}

export default useCollabDoc
