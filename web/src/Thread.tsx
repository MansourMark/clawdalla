import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { ArrowUp, Check, ChevronRight, CircleAlert, FileText, Loader2, Mic, Paperclip, Square, Volume2, X, Zap, Gauge, Brain, Sparkles } from 'lucide-react'
import { api, fileToAttachment, isElectron, isTouch, type Msg, type Part, type Pending, type SessionView } from './api'

marked.setOptions({ gfm: true, breaks: true })
const md = (s: string) => DOMPurify.sanitize(marked.parse(s, { async: false }) as string, { ADD_ATTR: ['target'] })

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => md(text), [text])
  return (
    <div
      className="md"
      onClick={(e) => {
        const t = e.target as HTMLElement
        const a = t.closest('a')
        if (a) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noreferrer') }
        const pre = t.closest('pre')
        if (pre && e.detail === 2) void navigator.clipboard?.writeText(pre.innerText)
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function ToolRow({ p }: { p: Extract<Part, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const icon = p.status === 'running' || p.status === 'pending' ? <Loader2 size={14} className="spin" /> : p.status === 'done' ? <Check size={14} /> : <CircleAlert size={14} />
  return (
    <div className={'tool ' + p.status}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-icon">{icon}</span>
        <span className="tool-title">{p.title || p.name}</span>
        <ChevronRight size={14} className={'chev' + (open ? ' open' : '')} />
      </button>
      {open && (
        <div className="tool-body">
          {p.name !== 'shell' && p.name !== 'read' && <pre>{JSON.stringify(p.input, null, 2)?.slice(0, 6000)}</pre>}
          {p.output && <pre>{p.output}</pre>}
        </div>
      )}
    </div>
  )
}

function speak(text: string) {
  speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text.replace(/```[\s\S]*?```/g, ' code block ').replace(/[*_#`>]/g, ''))
  speechSynthesis.speak(u)
}

function Message({ m, last, busy }: { m: Msg; last: boolean; busy: boolean }) {
  if (m.role === 'note') return <div className="note">{m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}</div>
  if (m.role === 'user') {
    if (m.synthetic === 'summary') return <div className="note">Earlier conversation was summarised to save space.</div>
    const text = m.parts.filter((p) => p.type === 'text').map((p: any) => p.text).join('\n')
    if (m.synthetic === 'check') return <details className="note check-note"><summary>Automatic check failed — fixing</summary><pre>{text}</pre></details>
    return (
      <div className="msg user">
        <div className="bubble">
          {m.parts.map((p, i) => p.type === 'file' ? (p.data ? <img key={i} className="attach-img" src={`data:${p.mime};base64,${p.data}`} alt={p.name} /> : <div key={i} className="attach-chip"><FileText size={14} />{p.name}</div>) : null)}
          {text && <div className="user-text">{text}</div>}
        </div>
      </div>
    )
  }
  const text = m.parts.filter((p) => p.type === 'text').map((p: any) => p.text).join('\n')
  const empty = !m.parts.length && !m.error
  return (
    <div className="msg assistant">
      {m.parts.map((p, i) => {
        if (p.type === 'text') return p.text ? <Markdown key={i} text={p.text} /> : null
        if (p.type === 'reasoning') return p.text.trim() ? <details key={i} className="reasoning"><summary>Thinking</summary><div>{p.text}</div></details> : null
        if (p.type === 'tool') return <ToolRow key={p.id} p={p} />
        return null
      })}
      {empty && last && busy && <div className="dots"><i /><i /><i /></div>}
      {m.error && <div className="error-line"><CircleAlert size={15} />{m.error}</div>}
      {text && m.done && !(last && busy) && 'speechSynthesis' in window && (
        <div className="msg-actions">
          <button title="Read aloud" onClick={() => speak(text)}><Volume2 size={15} /></button>
          {m.level && <span className="tag">{m.level}</span>}
        </div>
      )}
    </div>
  )
}

function PendingCard({ sid, p }: { sid: string; p: Pending }) {
  const [answers, setAnswers] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const reply = async (payload: any) => { setBusy(true); try { await api(`/sessions/${sid}/reply`, 'POST', { pendingId: p.id, ...payload }) } finally { setBusy(false) } }
  if (p.type === 'permission') {
    return (
      <div className="card ask">
        <div className="card-title">Allow this?</div>
        <div className="ask-what">{p.title}</div>
        {p.detail && <pre className="ask-detail">{p.detail}</pre>}
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => reply({ decision: 'once' })}>Allow once</button>
          <button className="btn" disabled={busy} onClick={() => reply({ decision: 'always' })}>Always allow</button>
          <button className="btn ghost" disabled={busy} onClick={() => reply({ decision: 'reject' })}>Deny</button>
        </div>
      </div>
    )
  }
  const qs = p.questions || []
  return (
    <div className="card ask">
      {qs.map((q, i) => (
        <div key={i} className="q">
          <div className="card-title">{q.question}</div>
          <div className="row wrap">
            {(q.options || []).map((o) => <button key={o} className={'btn chip' + (answers[i] === o ? ' on' : '')} onClick={() => setAnswers((a) => { const n = [...a]; n[i] = o; return n })}>{o}</button>)}
          </div>
          <input className="input" placeholder="Or type your answer" value={q.options?.includes(answers[i]) ? '' : answers[i] || ''} onChange={(e) => setAnswers((a) => { const n = [...a]; n[i] = e.target.value; return n })} />
        </div>
      ))}
      <div className="row">
        <button className="btn primary" disabled={busy || !qs.every((_, i) => answers[i]?.trim())} onClick={() => reply({ answers })}>Answer</button>
      </div>
    </div>
  )
}

const LEVELS = [
  { id: 'auto', label: 'Auto', icon: Sparkles, hint: 'Picks a level for each message' },
  { id: 'fast', label: 'Fast', icon: Zap, hint: 'Quick answers' },
  { id: 'medium', label: 'Medium', icon: Gauge, hint: 'Everyday work' },
  { id: 'smart', label: 'Smart', icon: Brain, hint: 'Hard problems' },
]

export interface ComposerState { text: string; level: string; mode: 'build' | 'plan' }

export function Composer(props: {
  kind: 'chat' | 'code'; busy: boolean; state: ComposerState; onChange: (s: ComposerState) => void
  onSend: (text: string, files: { name: string; mime: string; data: string }[]) => Promise<void>; onStop: () => void; placeholder?: string
}) {
  const { state, onChange } = props
  const [files, setFiles] = useState<{ name: string; mime: string; data: string }[]>([])
  const [listening, setListening] = useState(false)
  const [menu, setMenu] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const rec = useRef<any>(null)
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  const canVoice = !!SR && !isElectron

  const fit = () => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 220) + 'px' } }
  useLayoutEffect(fit, [state.text])
  useEffect(() => { const id = setTimeout(fit, 250); window.addEventListener('resize', fit); window.addEventListener('load', fit); return () => { clearTimeout(id); window.removeEventListener('resize', fit); window.removeEventListener('load', fit) } }, [])

  const send = async () => {
    const text = state.text.trim()
    if (!text && !files.length) return
    const f = files
    onChange({ ...state, text: '' }); setFiles([])
    try { await props.onSend(text, f) } catch { onChange({ ...state, text }); setFiles(f) }
  }
  const addFiles = async (list: FileList | File[]) => {
    const next: { name: string; mime: string; data: string }[] = []
    for (const f of Array.from(list)) { if (f.size > 20 * 1024 * 1024) continue; next.push(await fileToAttachment(f)) }
    setFiles((cur) => [...cur, ...next])
  }
  const toggleMic = () => {
    if (listening) { rec.current?.stop(); return }
    const r = new SR(); rec.current = r
    r.continuous = true; r.interimResults = true; r.lang = navigator.language
    const base = state.text ? state.text + ' ' : ''
    r.onresult = (e: any) => { let t = ''; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; onChange({ ...state, text: base + t }) }
    r.onend = () => setListening(false)
    r.onerror = () => setListening(false)
    r.start(); setListening(true)
  }
  const lv = LEVELS.find((l) => l.id === state.level) || LEVELS[0]

  return (
    <div className="composer-wrap">
      <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files) }}>
        {files.length > 0 && (
          <div className="row wrap files">
            {files.map((f, i) => <span key={i} className="attach-chip"><FileText size={13} />{f.name}<button onClick={() => setFiles(files.filter((_, n) => n !== i))}><X size={12} /></button></span>)}
          </div>
        )}
        <textarea
          ref={ta} rows={1} value={state.text} placeholder={props.placeholder || (props.kind === 'chat' ? 'Ask anything' : 'What should I build or change?')}
          onChange={(e) => onChange({ ...state, text: e.target.value })}
          onPaste={(e) => { const fs = Array.from(e.clipboardData.files); if (fs.length) { e.preventDefault(); void addFiles(fs) } }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !isTouch && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }}
        />
        <div className="composer-bar">
          <button className="icon-btn" title="Attach files" onClick={() => fileInput.current?.click()}><Paperclip size={17} /></button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = '' }} />
          <div className="level">
            <button className="pill" onClick={() => setMenu(!menu)}><lv.icon size={14} />{lv.label}</button>
            {menu && (
              <>
                <div className="scrim clear" onClick={() => setMenu(false)} />
                <div className="menu up">
                  {LEVELS.map((l) => (
                    <button key={l.id} className={'menu-item' + (l.id === state.level ? ' on' : '')} onClick={() => { onChange({ ...state, level: l.id }); setMenu(false) }}>
                      <l.icon size={15} /><span><b>{l.label}</b><small>{l.hint}</small></span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {props.kind === 'code' && (
            <div className="seg small">
              <button className={state.mode === 'plan' ? 'on' : ''} onClick={() => onChange({ ...state, mode: 'plan' })}>Plan</button>
              <button className={state.mode === 'build' ? 'on' : ''} onClick={() => onChange({ ...state, mode: 'build' })}>Build</button>
            </div>
          )}
          <span className="grow" />
          {canVoice && <button className={'icon-btn' + (listening ? ' live' : '')} title="Speak" onClick={toggleMic}><Mic size={17} /></button>}
          {props.busy && !state.text.trim() && !files.length
            ? <button className="send stop" title="Stop" onClick={props.onStop}><Square size={14} fill="currentColor" /></button>
            : <button className="send" title="Send" disabled={!state.text.trim() && !files.length} onClick={() => void send()}><ArrowUp size={18} /></button>}
        </div>
      </div>
    </div>
  )
}

export function Thread({ view, empty }: { view: SessionView | null; empty: React.ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => { stick.current = true }, [view?.id])
  useLayoutEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight })
  const msgs = view?.messages || []
  return (
    <div className="thread" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
      <div className="thread-inner">
        {!msgs.length && empty}
        {msgs.map((m, i) => <Message key={m.id} m={m} last={i === msgs.length - 1} busy={!!view?.busy} />)}
        {view && view.todos.length > 0 && view.busy && (
          <div className="todos">
            {view.todos.map((t, i) => <div key={i} className={'todo ' + t.status}><span className="box">{t.status === 'done' ? <Check size={11} /> : t.status === 'in_progress' ? <Loader2 size={11} className="spin" /> : null}</span>{t.text}</div>)}
          </div>
        )}
        {view?.lastCheck && (
          <details className={'check ' + view.lastCheck.status}>
            <summary>{view.lastCheck.status === 'running' ? <Loader2 size={14} className="spin" /> : view.lastCheck.status === 'passed' ? <Check size={14} /> : <CircleAlert size={14} />}
              {view.lastCheck.status === 'running' ? 'Running the project check…' : view.lastCheck.status === 'passed' ? 'Check passed' : 'Check failed'}
              <code>{view.lastCheck.command.slice(0, 60)}</code>
            </summary>
            {view.lastCheck.output && <pre>{view.lastCheck.output}</pre>}
          </details>
        )}
        {view?.pending.map((p) => <PendingCard key={p.id} sid={view.id} p={p} />)}
        {view?.busy && msgs.length > 0 && msgs[msgs.length - 1].role !== 'assistant' && !view.pending.length && <div className="msg assistant"><div className="dots"><i /><i /><i /></div></div>}
      </div>
    </div>
  )
}
