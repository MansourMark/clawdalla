// Talks to model providers. Two wire formats cover everything:
// the Anthropic Messages API (official SDK) and the OpenAI-compatible chat API.
import Anthropic from '@anthropic-ai/sdk'
import type { Store, ModelRef } from '../store'
import type { ModelInfo, Msg, Part, StreamRequest, StreamResult, ToolCall } from './types'

export interface Preset { id: string; name: string; kind: 'anthropic' | 'openai'; baseURL?: string; noKey?: boolean; needsBaseURL?: boolean; keyHint?: string }

export const PRESETS: Preset[] = [
  { id: 'anthropic', name: 'Anthropic (Claude)', kind: 'anthropic', keyHint: 'sk-ant-…' },
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseURL: 'https://api.openai.com/v1', keyHint: 'sk-…' },
  { id: 'google', name: 'Google Gemini', kind: 'openai', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', keyHint: 'AIza…' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai', baseURL: 'https://openrouter.ai/api/v1', keyHint: 'sk-or-…' },
  { id: 'groq', name: 'Groq', kind: 'openai', baseURL: 'https://api.groq.com/openai/v1', keyHint: 'gsk_…' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseURL: 'https://api.deepseek.com/v1' },
  { id: 'xai', name: 'xAI (Grok)', kind: 'openai', baseURL: 'https://api.x.ai/v1' },
  { id: 'mistral', name: 'Mistral', kind: 'openai', baseURL: 'https://api.mistral.ai/v1' },
  { id: 'ollama', name: 'Ollama (on this computer)', kind: 'openai', baseURL: 'http://127.0.0.1:11434/v1', noKey: true },
  { id: 'custom', name: 'Custom (OpenAI-compatible)', kind: 'openai', needsBaseURL: true },
]

export class ThinkingInvalid extends Error {}
export class ProviderError extends Error { constructor(msg: string, readonly status?: number) { super(msg) } }

const IMAGE = /^image\/(png|jpeg|gif|webp)$/
const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|image|audio|realtime|transcribe|rerank|guard|aqa|veo|imagen|sora|speech/i

function fileAsText(p: Extract<Part, { type: 'file' }>) {
  const text = Buffer.from(p.data, 'base64').toString('utf8')
  return `File "${p.name}":\n\`\`\`\n${text.slice(0, 200000)}\n\`\`\``
}
const toolOutput = (p: Extract<Part, { type: 'tool' }>) =>
  p.status === 'done' || p.status === 'error' || p.status === 'denied' ? (p.output || '(no output)') : 'Interrupted before this tool finished.'

export class Providers {
  private modelCache?: { at: number; list: ModelInfo[] }
  private bare = new Set<string>()
  constructor(private store: Store) {}

  preset(id: string) { return PRESETS.find((p) => p.id === id) }
  connected() {
    return PRESETS.filter((p) => {
      const c = this.store.data.providers[p.id]
      return !!c && (p.noKey || !!c.key) && (!p.needsBaseURL || !!c.baseURL)
    })
  }
  private conf(id: string) {
    const p = this.preset(id)
    const c = this.store.data.providers[id]
    if (!p || !c) throw new ProviderError(`Provider "${id}" is not connected. Add its API key in Settings.`)
    return { p, key: c.key || '', baseURL: (c.baseURL || p.baseURL || '').replace(/\/+$/, '') }
  }
  invalidate() { this.modelCache = undefined }

  async listFor(id: string): Promise<ModelInfo[]> {
    const { p, key, baseURL } = this.conf(id)
    if (p.kind === 'anthropic') {
      const client = new Anthropic({ apiKey: key, ...(baseURL ? { baseURL } : {}) })
      const out: ModelInfo[] = []
      for await (const m of client.models.list({ limit: 100 })) {
        const any = m as any
        out.push({ provider: id, providerName: p.name, id: m.id, name: m.display_name || m.id, context: any.max_input_tokens, maxOutput: any.max_tokens })
      }
      return out
    }
    const r = await fetch(baseURL + '/models', { headers: key ? { authorization: 'Bearer ' + key } : {} })
    if (!r.ok) throw new ProviderError(`${p.name}: ${r.status} ${(await r.text()).slice(0, 200)}`, r.status)
    const j: any = await r.json()
    const data: any[] = j.data || j.models || []
    return data
      .map((m) => String(m.id || m.name || '').replace(/^models\//, ''))
      .filter((mid) => mid && !NOT_CHAT.test(mid))
      .map((mid) => ({ provider: id, providerName: p.name, id: mid, name: mid }))
  }

  async models(force = false): Promise<ModelInfo[]> {
    if (!force && this.modelCache && Date.now() - this.modelCache.at < 10 * 60000) return this.modelCache.list
    const lists = await Promise.all(this.connected().map((p) => this.listFor(p.id).catch(() => [] as ModelInfo[])))
    const list = lists.flat()
    this.modelCache = { at: Date.now(), list }
    return list
  }

  /** Choose a model for a level when the owner has not picked one. */
  async pick(level: 'fast' | 'medium' | 'smart'): Promise<ModelRef> {
    const chosen = this.store.data.levels[level]
    if (chosen && this.connected().some((p) => p.id === chosen.provider)) return chosen
    const all = await this.models()
    if (!all.length) throw new ProviderError('No model available yet. Add an API key in Settings.')
    const prefs: Record<string, RegExp[]> = {
      fast: [/^claude-haiku-5-5$/, /haiku/, /gpt-[\d.]+-(mini|nano)/, /flash-lite|flash/, /mini|nano|small|lite|instant|8b/],
      medium: [/^claude-sonnet-5-5$/, /sonnet/, /^gpt-[\d.]+$/, /gemini-[\d.]+-pro/, /deepseek-chat|large|grok-\d(?!.*mini)/],
      smart: [/^claude-opus-5-5$/, /opus/, /^gpt-[\d.]+-pro|^o\d/, /^gpt-[\d.]+$/, /gemini-[\d.]+-pro/, /sonnet|reasoner|large/],
    }
    const order = this.connected().map((p) => p.id)
    for (const pid of order) {
      const mine = all.filter((m) => m.provider === pid)
      for (const re of prefs[level]) {
        const hits = mine.filter((m) => re.test(m.id)).sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))
        if (hits[0]) return { provider: pid, id: hits[0].id }
      }
    }
    return { provider: all[0].provider, id: all[0].id }
  }

  async info(ref: ModelRef) { return (await this.models()).find((m) => m.provider === ref.provider && m.id === ref.id) }

  stream(ref: ModelRef, req: StreamRequest): Promise<StreamResult> {
    const { p } = this.conf(ref.provider)
    return p.kind === 'anthropic' ? this.anthropic(ref, req) : this.openai(ref, req)
  }

  /** One-shot text completion, no tools. */
  async complete(ref: ModelRef, system: string, user: string, signal?: AbortSignal): Promise<string> {
    const msg: Msg = { id: 'x', role: 'user', parts: [{ type: 'text', text: user }], time: Date.now() }
    const r = await this.stream(ref, { model: ref.id, system, messages: [msg], thinkingCut: 0, tools: [], effort: 'low', signal: signal ?? new AbortController().signal })
    return r.text.trim()
  }

  // ---------- Anthropic ----------
  private anthropicMessages(req: StreamRequest, provider: string): Anthropic.MessageParam[] {
    const out: Anthropic.MessageParam[] = []
    req.messages.forEach((m, i) => {
      if (m.role === 'note') return
      if (m.role === 'user') {
        const content: Anthropic.ContentBlockParam[] = []
        for (const p of m.parts) {
          if (p.type === 'file') {
            if (IMAGE.test(p.mime)) content.push({ type: 'image', source: { type: 'base64', media_type: p.mime as any, data: p.data } })
            else if (p.mime === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data } })
            else content.push({ type: 'text', text: fileAsText(p) })
          }
        }
        for (const p of m.parts) if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text })
        if (content.length) out.push({ role: 'user', content })
        return
      }
      const tools = m.parts.filter((p): p is Extract<Part, { type: 'tool' }> => p.type === 'tool')
      let content: any[]
      if (m.native && m.native.provider === provider && m.native.model === req.model) {
        content = i < req.thinkingCut ? m.native.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') : m.native.content
      } else {
        content = []
        for (const p of m.parts) {
          if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text })
          if (p.type === 'tool') content.push({ type: 'tool_use', id: p.id, name: p.name, input: p.input ?? {} })
        }
      }
      if (!content.length) return
      out.push({ role: 'assistant', content })
      if (tools.length) {
        out.push({
          role: 'user',
          content: tools.map((t) => ({ type: 'tool_result' as const, tool_use_id: t.id, content: toolOutput(t), is_error: t.status === 'error' || t.status === 'denied' })),
        })
      }
    })
    return out
  }

  private async anthropic(ref: ModelRef, req: StreamRequest): Promise<StreamResult> {
    const { key, baseURL } = this.conf(ref.provider)
    const client = new Anthropic({ apiKey: key, ...(baseURL ? { baseURL } : {}) })
    const info = await this.info(ref)
    const base = {
      model: req.model,
      max_tokens: Math.min(req.maxOutput ?? 64000, info?.maxOutput ?? 64000),
      system: req.system,
      messages: this.anthropicMessages(req, ref.provider),
    }
    const run = async (bare: boolean) => {
      const params: any = { ...base }
      if (req.tools.length) params.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema, ...(bare ? {} : { eager_input_streaming: true }) }))
      if (!bare) {
        params.cache_control = { type: 'ephemeral' }
        if (req.effort) params.output_config = { effort: req.effort }
      }
      const stream = client.messages.stream(params, { signal: req.signal })
      if (req.onText) stream.on('text', (d) => req.onText!(d))
      if (req.onReasoning) stream.on('thinking', (d) => req.onReasoning!(d))
      return stream.finalMessage()
    }
    let msg: Anthropic.Message
    try {
      msg = await run(this.bare.has(req.model))
    } catch (e) {
      if (e instanceof Anthropic.BadRequestError) {
        if (/signature/i.test(e.message)) throw new ThinkingInvalid(e.message)
        if (this.bare.has(req.model)) throw new ProviderError(e.message, 400)
        // Older models reject some optional parameters: retry once without them and remember.
        this.bare.add(req.model)
        try { msg = await run(true) } catch (e2) {
          if (e2 instanceof Anthropic.BadRequestError && /signature/i.test(e2.message)) throw new ThinkingInvalid(e2.message)
          if (e2 instanceof Anthropic.APIError) throw new ProviderError(e2.message, e2.status)
          throw e2
        }
      } else if (e instanceof Anthropic.AuthenticationError) {
        throw new ProviderError('Anthropic rejected the API key. Check it in Settings.', 401)
      } else if (e instanceof Anthropic.RateLimitError) {
        throw new ProviderError('Anthropic rate limit reached. Try again in a moment.', 429)
      } else if (e instanceof Anthropic.APIError) {
        throw new ProviderError(e.message, e.status)
      } else throw e
    }
    const toolCalls: ToolCall[] = []
    let text = ''
    let reasoning = ''
    for (const b of msg.content) {
      if (b.type === 'text') text += b.text
      else if (b.type === 'thinking') reasoning += b.thinking
      else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, input: b.input })
    }
    const u = msg.usage
    return {
      text, reasoning, toolCalls, native: msg.content,
      stop: msg.stop_reason === 'tool_use' ? 'tool' : msg.stop_reason === 'max_tokens' ? 'length' : msg.stop_reason === 'refusal' ? 'refusal' : 'end',
      usage: { input: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens },
    }
  }

  // ---------- OpenAI-compatible ----------
  private openaiMessages(req: StreamRequest) {
    const out: any[] = [{ role: 'system', content: req.system }]
    for (const m of req.messages) {
      if (m.role === 'note') continue
      if (m.role === 'user') {
        const content: any[] = []
        for (const p of m.parts) {
          if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text })
          if (p.type === 'file') {
            if (IMAGE.test(p.mime)) content.push({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } })
            else if (p.mime === 'application/pdf') content.push({ type: 'text', text: `(PDF "${p.name}" attached, but this provider cannot read PDFs here.)` })
            else content.push({ type: 'text', text: fileAsText(p) })
          }
        }
        if (!content.length) continue
        out.push({ role: 'user', content: content.every((c) => c.type === 'text') ? content.map((c) => c.text).join('\n\n') : content })
        continue
      }
      const text = m.parts.filter((p) => p.type === 'text').map((p: any) => p.text).join('')
      const tools = m.parts.filter((p): p is Extract<Part, { type: 'tool' }> => p.type === 'tool')
      if (!text && !tools.length) continue
      const a: any = { role: 'assistant', content: text || null }
      if (tools.length) a.tool_calls = tools.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } }))
      out.push(a)
      for (const t of tools) out.push({ role: 'tool', tool_call_id: t.id, content: toolOutput(t) })
    }
    return out
  }

  private async openai(ref: ModelRef, req: StreamRequest): Promise<StreamResult> {
    const { p, key, baseURL } = this.conf(ref.provider)
    const body: any = { model: req.model, messages: this.openaiMessages(req), stream: true }
    if (!this.bare.has(ref.provider + '/' + req.model)) body.stream_options = { include_usage: true }
    if (req.tools.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }))
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (key) headers.authorization = 'Bearer ' + key
    if (ref.provider === 'openrouter') { headers['x-title'] = 'Clawdalla' }
    let r!: Response
    for (let attempt = 0; ; attempt++) {
      r = await fetch(baseURL + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal })
      if (r.ok) break
      const errText = (await r.text()).slice(0, 400)
      if (r.status === 400 && body.stream_options) { delete body.stream_options; this.bare.add(ref.provider + '/' + req.model); continue }
      if ((r.status === 429 || r.status >= 500) && attempt < 3) { await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt)); continue }
      if (r.status === 401 || r.status === 403) throw new ProviderError(`${p.name} rejected the API key. Check it in Settings.`, r.status)
      throw new ProviderError(`${p.name} error ${r.status}: ${errText}`, r.status)
    }
    const reader = r.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let text = ''
    let reasoning = ''
    let finish = ''
    const usage = { input: 0, output: 0 }
    const calls: { id: string; name: string; args: string }[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        let j: any
        try { j = JSON.parse(data) } catch { continue }
        if (j.error) throw new ProviderError(`${p.name}: ${j.error.message || JSON.stringify(j.error)}`)
        if (j.usage) { usage.input = j.usage.prompt_tokens ?? usage.input; usage.output = j.usage.completion_tokens ?? usage.output }
        const c = j.choices?.[0]
        if (!c) continue
        if (c.finish_reason) finish = c.finish_reason
        const d = c.delta || {}
        const rs = d.reasoning_content ?? d.reasoning
        if (typeof rs === 'string' && rs) { reasoning += rs; req.onReasoning?.(rs) }
        if (typeof d.content === 'string' && d.content) { text += d.content; req.onText?.(d.content) }
        for (const tc of d.tool_calls || []) {
          const idx = tc.index ?? calls.length
          const cur = (calls[idx] ??= { id: '', name: '', args: '' })
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name += tc.function.name
          if (tc.function?.arguments) cur.args += tc.function.arguments
        }
      }
    }
    const toolCalls: ToolCall[] = calls.filter(Boolean).map((c, n) => {
      const id = c.id || `call_${Date.now().toString(36)}_${n}`
      try { return { id, name: c.name, input: c.args ? JSON.parse(c.args) : {} } } catch { return { id, name: c.name, input: {}, invalid: 'The tool arguments were not valid JSON. Send the call again with valid JSON.' } }
    })
    return { text, reasoning, toolCalls, usage, stop: toolCalls.length ? 'tool' : finish === 'length' ? 'length' : finish === 'content_filter' ? 'refusal' : 'end' }
  }
}
