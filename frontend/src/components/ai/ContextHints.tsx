import type { CompileErrorInfo, Selection } from '../../lib/ai'

type Props = {
  fileId: string | null
  selection: Selection | null
  compileError: CompileErrorInfo | null
}

export default function ContextHints({ fileId, selection, compileError }: Props) {
  const hasContext = Boolean(fileId || selection || compileError)
  if (!hasContext) {
    return (
      <div className="border-b px-3 py-1.5 text-[11px] text-zinc-400">
        No file context yet - open a file to give the assistant more to work with.
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1 border-b px-3 py-1.5 text-[11px]">
      {fileId && (
        <span
          title={fileId}
          className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-zinc-600"
        >
          file {fileId.slice(0, 8)}
        </span>
      )}
      {selection && (
        <span className="rounded bg-sky-50 px-1.5 py-0.5 text-sky-700">
          lines {selection.from + 1}-{Math.max(selection.from + 1, selection.to)}
        </span>
      )}
      {compileError && (
        <span
          title={compileError.message}
          className="max-w-full truncate rounded bg-red-50 px-1.5 py-0.5 text-red-700"
        >
          compile: {compileError.message.slice(0, 80)}
        </span>
      )}
    </div>
  )
}
