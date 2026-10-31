import { useEffect, useRef, useState } from 'react'
import Icon from './shell/Icon'
import { loadCodeCogsEditor } from '../lib/codecogs'

export type EquationMode = 'inline' | 'display' | 'raw'

type Props = {
  initialLatex: string
  initialMode?: EquationMode
  onClose: () => void
  onInsert: (latex: string, mode: EquationMode) => void
}

/**
 * WYSIWYG equation builder backed by the free CodeCogs equation editor.
 * It edits one equation at a time; the result is inserted into the LaTeX file.
 */
export default function EquationDialog({
  initialLatex,
  initialMode = 'inline',
  onClose,
  onInsert,
}: Props) {
  const [suffix] = useState(() => Math.random().toString(36).slice(2, 9))
  const ids = {
    toolbar: `cc-toolbar-${suffix}`,
    latex: `cc-latex-${suffix}`,
    output: `cc-output-${suffix}`,
  }
  const linkedRef = useRef<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<EquationMode>(initialMode)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await loadCodeCogsEditor()
        if (cancelled) return
        const Eq = window.EqEditor
        if (!Eq) throw new Error('Equation editor did not initialise')
        const linked = Eq.TextArea.link(ids.latex).addOutput(new Eq.Output(ids.output))
        Eq.Toolbar.link(ids.toolbar).addTextArea(linked)
        linkedRef.current = linked

        const input = document.getElementById(ids.latex)
        if (initialLatex && input) {
          // The old editor API has no setText(); insert() updates its token
          // state, while writing textContent directly would leave the preview
          // and the next keystroke out of sync.
          if (typeof linked.insert === 'function') {
            linked.clear()
            linked.insert(initialLatex)
            if (typeof linked.notifyOutputs === 'function') linked.notifyOutputs()
          } else {
            input.textContent = initialLatex
            input.dispatchEvent(new Event('input', { bubbles: true }))
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? `${err.message}. You can still type LaTeX below.`
              : 'Could not load the equation toolbar. You can still type LaTeX below.',
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // The dialog is mounted fresh for every open, so the ids are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function insert() {
    const linked = linkedRef.current
    const element = document.getElementById(ids.latex)
    const value =
      linked && typeof linked.getText === 'function'
        ? String(linked.getText())
        : element?.textContent ?? ''
    const latex = value.trim()
    if (!latex) {
      setError('Enter an equation first.')
      return
    }
    onInsert(latex, mode)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Equation editor"
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-[var(--shadow-lg)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <Icon name="functions" size={18} className="text-[var(--accent)]" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">Equation editor</div>
            <div className="text-[10px] text-[var(--muted)]">
              Visual builder powered by{' '}
              <a
                href="https://editor.codecogs.com"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                CodeCogs
              </a>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--ink)]"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-4">
          <div className="rounded-lg border border-[var(--border)] bg-white">
            <div id={ids.toolbar} className="cc-toolbar" />
            <div
              id={ids.latex}
              contentEditable
              suppressContentEditableWarning
              data-placeholder="Write LaTeX here… e.g. \frac{a}{b}"
              className="cc-latex min-h-[90px] whitespace-pre-wrap px-3 py-3 font-[var(--font-mono)] text-[14px] text-slate-800 outline-none"
            />
          </div>

          <div className="relative flex min-h-[90px] items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
            {loading && (
              <span className="absolute text-xs text-[var(--muted)]">
                Loading equation toolbar…
              </span>
            )}
            {/* The img must exist before EqEditor.Output connects to it. */}
            <img
              id={ids.output}
              alt="Rendered equation"
              className={`max-h-40 max-w-full ${loading ? 'invisible' : ''}`}
            />
          </div>

          {error && (
            <p className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[11px] font-medium text-[var(--ink-2)]" htmlFor={`${ids.latex}-mode`}>
              Insert as
            </label>
            <select
              id={`${ids.latex}-mode`}
              value={mode}
              onChange={(event) => setMode(event.target.value as EquationMode)}
              className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1.5 text-xs outline-none focus:border-[var(--accent)]"
            >
              <option value="inline">Inline math — $...$</option>
              <option value="display">Display math — \[...\]</option>
              <option value="raw">Raw LaTeX</option>
            </select>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-[var(--border)] px-3.5 py-1.5 text-xs text-[var(--ink-2)] hover:bg-[var(--panel-3)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={insert}
            className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 py-1.5 text-xs font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-2)]"
          >
            <Icon name="add" size={15} /> Insert equation
          </button>
        </div>
      </div>
    </div>
  )
}
