type Props = {
  file: string | null
  line: number | null
  column: number | null
  engine: string
  build: string
  collab: string
  pdfPage: number
  pdfTotal: number
}

export default function StatusBar({
  file,
  line,
  column,
  engine,
  build,
  collab,
  pdfPage,
  pdfTotal,
}: Props) {
  const live = collab === 'live'
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-t border-[var(--border)] bg-[var(--panel)] px-3 text-[11px] text-[var(--muted)]">
      <span className="flex shrink-0 items-center gap-1.5" title="Collaboration status">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            live ? 'bg-[var(--ok)]' : 'bg-[var(--muted-2)]'
          }`}
        />
        {live ? 'Live' : collab}
      </span>
      <span className="min-w-0 truncate">{file ?? 'No file open'}</span>
      {line !== null && (
        <span className="shrink-0 tabular-nums">
          Ln {line}, Col {column ?? 1}
        </span>
      )}
      <span className="flex-1" />
      <span className="hidden shrink-0 sm:inline">{engine}</span>
      <span className="hidden shrink-0 lg:inline">{build}</span>
      <span className="shrink-0 tabular-nums">
        PDF {pdfPage}/{pdfTotal || '–'}
      </span>
    </div>
  )
}
