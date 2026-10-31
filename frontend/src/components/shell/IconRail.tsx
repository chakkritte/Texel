import Icon from './Icon'

export type PanelTab = 'files' | 'history' | 'comments' | 'ai'

const ITEMS: { id: PanelTab; label: string; icon: string }[] = [
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'history', label: 'Version history', icon: 'history' },
  { id: 'comments', label: 'Comments', icon: 'chat_bubble' },
  { id: 'ai', label: 'AI assistant', icon: 'smart_toy' },
]

export default function IconRail({
  active,
  onChange,
}: {
  active: PanelTab
  onChange: (tab: PanelTab) => void
}) {
  return (
    <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-[var(--border)] bg-[var(--panel-2)] py-2">
      {ITEMS.map(({ id, label, icon }) => (
        <button
          key={id}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={active === id}
          onClick={() => onChange(id)}
          className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors ${
            active === id
              ? 'bg-[var(--accent-soft)] text-[var(--color-on-secondary-container)]'
              : 'text-[var(--muted)] hover:bg-[var(--panel-3)] hover:text-[var(--ink)]'
          }`}
        >
          <Icon name={icon} size={21} />
        </button>
      ))}
    </nav>
  )
}
