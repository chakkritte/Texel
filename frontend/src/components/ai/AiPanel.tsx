import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import {
  fetchConversations,
  fetchMessages,
  fetchModels,
  fetchUsage,
  streamAiMessage,
  type AiConversation,
  type AiMessage,
  type AiProviderInfo,
  type AiUsage,
  type CompileErrorInfo,
  type DoneInfo,
  type Selection,
} from '../../lib/ai'
import ChatMessage from './ChatMessage'
import ContextHints from './ContextHints'
import ModelSelector from './ModelSelector'
import type { JumpTarget, UiMessage } from './types'

/** A prompt queued by the editor's selection toolbar. */
export type AiRequest = {
  prompt: string
  nonce: number
}

export type AiPanelProps = {
  projectId: string
  fileId: string | null
  selection: Selection | null
  /** Accepts the structured form or a raw compiler message string. */
  compileError: CompileErrorInfo | string | null
  /** Prompt to send as soon as the panel has a usable model. */
  request?: AiRequest | null
  onRequestHandled?: (nonce: number) => void
  onJumpToError?: (target: JumpTarget) => void
  onApplied?: (fileId: string) => void | Promise<void>
}

type Action = 'chat' | 'fix' | 'explain'

let localCounter = 0
function localId(prefix: string): string {
  localCounter += 1
  return `${prefix}-${Date.now()}-${localCounter}`
}

function toUiMessage(message: AiMessage): UiMessage {
  return {
    id: message.id,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.content,
    provider: message.provider,
    model: message.model,
    tokens_in: message.tokens_in,
    tokens_out: message.tokens_out,
    tool_calls: message.tool_calls ?? [],
  }
}

export default function AiPanel({
  projectId,
  fileId,
  selection,
  compileError,
  request = null,
  onRequestHandled,
  onJumpToError,
  onApplied,
}: AiPanelProps) {
  const compileErrorInfo: CompileErrorInfo | null =
    typeof compileError === 'string' ? { message: compileError } : compileError

  const [providers, setProviders] = useState<AiProviderInfo[]>([])
  const [provider, setProvider] = useState('anthropic')
  const [model, setModel] = useState('')
  const [conversations, setConversations] = useState<AiConversation[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<Action>('chat')
  const [usage, setUsage] = useState<AiUsage | null>(null)
  const [loadingConversation, setLoadingConversation] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const skipLoadRef = useRef<string | null>(null)
  const handledRequestRef = useRef<number | null>(null)
  const pendingRequestRef = useRef<AiRequest | null>(null)
  const requestHandledRef = useRef(onRequestHandled)
  requestHandledRef.current = onRequestHandled
  const sendRef = useRef<(text: string) => Promise<void>>(async () => {})

  const refreshSide = useCallback(async () => {
    try {
      const [nextConversations, nextUsage] = await Promise.all([
        fetchConversations(projectId),
        fetchUsage().catch(() => null),
      ])
      setConversations(nextConversations)
      if (nextUsage) setUsage(nextUsage)
    } catch {
      /* non-critical */
    }
  }, [projectId])

  // Load model catalog + conversation history when the project changes.
  useEffect(() => {
    let alive = true
    setConversations([])
    setConversationId(null)
    setMessages([])
    setError('')
    setUsage(null)
    setLoadingConversation(false)
    ;(async () => {
      try {
        const [modelResponse, nextConversations, nextUsage] = await Promise.all([
          fetchModels(),
          fetchConversations(projectId),
          fetchUsage().catch(() => null),
        ])
        if (!alive) return
        setProviders(modelResponse.providers)
        const first = modelResponse.providers[0]
        if (first) {
          setProvider(first.id)
          setModel(first.default || first.models[0] || '')
        }
        setConversations(nextConversations)
        if (nextUsage) setUsage(nextUsage)
        if (nextConversations.length > 0) setConversationId(nextConversations[0].id)
      } catch (err) {
        if (alive) {
          setError(err instanceof Error ? err.message : 'Could not load the AI panel')
        }
      }
    })()
    return () => {
      alive = false
      // Navigating to another project (or unmounting) must stop an in-flight
      // stream from writing into the new project's panel.
      abortRef.current?.abort()
    }
  }, [projectId])

  // Load messages for a selected conversation. A conversation created by the
  // streaming endpoint is already present in local state, so skip that reload.
  useEffect(() => {
    if (!conversationId) {
      setMessages([])
      setLoadingConversation(false)
      return
    }
    if (skipLoadRef.current === conversationId) {
      skipLoadRef.current = null
      setLoadingConversation(false)
      return
    }
    let alive = true
    setMessages([])
    setLoadingConversation(true)
    fetchMessages(conversationId)
      .then((rows) => {
        if (alive) setMessages(rows.map(toUiMessage))
      })
      .catch((err) => {
        if (alive) {
          setError(err instanceof Error ? err.message : 'Could not load messages')
        }
      })
      .finally(() => {
        if (alive) setLoadingConversation(false)
      })
    return () => {
      alive = false
    }
  }, [conversationId])

  useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [messages])

  function changeProvider(next: string) {
    setProvider(next)
    const info = providers.find((item) => item.id === next)
    setModel(info?.default || info?.models[0] || '')
  }

  function newConversation() {
    if (busy) return
    skipLoadRef.current = null
    setConversationId(null)
    setMessages([])
    setError('')
    setMode('chat')
  }

  async function send(text: string) {
    const content = text.trim()
    if (!content || busy) return
    if (!provider || !model) {
      setError('No AI model is available for this project.')
      return
    }

    setBusy(true)
    setError('')
    setInput('')
    const userMessageId = localId('user')
    const assistantMessageId = localId('assistant')
    setMessages((previous) => [
      ...previous,
      { id: userMessageId, role: 'user', content },
      {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        tool_calls: [],
        pending: true,
      },
    ])

    const controller = new AbortController()
    abortRef.current = controller

    try {
      await streamAiMessage(
        projectId,
        {
          conversation_id: conversationId ?? undefined,
          provider,
          model,
          content,
          context: {
            file_id: fileId ?? undefined,
            selection: selection ?? undefined,
            compile_job_id: compileErrorInfo?.jobId,
          },
        },
        {
          onToken: (token) => {
            setMessages((previous) =>
              previous.map((message) =>
                message.id === assistantMessageId
                  ? { ...message, content: message.content + token }
                  : message,
              ),
            )
          },
          onTool: (call) => {
            setMessages((previous) =>
              previous.map((message) =>
                message.id === assistantMessageId
                  ? {
                      ...message,
                      tool_calls: [...(message.tool_calls ?? []), call],
                    }
                  : message,
              ),
            )
          },
          onDone: (info: DoneInfo) => {
            setMessages((previous) =>
              previous.map((message) =>
                message.id === assistantMessageId
                  ? {
                      ...message,
                      pending: false,
                      provider: info.provider,
                      model: info.model,
                      tokens_in: info.usage?.tokens_in,
                      tokens_out: info.usage?.tokens_out,
                    }
                  : message,
              ),
            )
            // Only a freshly created conversation needs its id installed; the
            // messages are already in local state, so skip the reload effect.
            if (conversationId === null) {
              skipLoadRef.current = info.conversation_id
              setConversationId(info.conversation_id)
            }
            void refreshSide()
          },
          onError: (message) => {
            setError(message)
            setMessages((previous) =>
              previous.map((item) =>
                item.id === assistantMessageId
                  ? { ...item, pending: false, error: message }
                  : item,
              ),
            )
          },
        },
        controller.signal,
      )
    } catch (err) {
      const errorName =
        typeof err === 'object' && err !== null
          ? (err as { name?: string }).name
          : undefined
      if (errorName === 'AbortError') {
        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantMessageId
              ? { ...message, pending: false, content: message.content || '(stopped)' }
              : message,
          ),
        )
      } else {
        const message = err instanceof Error ? err.message : 'AI request failed'
        setError(message)
        setMessages((previous) =>
          previous.map((item) =>
            item.id === assistantMessageId
              ? { ...item, pending: false, error: message }
              : item,
          ),
        )
      }
    } finally {
      abortRef.current = null
      setBusy(false)
      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantMessageId && message.pending
            ? { ...message, pending: false }
            : message,
        ),
      )
    }
  }

  sendRef.current = send

  // A selection-toolbar action queues a prompt. Send it immediately when a
  // model is ready, otherwise leave it pending until the catalog has loaded.
  useEffect(() => {
    if (!request || handledRequestRef.current === request.nonce) return
    handledRequestRef.current = request.nonce
    setMode('chat')
    requestHandledRef.current?.(request.nonce)
    if (!busy && provider && model) {
      pendingRequestRef.current = null
      void sendRef.current(request.prompt)
    } else {
      pendingRequestRef.current = request
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  useEffect(() => {
    if (!pendingRequestRef.current || busy || !provider || !model) return
    const queued = pendingRequestRef.current
    pendingRequestRef.current = null
    void sendRef.current(queued.prompt)
  }, [busy, provider, model])

  function actionPrompt(action: 'fix' | 'explain'): string {
    if (action === 'fix') {
      if (compileErrorInfo) {
        const location = compileErrorInfo.file
          ? `${compileErrorInfo.file}${compileErrorInfo.line ? `:${compileErrorInfo.line}` : ''}: `
          : ''
        return (
          'The project currently fails to compile. Diagnose this error and propose a minimal fix.\n' +
          location +
          compileErrorInfo.message
        )
      }
      return 'Review the current project for likely LaTeX compile errors and propose fixes where needed.'
    }
    return selection
      ? 'Explain the selected LaTeX: what it does and anything worth improving.'
      : 'Explain the structure of the current file and suggest improvements.'
  }

  function runAction(action: 'fix' | 'explain') {
    setMode(action)
    const prompt = actionPrompt(action)
    if (busy) {
      setInput(prompt)
      return
    }
    void send(prompt)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void send(input)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send(input)
    }
  }

  const actions: { id: Action; label: string }[] = [
    { id: 'chat', label: 'Chat' },
    { id: 'fix', label: 'Fix errors' },
    { id: 'explain', label: 'Explain' },
  ]

  return (
    <aside className="flex h-full w-[360px] shrink-0 flex-col border-r bg-white">
      <div className="space-y-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">AI</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={newConversation}
            disabled={busy}
            className="text-xs text-emerald-700 hover:underline disabled:opacity-40"
          >
            + New
          </button>
        </div>
        <ModelSelector
          providers={providers}
          provider={provider}
          model={model}
          disabled={busy || providers.length === 0}
          onProviderChange={changeProvider}
          onModelChange={setModel}
        />
        <select
          aria-label="Conversation"
          className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs disabled:opacity-50"
          value={conversationId ?? ''}
          disabled={busy}
          onChange={(event) => setConversationId(event.target.value || null)}
        >
          <option value="">New conversation</option>
          {conversations.map((conversation) => (
            <option key={conversation.id} value={conversation.id}>
              {conversation.title || 'Untitled conversation'}
            </option>
          ))}
        </select>
      </div>

      <ContextHints
        fileId={fileId}
        selection={selection}
        compileError={compileErrorInfo}
      />

      <div className="flex border-b text-xs">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => {
              if (action.id === 'chat') {
                setMode('chat')
              } else {
                runAction(action.id)
              }
            }}
            className={`flex-1 px-2 py-1.5 ${
              mode === action.id
                ? 'border-b-2 border-emerald-600 font-medium text-emerald-700'
                : 'text-zinc-500 hover:bg-zinc-50'
            }`}
          >
            {action.label}
          </button>
        ))}
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-2 overflow-auto bg-zinc-50 px-2 py-2"
      >
        {messages.length === 0 && !loadingConversation && (
          <div className="rounded-lg border border-dashed border-zinc-300 p-3 text-xs text-zinc-500">
            Ask about the current file, fix a compile error, or explain a selection. Edits are
            proposed as a diff and applied only after you accept them.
          </div>
        )}
        {loadingConversation && (
          <div className="p-2 text-xs text-zinc-400">Loading conversation…</div>
        )}
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            onApplied={onApplied}
            onJumpToError={onJumpToError}
          />
        ))}
      </div>

      {error && (
        <div className="border-t bg-red-50 px-3 py-1.5 text-xs text-red-700">{error}</div>
      )}

      <form onSubmit={submit} className="border-t p-2">
        <textarea
          value={input}
          rows={3}
          placeholder="Ask the assistant…"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          className="w-full resize-none rounded border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
        />
        <div className="mt-1 flex items-center gap-2">
          <span className="flex-1 text-[10px] text-zinc-400">
            Enter to send · Shift+Enter for a newline
          </span>
          {busy && (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="rounded border px-2 py-1 text-xs"
            >
              Stop
            </button>
          )}
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>

      {usage && (
        <div className="border-t px-3 py-1 text-[10px] text-zinc-400">
          Today {usage.today_tokens.toLocaleString()} / {usage.daily_quota.toLocaleString()}{' '}
          tokens · ${usage.cost_usd.toFixed(4)} in {usage.days}d
        </div>
      )}
    </aside>
  )
}
