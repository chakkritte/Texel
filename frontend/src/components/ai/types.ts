import type { ToolCall } from '../../lib/ai'

export type UiMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  provider?: string | null
  model?: string | null
  tokens_in?: number
  tokens_out?: number
  tool_calls?: ToolCall[]
  pending?: boolean
  error?: string
}

export type JumpTarget = {
  file: string
  line: number
  message?: string
}
