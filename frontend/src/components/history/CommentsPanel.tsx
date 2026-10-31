import { useCallback, useEffect, useState } from 'react'
import {
  createComment,
  deleteComment,
  listComments,
  resolveComment,
  type CommentT,
} from '../../lib/history'

type CommentsPanelProps = {
  projectId: string
  fileId: string | null
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

export default function CommentsPanel({ projectId, fileId }: CommentsPanelProps) {
  const [comments, setComments] = useState<CommentT[]>([])
  const [body, setBody] = useState('')
  const [showResolved, setShowResolved] = useState(true)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!fileId) {
      setComments([])
      return
    }
    setLoading(true)
    setError('')
    try {
      setComments(await listComments(projectId, fileId, showResolved))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load comments')
    } finally {
      setLoading(false)
    }
  }, [projectId, fileId, showResolved])

  useEffect(() => {
    void load()
  }, [load])

  async function post() {
    if (!fileId || !body.trim()) return
    setBusy('post')
    setError('')
    try {
      await createComment(projectId, { file_id: fileId, body: body.trim() })
      setBody('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post comment')
    } finally {
      setBusy(null)
    }
  }

  async function resolve(comment: CommentT) {
    setBusy(comment.id)
    setError('')
    try {
      await resolveComment(comment.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resolve comment')
    } finally {
      setBusy(null)
    }
  }

  async function remove(comment: CommentT) {
    if (!window.confirm('Delete this comment?')) return
    setBusy(comment.id)
    setError('')
    try {
      await deleteComment(comment.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete comment')
    } finally {
      setBusy(null)
    }
  }

  if (!fileId) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-zinc-500">
        Select a file to see its comments.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase text-zinc-500">Comments</span>
          <label className="flex items-center gap-1 text-xs text-zinc-500">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
            />
            resolved
          </label>
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          placeholder="Leave a comment on this file…"
          className="mt-2 w-full resize-none rounded border border-zinc-300 bg-white px-2 py-1 text-xs"
        />
        <div className="mt-1 flex justify-end">
          <button
            onClick={() => void post()}
            disabled={!body.trim() || busy !== null}
            className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {busy === 'post' ? 'Posting…' : 'Comment'}
          </button>
        </div>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && comments.length === 0 ? (
          <p className="p-3 text-xs text-zinc-500">Loading comments…</p>
        ) : comments.length === 0 ? (
          <p className="p-3 text-xs text-zinc-500">No comments on this file yet.</p>
        ) : (
          <ul className="divide-y">
            {comments.map((comment) => (
              <li
                key={comment.id}
                className={`px-3 py-2 ${comment.resolved_at ? 'opacity-60' : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium">
                    {comment.author_name || 'Unknown author'}
                  </span>
                  <span className="shrink-0 text-[11px] text-zinc-400">
                    {formatTime(comment.created_at)}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-xs text-zinc-700">
                  {comment.body}
                </p>
                {comment.anchor?.snippet && (
                  <p className="mt-1 border-l-2 border-zinc-300 pl-2 text-[11px] italic text-zinc-500">
                    {comment.anchor.snippet}
                  </p>
                )}
                <div className="mt-1 flex items-center gap-2">
                  {comment.resolved_at ? (
                    <span className="text-[11px] text-emerald-700">Resolved</span>
                  ) : (
                    <button
                      onClick={() => void resolve(comment)}
                      disabled={busy !== null}
                      className="text-[11px] text-emerald-700 hover:underline disabled:opacity-40"
                    >
                      Resolve
                    </button>
                  )}
                  <button
                    onClick={() => void remove(comment)}
                    disabled={busy !== null}
                    className="text-[11px] text-red-600 hover:underline disabled:opacity-40"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
