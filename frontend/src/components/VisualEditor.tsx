import { createElement, useEffect, useMemo, useRef } from 'react'
import type { ClipboardEvent, FocusEvent, KeyboardEvent, ReactNode } from 'react'
import { unified } from 'unified'
import { unifiedLatexFromString } from '@unified-latex/unified-latex-util-parse'
import { getArgsContent } from '@unified-latex/unified-latex-util-arguments'
import {
  escapedTextOf,
  isEscapedTextNode,
  latexToHtml,
  nodeText,
  renderMathIn,
} from '../lib/latexVisual'

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

type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'format'; command: string; children: InlineNode[] }

const INLINE_FORMATS: Record<string, { tag: string }> = {
  textbf: { tag: 'strong' },
  textit: { tag: 'em' },
  emph: { tag: 'em' },
  underline: { tag: 'u' },
  texttt: { tag: 'code' },
  textsc: { tag: 'span' },
}

type Block =
  | { kind: 'heading'; level: 2 | 3 | 4; text: string; from: number; to: number }
  | { kind: 'formatted'; model: InlineNode[]; from: number; to: number }
  | { kind: 'list'; ordered: boolean; items: InlineNode[][]; from: number; to: number }
  | { kind: 'readonly'; raw: string; from: number; to: number; line: number }

function pushText(target: InlineNode[], text: string): void {
  if (!text) return
  const last = target[target.length - 1]
  if (last?.type === 'text') last.text += text
  else target.push({ type: 'text', text })
}

function buildInline(nodes: any[]): InlineNode[] | null {
  const out: InlineNode[] = []
  for (const node of nodes) {
    if (node?.type === 'string') {
      pushText(out, node.content ?? '')
      continue
    }
    if (node?.type === 'whitespace') {
      pushText(out, node.content ?? ' ')
      continue
    }
    const escaped = escapedTextOf(node)
    if (escaped !== null) {
      pushText(out, escaped)
      continue
    }
    if (node?.type === 'macro' && INLINE_FORMATS[node.content]) {
      const args = getArgsContent(node)[0]
      if (!Array.isArray(args) || args.length === 0) return null
      const children = buildInline(args)
      if (!children) return null
      out.push({ type: 'format', command: node.content, children })
      continue
    }
    return null
  }
  return out
}

function modelToLatex(nodes: InlineNode[]): string {
  return nodes
    .map((node) =>
      node.type === 'text'
        ? escapeLatex(node.text)
        : `\\${node.command}{${modelToLatex(node.children)}}`,
    )
    .join('')
}

function renderInline(nodes: InlineNode[], prefix = ''): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === 'text') return node.text
    const format = INLINE_FORMATS[node.command] ?? { tag: 'span' }
    return createElement(
      format.tag,
      {
        key: `${prefix}${index}`,
        'data-cmd': node.command,
        style: node.command === 'textsc' ? { fontVariant: 'small-caps' } : undefined,
      },
      ...renderInline(node.children, `${prefix}${index}-`),
    )
  })
}

function serializeChildren(element: HTMLElement): string {
  let out = ''
  element.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out += escapeLatex((child.textContent ?? '').replace(/ /g, ' '))
      return
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return
    const el = child as HTMLElement
    const tag = el.tagName
    const inner = serializeChildren(el)
    if (tag === 'BR') {
      out += '\n'
    } else if (tag === 'B' || tag === 'STRONG') {
      out += `\\textbf{${inner}}`
    } else if (tag === 'I' || tag === 'EM') {
      out += `\\${el.dataset.cmd || 'textit'}{${inner}}`
    } else if (tag === 'U') {
      out += `\\underline{${inner}}`
    } else if (tag === 'CODE') {
      out += `\\texttt{${inner}}`
    } else if (tag === 'SUP') {
      out += `\\textsuperscript{${inner}}`
    } else if (tag === 'SUB') {
      out += `\\textsubscript{${inner}}`
    } else if (tag === 'SPAN' && el.dataset.cmd === 'textsc') {
      out += `\\textsc{${inner}}`
    } else {
      out += inner
    }
  })
  return out
}

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

function parseListItems(node: any): InlineNode[][] | null {
  const items: any[][] = []
  for (const child of node.content ?? []) {
    if (child?.type !== 'macro' || child.content !== 'item') continue
    const args = Array.isArray(child.args) ? child.args : []
    const contentArg = args[args.length - 1]
    const rawContent = Array.isArray(contentArg?.content) ? contentArg.content : []
    // Only support plain \item (no optional \item[label]).
    const hasLabel = args
      .slice(0, -1)
      .some((arg: any) => Array.isArray(arg.content) && arg.content.length > 0)
    if (hasLabel) return null
    const first = rawContent.findIndex((part: any) => part?.type !== 'whitespace')
    if (first === -1) {
      items.push([])
      continue
    }
    let last = rawContent.length - 1
    while (last > first && rawContent[last]?.type === 'whitespace') last -= 1
    items.push(rawContent.slice(first, last + 1))
  }
  if (items.length === 0) return null
  const models = items.map((item) => buildInline(item))
  if (models.some((model) => model === null)) return null
  return models as InlineNode[][]
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
    const model = buildInline(buffer)
    if (model) {
      blocks.push({
        kind: 'formatted',
        model,
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

    if (
      node.type === 'environment' &&
      (node.env === 'itemize' || node.env === 'enumerate')
    ) {
      flush()
      const from = node.position?.start?.offset ?? 0
      const to = node.position?.end?.offset ?? from
      const items = parseListItems(node)
      if (items) {
        blocks.push({
          kind: 'list',
          ordered: node.env === 'enumerate',
          items,
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

function EditableFormattedParagraph({
  model,
  from,
  to,
  onEdit,
}: {
  model: InlineNode[]
  from: number
  to: number
  onEdit: (from: number, to: number, text: string) => void
}) {
  const initial = useMemo(() => modelToLatex(model), [model])
  function blur(event: FocusEvent<HTMLElement>) {
    const next = serializeChildren(event.currentTarget)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+$/, '')
    if (next !== initial) onEdit(from, to, next)
  }
  function keyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter') event.preventDefault()
  }
  return (
    <p
      contentEditable
      suppressContentEditableWarning
      onBlur={blur}
      onKeyDown={keyDown}
      onPaste={plainPaste}
      spellCheck
      title="Editable paragraph — select text to use B/I/U"
      className="visual-editable whitespace-pre-wrap"
    >
      {renderInline(model)}
    </p>
  )
}

function EditableList({
  ordered,
  items,
  from,
  to,
  onEdit,
}: {
  ordered: boolean
  items: InlineNode[][]
  from: number
  to: number
  onEdit: (from: number, to: number, text: string) => void
}) {
  const initial = useMemo(() => items.map((item) => modelToLatex(item)), [items])
  function blurItem(index: number, event: FocusEvent<HTMLElement>) {
    const next = serializeChildren(event.currentTarget)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+$/, '')
    if (next === initial[index]) return
    const updated = [...initial]
    updated[index] = next
    const environment = ordered ? 'enumerate' : 'itemize'
    const text = `\\begin{${environment}}\n${updated
      .map((item) => `\\item ${item.trim()}`)
      .join('\n')}\n\\end{${environment}}`
    onEdit(from, to, text)
  }
  function keyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter') event.preventDefault()
  }
  const ListTag = ordered ? 'ol' : 'ul'
  return (
    <ListTag className={ordered ? 'list-decimal' : 'list-disc'}>
      {items.map((model, index) => (
        <li
          key={`${from}-${index}`}
          contentEditable
          suppressContentEditableWarning
          onBlur={(event) => blurItem(index, event)}
          onKeyDown={keyDown}
          onPaste={plainPaste}
          spellCheck
          title="Editable list item — select text to use B/I/U"
          className="visual-editable whitespace-pre-wrap"
        >
          {renderInline(model, `item-${index}-`)}
        </li>
      ))}
    </ListTag>
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

function applyFormat(command: 'bold' | 'italic' | 'underline'): void {
  try {
    document.execCommand(command)
  } catch {
    /* unsupported browser command */
  }
}

function applyCode(): void {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return
  const text = selection.toString()
  try {
    document.execCommand('insertHTML', false, `<code>${escapeHtml(text)}</code>`)
  } catch {
    /* ignore */
  }
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
      <div className="sticky top-0 z-10 mx-auto mb-3 flex max-w-[860px] flex-wrap items-center gap-1 rounded-lg border border-zinc-200 bg-white/95 px-3 py-2 text-xs shadow-sm backdrop-blur">
        <span className="mr-1 text-zinc-500">Format</span>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => applyFormat('bold')}
          className="rounded-md border border-zinc-200 px-2 py-0.5 font-bold text-zinc-700 hover:bg-zinc-100"
          title="Bold (Ctrl/Cmd+B)"
        >
          B
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => applyFormat('italic')}
          className="rounded-md border border-zinc-200 px-2 py-0.5 italic text-zinc-700 hover:bg-zinc-100"
          title="Italic (Ctrl/Cmd+I)"
        >
          I
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => applyFormat('underline')}
          className="rounded-md border border-zinc-200 px-2 py-0.5 underline text-zinc-700 hover:bg-zinc-100"
          title="Underline (Ctrl/Cmd+U)"
        >
          U
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={applyCode}
          className="rounded-md border border-zinc-200 px-2 py-0.5 font-[var(--font-mono)] text-[11px] text-zinc-700 hover:bg-zinc-100"
          title="Monospace / \texttt"
        >
          {'</>'}
        </button>
        <span className="ml-2 text-[10px] text-zinc-400">
          Select text in a paragraph or list item
        </span>
      </div>
      <div className="mx-auto max-w-[860px] rounded-lg bg-white px-10 py-8 shadow-[var(--shadow-md)]">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 pb-2 text-[10px] text-zinc-400">
          <span className="truncate font-[var(--font-mono)]">{fileName || 'LaTeX document'}</span>
          <span className="shrink-0">
            Click text, list items or equations to edit · use B/I/U for formatting
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
            if (block.kind === 'formatted') {
              return (
                <EditableFormattedParagraph
                  key={key}
                  model={block.model}
                  from={block.from}
                  to={block.to}
                  onEdit={onEditBlock}
                />
              )
            }
            if (block.kind === 'list') {
              return (
                <EditableList
                  key={key}
                  ordered={block.ordered}
                  items={block.items}
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
