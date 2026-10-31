import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  indentOnInput,
  StreamLanguage,
} from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { autocompletion } from '@codemirror/autocomplete'
import { oneDark } from '@codemirror/theme-one-dark'
import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { yCollab } from 'y-codemirror.next'
import { reviewField, setReviewEffect, type ReviewState } from './review'
import type { Selection } from '../lib/ai'
import SelectionToolbar, { type SelectionAction } from './SelectionToolbar'

export type JumpTarget = { line: number; column?: number; nonce: number }

type Props = {
  value: string
  onChange: (value: string) => void
  readOnly?: boolean
  jump?: JumpTarget | null
  ytext?: Y.Text | null
  awareness?: Awareness | null
  onCursor?: (line: number, column: number) => void
  dark?: boolean
  review?: ReviewState | null
  language?: 'stex' | 'plain'
  /** Show quick AI actions when text is selected. */
  aiActions?: boolean
  /** Reports a 0-based line selection (``to`` exclusive) or null when empty. */
  onSelectionChange?: (selection: Selection | null) => void
  onSelectionAction?: (action: SelectionAction, selection: Selection) => void
}

type ToolbarState = {
  left: number
  top: number
  selection: Selection
}

export default function CodeMirrorEditor({
  value,
  onChange,
  readOnly = false,
  jump = null,
  ytext = null,
  awareness = null,
  onCursor,
  dark = false,
  review = null,
  language = 'stex',
  aiActions = false,
  onSelectionChange,
  onSelectionAction,
}: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const changeRef = useRef(onChange)
  changeRef.current = onChange
  const cursorRef = useRef(onCursor)
  cursorRef.current = onCursor
  const reviewRef = useRef(review)
  reviewRef.current = review
  const aiActionsRef = useRef(aiActions)
  aiActionsRef.current = aiActions
  const selectionChangeRef = useRef(onSelectionChange)
  selectionChangeRef.current = onSelectionChange
  const selectionActionRef = useRef(onSelectionAction)
  selectionActionRef.current = onSelectionAction
  const lastSelectionRef = useRef<string | null>(null)
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null)

  const refreshSelection = useCallback((instance: EditorView) => {
    const main = instance.state.selection.main
    if (main.empty) {
      setToolbar(null)
      if (lastSelectionRef.current !== null) {
        lastSelectionRef.current = null
        selectionChangeRef.current?.(null)
      }
      return
    }

    const doc = instance.state.doc
    const startLine = doc.lineAt(main.from).number - 1
    const endInfo = doc.lineAt(main.to)
    // ``to`` is exclusive; a selection that ends exactly at the start of a
    // line does not include that line.
    const endLine =
      main.to > 0 && endInfo.from === main.to ? endInfo.number - 1 : endInfo.number
    const selection: Selection = {
      from: startLine,
      to: Math.max(startLine + 1, endLine),
      text: doc.sliceString(main.from, main.to).slice(0, 4000),
    }
    // Report the selection even when the editor has lost focus, so the AI panel
    // keeps its context while the user types a question there. Repeating the
    // same line range on every scroll tick would needlessly re-render the page.
    const selectionKey = `${selection.from}:${selection.to}`
    if (lastSelectionRef.current !== selectionKey) {
      lastSelectionRef.current = selectionKey
      selectionChangeRef.current?.(selection)
    }

    if (!instance.hasFocus || !aiActionsRef.current) {
      setToolbar(null)
      return
    }
    const head = instance.coordsAtPos(main.head)
    if (!head) {
      setToolbar(null)
      return
    }
    // The bar is centred with translateX(-50%); keep roughly half its width
    // inside the viewport.
    const half = 150
    const left = Math.min(
      Math.max(head.left, half + 8),
      Math.max(half + 8, window.innerWidth - half - 8),
    )
    const top = head.top > 56 ? head.top - 44 : head.bottom + 8
    setToolbar((previous) =>
      previous &&
      previous.left === left &&
      previous.top === top &&
      previous.selection.from === selection.from &&
      previous.selection.to === selection.to
        ? previous
        : { left, top, selection },
    )
  }, [])

  useEffect(() => {
    if (!host.current) return
    setToolbar(null)
    const instance = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: ytext ? ytext.toString() : value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          ...(dark
            ? []
            : [syntaxHighlighting(defaultHighlightStyle, { fallback: true })]),
          bracketMatching(),
          autocompletion(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          ...(language === 'stex' ? [StreamLanguage.define(stex)] : []),
          ...(dark ? [oneDark] : []),
          reviewField,
          EditorView.lineWrapping,
          EditorView.editable.of(!readOnly),
          ...(ytext && awareness ? [yCollab(ytext, awareness)] : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !ytext) {
              changeRef.current(update.state.doc.toString())
            }
            if (update.selectionSet || update.docChanged) {
              const head = update.state.selection.main.head
              const line = update.state.doc.lineAt(head)
              cursorRef.current?.(line.number, head - line.from + 1)
            }
            if (
              update.selectionSet ||
              update.docChanged ||
              update.focusChanged ||
              update.geometryChanged
            ) {
              refreshSelection(update.view)
            }
          }),
        ],
      }),
    })
    view.current = instance
    if (reviewRef.current) {
      instance.dispatch({ effects: setReviewEffect.of(reviewRef.current) })
    }
    // Keep the floating bar anchored while the editor or page scrolls.
    const reposition = () => refreshSelection(instance)
    const hostEl = host.current
    hostEl?.addEventListener('scroll', reposition, { passive: true })
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      hostEl?.removeEventListener('scroll', reposition)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      instance.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytext, awareness, readOnly, dark, language, refreshSelection])

  useEffect(() => {
    const instance = view.current
    if (!instance || ytext) return
    if (value !== instance.state.doc.toString()) {
      instance.dispatch({
        changes: { from: 0, to: instance.state.doc.length, insert: value },
      })
    }
  }, [value])

  useEffect(() => {
    const instance = view.current
    if (!instance) return
    instance.dispatch({ effects: setReviewEffect.of(review) })
  }, [review])

  useEffect(() => {
    const instance = view.current
    if (!instance || !jump) return
    const lineNo = Math.min(Math.max(1, jump.line), instance.state.doc.lines)
    const line = instance.state.doc.line(lineNo)
    const pos = Math.min(line.from + (jump.column ?? 0), line.to)
    instance.dispatch({
      selection: { anchor: pos },
      scrollIntoView: true,
    })
    instance.focus()
  }, [jump])

  return (
    <div className="relative h-full">
      <div ref={host} className="h-full overflow-auto text-[14px] leading-[20px]" />
      {toolbar && (
        <SelectionToolbar
          left={toolbar.left}
          top={toolbar.top}
          onAction={(action) => {
            const selection = toolbar.selection
            setToolbar(null)
            // Drop editor focus so a layout change (the AI panel opening) does
            // not immediately re-open the bar from a geometry update.
            view.current?.contentDOM.blur()
            selectionActionRef.current?.(action, selection)
          }}
        />
      )}
    </div>
  )
}
