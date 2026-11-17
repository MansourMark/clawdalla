import { useEffect, useState } from 'react'
import { Check, Loader2, Plus, Trash2, X } from 'lucide-react'
import { api } from './api'

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return <section className="set"><h3>{title}</h3>{hint && <p className="muted small">{hint}</p>}{children}</section>
}

export function ProviderKeys({ settings, onChange }: { settings: any; onChange: (s?: any) => void }) {
  const [pid, setPid] = useState('anthropic')
  const [key, setKey] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const preset = settings.providers.find((p: any) => p.id === pid)
  const save = async () => {
    setBusy(true); setErr('')
    try { await api('/providers/' + pid, 'PUT', { key: key || (preset.noKey ? 'none' : ''), baseURL: baseURL || undefined }); setKey(''); setBaseURL(''); onChange() } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="col">
      {settings.providers.filter((p: any) => p.connected).map((p: any) => (
        <div key={p.id} className="row line"><Check size={15} className="ok" /><span className="grow">{p.name}</span><span className="muted small">key saved on the main computer</span>
          <button className="icon-btn" title="Remove" onClick={async () => { await api('/providers/' + p.id, 'DELETE'); onChange() }}><Trash2 size={15} /></button></div>
      ))}
      <div className="row wrap">
        <select className="input fit" value={pid} onChange={(e) => { setPid(e.target.value); setErr('') }}>
          {settings.providers.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {!preset.noKey && <input className="input grow mono" type="password" autoComplete="off" placeholder={preset.keyHint ? `API key (${preset.keyHint})` : 'API key'} value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save() }} />}
        {(preset.needsBaseURL || preset.noKey) && <input className="input grow mono" placeholder={preset.needsBaseURL ? 'Base URL, e.g. https://host/v1' : 'Base URL (optional)'} value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />}
        <button className="btn primary" disabled={busy || (!preset.noKey && !key.trim()) || (preset.needsBaseURL && !baseURL.trim() && !preset.baseURL)} onClick={save}>{busy ? <Loader2 size={15} className="spin" /> : null}Connect</button>
      </div>
      {err && <div className="error-line">{err}</div>}
    </div>
  )
}

export function Settings({ onClose, local }: { onClose: () => void; local: boolean }) {
  const [s, setS] = useState<any>(null)
  const [models, setModels] = useState<any[]>([])
  const [remote, setRemote] = useState<any>(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [pw, setPw] = useState('')
  const [search, setSearch] = useState({ provider: 'tavily', key: '' })
  const [plug, setPlug] = useState({ name: '', target: '' })
  const [push, setPush] = useState<'unknown' | 'on' | 'off' | 'unsupported'>('unknown')

  const load = () => api('/settings').then(setS).catch((e) => setErr(e.message))
  const loadModels = () => api('/models').then(setModels).catch(() => {})
  useEffect(() => { void load(); void loadModels(); api('/remote').then(setRemote).catch(() => {}) }, [])
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return setPush('unsupported')
    navigator.serviceWorker.getRegistration().then((r) => r?.pushManager.getSubscription()).then((sub) => setPush(sub ? 'on' : 'off')).catch(() => setPush('off'))
  }, [])
  const put = async (patch: any) => { setErr(''); try { setS(await api('/settings', 'PUT', patch)) } catch (e: any) { setErr(e.message) } }

  const enablePush = async () => {
    setErr('')
    try {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications were not allowed in this browser.')
      const reg = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
      const { key } = await api('/push/key')
      const pad = '='.repeat((4 - (key.length % 4)) % 4)
      const raw = Uint8Array.from(atob((key + pad).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw })
      await api('/push/subscribe', 'POST', sub.toJSON())
      setPush('on'); await api('/push/test', 'POST')
    } catch (e: any) { setErr(e.message) }
  }

  if (!s) return <div className="settings"><div className="pad muted">{err || <Loader2 size={16} className="spin" />}</div></div>
  const modelValue = (l: string) => (s.levels[l] ? `${s.levels[l].provider}::${s.levels[l].id}` : '')
  return (
    <div className="settings">
      <div className="settings-head"><h1>Settings</h1><button className="icon-btn" onClick={onClose}><X size={19} /></button></div>
      <div className="settings-body">
        {err && <div className="error-line">{err}</div>}
        <Section title="API keys" hint="Keys are stored only on the main computer and are never sent to your other devices.">
          <ProviderKeys settings={s} onChange={() => { void load(); void loadModels() }} />
        </Section>

        <Section title="Levels" hint="Which model each level uses. “Automatic” picks a sensible one from your connected providers.">
          {(['fast', 'medium', 'smart'] as const).map((l) => (
            <label key={l} className="field inline"><span>{l[0].toUpperCase() + l.slice(1)}</span>
              <select className="input" value={modelValue(l)} onChange={(e) => { const [provider, ...rest] = e.target.value.split('::'); void put({ levels: { [l]: e.target.value ? { provider, id: rest.join('::') } : null } }) }}>
                <option value="">Automatic{s.resolvedLevels[l] ? ` (${s.resolvedLevels[l].id})` : ''}</option>
                {models.map((m) => <option key={m.provider + m.id} value={`${m.provider}::${m.id}`}>{m.providerName} · {m.name}</option>)}
              </select>
            </label>
          ))}
        </Section>

        <Section title="Personality">
          <label className="check-row"><input type="checkbox" checked={s.humor} onChange={(e) => put({ humor: e.target.checked })} /><span>Answer with jokes when chatting (always plain while working). Applies to new conversations.</span></label>
        </Section>

        <Section title="Permissions" hint="How much Clawdalla asks before acting on the main computer.">
          {[['all', 'Ask for everything', 'Web access, commands, file changes and plugins all need approval. Reading project files does not.'], ['risky', 'Ask for risky actions', 'Commands, file changes and plugins need approval. Reading and web search run freely.'], ['never', 'Never ask', 'Everything runs without asking. Fastest, but mistakes are not caught first.']].map(([v, t, d]) => (
            <label key={v} className="radio-row"><input type="radio" name="perm" checked={s.permission === v} onChange={() => put({ permission: v })} /><span><b>{t}</b><small>{d}</small></span></label>
          ))}
          <label className="field inline"><span>Automatic fix rounds</span><input className="input fit" type="number" min={0} max={10} value={s.maxFixRounds} onChange={(e) => put({ maxFixRounds: Number(e.target.value) })} /></label>
        </Section>

        <Section title="Web and browser">
          <label className="check-row"><input type="checkbox" checked={s.browserTool} onChange={(e) => put({ browserTool: e.target.checked })} /><span>Let Clawdalla drive its own browser window on the main computer ({navigator.platform.startsWith('Mac') ? 'uses Chrome' : 'uses Edge or Chrome'})</span></label>
          <p className="muted small">Web search works without a key. For more reliable results add a search key{s.websearch?.set ? ` (currently: ${s.websearch.provider})` : ''}.</p>
          <div className="row wrap">
            <select className="input fit" value={search.provider} onChange={(e) => setSearch({ ...search, provider: e.target.value })}><option value="tavily">Tavily</option><option value="brave">Brave Search</option></select>
            <input className="input grow mono" type="password" autoComplete="off" placeholder="Search API key" value={search.key} onChange={(e) => setSearch({ ...search, key: e.target.value })} />
            <button className="btn" disabled={!search.key.trim()} onClick={async () => { await put({ websearch: search }); setSearch({ ...search, key: '' }) }}>Save</button>
            {s.websearch?.set && <button className="btn ghost" onClick={() => put({ websearch: null })}>Remove</button>}
          </div>
        </Section>

        <Section title="Plugins" hint="Add tools through MCP servers: a command to run on the main computer, or a URL.">
          {s.plugins.map((p: any) => (
            <div key={p.name} className="row line"><span className={'dot ' + (p.status === 'ready' ? 'added' : p.status === 'error' ? 'deleted' : 'modified')} /><span className="grow">{p.name}<small className="muted"> · {p.status === 'ready' ? `${p.tools} tools` : p.status === 'error' ? p.error : 'connecting…'}</small></span>
              {p.name !== 'browser' && <button className="icon-btn" onClick={() => { const mcp = { ...s.mcp }; delete mcp[p.name]; void put({ mcp }) }}><Trash2 size={15} /></button>}</div>
          ))}
          <div className="row wrap">
            <input className="input fit" placeholder="Name" value={plug.name} onChange={(e) => setPlug({ ...plug, name: e.target.value })} />
            <input className="input grow mono" placeholder="npx -y some-mcp-server   or   https://host/mcp" value={plug.target} onChange={(e) => setPlug({ ...plug, target: e.target.value })} />
            <button className="btn" disabled={!plug.name.trim() || !plug.target.trim()} onClick={async () => {
              const t = plug.target.trim()
              const def = /^https?:\/\//.test(t) ? { type: 'remote', url: t } : { type: 'local', command: t.split(/\s+/) }
              await put({ mcp: { ...s.mcp, [plug.name.trim().replace(/[^\w-]/g, '_')]: def } }); setPlug({ name: '', target: '' })
            }}><Plus size={15} />Add</button>
          </div>
        </Section>

        <Section title="Other devices" hint="Reach this computer from your phone, tablet and laptop over Tailscale, a free private network between your own devices.">
          {!remote ? <Loader2 size={15} className="spin" /> : !remote.installed ? (
            <p className="small">Tailscale is not installed on the main computer. Install it from <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">tailscale.com/download</a>, sign in, then come back here. Install it on your other devices too, with the same account.</p>
          ) : !remote.running ? <p className="small">Tailscale is installed but not signed in. Open Tailscale on the main computer and sign in.</p> : (
            <div className="col">
              {remote.serving
                ? <p className="small">On your other devices (with Tailscale on), open:<br /><a className="mono" href={remote.url}>{remote.url}</a></p>
                : <><p className="small">Not shared yet. This makes Clawdalla reachable at <span className="mono">{remote.url}</span> for devices in your Tailscale network only.</p>
                  {local ? <button className="btn primary fit" onClick={async () => { setErr(''); try { setRemote({ ...(await api('/remote/enable', 'POST')), port: remote.port, previewPort: remote.previewPort }) } catch (e: any) { setErr(e.message + ' — you may need to enable HTTPS certificates in the Tailscale admin console.') } }}>Turn on secure access</button> : <p className="muted small">Turn this on from the main computer.</p>}</>}
              <p className="muted small">Without the secure link, <span className="mono">{remote.httpUrl}</span> also works on your Tailscale network, but voice input and notifications need the secure link.</p>
            </div>
          )}
        </Section>

        <Section title="Notifications" hint="Get told on this device when a task finishes or needs you. On iPhone, add Clawdalla to the Home Screen first.">
          {push === 'unsupported' ? <p className="muted small">This browser does not support notifications here{location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1' ? ' (needs the secure link)' : ''}.</p>
            : push === 'on' ? <div className="row"><Check size={15} className="ok" /><span>On for this device</span><button className="btn ghost" onClick={() => api('/push/test', 'POST')}>Send a test</button></div>
            : <button className="btn fit" onClick={enablePush}>Turn on for this device</button>}
        </Section>

        <Section title="Security">
          <div className="row wrap">
            <input className="input grow" type="password" autoComplete="new-password" placeholder="New password" value={pw} onChange={(e) => setPw(e.target.value)} />
            <button className="btn" disabled={pw.length < 6} onClick={async () => { await put({ password: pw }); setPw(''); setNote('Password changed.') }}>Change password</button>
          </div>
          <div className="row"><span className="grow small">{s.devices} device{s.devices === 1 ? '' : 's'} signed in</span><button className="btn ghost" onClick={async () => { await api('/logout-all', 'POST'); setNote('All other devices were signed out.'); void load() }}>Sign out all devices</button></div>
          {note && <p className="small ok">{note}</p>}
        </Section>
      </div>
    </div>
  )
}
