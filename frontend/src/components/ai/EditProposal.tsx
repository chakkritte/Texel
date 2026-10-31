import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import type { JumpToErrorInput, ProposeEditInput, ToolCall } from '../../lib/ai'
import type { JumpTarget } from './types'

type Props = {
  call: ToolCall
  onApplied?: (fileId: string) => void | Promise<void>
  onJumpToError?: (target: JumpTarget) => void
}

type Status = 'loading' | 'ready' | 'applying' | 'applied' | 'rejected' | 'error'

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function parsePropose(input: Record<string, unknown>): ProposeEditInput | null {
  const fileId = asString(input.file_id)
  const replacement = asString(input.replacement)
  const rawRange = input.range
  if (!fileId || replacement === null || !rawRange || typeof rawRange !== 'object') {
    return null
  }
  const range = rawRange as Record<string, unknown>
  const from = asInteger(range.from)
  const to = asInteger(range.to)
  if (from === null || to === null || from < 0 || to < from) return null
  return {
    file_id: fileId,
    range: { from, to },
    replacement,
    rationale: asString(input.rationale) ?? undefined,
  }
}

function parseJump(input: Record<string, unknown>): JumpToErrorInput | null {
  const file = asString(input.file)
  const line = asInteger(input.line)
  if (!file || line === null || line < 1) return null
  const jobId = asString(input.job_id)
  return {
    file,
    line,
    message: asString(input.message) ?? undefined,
    job_id: jobId ?? undefined,
  }
}

function preview(text: string): string {
  return text.length > 1400 ? `${text.slice(0, 1400)}\n…` : text
}

export default function EditProposal({ call, onApplied, onJumpToError }: Props) {
  const jump = call.name === 'jump_to_error' ? parseJump(call.input) : null
  const proposal = call.name === 'propose_edit' ? parsePropose(call.input) : null

  const [original, setOriginal] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [problem, setProblem] = useState('')

  const fileId = proposal?.file_id
  const from = proposal?.range.from
  const to = proposal?.range.to

  useEffect(() => {
    if (!fileId || from === undefined || to === undefined) return
    let alive = true
    setOriginal(null)
    setProblem('')
    setStatus('loading')
    api<{ content: string; seq: number }>(`/files/${fileId}/content`)
      .then((data) => {
        if (!alive) return
        setOriginal(data.content)
        setStatus('ready')
      })
      .catch((err) => {
        if (!alive) return
        setProblem(err instanceof Error ? err.message : 'Could not load the file')
        setStatus('error')
      })
    return () => {
      alive = false
    }
  }, [fileId, from, to])

  const rangeValid = useMemo(() => {
    if (original === null || !proposal) return false
    return (
      proposal.range.from >= 0 &&
      proposal.range.to >= proposal.range.from &&
      proposal.range.to <= original.length
    )
  }, [original, proposal])

  if (jump) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate font-mono">
            {jump.file}:{jump.line}
          </span>
          <button
            type="button"
            onClick={() =>
              onJumpToError?.({
                file: jump.file,
                line: jump.line,
                message: jump.message,
              })
            }
            disabled={!onJumpToError}
            className="shrink-0 rounded border border-amber-300 bg-white px-2 py-0.5 font-medium disabled:opacity-40"
          >
            Jump to error
          </button>
        </div>
        {jump.message && <div className="mt-1 whitespace-pre-wrap">{jump.message}</div>}
        {!onJumpToError && (
          <div className="mt-1 text-[10px] text-amber-700">
            Editor has not wired onJumpToError yet.
          </div>
        )}
      </div>
    )
  }

  if (!proposal) return null

  const removed = rangeValid && original !== null
    ? original.slice(proposal.range.from, proposal.range.to)
    : ''
  const disabled = status !== 'ready' || !rangeValid

  async function apply() {
    if (!proposal || original === null) return
    if (!rangeValid) {
      setProblem('The proposed range is outside the current file. Save/reload and try again.')
      return
    }
    setStatus('applying')
    setProblem('')
    try {
      const next =
        original.slice(0, proposal.range.from) +
        proposal.replacement +
        original.slice(proposal.range.to)
      await api(`/files/${proposal.file_id}/content`, {
        method: 'PUT',
        body: JSON.stringify({ content: next }),
      })
      setStatus('applied')
      try {
        await onApplied?.(proposal.file_id)
      } catch {
        /* the edit is already saved; a refresh failure must not mark it failed */
      }
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Could not apply the edit')
      setStatus('error')
    }
  }

  return (
    <div className="rounded-md border border-emerald-200 bg-white p-2 text-xs text-zinc-700 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-emerald-800">Proposed edit</span>
        <span className="font-mono text-[10px] text-zinc-400">
          {proposal.file_id.slice(0, 8)} · {proposal.range.from}-{proposal.range.to}
        </span>
      </div>

      {proposal.rationale && (
        <div className="mt-1 text-zinc-600">{proposal.rationale}</div>
      )}

      {status === 'loading' && <div className="mt-2 text-zinc-400">Loading file…</div>}

      {(status === 'ready' || status === 'applying') && rangeValid && (
        <div className="mt-2 space-y-1">
          <div>
            <div className="text-[10px] font-semibold uppercase text-red-500">Remove</div>
            <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-red-50 p-1.5 text-[11px] text-red-800">
              {removed ? preview(removed) : '(empty)'}
            </pre>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase text-emerald-600">Insert</div>
            <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-emerald-50 p-1.5 text-[11px] text-emerald-800">
              {proposal.replacement ? preview(proposal.replacement) : '(empty)'}
            </pre>
          </div>
        </div>
      )}

      {(status === 'ready' || status === 'applying') && !rangeValid && (
        <div className="mt-2 text-[11px] text-red-600">
          The proposed range does not fit the current file.
        </div>
      )}

      {problem && <div className="mt-2 text-[11px] text-red-600">{problem}</div>}

      {status === 'applied' && (
        <div className="mt-2 text-[11px] font-medium text-emerald-700">Applied.</div>
      )}
      {status === 'rejected' && (
        <div className="mt-2 text-[11px] text-zinc-500">Rejected.</div>
      )}

      {status !== 'applied' && status !== 'rejected' && (
        <div className="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void apply()}
            disabled={disabled}
            className="rounded bg-emerald-600 px-2 py-1 font-medium text-white disabled:opacity-40"
          >
            {status === 'applying' ? 'Applying…' : 'Apply'}
          </button>
          <button
            type="button"
            onClick={() => setStatus('rejected')}
            disabled={status === 'applying'}
            className="rounded border px-2 py-1 disabled:opacity-40"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  )
}
