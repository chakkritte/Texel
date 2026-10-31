import Icon from './shell/Icon'

export type SelectionAction = 'explain' | 'rewrite' | 'fix' | 'translate'

const ACTIONS: { id: SelectionAction; label: string; icon: string; title: string }[] = [
  { id: 'explain', label: 'Explain', icon: 'lightbulb', title: 'Explain the selected text' },
  { id: 'rewrite', label: 'Rewrite', icon: 'edit', title: 'Rewrite the selection more clearly' },
  { id: 'fix', label: 'Fix', icon: 'build', title: 'Fix syntax or compile errors in the selection' },
  {
    id: 'translate',
    label: 'Translate',
    icon: 'translate',
    title: 'Translate the selection to academic English',
  },
]

type Props = {
  left: number
  top: number
  onAction: (action: SelectionAction) => void
}

/** Floating quick-action bar shown above a non-empty editor selection. */
export default function SelectionToolbar({ left, top, onAction }: Props) {
  return (
    <div
      role="toolbar"
      aria-label="AI actions for the selected text"
      className="fixed z-40 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-1 shadow-lg"
      style={{ left, top }}
      // Keep the editor selection (and focus) intact when a button is pressed.
      onMouseDown={(event) => event.preventDefault()}
    >
      {ACTIONS.map((action) => (
        <button
          key={action.id}
          type="button"
          title={action.title}
          aria-label={action.title}
          onClick={() => onAction(action.id)}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--ink-2)] hover:bg-[var(--panel-3)] hover:text-[var(--ink)]"
        >
          <Icon name={action.icon} size={14} />
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  )
}
