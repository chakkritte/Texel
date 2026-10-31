import { useEffect, useMemo, useRef } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { unified } from 'unified'
import rehypeStringify from 'rehype-stringify'
import { unifiedLatexFromString } from '@unified-latex/unified-latex-util-parse'
import { unifiedLatexToHast } from '@unified-latex/unified-latex-to-hast'
import { getArgsContent } from '@unified-latex/unified-latex-util-arguments'

function firstArgument(node: any): any[] {
  try {
    return getArgsContent(node)[0] ?? []
  } catch {
    return []
  }
}

function nodeText(nodes: any[]): string {
  return nodes
    .map((node) => {
      if (!node) return ''
      if (node.type === 'string') return node.content ?? ''
      if (node.type === 'whitespace') return node.content ?? ' '
      if (node.type === 'parbreak') return ' '
      if (Array.isArray(node.content)) return nodeText(node.content)
      return ''
    })
    .join('')
}

// Some IEEE macros are parsed as a bare macro followed by a group. Attach the
// group as an argument so the HTML converter can render the macro's content.
const ATTACH_GROUP_MACROS = new Set([
  'textsuperscript',
  'textsubscript',
  'authorrefmark',
  'IEEEmembership',
])

function attachFollowingGroups() {
  return (tree: any) => {
    const walk = (nodes: any[]) => {
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index]
        if (
          node?.type === 'macro' &&
          ATTACH_GROUP_MACROS.has(node.content) &&
          (!node.args || node.args.length === 0) &&
          nodes[index + 1]?.type === 'group'
        ) {
          const group = nodes[index + 1]
          node.args = [
            {
              type: 'argument',
              content: group.content ?? [],
              openMark: '{',
              closeMark: '}',
            },
          ]
          nodes.splice(index + 1, 1)
        }
        if (Array.isArray(node?.content)) walk(node.content)
        if (Array.isArray(node?.args)) {
          for (const arg of node.args) {
            if (Array.isArray(arg.content)) walk(arg.content)
          }
        }
      }
    }
    walk(tree.content)
  }
}

// Return a group so the content renders inline. html-like nodes cannot be
// constructed reliably across the package's bundled instances, which would
// leak raw "\html-tag" text into the visual view.
const macroReplacements: Record<string, (node: any) => any> = {
  textsuperscript: (node) => ({ type: 'string', content: nodeText(firstArgument(node)) }),
  textsubscript: (node) => ({ type: 'string', content: nodeText(firstArgument(node)) }),
  uppercase: (node) => ({ type: 'string', content: nodeText(firstArgument(node)) }),
  authorrefmark: (node) => ({ type: 'string', content: nodeText(firstArgument(node)) }),
  IEEEmembership: (node) => ({ type: 'string', content: nodeText(firstArgument(node)) }),
}

function stripMathDelimiters(value: string): string {
  let latex = value.trim()
  const environment = latex.match(
    /^\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|eqnarray\*?)\}([\s\S]*)\\end\{\1\}$/,
  )
  if (environment) return environment[2].trim()
  if (latex.startsWith('$$') && latex.endsWith('$$')) {
    latex = latex.slice(2, -2)
  } else if (latex.startsWith('$') && latex.endsWith('$')) {
    latex = latex.slice(1, -1)
  } else if (latex.startsWith('\\[') && latex.endsWith('\\]')) {
    latex = latex.slice(2, -2)
  } else if (latex.startsWith('\\(') && latex.endsWith('\\)')) {
    latex = latex.slice(2, -2)
  }
  return latex.trim()
}

/**
 * Read-only visual rendering of a single LaTeX file (Phase 3.1).
 * Math is rendered with KaTeX; unknown macros are left as the converter
 * produced them. Editing and source mapping are part of the next phases.
 */
export default function VisualDocument({
  content,
  fileName,
}: {
  content: string
  fileName: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const { html, error } = useMemo(() => {
    if (!content.trim()) return { html: '', error: '' }
    try {
      // The unified-latex plugins pin a different unified type version; the
      // runtime pipeline is compatible, so keep the processor untyped here.
      const result = (unified() as any)
        .use(unifiedLatexFromString)
        .use(attachFollowingGroups)
        .use(unifiedLatexToHast, { macroReplacements })
        .use(rehypeStringify)
        .processSync(content)
      return { html: String(result), error: '' }
    } catch (err) {
      return {
        html: '',
        error: err instanceof Error ? err.message : 'Could not parse this LaTeX file',
      }
    }
  }, [content])

  useEffect(() => {
    const root = hostRef.current
    if (!root) return
    root.querySelectorAll<HTMLElement>('.inline-math, .display-math').forEach((element) => {
      if (element.classList.contains('katex-rendered')) return
      const display = element.classList.contains('display-math')
      const latex = stripMathDelimiters(element.textContent ?? '')
      if (!latex) return
      try {
        element.innerHTML = katex.renderToString(latex, {
          displayMode: display,
          throwOnError: false,
          strict: false,
        })
        element.classList.add('katex-rendered')
      } catch {
        /* keep the converter's raw math */
      }
    })
  }, [html])

  if (error) {
    return (
      <div className="h-full overflow-auto bg-[var(--panel-3)] px-6 py-6">
        <div className="mx-auto max-w-[860px] rounded-lg border border-[var(--warn)]/40 bg-[var(--warn-soft)] px-4 py-3 text-xs text-[var(--warn)]">
          Visual view could not parse this file. Showing the source instead.
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
        <div className="mb-5 flex items-center justify-between gap-2 border-b border-zinc-200 pb-2 text-[10px] text-zinc-400">
          <span className="truncate font-[var(--font-mono)]">{fileName || 'LaTeX document'}</span>
          <span className="shrink-0">Read-only visual view</span>
        </div>
        <div
          ref={hostRef}
          className="latex-visual"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  )
}
