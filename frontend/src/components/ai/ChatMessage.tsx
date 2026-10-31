import EditProposal from './EditProposal'
import type { JumpTarget, UiMessage } from './types'

type Props = {
  message: UiMessage
  onApplied?: (fileId: string) => void | Promise<void>
  onJumpToError?: (target: JumpTarget) => void
}

export default function ChatMessage({ message, onApplied, onJumpToError }: Props) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[94%] rounded-lg px-2.5 py-2 text-sm ${
          isUser ? 'bg-emerald-600 text-white' : 'bg-zinc-100 text-zinc-800'
        }`}
      >
        {message.content ? (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        ) : message.pending ? (
          <span className="text-xs text-zinc-500">Thinking…</span>
        ) : null}

        {message.tool_calls && message.tool_calls.length > 0 && (
          <div className="mt-2 space-y-2">
            {message.tool_calls.map((call, index) => (
              <EditProposal
                key={`${message.id}-tool-${index}`}
                call={call}
                onApplied={onApplied}
                onJumpToError={onJumpToError}
              />
            ))}
          </div>
        )}

        {message.error && (
          <div className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">
            {message.error}
          </div>
        )}

        {!isUser && !message.pending && (message.tokens_in || message.tokens_out) ? (
          <div className="mt-1 text-right text-[10px] text-zinc-400">
            {message.model ?? ''} · {message.tokens_in ?? 0} in / {message.tokens_out ?? 0} out
          </div>
        ) : null}
      </div>
    </div>
  )
}
