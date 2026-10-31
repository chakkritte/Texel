import { createElement, useEffect, useMemo, useRef, useState } from 'react'
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
import { formatBibEntry, type BibEntry } from '../lib/bibtex'
import type { Awareness } from 'y-protocols/awareness'

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

type TableData = {
  rows: InlineNode[][][]
  prefix: string
  suffix: string
  spec: string
  envFrom: number
  envTo: number
  expected: string
}

type Block =
  | { kind: 'heading'; level: 2 | 3 | 4; text: string; from: number; to: number }
  | { kind: 'formatted'; model: InlineNode[]; from: number; to: number }
  | { kind: 'list'; ordered: boolean; items: InlineNode[][]; from: number; to: number }
  | {
      kind: 'table'
      caption: string | null
      labels: VisualRefNode[]
      table: TableData
      from: number
      to: number
    }
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
  raw: string
  inner: string
  open: string
  close: string
  display: boolean
}

export type VisualRefNode = {
  kind: 'cite' | 'ref' | 'label'
  from: number
  to: number
  value: string
  raw: string
}

const REF_MACROS: Record<string, VisualRefNode['kind']> = {
  cite: 'cite',
  citep: 'cite',
  citet: 'cite',
  ref: 'ref',
  eqref: 'ref',
  autoref: 'ref',
  pageref: 'ref',
  label: 'label',
}

function parseMathRaw(
  raw: string,
  displayHint: boolean,
): Omit<VisualMathNode, 'from' | 'to' | 'raw'> | null {
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
        const raw = source.slice(from, to)
        const info = parseMathRaw(raw, node.type !== 'inlinemath')
        if (info) out.push({ from, to, raw, ...info })
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

function collectRefs(nodes: any[], source: string, out: VisualRefNode[]): void {
  for (const node of nodes) {
    if (node?.type === 'macro' && REF_MACROS[node.content]) {
      const args = Array.isArray(node.args) ? node.args : []
      const keyArg = args[args.length - 1]
      const content = Array.isArray(keyArg?.content) ? keyArg.content : []
      if (content.length > 0) {
        const from = content[0].position?.start?.offset
        const to = content[content.length - 1].position?.end?.offset
        if (typeof from === 'number' && typeof to === 'number' && to > from) {
          out.push({
            kind: REF_MACROS[node.content],
            from,
            to,
            value: nodeText(content).trim(),
            raw: source.slice(from, to),
          })
        }
      }
      continue
    }
    if (Array.isArray(node.content)) collectRefs(node.content, source, out)
    if (Array.isArray(node.args)) {
      for (const arg of node.args) {
        if (Array.isArray(arg.content)) collectRefs(arg.content, source, out)
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

function trimWhitespaceNodes(nodes: any[]): any[] {
  let first = 0
  let last = nodes.length - 1
  while (first <= last && nodes[first]?.type === 'whitespace') first += 1
  while (last >= first && nodes[last]?.type === 'whitespace') last -= 1
  return nodes.slice(first, last + 1)
}

function findTabularNode(nodes: any[]): any | null {
  for (const node of nodes) {
    if (
      node?.type === 'environment' &&
      (node.env === 'tabular' || node.env === 'tabularx' || node.env === 'longtable')
    ) {
      return node
    }
    if (Array.isArray(node?.content)) {
      const found = findTabularNode(node.content)
      if (found) return found
    }
    if (Array.isArray(node?.args)) {
      for (const arg of node.args) {
        if (Array.isArray(arg.content)) {
          const found = findTabularNode(arg.content)
          if (found) return found
        }
      }
    }
  }
  return null
}

function parseTabular(node: any, source: string): TableData | null {
  const envFrom = node?.position?.start?.offset
  const envTo = node?.position?.end?.offset
  const contentNodes = Array.isArray(node?.content) ? node.content : []
  if (
    typeof envFrom !== 'number' ||
    typeof envTo !== 'number' ||
    contentNodes.length === 0
  ) {
    return null
  }
  const rows: InlineNode[][][] = []
  let row: InlineNode[][] = []
  let cells: any[] = []

  const finishCell = (): boolean => {
    const model = buildInline(trimWhitespaceNodes(cells))
    if (!model) return false
    row.push(model)
    cells = []
    return true
  }
  const finishRow = (): boolean => {
    if (!finishCell()) return false
    rows.push(row)
    row = []
    return true
  }

  for (const child of contentNodes) {
    if (child?.type === 'string' && child.content === '&') {
      if (!finishCell()) return null
      continue
    }
    if (child?.type === 'macro' && child.content === '\\') {
      if (!finishRow()) return null
      continue
    }
    if (
      child?.type === 'macro' &&
      ['hline', 'cline', 'toprule', 'midrule', 'bottomrule'].includes(child.content)
    ) {
      return null
    }
    cells.push(child)
  }
  if (!finishRow()) return null
  // A trailing row break creates an empty final row.
  if (
    rows.length > 0 &&
    rows[rows.length - 1].length === 1 &&
    rows[rows.length - 1][0].length === 0
  ) {
    rows.pop()
  }
  if (rows.length === 0) return null

  const first = contentNodes[0]?.position?.start?.offset
  const last = contentNodes[contentNodes.length - 1]?.position?.end?.offset
  if (typeof first !== 'number' || typeof last !== 'number') return null
  const args = Array.isArray(node.args) ? node.args : []
  const specArg = args[args.length - 1]
  const spec = Array.isArray(specArg?.content) ? nodeText(specArg.content).trim() : ''
  return {
    rows,
    prefix: source.slice(envFrom, first),
    suffix: source.slice(last, envTo),
    spec,
    envFrom,
    envTo,
    expected: source.slice(envFrom, envTo),
  }
}

function tableFloatBlock(
  node: any,
  source: string,
  refNodes: VisualRefNode[],
): Block | null {
  const from = node?.position?.start?.offset
  const to = node?.position?.end?.offset
  if (typeof from !== 'number' || typeof to !== 'number') return null
  const tabular = findTabularNode(Array.isArray(node.content) ? node.content : [])
  if (!tabular) return null
  const table = parseTabular(tabular, source)
  if (!table) return null
  const captionNode = (node.content ?? []).find(
    (child: any) => child?.type === 'macro' && child.content === 'caption',
  )
  let caption: string | null = null
  if (captionNode) {
    const args = Array.isArray(captionNode.args) ? captionNode.args : []
    const content = args[args.length - 1]?.content
    if (Array.isArray(content)) caption = nodeText(content).trim() || null
  }
  const labels = refNodes.filter(
    (ref) => ref.kind === 'label' && ref.from >= from && ref.to <= to,
  )
  return { kind: 'table', caption, labels, table, from, to }
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
  refNodes: VisualRefNode[]
  error: string
} {
  let tree: any
  try {
    tree = (unified() as any).use(unifiedLatexFromString).parse(content)
  } catch (err) {
    return {
      blocks: [],
      mathNodes: [],
      refNodes: [],
      error: err instanceof Error ? err.message : 'Could not parse this LaTeX file',
    }
  }
  const document = tree.content.find(
    (node: any) => node.type === 'environment' && node.env === 'document',
  )
  const body: any[] = document?.content ?? tree.content
  const blocks: Block[] = []
  const mathNodes: VisualMathNode[] = []
  const refNodes: VisualRefNode[] = []
  collectMath(body, content, mathNodes)
  collectRefs(body, content, refNodes)
  let buffer: any[] = []

  const blockEnd = (node: any): number => {
    let end = node.position?.end?.offset ?? 0
    if (Array.isArray(node.args)) {
      for (const arg of node.args) {
        const items = Array.isArray(arg.content) ? arg.content : []
        const closeMark = typeof arg.closeMark === 'string' ? arg.closeMark.length : 0
        for (const item of items) {
          end = Math.max(end, (item.position?.end?.offset ?? 0) + closeMark)
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
    const to = Math.max(last.position?.end?.offset ?? from, blockEnd(last))
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
      (node.env === 'table' || node.env === 'table*')
    ) {
      flush()
      const block = tableFloatBlock(node, content, refNodes)
      if (block) {
        blocks.push(block)
      } else {
        const from = node.position?.start?.offset ?? 0
        const to = Math.max(node.position?.end?.offset ?? from, blockEnd(node))
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
      (node.env === 'tabular' || node.env === 'tabularx' || node.env === 'longtable')
    ) {
      flush()
      const table = parseTabular(node, content)
      const from = node.position?.start?.offset ?? 0
      const to = node.position?.end?.offset ?? from
      if (table) {
        blocks.push({
          kind: 'table',
          caption: null,
          labels: [],
          table,
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
    // Macro positions cover only the command name; include its arguments
    // (e.g. \includegraphics[...]{file}) in the raw block.
    const to = Math.max(node.position?.end?.offset ?? from, blockEnd(node))
    blocks.push({
      kind: 'readonly',
      raw: content.slice(from, to),
      from,
      to,
      line: lineAt(content, from),
    })
  }
  flush()
  return { blocks, mathNodes, refNodes, error: '' }
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
  expected,
  onEdit,
}: {
  level: 2 | 3 | 4
  text: string
  from: number
  to: number
  expected: string
  onEdit: (from: number, to: number, text: string, expected?: string) => void
}) {
  const Tag = (`h${level}` as 'h2' | 'h3' | 'h4')
  function blur(event: FocusEvent<HTMLElement>) {
    const next = (event.currentTarget.innerText || '').replace(/ /g, ' ').trim()
    if (normalizeText(next) !== normalizeText(text))
      onEdit(from, to, escapeLatex(next), expected)
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
  expected,
  onEdit,
}: {
  model: InlineNode[]
  from: number
  to: number
  expected: string
  onEdit: (from: number, to: number, text: string, expected?: string) => void
}) {
  const initial = useMemo(() => modelToLatex(model), [model])
  function blur(event: FocusEvent<HTMLElement>) {
    const next = serializeChildren(event.currentTarget)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+$/, '')
    if (next !== initial) onEdit(from, to, next, expected)
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
  expected,
  onEdit,
}: {
  ordered: boolean
  items: InlineNode[][]
  from: number
  to: number
  expected: string
  onEdit: (from: number, to: number, text: string, expected?: string) => void
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
    onEdit(from, to, text, expected)
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

function EditableTable({
  caption,
  labels,
  table,
  onEdit,
  onEditRef,
}: {
  caption: string | null
  labels: VisualRefNode[]
  table: TableData
  onEdit: (from: number, to: number, text: string, expected?: string) => void
  onEditRef: (ref: VisualRefNode) => void
}) {
  const initial = useMemo(
    () => table.rows.map((row) => row.map((cell) => modelToLatex(cell))),
    [table],
  )
  const aligns = useMemo(
    () =>
      table.spec
        .replace(/\|/g, '')
        .replace(/@\{[^}]*\}/g, '')
        .replace(/[pmb]\{[^}]*\}/g, 'l')
        .split('')
        .filter((char) => 'lcrX'.includes(char))
        .map((char) =>
          char === 'c' ? 'center' : char === 'r' ? 'right' : 'left',
        ),
    [table.spec],
  )

  function blurCell(rowIndex: number, cellIndex: number, event: FocusEvent<HTMLElement>) {
    const next = serializeChildren(event.currentTarget)
      .replace(/ /g, ' ')
      .replace(/[ \t]+$/, '')
    if (next === initial[rowIndex][cellIndex]) return
    const updated = initial.map((row) => [...row])
    updated[rowIndex][cellIndex] = next
    const body = updated
      .map((row) => `${row.join(' & ')} \\\\`)
      .join('\n')
    onEdit(table.envFrom, table.envTo, `${table.prefix}\n${body}\n${table.suffix}`, table.expected)
  }

  function keyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter') event.preventDefault()
  }

  return (
    <div className="my-3">
      {caption && <div className="table-caption">{caption}</div>}
      {labels.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {labels.map((label) => (
            <button
              key={`${label.from}-${label.to}`}
              type="button"
              onClick={() => onEditRef(label)}
              className="macro-label ref-chip"
            >
              {label.value}
            </button>
          ))}
        </div>
      )}
      <table className="editable-tabular">
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  contentEditable
                  suppressContentEditableWarning
                  onBlur={(event) => blurCell(rowIndex, cellIndex, event)}
                  onKeyDown={keyDown}
                  onPaste={plainPaste}
                  spellCheck
                  title="Editable table cell"
                  className="visual-editable whitespace-pre-wrap"
                  style={{ textAlign: aligns[cellIndex] ?? 'left' }}
                >
                  {renderInline(cell, `cell-${rowIndex}-${cellIndex}-`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ReadonlyBlock({
  raw,
  line,
  mathNodes,
  refNodes,
  bibEntries = [],
  resolveAsset,
  onEditSource,
  onEditMath,
  onEditRef,
}: {
  raw: string
  line: number
  mathNodes: VisualMathNode[]
  refNodes: VisualRefNode[]
  bibEntries?: BibEntry[]
  resolveAsset?: (path: string) => Promise<string | null>
  onEditSource: (line: number) => void
  onEditMath: (math: VisualMathNode) => void
  onEditRef: (ref: VisualRefNode) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editMathRef = useRef(onEditMath)
  editMathRef.current = onEditMath
  const editRefRef = useRef(onEditRef)
  editRefRef.current = onEditRef
  const resolveAssetRef = useRef(resolveAsset)
  resolveAssetRef.current = resolveAsset
  const bibEntriesRef = useRef(bibEntries)
  bibEntriesRef.current = bibEntries
  const { html, error } = useMemo(() => latexToHtml(raw), [raw])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    renderMathIn(host)
    const mathElements = Array.from(
      host.querySelectorAll<HTMLElement>('.inline-math, .display-math'),
    )
    if (mathElements.length === mathNodes.length) {
      mathElements.forEach((element, index) => {
        element.dataset.mathIndex = String(index)
        element.classList.add('math-clickable')
        element.title = 'Click to edit equation'
      })
    }
    const refElements = Array.from(
      host.querySelectorAll<HTMLElement>(
        '.macro-cite, .macro-citep, .macro-citet, .macro-ref, .macro-eqref, .macro-autoref, .macro-pageref, .macro-label',
      ),
    )
    if (refElements.length === refNodes.length) {
      refElements.forEach((element, index) => {
        const ref = refNodes[index]
        element.dataset.refIndex = String(index)
        element.classList.add('ref-chip')
        let title = 'Click to edit this key'
        if (ref?.kind === 'cite') {
          const keys = ref.value
            .split(',')
            .map((key) => key.trim())
            .filter(Boolean)
          const entry = keys
            .map((key) => bibEntriesRef.current.find((item) => item.key === key))
            .find(Boolean)
          if (entry) title = formatBibEntry(entry)
        }
        element.title = title
      })
    }
    const onClick = (event: MouseEvent) => {
      const mathTarget = (event.target as HTMLElement | null)?.closest(
        '[data-math-index]',
      ) as HTMLElement | null
      if (mathTarget) {
        const index = Number(mathTarget.dataset.mathIndex)
        const math = mathNodes[index]
        if (!math) return
        event.preventDefault()
        event.stopPropagation()
        editMathRef.current(math)
        return
      }
      const refTarget = (event.target as HTMLElement | null)?.closest(
        '[data-ref-index]',
      ) as HTMLElement | null
      if (!refTarget) return
      const index = Number(refTarget.dataset.refIndex)
      const ref = refNodes[index]
      if (!ref) return
      event.preventDefault()
      event.stopPropagation()
      editRefRef.current(ref)
    }
    host.addEventListener('click', onClick)
    return () => host.removeEventListener('click', onClick)
  }, [html, mathNodes, refNodes, bibEntries])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    const images = Array.from(
      host.querySelectorAll<HTMLImageElement>('img.includegraphics'),
    )
    images.forEach((image) => {
      const path = image.getAttribute('src') ?? ''
      if (!path) return
      image.loading = 'lazy'
      resolveAssetRef.current?.(path)
        .then((url) => {
          if (cancelled) return
          if (url) {
            image.src = url
          } else {
            image.alt = `Missing image: ${path}`
            image.classList.add('missing-image')
          }
        })
        .catch(() => {
          /* leave the placeholder */
        })
    })
    return () => {
      cancelled = true
    }
  }, [html, resolveAsset])

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
  bibEntries = [],
  awareness = null,
  fileId = null,
  userLabel = '',
  resolveAsset,
  onEditBlock,
  onEditSource,
  onEditMath,
  onEditRef,
}: {
  content: string
  fileName: string
  bibEntries?: BibEntry[]
  awareness?: Awareness | null
  fileId?: string | null
  userLabel?: string
  resolveAsset?: (path: string) => Promise<string | null>
  onEditBlock: (from: number, to: number, text: string, expected?: string) => void
  onEditSource: (line: number) => void
  onEditMath: (math: VisualMathNode) => void
  onEditRef: (ref: VisualRefNode) => void
}) {
  const { blocks, mathNodes, refNodes, error } = useMemo(
    () => buildBlocks(content),
    [content],
  )

  const [remoteLocks, setRemoteLocks] = useState<
    Array<{ from: number; to: number; name: string }>
  >([])

  useEffect(() => {
    if (!awareness) {
      setRemoteLocks([])
      return
    }
    const update = () => {
      const locks: Array<{ from: number; to: number; name: string }> = []
      awareness.getStates().forEach((state: any, clientId: number) => {
        if (clientId === awareness.clientID) return
        const block = state?.editingBlock
        if (
          block &&
          block.fileId === fileId &&
          typeof block.from === 'number' &&
          typeof block.to === 'number'
        ) {
          locks.push({
            from: block.from,
            to: block.to,
            name: block.name || 'another user',
          })
        }
      })
      setRemoteLocks(locks)
    }
    awareness.on('change', update)
    update()
    return () => {
      awareness.off('change', update)
      awareness.setLocalStateField('editingBlock', null)
    }
  }, [awareness, fileId])

  function beginEdit(from: number, to: number) {
    awareness?.setLocalStateField('editingBlock', {
      fileId,
      from,
      to,
      name: userLabel || 'another user',
    })
  }

  function endEdit() {
    awareness?.setLocalStateField('editingBlock', null)
  }

  function lockFor(from: number, to: number): string | null {
    return (
      remoteLocks.find((lock) => lock.from < to && lock.to > from)?.name ?? null
    )
  }

  function editableWrapper(
    content: ReactNode,
    key: string,
    from: number,
    to: number,
  ) {
    const lockedBy = lockFor(from, to)
    return (
      <div
        key={key}
        className="relative"
        onFocusCapture={() => beginEdit(from, to)}
        onBlurCapture={endEdit}
      >
        {content}
        {lockedBy && (
          <>
            <div
              className="absolute inset-0 z-10 cursor-not-allowed rounded bg-white/40"
              title={`Locked by ${lockedBy}`}
            />
            <span className="absolute right-2 top-0 z-20 rounded-full bg-[var(--warn-soft)] px-2 py-0.5 text-[10px] text-[var(--warn)]">
              Locked by {lockedBy}
            </span>
          </>
        )}
      </div>
    )
  }

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
              return editableWrapper(
                <EditableHeading
                  level={block.level}
                  text={block.text}
                  from={block.from}
                  to={block.to}
                  expected={content.slice(block.from, block.to)}
                  onEdit={onEditBlock}
                />,
                key,
                block.from,
                block.to,
              )
            }
            if (block.kind === 'formatted') {
              return editableWrapper(
                <EditableFormattedParagraph
                  model={block.model}
                  from={block.from}
                  to={block.to}
                  expected={content.slice(block.from, block.to)}
                  onEdit={onEditBlock}
                />,
                key,
                block.from,
                block.to,
              )
            }
            if (block.kind === 'list') {
              return editableWrapper(
                <EditableList
                  ordered={block.ordered}
                  items={block.items}
                  from={block.from}
                  to={block.to}
                  expected={content.slice(block.from, block.to)}
                  onEdit={onEditBlock}
                />,
                key,
                block.from,
                block.to,
              )
            }
            if (block.kind === 'table') {
              return editableWrapper(
                <EditableTable
                  caption={block.caption}
                  labels={block.labels}
                  table={block.table}
                  onEdit={onEditBlock}
                  onEditRef={onEditRef}
                />,
                key,
                block.from,
                block.to,
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
                  refNodes={refNodes.filter(
                    (ref) => ref.from >= block.from && ref.to <= block.to,
                  )}
                  bibEntries={bibEntries}
                  resolveAsset={resolveAsset}
                  onEditSource={onEditSource}
                  onEditMath={onEditMath}
                  onEditRef={onEditRef}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
