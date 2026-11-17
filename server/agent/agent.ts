// Clawdalla's own agent engine: sessions, the model/tool loop, permissions and context management.
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Store, ModelRef, Level } from '../store'
import { Providers, ProviderError, ThinkingInvalid } from './providers'
import { builtinTools, inside, type Tool, type ToolCtx } from './tools'
import type { Mcp } from './mcp'
import type { Snapshots } from './snapshot'
import type { Mode, Msg, Part, Pending, Session } from './types'
import { buildNote, buildSystem, helperSystem, planNote, reviewPrompt, summarizePrompt } from '../prompts'

const id = (p: string) => p + '_' + Date.now().toString(36) + randomBytes(5).toString('hex')
const EFFORT = { fast: 'low', medium: 'medium', smart: 'high' } as const
const HELPER_TOOLS = new Set(['read', 'list', 'glob', 'grep', 'webfetch', 'websearch'])
const MAX_STEPS = 150

interface Runtime {
  busy: boolean
  abort?: AbortController
  queue: Msg[]
  pending: Map<string, { info: Pending; resolve: (v: any) => void }>
  saveTimer?: NodeJS.Timeout
}

export interface SendInput { text: string; files?: { name: string; mime: string; data: string }[]; level?: string; mode?: Mode; synthetic?: Msg['synthetic'] }

export class Agent extends EventEmitter {
  sessions = new Map<string, Session>()
  private rt = new Map<string, Runtime>()

  constructor(private store: Store, readonly providers: Providers, private mcp: Mcp, private snapshots: Snapshots) {
    super()
    this.setMaxListeners(500)
    for (const f of readdirSync(store.sessionsDir)) {
      if (!f.endsWith('.json')) continue
      try {
        const s: Session = JSON.parse(readFileSync(join(store.sessionsDir, f), 'utf8'))
        // A session that was mid-run when the app closed: mark unfinished tools.
        for (const m of s.messages) for (const p of m.parts) if (p.type === 'tool' && (p.status === 'running' || p.status === 'pending')) { p.status = 'error'; p.output = 'Interrupted: the app was closed.' }
        this.sessions.set(s.id, s)
      } catch { /* unreadable session file: skip */ }
    }
  }

  private runtime(sid: string) {
    let r = this.rt.get(sid)
    if (!r) { r = { busy: false, queue: [], pending: new Map() }; this.rt.set(sid, r) }
    return r
  }
  private ev(type: string, data: Record<string, unknown> = {}) { this.emit('event', { type, ...data }) }
  private touch(s: Session, structural = true) {
    s.updated = Date.now()
    const r = this.runtime(s.id)
    if (!r.saveTimer) r.saveTimer = setTimeout(() => { r.saveTimer = undefined; this.persist(s) }, 400)
    if (structural) this.ev('session', { sessionId: s.id })
  }
  private persist(s: Session) {
    if (!this.sessions.has(s.id)) return
    const f = join(this.store.sessionsDir, s.id + '.json')
    try { writeFileSync(f + '.tmp', JSON.stringify(s)); renameSync(f + '.tmp', f) } catch { /* disk problem: keep in memory */ }
  }

  /** Tell listeners a session changed (used by the host after it updates check results). */
  poke(sid: string) { const s = this.sessions.get(sid); if (s) this.touch(s) }

  // ---------- reading ----------
  isBusy(sid: string) { return this.runtime(sid).busy }
  pendingFor(sid: string) { return [...this.runtime(sid).pending.values()].map((p) => p.info) }
  list(filter: { kind?: string; projectId?: string } = {}) {
    return [...this.sessions.values()]
      .filter((s) => (!filter.kind || s.kind === filter.kind) && (!filter.projectId || s.projectId === filter.projectId))
      .sort((a, b) => b.updated - a.updated)
      .map((s) => ({ id: s.id, kind: s.kind, projectId: s.projectId, title: s.title, updated: s.updated, mode: s.mode, busy: this.isBusy(s.id), waiting: this.runtime(s.id).pending.size > 0 }))
  }
  view(sid: string) {
    const s = this.sessions.get(sid)
    if (!s) return undefined
    const messages = s.messages.map((m) => ({
      id: m.id, role: m.role, time: m.time, synthetic: m.synthetic, model: m.model, level: m.level, error: m.error, usage: m.usage, done: m.done, canUndo: m.role === 'user' && !m.synthetic,
      parts: m.parts.filter((p) => !(p.type === 'text' && p.hidden)).map((p) => {
        if (p.type === 'file') return { type: 'file', name: p.name, mime: p.mime, data: p.mime.startsWith('image/') && p.data.length < 3_000_000 ? p.data : undefined }
        if (p.type === 'tool') return { ...p, output: p.output && p.output.length > 20000 ? p.output.slice(0, 20000) + '\n…' : p.output }
        return p
      }),
    }))
    return {
      id: s.id, kind: s.kind, projectId: s.projectId, dir: s.dir, title: s.title, mode: s.mode, level: s.level, model: s.model, updated: s.updated,
      todos: s.todos, messages, busy: this.isBusy(sid), pending: this.pendingFor(sid), canRedo: !!s.undone, lastCheck: s.lastCheck, fixRounds: s.fixRounds,
    }
  }

  // ---------- session lifecycle ----------
  create(opts: { kind: 'chat' | 'code'; projectId?: string; mode?: Mode; level?: string; title?: string }): Session {
    const project = this.store.project(opts.projectId)
    if (opts.kind === 'code' && !project) throw new Error('Project not found.')
    const s: Session = {
      id: id('ses'), kind: opts.kind, projectId: project?.id, dir: project ? project.dir : this.store.chatDir,
      title: opts.title || (opts.kind === 'chat' ? 'New chat' : 'New task'), created: Date.now(), updated: Date.now(),
      mode: opts.kind === 'chat' ? 'chat' : opts.mode || 'build', level: opts.level || 'auto',
      messages: [], contextStart: 0, thinkingCut: 0, todos: [], allow: [], fixRounds: 0,
    }
    this.sessions.set(s.id, s)
    this.persist(s)
    this.ev('sessions')
    return s
  }
  remove(sid: string) {
    this.stop(sid)
    this.sessions.delete(sid)
    const f = join(this.store.sessionsDir, sid + '.json')
    if (existsSync(f)) unlinkSync(f)
    this.rt.delete(sid)
    this.ev('sessions')
  }
  rename(sid: string, title: string) {
    const s = this.sessions.get(sid); if (!s) return
    s.title = title.slice(0, 120); this.touch(s); this.ev('sessions')
  }
  stop(sid: string) {
    const r = this.runtime(sid)
    r.queue = []
    r.abort?.abort()
    for (const p of r.pending.values()) p.resolve({ decision: 'reject', message: 'Stopped by the owner.', answer: 'The owner stopped the task.' })
    r.pending.clear()
  }
  reply(sid: string, pendingId: string, payload: any) {
    const r = this.runtime(sid)
    const p = r.pending.get(pendingId)
    if (!p) return false
    r.pending.delete(pendingId)
    p.resolve(payload)
    this.ev('session', { sessionId: sid })
    this.ev('sessions')
    return true
  }

  // ---------- sending ----------
  private async resolveModel(s: Session, level: string, text: string): Promise<{ ref: ModelRef; level: Level }> {
    let lv = level as Level | 'auto'
    if (lv === 'auto') {
      lv = 'medium'
      try {
        const fast = await this.providers.pick('fast')
        const kind = s.kind === 'code' ? 'a coding task for an agent working in a project' : 'a chat question'
        const ans = (await this.providers.complete(fast,
          'You route requests to one of three model tiers. Reply with exactly one word: FAST, MEDIUM or SMART.\nFAST: greetings, small talk, simple facts, trivial edits or one-line changes.\nMEDIUM: ordinary questions, explanations, routine coding and edits.\nSMART: hard reasoning, tricky debugging, architecture, large or ambiguous builds, anything where a mistake is costly.',
          `This is ${kind}. Request:\n${text.slice(0, 2000)}`)).toUpperCase()
        lv = ans.includes('SMART') ? 'smart' : ans.includes('FAST') ? 'fast' : 'medium'
      } catch { /* classification failed: stay on medium */ }
    }
    return { ref: await this.providers.pick(lv), level: lv }
  }

  async send(sid: string, input: SendInput) {
    const s = this.sessions.get(sid)
    if (!s) throw new Error('Session not found.')
    const r = this.runtime(sid)
    const parts: Part[] = []
    for (const f of input.files || []) parts.push({ type: 'file', name: f.name, mime: f.mime || 'application/octet-stream', data: f.data })
    parts.push({ type: 'text', text: input.text })
    if (s.kind === 'code') {
      const mode = input.mode || s.mode
      const lastMode = s.mode
      const first = !s.messages.some((m) => m.role === 'user')
      if (mode === 'review') parts.push({ type: 'text', text: reviewPrompt, hidden: true })
      else if (first || mode !== lastMode) parts.push({ type: 'text', text: mode === 'plan' ? planNote : buildNote, hidden: true })
      s.mode = mode
    }
    const msg: Msg = { id: id('msg'), role: 'user', parts, time: Date.now(), synthetic: input.synthetic }
    if (input.level) s.level = input.level
    if (!input.synthetic) { s.fixRounds = 0; s.undone = undefined }
    if (r.busy) {
      r.queue.push(msg)
      this.ev('session', { sessionId: sid })
      return
    }
    r.busy = true
    r.abort = new AbortController()
    this.ev('sessions')
    if (s.kind === 'code' && !input.synthetic) msg.snapshot = await this.snapshots.take(s.dir)
    s.messages.push(msg)
    this.touch(s)
    void this.run(s, input.text)
  }

  private toolsFor(_s: Session): Tool[] { return [...builtinTools, ...this.mcp.tools()] }

  private async authorize(s: Session, tool: Tool, input: any, signal: AbortSignal): Promise<string | null> {
    const project = this.store.project(s.projectId)
    const perm = project?.neverAsk ? 'never' : this.store.data.permission
    if ((s.mode === 'plan' || s.mode === 'review') && (tool.name === 'write' || tool.name === 'edit')) {
      return s.mode === 'plan' ? 'Plan mode: file changes are not allowed. Present the plan instead.' : 'Review mode: file changes are not allowed. Report findings instead.'
    }
    let outside = false
    try { outside = !!tool.paths?.(input, s.dir).some((p) => !inside(s.dir, p)) } catch { /* bad path input: the tool will report it */ }
    let key = tool.allowKey ? tool.allowKey(input) : tool.name
    if (outside) key = 'outside:' + tool.name
    let ask = false
    if (perm === 'never') ask = false
    else if (tool.kind === 'read') ask = outside
    else if (tool.kind === 'web') ask = perm === 'all'
    else ask = true
    if (!ask || s.allow.includes(key)) return null
    const info: Pending = {
      id: id('ask'), sessionId: s.id, type: 'permission', tool: tool.name, title: tool.title(input),
      detail: (outside ? 'Outside the working folder.\n' : '') + (tool.name === 'shell' ? String(input.command) : tool.name === 'write' ? String(input.content ?? '').slice(0, 4000) : tool.name === 'edit' ? `- ${String(input.old_string ?? '').slice(0, 2000)}\n+ ${String(input.new_string ?? '').slice(0, 2000)}` : JSON.stringify(input, null, 2).slice(0, 2000)),
    }
    const res = await this.wait(s, info, signal)
    if (res.decision === 'always') { s.allow.push(key); return null }
    if (res.decision === 'once') return null
    return 'The owner declined this action.' + (res.message ? ' They said: ' + res.message : ' Ask what they would like instead, or continue without it.')
  }

  private wait(s: Session, info: Pending, signal: AbortSignal): Promise<any> {
    const r = this.runtime(s.id)
    return new Promise((resolve) => {
      if (signal.aborted) return resolve({ decision: 'reject', answer: 'Stopped.' })
      r.pending.set(info.id, { info, resolve })
      this.ev('session', { sessionId: s.id })
      this.ev('sessions')
      this.emit('waiting', s, info)
    })
  }

  private ctx(s: Session, signal: AbortSignal): ToolCtx {
    return {
      session: s, dir: s.dir, signal,
      websearchKey: this.store.data.websearch,
      changed: () => {},
      ask: async (questions) => {
        const res = await this.wait(s, { id: id('ask'), sessionId: s.id, type: 'question', questions }, signal)
        if (typeof res.answer === 'string') return res.answer
        const answers: string[] = res.answers || []
        return questions.map((q, i) => `Q: ${q.question}\nA: ${answers[i] || '(no answer)'}`).join('\n\n')
      },
      subtask: (prompt) => this.helper(s, prompt, signal),
    }
  }

  /** A read-only helper loop with its own context. */
  private async helper(s: Session, prompt: string, signal: AbortSignal): Promise<string> {
    const ref = s.model || (await this.providers.pick('medium'))
    const tools = builtinTools.filter((t) => HELPER_TOOLS.has(t.name))
    const messages: Msg[] = [{ id: id('msg'), role: 'user', parts: [{ type: 'text', text: prompt }], time: Date.now() }]
    const ctx = this.ctx(s, signal)
    for (let step = 0; step < 40; step++) {
      const res = await this.providers.stream(ref, { model: ref.id, system: helperSystem(s.dir), messages, thinkingCut: 0, tools: tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema })), effort: 'medium', signal })
      const m: Msg = { id: id('msg'), role: 'assistant', parts: [], time: Date.now() }
      if (res.native) m.native = { provider: ref.provider, model: ref.id, content: res.native }
      if (res.text) m.parts.push({ type: 'text', text: res.text })
      for (const c of res.toolCalls) m.parts.push({ type: 'tool', id: c.id, name: c.name, input: c.input, status: 'pending' })
      messages.push(m)
      if (!res.toolCalls.length) return res.text || '(the helper returned nothing)'
      for (const p of m.parts) {
        if (p.type !== 'tool') continue
        const tool = tools.find((t) => t.name === p.name)
        try {
          if (!tool) throw new Error('Unknown tool.')
          if (tool.paths?.(p.input, s.dir).some((x) => !inside(s.dir, x))) throw new Error('The helper may only read inside the working folder.')
          p.output = await tool.run(p.input, ctx); p.status = 'done'
        } catch (e: any) { p.output = String(e?.message || e); p.status = 'error' }
      }
    }
    return 'The helper ran out of steps before finishing.'
  }

  private async compact(s: Session, ref: ModelRef, signal: AbortSignal) {
    const history = s.messages.slice(s.contextStart)
    const ask: Msg = { id: id('msg'), role: 'user', parts: [{ type: 'text', text: summarizePrompt + '\nDo not call any tools; reply with the summary only.' }], time: Date.now() }
    const tools = this.toolsFor(s).map((t) => ({ name: t.name, description: t.description, schema: t.schema }))
    const res = await this.providers.stream(ref, { model: ref.id, system: s.system!, messages: [...history, ask], thinkingCut: Math.max(0, s.thinkingCut - s.contextStart), tools, effort: 'medium', signal })
    if (!res.text.trim()) return
    s.messages.push({ id: id('msg'), role: 'user', synthetic: 'summary', time: Date.now(), parts: [{ type: 'text', text: `[Summary of the conversation so far. Earlier messages are no longer visible to you.]\n\n${res.text.trim()}\n\nContinue the work from here.` }] })
    s.contextStart = s.messages.length - 1
    s.thinkingCut = 0
    this.touch(s)
  }
  async compactNow(sid: string) {
    const s = this.sessions.get(sid)
    const r = this.runtime(sid)
    if (!s || r.busy || !s.system || !s.model) return
    r.busy = true; r.abort = new AbortController(); this.ev('sessions'); this.ev('session', { sessionId: sid })
    try { await this.compact(s, s.model, r.abort.signal) } catch { /* leave the conversation as it was */ }
    r.busy = false; this.ev('sessions'); this.ev('session', { sessionId: sid })
  }

  private async makeTitle(s: Session, text: string) {
    s.title = text.replace(/\s+/g, ' ').slice(0, 48) || s.title
    this.ev('sessions')
    try {
      const fast = await this.providers.pick('fast')
      const t = await this.providers.complete(fast, 'Write a title of three to six words for a conversation that starts with this message. Reply with the title only: no quotes, no punctuation at the end.', text.slice(0, 1500))
      const clean = t.split('\n')[0].replace(/^["'\s]+|["'.\s]+$/g, '').slice(0, 70)
      if (clean) { s.title = clean; this.touch(s, false); this.ev('sessions') }
    } catch { /* keep the truncated title */ }
  }

  private async run(s: Session, firstText: string) {
    const r = this.runtime(s.id)
    const signal = r.abort!.signal
    let ok = true
    let failure = ''
    let edited = false
    try {
      await this.mcp.ready
      const picked = await this.resolveModel(s, s.level, firstText)
      s.model = picked.ref
      if (!s.system) s.system = buildSystem(s, this.store.data.humor)
      if (s.title === 'New chat' || s.title === 'New task') void this.makeTitle(s, firstText)
      const info = await this.providers.info(picked.ref)
      const limit = Math.min((info?.context ?? 200000) * 0.7, 300000)
      const ctx = this.ctx(s, signal)
      ctx.changed = () => { edited = true }
      let retried = 0

      for (let step = 0; step < MAX_STEPS; step++) {
        if (signal.aborted) break
        const lastUsage = [...s.messages].reverse().find((m) => m.role === 'assistant' && m.usage)?.usage?.input ?? 0
        if (lastUsage > limit) { try { await this.compact(s, picked.ref, signal) } catch { /* keep going uncompacted */ } }

        const tools = this.toolsFor(s)
        const cur: Msg = { id: id('msg'), role: 'assistant', parts: [], time: Date.now(), model: picked.ref, level: picked.level }
        s.messages.push(cur)
        this.touch(s)
        const stream = (kind: 'text' | 'reasoning') => (delta: string) => {
          let last = cur.parts[cur.parts.length - 1]
          if (!last || last.type !== kind) { last = { type: kind, text: '' } as Part; cur.parts.push(last) }
          ;(last as any).text += delta
          this.ev('delta', { sessionId: s.id, messageId: cur.id, kind, index: cur.parts.length - 1, offset: (last as any).text.length - delta.length, text: delta })
        }
        let res
        try {
          res = await this.providers.stream(picked.ref, {
            model: picked.ref.id, system: s.system, messages: s.messages.slice(s.contextStart, -1), thinkingCut: Math.max(0, s.thinkingCut - s.contextStart),
            tools: tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema })), effort: EFFORT[picked.level], signal,
            onText: stream('text'), onReasoning: stream('reasoning'),
          })
        } catch (e: any) {
          s.messages.pop()
          if (signal.aborted) break
          if (e instanceof ThinkingInvalid && retried < 2) { retried++; s.thinkingCut = s.messages.length; step--; continue }
          if (e instanceof ProviderError && (e.status === 429 || (e.status ?? 0) >= 500) && retried < 3) { retried++; await new Promise((x) => setTimeout(x, 2000 * retried)); step--; continue }
          throw e
        }
        retried = 0
        cur.usage = res.usage
        if (res.native) cur.native = { provider: picked.ref.provider, model: picked.ref.id, content: res.native }
        if (!cur.parts.some((p) => p.type === 'text') && res.text) cur.parts.push({ type: 'text', text: res.text })
        for (const c of res.toolCalls) {
          const tool = tools.find((t) => t.name === c.name)
          let title = c.name
          try { if (tool) title = tool.title(c.input ?? {}) } catch { /* odd input: keep the name */ }
          cur.parts.push({ type: 'tool', id: c.id, name: c.name, input: c.input, title, status: 'pending' })
        }
        cur.done = true
        this.touch(s)

        if (res.stop === 'refusal') { cur.error = 'The model declined this request.'; ok = false; failure = cur.error; break }
        const calls = cur.parts.filter((p): p is Extract<Part, { type: 'tool' }> => p.type === 'tool')
        if (!calls.length) {
          if (res.stop === 'length') cur.error = 'The reply was cut off at the length limit. Say "continue" to carry on.'
          if (r.queue.length) { s.messages.push(...r.queue.splice(0)); this.touch(s); continue }
          break
        }
        for (const p of calls) {
          if (signal.aborted) { p.status = 'error'; p.output = 'Stopped by the owner.'; continue }
          const call = res.toolCalls.find((c) => c.id === p.id)
          const tool = tools.find((t) => t.name === p.name)
          p.start = Date.now()
          try {
            if (res.stop === 'length') throw new Error('The output was cut off before this tool call was complete. Send it again, in smaller pieces if it is large.')
            if (call?.invalid) throw new Error(call.invalid)
            if (!tool) throw new Error(`Unknown tool "${p.name}".`)
            if (!p.input || typeof p.input !== 'object') throw new Error('Tool input must be a JSON object.')
            const denied = await this.authorize(s, tool, p.input, signal)
            if (denied) { p.status = 'denied'; p.output = denied }
            else {
              p.status = 'running'
              this.touch(s)
              p.output = await tool.run(p.input, ctx)
              p.status = 'done'
            }
          } catch (e: any) {
            p.status = 'error'
            p.output = signal.aborted ? 'Stopped by the owner.' : String(e?.message || e)
          }
          p.end = Date.now()
          this.touch(s)
        }
        if (r.queue.length) { s.messages.push(...r.queue.splice(0)); this.touch(s) }
        if (step === MAX_STEPS - 1) s.messages.push({ id: id('msg'), role: 'note', time: Date.now(), parts: [{ type: 'text', text: 'Stopped after a very long run. Send a message to continue.' }] })
      }
    } catch (e: any) {
      ok = false
      failure = String(e?.message || e)
      s.messages.push({ id: id('msg'), role: 'assistant', parts: [], time: Date.now(), error: failure, done: true })
    }
    const stopped = signal.aborted
    if (stopped) s.messages.push({ id: id('msg'), role: 'note', time: Date.now(), parts: [{ type: 'text', text: 'Stopped.' }] })
    r.busy = false
    r.abort = undefined
    this.touch(s)
    this.persist(s)
    this.ev('sessions')
    this.emit('idle', s, { ok: ok && !stopped, stopped, failure, edited })
  }

  // ---------- undo / redo ----------
  async undo(sid: string): Promise<string> {
    const s = this.sessions.get(sid)
    if (!s || this.isBusy(sid)) throw new Error('Wait for the current task to finish first.')
    let idx = -1
    for (let i = s.messages.length - 1; i >= s.contextStart; i--) if (s.messages[i].role === 'user' && !s.messages[i].synthetic) { idx = i; break }
    if (idx < 0) throw new Error('Nothing to undo.')
    const target = s.messages[idx]
    let after: string | undefined
    if (s.kind === 'code' && target.snapshot) after = await this.snapshots.restore(s.dir, target.snapshot)
    s.undone = { messages: s.messages.splice(idx), snapshot: after }
    s.lastCheck = undefined; s.lastCheckFingerprint = undefined
    s.thinkingCut = Math.min(s.thinkingCut, s.messages.length)
    this.touch(s)
    return target.parts.filter((p) => p.type === 'text' && !p.hidden).map((p: any) => p.text).join('\n')
  }
  async redo(sid: string) {
    const s = this.sessions.get(sid)
    if (!s?.undone || this.isBusy(sid)) throw new Error('Nothing to redo.')
    if (s.kind === 'code' && s.undone.snapshot) await this.snapshots.restore(s.dir, s.undone.snapshot)
    s.messages.push(...s.undone.messages)
    s.undone = undefined
    this.touch(s)
  }
}
