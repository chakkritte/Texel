import type { AiProviderInfo } from '../../lib/ai'

type Props = {
  providers: AiProviderInfo[]
  provider: string
  model: string
  disabled?: boolean
  onProviderChange: (provider: string) => void
  onModelChange: (model: string) => void
}

export default function ModelSelector({
  providers,
  provider,
  model,
  disabled,
  onProviderChange,
  onModelChange,
}: Props) {
  const current = providers.find((item) => item.id === provider)
  const discovered = current?.models ?? []
  // Keep the configured default selectable even when /api/tags is unavailable
  // or the daemon does not advertise it.
  const models = model && !discovered.includes(model) ? [model, ...discovered] : discovered
  const selectClass =
    'min-w-0 flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-xs disabled:opacity-50'

  return (
    <div className="flex gap-1.5">
      <select
        aria-label="AI provider"
        className={selectClass}
        value={provider}
        disabled={disabled}
        onChange={(event) => onProviderChange(event.target.value)}
      >
        {providers.map((item) => (
          <option key={item.id} value={item.id}>
            {item.id === 'anthropic' ? 'Anthropic' : item.id === 'ollama' ? 'Ollama' : item.id}
          </option>
        ))}
      </select>
      <select
        aria-label="AI model"
        className={selectClass}
        value={model}
        disabled={disabled}
        onChange={(event) => onModelChange(event.target.value)}
      >
        {models.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
    </div>
  )
}
