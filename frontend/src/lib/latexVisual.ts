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

const ESCAPED_TEXT: Record<string, string> = {
  '%': '%',
  '&': '&',
  '#': '#',
  _: '_',
  '{': '{',
  '}': '}',
  $: '$',
  textasciitilde: '~',
  textasciicircum: '^',
  textbackslash: '\\',
}

export function isEscapedTextNode(node: any): boolean {
  if (node?.type !== 'macro' || !(node.content in ESCAPED_TEXT)) return false
  const args = Array.isArray(node.args) ? node.args : []
  return args.every(
    (arg: any) => !Array.isArray(arg.content) || arg.content.length === 0,
  )
}

export function nodeText(nodes: any[]): string {
  return nodes
    .map((node) => {
      if (!node) return ''
      if (node.type === 'string') return node.content ?? ''
      if (node.type === 'whitespace') return node.content ?? ' '
      if (node.type === 'parbreak') return ' '
      if (isEscapedTextNode(node)) return ESCAPED_TEXT[node.content]
      if (Array.isArray(node.content)) return nodeText(node.content)
      return ''
    })
    .join('')
}

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

const macroReplacements: Record<string, (node: any) => any> = {
  textsuperscript: (node) => ({ type: 'string', content: nodeText(firstArgument(node)) }),
  textsubscript: (node) => ({ type: 'string', content: nodeText(firstArgument(node)) }),
  uppercase: (node) => ({ type: 'string', content: nodeText(firstArgument(node)) }),
  authorrefmark: (node) => ({ type: 'string', content: nodeText(firstArgument(node)) }),
  IEEEmembership: (node) => ({ type: 'string', content: nodeText(firstArgument(node)) }),
}

export function stripMathDelimiters(value: string): string {
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

export function latexToHtml(source: string): { html: string; error: string } {
  if (!source.trim()) return { html: '', error: '' }
  try {
    // The unified-latex plugins pin a different unified type version; the
    // runtime pipeline is compatible, so keep the processor untyped here.
    const result = (unified() as any)
      .use(unifiedLatexFromString)
      .use(attachFollowingGroups)
      .use(unifiedLatexToHast, { macroReplacements })
      .use(rehypeStringify)
      .processSync(source)
    return { html: String(result), error: '' }
  } catch (err) {
    return {
      html: '',
      error: err instanceof Error ? err.message : 'Could not parse this LaTeX fragment',
    }
  }
}

export function renderMathIn(root: HTMLElement): void {
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
      /* keep the raw math */
    }
  })
}
