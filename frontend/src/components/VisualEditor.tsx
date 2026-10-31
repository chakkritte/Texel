import { useEffect, useMemo, useRef } from 'react'
import type { ClipboardEvent, FocusEvent, KeyboardEvent } from 'react'
import { unified } from 'unified'
import { unifiedLatexFromString } from '@unified-latex/unified-latex-util-parse'
import { isEscapedTextNode, latexToHtml, nodeText, renderMathIn } from '../lib/latexVisual'

const SECTION_LEVELS: Record<string, 2 | 3 | 4> = {
  section: 2,
  subsection: 3,
  subsubsection: 4,
}

const INLINE_MACROS = new Set([
  'textbf',
  'textit',
  'emph',
  'texttt',
  'underline',
  'cite',
  'ref',
  'label',
  'url',
  'footnote',
  'textsuperscript',
  'textsubscript',
  'uppercase',
  'authorrefmark',
  'IEEEmembership',
  'text',
  'textrm',
  'textsf',
  'textnormal',
  'mathrm',
  'mathbf',
  'mathit',
  'mathbb',
  'mbox',
])

type Block =
  | { kind: 'heading'; level: 2 | 3 | 4; text: string; from: number; to: number }
  | { kind: 'paragraph'; text: string; from: number; to: number }
  | { kind: 'readonly'; raw: string; from: number; to: number; line: number }

export type VisualMathNode = {
  from: number
  to: number
  inner: string
  open: string
  close: string
  display: boolean
}

function parseMathRaw(
  raw: string,
  displayHint: boolean,
): Omit<VisualMathNode, 'from' | 'to'> | null {
  if (!raw.trim()) return null
  if (raw.startsWith('$$') && raw.endsWith('$$') && raw.length >= 4) {
    return { inner: raw.slice(2, -2).trim(), open: '$$', close: '$$', display: true }
  }
  if (raw.startsWith('\\[') && raw.endsWith('\\]') && raw.length >= 4) {
    return { inner: raw.slice(2, -2).trim(), open: '\\[', close: '\\]', display: true }
  }
  if (raw.startsWith('\\(') && raw.endsWith('\\)') && raw.length >= 4) {
    return { inner: raw.slice(2, -2).trim(), open: '\\(', close: '\\)', display: false }
  }
  if (raw.startsWith('$') && raw.endsWith('$') && raw.length >= 2) {
    return { inner: raw.slice(1, -1).trim(), open: '$', close: '$', display: false }
  }
  const environment = raw.match(/^\\begin\{([^}]+)\}/)
  if (environment) {
    const close = `\\end{${environment[1]}}`
    if (raw.endsWith(close)) {
      const open = environment[0]
      return {
        inner: raw.slice(open.length, raw.length - close.length).trim(),
        open,
        close,
        display: true,
      }
    }
  }
  return { inner: raw.trim(), open: '', close: '', display: displayHint }
}

function collectMath(nodes: any[], source: string, out: VisualMathNode[]): void {
  for (const node of nodes) {
    if (
      node.type === 'inlinemath' ||
      node.type === 'displaymath' ||
      node.type === 'mathenv'
    ) {
      const from = node.position?.start?.offset
      const to = node.position?.end?.offset
      if (typeof from === 'number' && typeof to === 'number' && to > from) {
        const info = parseMathRaw(source.slice(from, to), node.type !== 'inlinemath')
        if (info) out.push({ from, to, ...info })
      }
      continue
    }
    if (Array.isArray(node.content)) collectMath(node.content, source, out)
    if (Array.isArray(node.args)) {
      for (const arg of node.args) {
        if (Array.isArray(arg.content)) collectMath(arg.content, source, out)
      }
    }
  }
}

function isPlainNode(node: any): boolean {
  return node?.type === 'string' || node?.type === 'whitespace' || isEscapedTextNode(node)
}

function isInlineNode(node: any): boolean {
  if (!node) return false
  if (
    node.type === 'string' ||
    node.type === 'whitespace' ||
    node.type === 'inlinemath' ||
    node.type === 'group' ||
    node.type === 'comment' ||
    isEscapedTextNode(node)
  ) {
    return true
  }
  return node.type === 'macro' && INLINE_MACROS.has(node.content)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function escapeLatex(text: string): string {
  const backslash = '\u0000BS\u0000'
  let out = text.replace(/\\/g, backslash)
  out = out.replace(/([{}%$&#_])/g, '\\$1')
  out = out.replace(/~/g, '\\textasciitilde{}')
  out = out.replace(/\^/g, '\\textasciicircum{}')
  return out.replace(/\u0000BS\u0000/g, '\\textbackslash{}')
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function lineAt(content: string, offset: number): number {
  return content.slice(0, Math.max(0, offset)).split('\n').length
}

function buildBlocks(content: string): {
  blocks: Block[]
  mathNodes: VisualMathNode[]
  error: string
} {
  let tree: any
  try {
    tree = (unified() as any).use(unifiedLatexFromString).parse(content)
  } catch (err) {
    return {
      blocks: [],
      mathNodes: [],
      error: err instanceof Error ? err.message : 'Could not parse this LaTeX file',
    }
  }
  const document = tree.content.find(
    (node: any) => node.type === 'environment' && node.env === 'document',
  )
  const body: any[] = document?.content ?? tree.content
  const blocks: Block[] = []
  const mathNodes: VisualMathNode[] = []
  collectMath(body, content, mathNodes)
  let buffer: any[] = []

  const blockEnd = (node: any): number => {
    let end = node.position?.end?.offset ?? 0
    if (Array.isArray(node.args)) {
      for (const arg of node.args) {
        const items = Array.isArray(arg.content) ? arg.content : []
        for (const item of items) {
          end = Math.max(end, item.position?.end?.offset ?? 0)
        }
      }
    }
    return end
  }

  const flush = () => {
    if (buffer.length === 0) return
    const first = buffer[0]
    const last = buffer[buffer.length - 1]
    const from = first.position?.start?.offset ?? 0
    const to = last.position?.end?.offset ?? from
    const plain = buffer.every(isPlainNode)
    if (plain) {
      blocks.push({
        kind: 'paragraph',
        text: nodeText(buffer),
        from,
        to,
      })
    } else {
      blocks.push({
        kind: 'readonly',
        raw: content.slice(from, to),
        from,
        to,
        line: lineAt(content, from),
      })
    }
    buffer = []
  }

  for (const node of body) {
    if (node.type === 'parbreak') {
      flush()
      continue
    }
    if (node.type === 'whitespace' && buffer.length === 0) continue

    if (node.type === 'macro' && SECTION_LEVELS[node.content]) {
      flush()
      // \section has named arguments (starred, tocdepth, tocTitle, title);
      // the visible title is the last argument.
      const argList = Array.isArray(node.args) ? node.args : []
      const titleArg = argList[argList.length - 1]
      const args = Array.isArray(titleArg?.content) ? titleArg.content : []
      const plain = args.length > 0 && args.every(isPlainNode)
      if (plain) {
        blocks.push({
          kind: 'heading',
          level: SECTION_LEVELS[node.content],
          text: nodeText(args),
          from: args[0].position?.start?.offset ?? 0,
          to: args[args.length - 1].position?.end?.offset ?? 0,
        })
      } else {
        const from = node.position?.start?.offset ?? 0
        const to = blockEnd(node)
        blocks.push({
          kind: 'readonly',
          raw: content.slice(from, to),
          from,
          to,
          line: lineAt(content, from),
        })
      }
      continue
    }

    if (isInlineNode(node)) {
      buffer.push(node)
      continue
    }

    flush()
    const from = node.position?.start?.offset ?? 0
    const to = node.position?.end?.offset ?? from
    blocks.push({
      kind: 'readonly',
      raw: content.slice(from, to),
      from,
      to,
      line: lineAt(content, from),
    })
  }
  flush()
  return { blocks, mathNodes, error: '' }
}

function plainPaste(event: ClipboardEvent<HTMLElement>) {
  event.preventDefault()
  const text = event.clipboardData.getData('text/plain')
  document.execCommand('insertText', false, text)
}

function EditableHeading({
  level,
  text,
  from,
  to,
  onEdit,
}: {
  level: 2 | 3 | 4
  text: string
  from: number
  to: number
  onEdit: (from: number, to: number, text: string) => void
}) {
  const Tag = (`h${level}` as 'h2' | 'h3' | 'h4')
  function blur(event: FocusEvent<HTMLElement>) {
    const next = (event.currentTarget.innerText || '').replace(/ /g, ' ').trim()
    if (normalizeText(next) !== normalizeText(text)) onEdit(from, to, escapeLatex(next))
  }
  function keyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter') event.preventDefault()
  }
  return (
    <Tag
      contentEditable
      suppressContentEditableWarning
      onBlur={blur}
      onKeyDown={keyDown}
      onPaste={plainPaste}
      spellCheck
      title="Editable heading"
      className="visual-editable visual-heading"
      dangerouslySetInnerHTML={{ __html: escapeHtml(text) }}
    />
  )
}

function EditableParagraph({
  text,
  from,
  to,
  onEdit,
}: {
  text: string
  from: number
  to: number
  onEdit: (from: number, to: number, text: string) => void
}) {
  function blur(event: FocusEvent<HTMLElement>) {
    const next = (event.currentTarget.innerText || '')
      .replace(/ /g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (normalizeText(next) !== normalizeText(text)) onEdit(from, to, escapeLatex(next))
  }
  return (
    <p
      contentEditable
      suppressContentEditableWarning
      onBlur={blur}
      onPaste={plainPaste}
      spellCheck
      title="Editable paragraph"
      className="visual-editable"
      dangerouslySetInnerHTML={{ __html: escapeHtml(text) }}
    />
  )
}

function ReadonlyBlock({
  raw,
  line,
  mathNodes,
  onEditSource,
  onEditMath,
}: {
  raw: string
  line: number
  mathNodes: VisualMathNode[]
  onEditSource: (line: number) => void
  onEditMath: (math: VisualMathNode) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editMathRef = useRef(onEditMath)
  editMathRef.current = onEditMath
  const { html, error } = useMemo(() => latexToHtml(raw), [raw])
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    renderMathIn(host)
    const elements = Array.from(
      host.querySelectorAll<HTMLElement>('.inline-math, .display-math'),
    )
    // Only map when the rendered order matches the AST order; otherwise a
    // click could target the wrong equation.
    if (elements.length !== mathNodes.length) return
    elements.forEach((element, index) => {
      element.dataset.mathIndex = String(index)
      element.classList.add('math-clickable')
      element.title = 'Click to edit equation'
    })
    const onClick = (event: MouseEvent) => {
      const target = (event.target as HTMLElement | null)?.closest(
        '[data-math-index]',
      ) as HTMLElement | null
      if (!target) return
      const index = Number(target.dataset.mathIndex)
      const math = mathNodes[index]
      if (!math) return
      event.preventDefault()
      event.stopPropagation()
      editMathRef.current(math)
    }
    host.addEventListener('click', onClick)
    return () => host.removeEventListener('click', onClick)
  }, [html, mathNodes])
  return (
    <div className="visual-readonly group/block relative">
      {error ? (
        <pre className="overflow-x-auto rounded-md bg-zinc-50 p-3 font-[var(--font-mono)] text-[12px] text-zinc-700">
          {raw}
        </pre>
      ) : (
        <div
          ref={hostRef}
          className="latex-visual"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      <button
        type="button"
        onClick={() => onEditSource(line)}
        className="absolute right-1 top-1 rounded-md border border-zinc-200 bg-white/90 px-2 py-0.5 text-[10px] text-zinc-500 opacity-0 transition-opacity hover:text-zinc-800 group-hover/block:opacity-100"
      >
        Edit in source
      </button>
    </div>
  )
}

export default function VisualEditor({
  content,
  fileName,
  onEditBlock,
  onEditSource,
  onEditMath,
}: {
  content: string
  fileName: string
  onEditBlock: (from: number, to: number, text: string) => void
  onEditSource: (line: number) => void
  onEditMath: (math: VisualMathNode) => void
}) {
  const { blocks, mathNodes, error } = useMemo(() => buildBlocks(content), [content])

  if (error) {
    return (
      <div className="h-full overflow-auto bg-[var(--panel-3)] px-6 py-6">
        <div className="mx-auto max-w-[860px] rounded-lg border border-[var(--warn)]/40 bg-[var(--warn-soft)] px-4 py-3 text-xs text-[var(--warn)]">
          Visual editor could not parse this file. Use the source editor instead.
          <div className="mt-1 font-[var(--font-mono)] text-[11px]">{error}</div>
        </div>
        <pre className="mx-auto mt-4 max-w-[860px] overflow-auto rounded-lg bg-white p-6 font-[var(--font-mono)] text-[12px] leading-relaxed text-zinc-800 shadow-sm">
          {content}
        </pre>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto bg-[var(--panel-3)] px-6 py-6">
      <div className="mx-auto max-w-[860px] rounded-lg bg-white px-10 py-8 shadow-[var(--shadow-md)]">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 pb-2 text-[10px] text-zinc-400">
          <span className="truncate font-[var(--font-mono)]">{fileName || 'LaTeX document'}</span>
          <span className="shrink-0">
            Click paragraphs and headings to edit · complex blocks are read-only
          </span>
        </div>
        <div className="latex-visual">
          {blocks.map((block, index) => {
            const key = `${block.kind}-${block.from}-${block.to}-${index}`
            if (block.kind === 'heading') {
              return (
                <EditableHeading
                  key={key}
                  level={block.level}
                  text={block.text}
                  from={block.from}
                  to={block.to}
                  onEdit={onEditBlock}
                />
              )
            }
            if (block.kind === 'paragraph') {
              return (
                <EditableParagraph
                  key={key}
                  text={block.text}
                  from={block.from}
                  to={block.to}
                  onEdit={onEditBlock}
                />
              )
            }
            return (
              <div key={key} className="my-3">
                <ReadonlyBlock
                  raw={block.raw}
                  line={block.line}
                  mathNodes={mathNodes.filter(
                    (math) => math.from >= block.from && math.to <= block.to,
                  )}
                  onEditSource={onEditSource}
                  onEditMath={onEditMath}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
