import { useCallback, useEffect, useRef, useState } from 'react'
import { Code2, FolderOpen, Loader2, Menu, MessageCircle, MoreHorizontal, PanelRight, Plus, Redo2, Settings as Cog, Trash2, Undo2, WifiOff } from 'lucide-react'
import { api, timeAgo, type Project, type SessionItem, type SessionView } from './api'
import { Composer, Thread, type ComposerState } from './Thread'
import { NewApp, OpenFolder, Panel } from './Coder'
import { ProviderKeys, Settings } from './Settings'

type Section = 'chat' | 'code'
const saved = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d } catch { return d } }
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } }

function Gate({ boot, onDone }: { boot: any; onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (path: string) => { setBusy(true); setErr(''); try { await api(path, 'POST', { password: pw }); onDone() } catch (e: any) { setErr(e.message) } finally { setBusy(false) } }
  const setup = !boot.setup
  return (
    <div className="gate">
      <div className="gate-card">
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>Clawdalla</h1>
        {setup && !boot.local ? <p className="muted">Finish setting up Clawdalla on the main computer first, then come back.</p> : (
          <form className="col" onSubmit={(e) => { e.preventDefault(); void submit(setup ? '/setup' : '/login') }}>
            <p className="muted">{setup ? 'Choose a password. Your other devices use it to sign in to this computer.' : `Sign in to ${boot.host || 'your main computer'}.`}</p>
            <input className="input" type="password" autoFocus autoComplete={setup ? 'new-password' : 'current-password'} placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
            {err && <div className="error-line">{err}</div>}
            <button className="btn primary" disabled={busy || pw.length < (setup ? 6 : 1)}>{setup ? 'Continue' : 'Sign in'}</button>
          </form>
        )}
      </div>
    </div>
  )
}

export function App() {
  const [boot, setBoot] = useState<any>(null)
  const [section, setSection] = useState<Section>(() => saved('section', 'chat'))
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [chatId, setChatId] = useState<string | null>(() => saved('chatId', null))
  const [projectId, setProjectId] = useState<string | null>(() => saved('projectId', null))
  const [codeId, setCodeId] = useState<string | null>(() => saved('codeId', null))
  const [view, setView] = useState<SessionView | null>(null)
  const [settings, setSettings] = useState<any>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [panel, setPanel] = useState<boolean>(() => window.innerWidth > 1100 && saved<boolean>('panel', false))
  const [modal, setModal] = useState<'new' | 'open' | null>(null)
  const [menu, setMenu] = useState(false)
  const [online, setOnline] = useState(true)
  const [tick, setTick] = useState(0)
  const [err, setErr] = useState('')
  const [chatComposer, setChatComposer] = useState<ComposerState>(() => ({ text: '', level: saved('chatLevel', 'auto'), mode: 'build' }))
  const [codeComposer, setCodeComposer] = useState<ComposerState>(() => ({ text: '', level: saved('codeLevel', 'auto'), mode: 'build' }))

  const activeId = section === 'chat' ? chatId : codeId
  const activeRef = useRef(activeId); activeRef.current = activeId
  const project = projects.find((p) => p.id === projectId) || null

  const loadBoot = useCallback(() => api('/state').then(setBoot).catch(() => setBoot({ error: true })), [])
  const loadLists = useCallback(async () => {
    const [s, p] = await Promise.all([api<SessionItem[]>('/sessions'), api<Project[]>('/projects')])
    setSessions(s); setProjects(p)
  }, [])
  const loadView = useCallback(async (sid: string | null) => {
    if (!sid) return setView(null)
    try { const v = await api<SessionView>('/sessions/' + sid); if (activeRef.current === sid) setView(v) }
    catch { if (activeRef.current === sid) { setView(null); if (section === 'chat') setChatId(null); else setCodeId(null) } }
  }, [section])

  useEffect(() => { void loadBoot() }, [loadBoot])
  useEffect(() => { save('section', section); save('chatId', chatId); save('projectId', projectId); save('codeId', codeId); save('panel', panel); save('chatLevel', chatComposer.level); save('codeLevel', codeComposer.level) }, [section, chatId, projectId, codeId, panel, chatComposer.level, codeComposer.level])
  useEffect(() => { setView(null); void loadView(activeId) }, [activeId, loadView])
  useEffect(() => { if (view && section === 'code' && (view.mode === 'plan' || view.mode === 'build')) setCodeComposer((c) => ({ ...c, mode: view.mode as any })) }, [view?.id])

  // live updates from the main computer
  useEffect(() => {
    if (!boot?.authed) return
    void loadLists(); api('/settings').then(setSettings).catch(() => {})
    let listTimer: any, viewTimer: any
    const es = new EventSource('/api/events')
    es.onopen = () => { setOnline(true); void loadLists(); void loadView(activeRef.current) }
    es.onerror = () => setOnline(false)
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data)
      if (ev.type === 'sessions') { clearTimeout(listTimer); listTimer = setTimeout(loadLists, 150) }
      else if (ev.type === 'session' && ev.sessionId === activeRef.current) { clearTimeout(viewTimer); viewTimer = setTimeout(() => { void loadView(activeRef.current); setTick((t) => t + 1) }, 60) }
      else if (ev.type === 'delta' && ev.sessionId === activeRef.current) {
        setView((v) => {
          if (!v) return v
          const mi = v.messages.findIndex((m) => m.id === ev.messageId)
          if (mi < 0) return v
          const m = v.messages[mi]
          const parts = [...m.parts]
          const cur: any = parts[ev.index]
          if (!cur && ev.index === parts.length) parts.push({ type: ev.kind, text: ev.text })
          else if (cur && cur.type === ev.kind && cur.text.length >= ev.offset) parts[ev.index] = { ...cur, text: cur.text.slice(0, ev.offset) + ev.text }
          else { clearTimeout(viewTimer); viewTimer = setTimeout(() => loadView(activeRef.current), 60); return v }
          const messages = [...v.messages]; messages[mi] = { ...m, parts }
          return { ...v, messages }
        })
      }
    }
    const onMsg = (e: MessageEvent) => { if (e.data?.openSession) openSession(e.data.openSession) }
    navigator.serviceWorker?.addEventListener('message', onMsg)
    return () => { es.close(); clearTimeout(listTimer); clearTimeout(viewTimer); navigator.serviceWorker?.removeEventListener('message', onMsg) }
  }, [boot?.authed])

  const openSession = (sid: string) => {
    api<SessionView>('/sessions/' + sid).then((v) => {
      if (v.kind === 'chat') { setSection('chat'); setChatId(sid) } else { setSection('code'); setProjectId(v.projectId || null); setCodeId(sid) }
    }).catch(() => {})
  }
  useEffect(() => { const m = location.hash.match(/s=(\w+)/); if (m && boot?.authed) { openSession(m[1]); history.replaceState(null, '', '/') } }, [boot?.authed])

  const send = async (text: string, files: any[]) => {
    setErr('')
    const c = section === 'chat' ? chatComposer : codeComposer
    try {
      const r = await api('/send', 'POST', { sessionId: activeId || undefined, kind: section, projectId: section === 'code' ? projectId : undefined, text, files, level: c.level, mode: section === 'code' ? c.mode : undefined })
      if (section === 'chat') setChatId(r.sessionId); else setCodeId(r.sessionId)
      void loadView(r.sessionId)
    } catch (e: any) { setErr(e.message); throw e }
  }
  const stop = () => activeId && api(`/sessions/${activeId}/stop`, 'POST')
  const undo = async () => { if (!activeId) return; try { const r = await api(`/sessions/${activeId}/undo`, 'POST'); const set = section === 'chat' ? setChatComposer : setCodeComposer; set((c) => ({ ...c, text: view?.messages.some((m) => m.role === 'user' && !m.synthetic) ? r.text : c.text })) } catch (e: any) { setErr(e.message) } }
  const remove = async (sid: string) => { if (!confirm('Delete this conversation?')) return; await api('/sessions/' + sid, 'DELETE'); if (chatId === sid) setChatId(null); if (codeId === sid) setCodeId(null) }

  if (!boot) return <div className="gate"><Loader2 className="spin" /></div>
  if (boot.error) return <div className="gate"><div className="gate-card"><WifiOff /><p>Cannot reach the main computer.</p><button className="btn" onClick={loadBoot}>Try again</button></div></div>
  if (!boot.setup || !boot.authed) return <Gate boot={boot} onDone={loadBoot} />

  const noKey = settings && !settings.providers.some((p: any) => p.connected)
  const list = sessions.filter((s) => (section === 'chat' ? s.kind === 'chat' : s.kind === 'code' && s.projectId === projectId))
  const composer = section === 'chat' ? chatComposer : codeComposer
  const setComposer = section === 'chat' ? setChatComposer : setCodeComposer
  const canUndo = !!view && !view.busy && view.messages.some((m) => m.role === 'user' && !m.synthetic)

  const empty = noKey ? (
    <div className="hero">
      <img src="/icon.svg" alt="" width={48} height={48} />
      <h2>Add an API key to start</h2>
      <p className="muted">Paste a key from any provider. It stays on the main computer.</p>
      <div className="hero-card"><ProviderKeys settings={settings} onChange={() => api('/settings').then(setSettings)} /></div>
    </div>
  ) : section === 'chat' ? (
    <div className="hero"><img src="/icon.svg" alt="" width={48} height={48} /><h2>What's on your mind?</h2><p className="muted">Ask anything. Clawdalla can search the web and use tools on your main computer.</p></div>
  ) : !project ? (
    <div className="hero">
      <Code2 size={40} strokeWidth={1.5} />
      <h2>Clawdalla Coder</h2>
      <p className="muted">Describe an app and it gets built on your main computer, or open an existing folder.</p>
      <div className="row"><button className="btn primary" onClick={() => setModal('new')}><Plus size={16} />New app</button><button className="btn" onClick={() => setModal('open')}><FolderOpen size={16} />Open folder</button></div>
    </div>
  ) : (
    <div className="hero"><Code2 size={40} strokeWidth={1.5} /><h2>{project.name}</h2><p className="muted mono small">{project.dir}</p><p className="muted">Say what to build or change. Plan first to agree on an approach; Build to do the work.</p></div>
  )

  return (
    <div className={'app' + (drawer ? ' drawer-open' : '')}>
      <nav className="sidebar">
        <div className="brand">
          <div className="seg">
            <button className={section === 'chat' ? 'on' : ''} onClick={() => { setSection('chat'); setShowSettings(false) }}><MessageCircle size={15} />Clawdalla</button>
            <button className={section === 'code' ? 'on' : ''} onClick={() => { setSection('code'); setShowSettings(false) }}><Code2 size={15} />Coder</button>
          </div>
        </div>
        {section === 'chat' ? (
          <button className="new" onClick={() => { setChatId(null); setShowSettings(false); setDrawer(false) }}><Plus size={16} />New chat</button>
        ) : (
          <div className="row new-row">
            <button className="new" onClick={() => setModal('new')}><Plus size={16} />New app</button>
            <button className="new icon" title="Open a folder" onClick={() => setModal('open')}><FolderOpen size={16} /></button>
          </div>
        )}
        <div className="list">
          {section === 'code' && projects.map((p) => (
            <div key={p.id} className="proj">
              <button className={'item proj-item' + (p.id === projectId ? ' on' : '')} onClick={() => { setProjectId(p.id); setCodeId(sessions.find((s) => s.projectId === p.id)?.id || null); setShowSettings(false) }}>
                <span className="grow ell">{p.name}</span>
                {sessions.some((s) => s.projectId === p.id && s.waiting) ? <span className="badge wait" /> : sessions.some((s) => s.projectId === p.id && s.busy) ? <Loader2 size={13} className="spin" /> : null}
              </button>
              {p.id === projectId && (
                <div className="sub">
                  <button className={'item' + (!codeId ? ' on' : '')} onClick={() => { setCodeId(null); setDrawer(false) }}><Plus size={13} />New task</button>
                  {list.map((s) => <SessionRow key={s.id} s={s} on={s.id === codeId} onOpen={() => { setCodeId(s.id); setShowSettings(false); setDrawer(false) }} onDelete={() => remove(s.id)} />)}
                </div>
              )}
            </div>
          ))}
          {section === 'chat' && list.map((s) => <SessionRow key={s.id} s={s} on={s.id === chatId} onOpen={() => { setChatId(s.id); setShowSettings(false); setDrawer(false) }} onDelete={() => remove(s.id)} />)}
          {section === 'chat' && !list.length && <div className="muted small pad-s">No chats yet.</div>}
          {section === 'code' && !projects.length && <div className="muted small pad-s">No projects yet.</div>}
        </div>
        <div className="side-foot">
          <button className={'item' + (showSettings ? ' on' : '')} onClick={() => { setShowSettings(true); setDrawer(false) }}><Cog size={16} />Settings</button>
          {!online && <span className="offline" title="Reconnecting to the main computer"><WifiOff size={14} /></span>}
        </div>
      </nav>
      <div className="drawer-scrim" onClick={() => setDrawer(false)} />

      {showSettings ? <Settings local={boot.local} onClose={() => { setShowSettings(false); api('/settings').then(setSettings) }} /> : (
        <main className="main">
          <header className="top">
            <button className="icon-btn only-mobile" onClick={() => setDrawer(true)}><Menu size={19} /></button>
            <div className="title ell">{view?.title || (section === 'chat' ? 'New chat' : project?.name || 'Coder')}</div>
            {view?.busy && <Loader2 size={15} className="spin muted" />}
            <span className="grow" />
            {view?.canRedo && <button className="icon-btn" title="Redo" onClick={() => api(`/sessions/${view.id}/redo`, 'POST').catch((e) => setErr(e.message))}><Redo2 size={17} /></button>}
            {canUndo && <button className="icon-btn" title={section === 'code' ? 'Undo the last request and its file changes' : 'Undo the last message'} onClick={undo}><Undo2 size={17} /></button>}
            {view && (
              <div className="level">
                <button className="icon-btn" onClick={() => setMenu(!menu)}><MoreHorizontal size={18} /></button>
                {menu && <><div className="scrim clear" onClick={() => setMenu(false)} /><div className="menu down right">
                  <button className="menu-item" onClick={() => { setMenu(false); const t = prompt('Rename', view.title); if (t) void api('/sessions/' + view.id, 'PATCH', { title: t }).then(() => loadView(view.id)) }}>Rename</button>
                  <button className="menu-item" onClick={() => { setMenu(false); void api(`/sessions/${view.id}/compact`, 'POST') }}>Summarise to save space</button>
                  <button className="menu-item danger" onClick={() => { setMenu(false); void remove(view.id) }}><Trash2 size={14} />Delete</button>
                </div></>}
              </div>
            )}
            {section === 'code' && project && <button className={'icon-btn' + (panel ? ' on' : '')} title="Changes, run and preview" onClick={() => setPanel(!panel)}><PanelRight size={18} /></button>}
          </header>
          <Thread view={view} empty={empty} />
          {err && <div className="error-line center">{err}</div>}
          {!(section === 'code' && !project) && !noKey && (
            <Composer kind={section} busy={!!view?.busy} state={composer} onChange={setComposer} onSend={send} onStop={stop} />
          )}
        </main>
      )}
      {!showSettings && section === 'code' && project && panel && (
        <Panel project={project} tick={tick} onClose={() => setPanel(false)} onProjectChanged={loadLists}
          onReview={async () => { try { const r = await api(`/projects/${project.id}/review`, 'POST', {}); setCodeId(r.sessionId); if (window.innerWidth < 1100) setPanel(false) } catch (e: any) { setErr(e.message) } }} />
      )}
      {modal === 'new' && <NewApp onClose={() => setModal(null)} onCreated={(pid, sid) => { setModal(null); setDrawer(false); void loadLists(); setSection('code'); setProjectId(pid); setCodeId(sid || null) }} />}
      {modal === 'open' && <OpenFolder onClose={() => setModal(null)} onCreated={(pid) => { setModal(null); setDrawer(false); void loadLists(); setSection('code'); setProjectId(pid); setCodeId(null) }} />}
    </div>
  )
}

function SessionRow({ s, on, onOpen, onDelete }: { s: SessionItem; on: boolean; onOpen: () => void; onDelete: () => void }) {
  return (
    <div className={'item session' + (on ? ' on' : '')} onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }}>
      <span className="grow ell">{s.title}</span>
      {s.waiting ? <span className="badge wait" title="Needs you" /> : s.busy ? <Loader2 size={13} className="spin" /> : <span className="ago">{timeAgo(s.updated)}</span>}
      <button className="del" title="Delete" onClick={(e) => { e.stopPropagation(); onDelete() }}><Trash2 size={13} /></button>
    </div>
  )
}
