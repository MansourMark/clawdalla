import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, CornerLeftUp, Download, ExternalLink, Folder, GitCommitHorizontal, Loader2, Play, RefreshCw, Square, Trash2, Undo2, X } from 'lucide-react'
import { api, type Project } from './api'

function Diff({ patch }: { patch: string }) {
  return (
    <pre className="diff">
      {patch.split('\n').map((l, i) => <div key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>{l || ' '}</div>)}
    </pre>
  )
}

export function Panel({ project, tick, onClose, onReview, onProjectChanged }: { project: Project; tick: number; onClose: () => void; onReview: () => void; onProjectChanged: () => void }) {
  const [tab, setTab] = useState<'changes' | 'run' | 'preview' | 'project'>('changes')
  const [changes, setChanges] = useState<any>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [cmd, setCmd] = useState('')
  const [out, setOut] = useState('')
  const [preview, setPreview] = useState<any>(null)
  const [remote, setRemote] = useState<any>(null)
  const [form, setForm] = useState({ name: project.name, checkCommand: project.checkCommand || '', devCommand: project.devCommand || '', autoCheck: project.autoCheck, neverAsk: project.neverAsk })

  const act = async (label: string, fn: () => Promise<void>) => { setBusy(label); setErr(''); try { await fn() } catch (e: any) { setErr(e.message) } finally { setBusy('') } }
  const loadChanges = useCallback(() => api(`/projects/${project.id}/changes`).then(setChanges).catch((e) => setErr(e.message)), [project.id])
  useEffect(() => { setForm({ name: project.name, checkCommand: project.checkCommand || '', devCommand: project.devCommand || '', autoCheck: project.autoCheck, neverAsk: project.neverAsk }) }, [project.id])
  useEffect(() => { if (tab === 'changes') void loadChanges() }, [tab, tick, loadChanges])
  useEffect(() => {
    if (tab !== 'preview') return
    const load = () => api('/preview').then(setPreview).catch(() => {})
    void load(); api('/remote').then(setRemote).catch(() => {})
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [tab])

  const previewUrl = location.protocol === 'https:' ? `https://${location.hostname}:8443` : `http://${location.hostname}:${remote?.previewPort || Number(location.port || 4780) + 1}`
  const mine = preview && preview.projectId === project.id

  return (
    <aside className="panel">
      <div className="panel-head">
        <div className="tabs">
          {(['changes', 'run', 'preview', 'project'] as const).map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
        </div>
        <button className="icon-btn" onClick={onClose}><X size={17} /></button>
      </div>
      <div className="panel-body">
        {err && <div className="error-line">{err}</div>}
        {tab === 'changes' && (
          !changes ? <div className="muted pad"><Loader2 size={15} className="spin" /></div>
          : !changes.git ? (
            <div className="pad">
              <p className="muted">{changes.reason}</p>
              {changes.reason?.includes('not a git') && <button className="btn" onClick={() => act('init', async () => { await api(`/projects/${project.id}/git-init`, 'POST'); await loadChanges() })}>Start tracking changes</button>}
            </div>
          ) : (
            <>
              <div className="row pad-s">
                <span className="muted grow">{changes.files.length ? `${changes.files.length} changed file${changes.files.length > 1 ? 's' : ''}` : 'No uncommitted changes'}{changes.branch ? ` · ${changes.branch}` : ''}</span>
                <button className="icon-btn" title="Refresh" onClick={() => void loadChanges()}><RefreshCw size={15} /></button>
              </div>
              {changes.files.map((f: any) => (
                <div key={f.file} className="file">
                  <button className="file-head" onClick={() => setOpen(open === f.file ? null : f.file)}>
                    <ChevronRight size={14} className={'chev' + (open === f.file ? ' open' : '')} />
                    <span className={'dot ' + f.status} /><span className="file-name">{f.file}</span>
                    <span className="icon-btn sm" title="Discard this file's changes" onClick={(e) => { e.stopPropagation(); if (confirm(`Discard changes to ${f.file}? This cannot be undone.`)) void act('discard', async () => { await api(`/projects/${project.id}/discard`, 'POST', { file: f.file }); await loadChanges() }) }}><Undo2 size={13} /></span>
                  </button>
                  {open === f.file && <Diff patch={f.patch} />}
                </div>
              ))}
              {changes.files.length > 0 && (
                <div className="pad-s col">
                  <input className="input" placeholder="Commit message" value={msg} onChange={(e) => setMsg(e.target.value)} />
                  <div className="row">
                    <button className="btn primary" disabled={!!busy} onClick={() => act('commit', async () => { await api(`/projects/${project.id}/commit`, 'POST', { message: msg || 'Update' }); setMsg(''); await loadChanges() })}><GitCommitHorizontal size={15} />Commit</button>
                    <button className="btn" disabled={!!busy} onClick={onReview}>Review</button>
                  </div>
                </div>
              )}
            </>
          )
        )}
        {tab === 'run' && (
          <div className="pad col">
            <div className="row">
              <button className="btn" disabled={!!busy} onClick={() => act('check', async () => { const r = await api(`/projects/${project.id}/check`, 'POST'); setOut(`$ ${r.command}\n${r.output}\n\n${r.passed ? '✓ Check passed' : '✗ Check failed'}`) })}>{busy === 'check' ? <Loader2 size={15} className="spin" /> : <Play size={15} />}Run check</button>
              <span className="muted small">{project.check || 'No check command yet'}</span>
            </div>
            <form className="row" onSubmit={(e) => { e.preventDefault(); if (cmd.trim()) void act('run', async () => { const r = await api(`/projects/${project.id}/run`, 'POST', { command: cmd }); setOut(`$ ${cmd}\n${r.output}\n[exit ${r.code}]`) }) }}>
              <input className="input mono" placeholder="Run a command in this project" value={cmd} onChange={(e) => setCmd(e.target.value)} />
              <button className="btn" disabled={!!busy}>{busy === 'run' ? <Loader2 size={15} className="spin" /> : 'Run'}</button>
            </form>
            {out && <pre className="output">{out}</pre>}
          </div>
        )}
        {tab === 'preview' && (
          <div className="pad col">
            <p className="muted small">Runs the app on the main computer and opens it here. One preview at a time. {project.dev ? <>Command: <code>{project.dev}</code></> : 'No run command yet — a plain index.html is served as files.'}</p>
            <div className="row">
              {mine && preview.status !== 'stopped' && preview.status !== 'error'
                ? <button className="btn" onClick={() => act('stop', async () => { await api(`/projects/${project.id}/preview`, 'DELETE'); setPreview(null) })}><Square size={14} />Stop</button>
                : <button className="btn primary" disabled={!!busy} onClick={() => act('start', async () => { setPreview(await api(`/projects/${project.id}/preview`, 'POST')) })}><Play size={15} />Start preview</button>}
              {mine && preview.status === 'running' && <a className="btn" href={previewUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open</a>}
              {mine && <span className="muted small">{preview.status}</span>}
            </div>
            {mine && preview.log && <pre className="output">{preview.log}</pre>}
          </div>
        )}
        {tab === 'project' && (
          <div className="pad col">
            <label className="field"><span>Name</span><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field"><span>Folder</span><input className="input mono" value={project.dir} readOnly /></label>
            <label className="field"><span>Check command</span><input className="input mono" placeholder={project.check || 'e.g. npm test'} value={form.checkCommand} onChange={(e) => setForm({ ...form, checkCommand: e.target.value })} /></label>
            <label className="field"><span>Run command (preview)</span><input className="input mono" placeholder={project.dev || 'e.g. npm run dev'} value={form.devCommand} onChange={(e) => setForm({ ...form, devCommand: e.target.value })} /></label>
            <label className="check-row"><input type="checkbox" checked={form.autoCheck} onChange={(e) => setForm({ ...form, autoCheck: e.target.checked })} /><span>Run the check after every change and send failures back to the coder</span></label>
            <label className="check-row"><input type="checkbox" checked={form.neverAsk} onChange={(e) => setForm({ ...form, neverAsk: e.target.checked })} /><span>Never ask before acting in this project</span></label>
            <div className="row">
              <button className="btn primary" onClick={() => act('save', async () => { await api(`/projects/${project.id}`, 'PATCH', { ...form, checkCommand: form.checkCommand || undefined, devCommand: form.devCommand || undefined }); onProjectChanged() })}>Save</button>
              <a className="btn" href={`/api/projects/${project.id}/zip`}><Download size={15} />Download zip</a>
              <span className="grow" />
              <button className="btn ghost danger" onClick={() => { if (confirm(`Remove "${project.name}" from Clawdalla? Its conversations are deleted. The files stay on the main computer.`)) void act('remove', async () => { await api(`/projects/${project.id}`, 'DELETE'); onProjectChanged(); onClose() }) }}><Trash2 size={15} />Remove</button>
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}

export function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <div className="modal-head"><h2>{title}</h2><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        {children}
      </div>
    </div>
  )
}

export function NewApp({ onClose, onCreated }: { onClose: () => void; onCreated: (projectId: string, sessionId?: string) => void }) {
  const [idea, setIdea] = useState('')
  const [name, setName] = useState('')
  const [planFirst, setPlanFirst] = useState(true)
  const [neverAsk, setNeverAsk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const create = async () => {
    setBusy(true); setErr('')
    try {
      const auto = idea.trim().split(/\s+/).slice(0, 4).join(' ')
      const r = await api('/projects', 'POST', { name: name.trim() || auto || 'New app', idea, planFirst, neverAsk, level: 'smart' })
      onCreated(r.project.id, r.sessionId)
    } catch (e: any) { setErr(e.message); setBusy(false) }
  }
  return (
    <Modal title="New app" onClose={onClose}>
      <div className="col">
        <label className="field"><span>What should it be?</span><textarea className="input" rows={5} autoFocus placeholder="Describe the app idea. It is built on your main computer, so you can close this device and check back later." value={idea} onChange={(e) => setIdea(e.target.value)} /></label>
        <label className="field"><span>Name (optional)</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="check-row"><input type="checkbox" checked={planFirst} onChange={(e) => setPlanFirst(e.target.checked)} /><span>Plan first, then build when I say go</span></label>
        <label className="check-row"><input type="checkbox" checked={neverAsk} onChange={(e) => setNeverAsk(e.target.checked)} /><span>Don't ask before each action in this project</span></label>
        {err && <div className="error-line">{err}</div>}
        <div className="row end"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !idea.trim()} onClick={create}>{busy ? <Loader2 size={15} className="spin" /> : null}Start</button></div>
      </div>
    </Modal>
  )
}

export function OpenFolder({ onClose, onCreated }: { onClose: () => void; onCreated: (projectId: string) => void }) {
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState('')
  const load = (path?: string) => api('/fs' + (path ? '?path=' + encodeURIComponent(path) : '')).then((d) => { setData(d); setErr('') }).catch((e) => setErr(e.message))
  useEffect(() => { void load() }, [])
  return (
    <Modal title="Open a folder on the main computer" onClose={onClose}>
      <div className="col">
        {data && (
          <>
            <div className="row wrap">
              {data.roots.map((r: string) => <button key={r} className="btn chip" onClick={() => load(r)}>{r}</button>)}
              <button className="btn chip" onClick={() => load(data.home)}>Home</button>
            </div>
            <div className="path mono">{data.path}</div>
            <div className="folder-list">
              {data.parent && <button className="folder" onClick={() => load(data.parent)}><CornerLeftUp size={15} />Up</button>}
              {data.entries.map((e: string) => <button key={e} className="folder" onClick={() => load(data.path.replace(/[\\/]$/, '') + data.sep + e)}><Folder size={15} />{e}</button>)}
              {!data.entries.length && <div className="muted pad-s">No folders here.</div>}
            </div>
          </>
        )}
        {err && <div className="error-line">{err}</div>}
        <div className="row end"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!data} onClick={async () => { try { const r = await api('/projects', 'POST', { dir: data.path }); onCreated(r.project.id) } catch (e: any) { setErr(e.message) } }}>Open this folder</button></div>
      </div>
    </Modal>
  )
}
