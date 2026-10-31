import { BASE, api, getToken, refreshSession } from './api'

export type Selection = {
  /** 0-based first selected line */
  from: number
  /** 0-based exclusive last selected line */
  to: number
  text?: string
}

export type CompileErrorInfo = {
  jobId?: string
  file?: string
  line?: number
  message: string
}

export type ToolCall = {
  name: 'propose_edit' | 'jump_to_error' | string
  input: Record<string, unknown>
}

export type ProposeEditInput = {
  file_id: string
  range: { from: number; to: number }
  replacement: string
  rationale?: string
}

export type JumpToErrorInput = {
  file: string
  line: number
  message?: string
  job_id?: string
}

export type AiProviderInfo = {
  id: string
  models: string[]
  default: string
}

export type AiModelsResponse = {
  providers: AiProviderInfo[]
}

export type AiConversation = {
  id: string
  project_id: string
  title: string
  provider: string
  model: string
  created_at: string
  updated_at: string
}

export type AiMessage = {
  id: string
  role: 'user' | 'assistant' | string
  content: string
  provider: string | null
  model: string | null
  tokens_in: number
  tokens_out: number
  tool_calls: ToolCall[] | null
  created_at: string
}

export type AiUsageBucket = {
  provider: string
  messages: number
  tokens_in: number
  tokens_out: number
  cost_usd: number
}

export type AiUsage = {
  days: number
  messages: number
  tokens_in: number
  tokens_out: number
  total_tokens: number
  cost_usd: number
  today_tokens: number
  daily_quota: number
  since: string
  by_provider: AiUsageBucket[]
}

export type StreamContext = {
  file_id?: string
  selection?: Selection
  compile_job_id?: string
}

export type StreamBody = {
  conversation_id?: string
  provider: string
  model: string
  content: string
  context: StreamContext
}

export type DoneInfo = {
  conversation_id: string
  message_id: string
  provider: string
  model: string
  usage: {
    tokens_in: number
    tokens_out: number
    total_tokens?: number
    cost_usd: number
  }
  latency_ms: number
}

export type StreamHandlers = {
  onToken: (text: string) => void
  onTool: (call: ToolCall) => void
  onDone: (info: DoneInfo) => void
  onError: (message: string) => void
}

function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra)
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return headers
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = () =>
    fetch(`${BASE}api/v1${path}`, {
      ...init,
      headers: authHeaders(init.headers),
      credentials: 'include',
    })
  let response = await send()
  if (response.status === 401 && (await refreshSession())) {
    response = await send()
  }
  return response
}

async function errorFromResponse(response: Response): Promise<Error> {
  const text = await response.text().catch(() => '')
  let detail = text
  try {
    const parsed = JSON.parse(text) as { detail?: unknown }
    if (typeof parsed.detail === 'string') detail = parsed.detail
  } catch {
    /* keep raw text */
  }
  return new Error(detail || `${response.status} ${response.statusText}`)
}

function parseEvent(raw: string): { event: string; data: unknown } | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }
  if (dataLines.length === 0) return null
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) }
  } catch {
    return null
  }
}

export function fetchModels(): Promise<AiModelsResponse> {
  return api<AiModelsResponse>('/ai/models')
}

export function fetchConversations(projectId: string): Promise<AiConversation[]> {
  return api<AiConversation[]>(`/ai/projects/${projectId}/conversations`)
}

export function createConversation(
  projectId: string,
  body: { title?: string; provider?: string; model?: string },
): Promise<AiConversation> {
  return api<AiConversation>(`/ai/projects/${projectId}/conversations`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function fetchMessages(conversationId: string): Promise<AiMessage[]> {
  return api<AiMessage[]>(`/ai/conversations/${conversationId}/messages`)
}

export function fetchUsage(days = 30): Promise<AiUsage> {
  return api<AiUsage>(`/ai/usage?days=${days}`)
}

/**
 * POST a message and consume the server's text/event-stream response.
 *
 * Events: token {text}, tool {name,input}, done {conversation_id,...}, error {message}.
 */
export async function streamAiMessage(
  projectId: string,
  body: StreamBody,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await authedFetch(`/ai/projects/${projectId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) throw await errorFromResponse(response)
  if (!response.body) throw new Error('Streaming is not supported by this browser')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const dispatch = (raw: string) => {
    const parsed = parseEvent(raw)
    if (!parsed) return
    const payload = (parsed.data ?? {}) as Record<string, unknown>
    switch (parsed.event) {
      case 'token':
        handlers.onToken(typeof payload.text === 'string' ? payload.text : '')
        break
      case 'tool':
        handlers.onTool({
          name: typeof payload.name === 'string' ? payload.name : '',
          input:
            payload.input && typeof payload.input === 'object'
              ? (payload.input as Record<string, unknown>)
              : {},
        })
        break
      case 'done':
        handlers.onDone(payload as unknown as DoneInfo)
        break
      case 'error':
        handlers.onError(
          typeof payload.message === 'string' ? payload.message : 'AI request failed',
        )
        break
      default:
        break
    }
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        if (chunk.trim()) dispatch(chunk)
        boundary = buffer.indexOf('\n\n')
      }
    }
    buffer += decoder.decode().replace(/\r\n/g, '\n')
    if (buffer.trim()) dispatch(buffer)
  } finally {
    reader.releaseLock()
  }
}

export { BASE }
