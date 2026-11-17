import type { ModelRef } from '../store'

export type Part =
  | { type: 'text'; text: string; hidden?: boolean }
  | { type: 'reasoning'; text: string }
  | { type: 'file'; name: string; mime: string; data: string }
  | {
      type: 'tool'; id: string; name: string; input: any; title?: string
      status: 'pending' | 'running' | 'done' | 'error' | 'denied'
      output?: string; start?: number; end?: number
    }

export interface Msg {
  id: string
  role: 'user' | 'assistant' | 'note'
  parts: Part[]
  time: number
  /** user messages the app wrote itself (auto-check results, summaries) */
  synthetic?: 'summary' | 'check' | 'system'
  model?: ModelRef
  level?: string
  usage?: { input: number; output: number }
  error?: string
  /** provider-native content blocks, replayed verbatim to the same model */
  native?: { provider: string; model: string; content: any[] }
  /** file snapshot taken just before this user message ran */
  snapshot?: string
  done?: boolean
}

export type Mode = 'chat' | 'build' | 'plan' | 'review'

export interface Session {
  id: string
  kind: 'chat' | 'code'
  projectId?: string
  dir: string
  title: string
  created: number
  updated: number
  mode: Mode
  level: string
  model?: ModelRef
  system?: string
  messages: Msg[]
  /** messages before this index are not sent to the model (replaced by a summary) */
  contextStart: number
  /** native thinking blocks before this index are stripped on replay */
  thinkingCut: number
  todos: { text: string; status: 'pending' | 'in_progress' | 'done' }[]
  allow: string[]
  undone?: { messages: Msg[]; snapshot?: string }
  fixRounds: number
  lastCheck?: { status: 'running' | 'passed' | 'failed'; command: string; output: string; time: number }
  lastCheckFingerprint?: string
}

export interface Pending {
  id: string
  sessionId: string
  type: 'permission' | 'question'
  tool?: string
  title?: string
  detail?: string
  questions?: { question: string; options?: string[] }[]
}

export interface ToolCall { id: string; name: string; input: any; invalid?: string }

export interface StreamRequest {
  model: string
  system: string
  messages: Msg[]
  thinkingCut: number
  tools: { name: string; description: string; schema: any }[]
  effort?: 'low' | 'medium' | 'high'
  maxOutput?: number
  signal: AbortSignal
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
}

export interface StreamResult {
  text: string
  reasoning: string
  toolCalls: ToolCall[]
  stop: 'end' | 'tool' | 'length' | 'refusal'
  usage: { input: number; output: number }
  native?: any[]
}

export interface ModelInfo { provider: string; providerName: string; id: string; name: string; context?: number; maxOutput?: number }
