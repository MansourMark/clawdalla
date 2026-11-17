// Clawdalla host server: login, API, live events, static web app.
import http from 'node:http'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
import os from 'node:os'
import { ZipArchive } from 'archiver'
import * as webpush from 'web-push'
import { Store } from './store'
import { Agent } from './agent/agent'
import { Providers, PRESETS } from './agent/providers'
import { Mcp } from './agent/mcp'
import { Snapshots } from './agent/snapshot'
import { Projects, bindHosts, serveStatic } from './projects'
import { runShell } from './agent/tools'
import { newAppPrompt } from './prompts'
import type { Session, Pending } from './agent/types'

export interface ServerOptions { dataDir: string; webDir: string; port?: number; browserCli?: string; version?: string }

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
function hashPassword(pw: string) { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(pw, salt, 32).toString('hex') }
function checkPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(':')
  const a = Buffer.from(hash, 'hex'); const b = scryptSync(pw, salt, 32)
  return a.length === b.length && timingSafeEqual(a, b)
}
class HttpError extends Error { constructor(readonly status: number, msg: string) { super(msg) } }

export async function startServer(opts: ServerOptions) {
  const port = opts.port ?? 4780
  const store = new Store(opts.dataDir)
  const providers = new Providers(store)
  const mcp = new Mcp(store, opts.browserCli)
  const snapshots = new Snapshots(join(opts.dataDir, 'snapshots'))
  const agent = new Agent(store, providers, mcp, snapshots)
  const projects = new Projects(store, port + 1, snapshots)
  void mcp.reload()

  // ---------- live events ----------
  const clients = new Set<http.ServerResponse>()
  const broadcast = (ev: any) => { const line = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(line) }
  agent.on('event', broadcast)
  setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 25000).unref()

  // ---------- push notifications ----------
  function vapid() {
    if (!store.data.vapid) { store.data.vapid = webpush.generateVAPIDKeys(); store.save() }
    return store.data.vapid
  }
  async function notify(title: string, body: string, sessionId?: string) {
    if (!store.data.push.length) return
    const v = vapid()
    const payload = JSON.stringify({ title, body: body.slice(0, 180), sessionId })
    const dead: any[] = []
    await Promise.all(store.data.push.map((sub) => webpush.sendNotification(sub, payload, { vapidDetails: { subject: 'mailto:owner@clawdalla.invalid', publicKey: v.publicKey, privateKey: v.privateKey }, TTL: 3600 }).catch((e: any) => { if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(sub) })))
    if (dead.length) { store.data.push = store.data.push.filter((s) => !dead.includes(s)); store.save() }
  }
  agent.on('waiting', (s: Session, info: Pending) => { void notify(s.title, info.type === 'question' ? 'Has a question for you' : `Needs approval: ${info.title}`, s.id) })

  // ---------- quality harness: run the project's check after the agent edits ----------
  const checking = new Map<string, AbortController>()
  agent.on('idle', async (s: Session, r: { ok: boolean; stopped: boolean; failure: string; edited: boolean }) => {
    const done = (text: string) => notify(s.title, text, s.id)
    if (r.stopped) return
    if (!r.ok) return void done('Stopped with an error: ' + r.failure)
    const p = store.project(s.projectId)
    if (!(s.kind === 'code' && s.mode === 'build' && p?.autoCheck && r.edited)) return void done(s.kind === 'code' ? 'Finished' : 'Replied')
    const fp = await projects.fingerprint(p.dir)
    if (fp === s.lastCheckFingerprint) return void done('Finished')
    const command = p.checkCommand || projects.detectCheck(p.dir)
    if (!command) return void done('Finished (no check command for this project yet)')
    const ac = new AbortController(); checking.set(s.id, ac)
    s.lastCheck = { status: 'running', command, output: '', time: Date.now() }; agent.poke(s.id)
    const res = await projects.runCheck(p, ac.signal).catch(() => undefined)
    checking.delete(s.id)
    if (!res || ac.signal.aborted) { s.lastCheck = undefined; agent.poke(s.id); return }
    s.lastCheck = { status: res.passed ? 'passed' : 'failed', command: res.command, output: res.output, time: Date.now() }
    s.lastCheckFingerprint = await projects.fingerprint(p.dir)
    agent.poke(s.id)
    if (res.passed) return void done('Finished — check passed')
    if (agent.isBusy(s.id)) return
    if (s.fixRounds >= store.data.maxFixRounds) return void done(`Check still failing after ${s.fixRounds} fix rounds`)
    s.fixRounds++
    await agent.send(s.id, { synthetic: 'check', text: `[Automatic check] \`${res.command}\` failed (fix round ${s.fixRounds} of ${store.data.maxFixRounds}). Output:\n\n${res.output}\n\nFix the cause, then finish.` }).catch(() => {})
  })

  // ---------- remote access (Tailscale) ----------
  const tsExe = () => (process.platform === 'win32' && existsSync('C:\\Program Files\\Tailscale\\tailscale.exe') ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : process.platform === 'darwin' && existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale') ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale' : 'tailscale')
  const ts = (args: string[]) => new Promise<string>((res, rej) => execFile(tsExe(), args, { timeout: 20000, windowsHide: true }, (e, out, err) => (e ? rej(new Error((err || e.message).trim())) : res(out))))
  async function remoteStatus() {
    try {
      const j = JSON.parse(await ts(['status', '--json']))
      const name = String(j.Self?.DNSName || '').replace(/\.$/, '')
      let serving = false
      try { serving = (await ts(['serve', 'status'])).includes(String(port)) } catch { /* serve not configured */ }
      return { installed: true, running: j.BackendState === 'Running', name, ips: j.Self?.TailscaleIPs || [], serving, url: name ? `https://${name}` : '', httpUrl: j.Self?.TailscaleIPs?.[0] ? `http://${j.Self.TailscaleIPs[0]}:${port}` : '' }
    } catch { return { installed: false, running: false, name: '', ips: [], serving: false, url: '', httpUrl: '' } }
  }

  // ---------- auth ----------
  const cookieOf = (req: http.IncomingMessage) => (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('cw='))?.slice(3) || ''
  const isLocal = (req: http.IncomingMessage) => { const c = cookieOf(req); return !!c && c === store.data.localToken }
  const authed = (req: http.IncomingMessage) => { const c = cookieOf(req); return !!c && (c === store.data.localToken || !!store.data.tokens[sha(c)]) }
  const setCookie = (req: http.IncomingMessage, res: http.ServerResponse, value: string) => {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
    res.setHeader('set-cookie', `cw=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value ? 31536000 : 0}${secure}`)
  }
  const fails = { count: 0, until: 0 }

  async function body(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of req) { size += c.length; if (size > 60 * 1024 * 1024) throw new HttpError(413, 'Too large.'); chunks.push(c) }
    if (!chunks.length) return {}
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, 'Invalid JSON.') }
  }
  const json = (res: http.ServerResponse, data: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data ?? {})) }

  async function settingsView() {
    const connected = new Set(providers.connected().map((p) => p.id))
    const levels: any = {}
    for (const l of ['fast', 'medium', 'smart'] as const) levels[l] = await providers.pick(l).catch(() => null)
    return {
      ...store.public(),
      providers: PRESETS.map((p) => ({ id: p.id, name: p.name, noKey: !!p.noKey, needsBaseURL: !!p.needsBaseURL, keyHint: p.keyHint, connected: connected.has(p.id), baseURL: store.data.providers[p.id]?.baseURL || '' })),
      resolvedLevels: levels,
      plugins: mcp.status(),
      notifications: store.data.push.length,
    }
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse, path: string, q: URLSearchParams) {
    const m = req.method || 'GET'
    const seg = path.split('/').filter(Boolean).slice(1) // after "api"
    const is = (method: string, ...parts: (string | null)[]) => m === method && seg.length === parts.length && parts.every((p, i) => p === null || p === seg[i])

    if (is('GET', 'state')) return json(res, { setup: !!store.data.passwordHash, authed: authed(req), local: isLocal(req), version: opts.version || 'dev', host: os.hostname() })
    if (is('POST', 'login')) {
      if (Date.now() < fails.until) throw new HttpError(429, 'Too many attempts. Wait a minute.')
      const b = await body(req)
      if (!store.data.passwordHash || !checkPassword(String(b.password || ''), store.data.passwordHash)) {
        if (++fails.count >= 5) { fails.count = 0; fails.until = Date.now() + 60000 }
        throw new HttpError(401, 'Wrong password.')
      }
      fails.count = 0
      const token = randomBytes(32).toString('hex')
      store.data.tokens[sha(token)] = { created: Date.now(), label: String(b.label || req.headers['user-agent'] || 'device').slice(0, 80) }
      store.save()
      setCookie(req, res, token)
      return json(res, { ok: true })
    }
    if (is('POST', 'setup')) {
      if (store.data.passwordHash && !authed(req)) throw new HttpError(403, 'Already set up.')
      if (!store.data.passwordHash && !isLocal(req)) throw new HttpError(403, 'Finish setup on the main computer first.')
      const b = await body(req)
      if (String(b.password || '').length < 6) throw new HttpError(400, 'Use at least 6 characters.')
      store.data.passwordHash = hashPassword(String(b.password)); store.save()
      return json(res, { ok: true })
    }
    if (!authed(req)) throw new HttpError(401, 'Sign in first.')

    if (is('POST', 'logout')) { const c = cookieOf(req); delete store.data.tokens[sha(c)]; store.save(); if (!isLocal(req)) setCookie(req, res, ''); return json(res, { ok: true }) }
    if (is('POST', 'logout-all')) { store.data.tokens = {}; store.save(); return json(res, { ok: true }) }

    if (is('GET', 'events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      res.write('retry: 1500\n\ndata: {"type":"hello"}\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    // settings & providers
    if (is('GET', 'settings')) return json(res, await settingsView())
    if (is('PUT', 'settings')) {
      const b = await body(req); const d = store.data
      if (typeof b.humor === 'boolean') d.humor = b.humor
      if (['all', 'risky', 'never'].includes(b.permission)) d.permission = b.permission
      if (b.levels && typeof b.levels === 'object') for (const l of ['fast', 'medium', 'smart'] as const) if (l in b.levels) d.levels[l] = b.levels[l] && b.levels[l].provider && b.levels[l].id ? { provider: String(b.levels[l].provider), id: String(b.levels[l].id) } : null
      if (typeof b.maxFixRounds === 'number') d.maxFixRounds = Math.max(0, Math.min(10, Math.round(b.maxFixRounds)))
      if ('websearch' in b) d.websearch = b.websearch?.key ? { provider: String(b.websearch.provider || 'tavily'), key: String(b.websearch.key) } : undefined
      let reload = false
      if (typeof b.browserTool === 'boolean' && b.browserTool !== d.browserTool) { d.browserTool = b.browserTool; reload = true }
      if (b.mcp && typeof b.mcp === 'object') { d.mcp = b.mcp; reload = true }
      if (b.password) { if (String(b.password).length < 6) throw new HttpError(400, 'Use at least 6 characters.'); d.passwordHash = hashPassword(String(b.password)) }
      store.save()
      if (reload) await mcp.reload()
      return json(res, await settingsView())
    }
    if (m === 'PUT' && seg[0] === 'providers' && seg.length === 2) {
      const preset = providers.preset(seg[1]); if (!preset) throw new HttpError(404, 'Unknown provider.')
      const b = await body(req)
      const prev = store.data.providers[preset.id]
      store.data.providers[preset.id] = { key: b.key ? String(b.key).trim() : prev?.key, baseURL: b.baseURL ? String(b.baseURL).trim() : prev?.baseURL }
      try {
        const list = await providers.listFor(preset.id)
        store.save(); providers.invalidate()
        return json(res, { ok: true, models: list.length })
      } catch (e: any) {
        if (prev) store.data.providers[preset.id] = prev; else delete store.data.providers[preset.id]
        throw new HttpError(400, 'Could not connect: ' + String(e?.message || e).slice(0, 300))
      }
    }
    if (m === 'DELETE' && seg[0] === 'providers' && seg.length === 2) { delete store.data.providers[seg[1]]; store.save(); providers.invalidate(); return json(res, { ok: true }) }
    if (is('GET', 'models')) return json(res, await providers.models(q.get('refresh') === '1'))

    // sessions
    if (is('GET', 'sessions')) return json(res, agent.list({ kind: q.get('kind') || undefined, projectId: q.get('projectId') || undefined }))
    if (is('POST', 'send')) {
      const b = await body(req)
      if (typeof b.text !== 'string' || (!b.text.trim() && !(b.files?.length))) throw new HttpError(400, 'Nothing to send.')
      let sid: string = b.sessionId
      if (!sid) sid = agent.create({ kind: b.kind === 'code' ? 'code' : 'chat', projectId: b.projectId, mode: b.mode, level: b.level }).id
      const files = Array.isArray(b.files) ? b.files.filter((f: any) => f && typeof f.data === 'string').map((f: any) => ({ name: String(f.name || 'file'), mime: String(f.mime || ''), data: f.data })) : []
      await agent.send(sid, { text: b.text, files, level: b.level, mode: b.mode })
      return json(res, { sessionId: sid })
    }
    if (seg[0] === 'sessions' && seg[1]) {
      const sid = seg[1]
      const s = agent.sessions.get(sid)
      if (!s) throw new HttpError(404, 'Session not found.')
      if (is('GET', 'sessions', null)) return json(res, agent.view(sid))
      if (is('DELETE', 'sessions', null)) { checking.get(sid)?.abort(); agent.remove(sid); return json(res, { ok: true }) }
      if (is('PATCH', 'sessions', null)) { const b = await body(req); if (b.title) agent.rename(sid, String(b.title)); return json(res, { ok: true }) }
      if (is('POST', 'sessions', null, 'stop')) { checking.get(sid)?.abort(); agent.stop(sid); return json(res, { ok: true }) }
      if (is('POST', 'sessions', null, 'undo')) return json(res, { text: await agent.undo(sid) })
      if (is('POST', 'sessions', null, 'redo')) { await agent.redo(sid); return json(res, { ok: true }) }
      if (is('POST', 'sessions', null, 'compact')) { void agent.compactNow(sid); return json(res, { ok: true }) }
      if (is('POST', 'sessions', null, 'reply')) { const b = await body(req); return json(res, { ok: agent.reply(sid, String(b.pendingId), b) }) }
    }

    // projects
    if (is('GET', 'projects')) return json(res, projects.list())
    if (is('POST', 'projects')) {
      const b = await body(req)
      const p = await projects.create({ name: b.name, dir: b.dir, idea: b.idea })
      let sessionId: string | undefined
      if (b.idea && String(b.idea).trim()) {
        const mode = b.planFirst ? 'plan' : 'build'
        if (b.neverAsk) projects.update(p.id, { neverAsk: true })
        const s = agent.create({ kind: 'code', projectId: p.id, mode, level: b.level || 'smart', title: p.name })
        sessionId = s.id
        await agent.send(s.id, { text: newAppPrompt(String(b.idea)), mode, level: b.level || 'smart' })
      }
      return json(res, { project: p, sessionId })
    }
    if (is('GET', 'preview')) return json(res, projects.previewState())
    if (seg[0] === 'projects' && seg[1]) {
      const p = store.project(seg[1])
      if (!p) throw new HttpError(404, 'Project not found.')
      if (is('PATCH', 'projects', null)) return json(res, projects.update(p.id, await body(req)))
      if (is('DELETE', 'projects', null)) { for (const s of agent.list({ projectId: p.id })) agent.remove(s.id); if (projects.previewState()?.projectId === p.id) projects.stopPreview(); projects.remove(p.id); return json(res, { ok: true }) }
      if (is('GET', 'projects', null, 'changes')) return json(res, await projects.changes(p))
      if (is('POST', 'projects', null, 'git-init')) { await projects.gitInit(p); return json(res, { ok: true }) }
      if (is('POST', 'projects', null, 'commit')) { const b = await body(req); await projects.commit(p, String(b.message || '').slice(0, 500)); return json(res, { ok: true }) }
      if (is('POST', 'projects', null, 'discard')) { const b = await body(req); await projects.discard(p, String(b.file)); return json(res, { ok: true }) }
      if (is('POST', 'projects', null, 'check')) { const r = await projects.runCheck(p, new AbortController().signal); return json(res, r || { command: '', passed: false, output: 'No check command found for this project. Set one in the project settings.' }) }
      if (is('POST', 'projects', null, 'run')) { const b = await body(req); const r = await runShell(String(b.command || ''), p.dir, new AbortController().signal, 120000); return json(res, { code: r.code, output: r.output.slice(-40000), timedOut: r.timedOut }) }
      if (is('POST', 'projects', null, 'preview')) return json(res, await projects.startPreview(p))
      if (is('DELETE', 'projects', null, 'preview')) { projects.stopPreview(); return json(res, { ok: true }) }
      if (is('POST', 'projects', null, 'review')) {
        const b = await body(req)
        const s = agent.create({ kind: 'code', projectId: p.id, mode: 'review', level: b.level || 'smart', title: 'Review of changes' })
        await agent.send(s.id, { text: 'Review the uncommitted changes.', mode: 'review', level: b.level || 'smart' })
        return json(res, { sessionId: s.id })
      }
      if (is('GET', 'projects', null, 'zip')) {
        res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${p.name.replace(/[^\w.-]+/g, '_')}.zip"` })
        const zip = new ZipArchive({ zlib: { level: 6 } })
        zip.on('error', () => res.destroy())
        zip.pipe(res)
        zip.glob('**/*', { cwd: p.dir, dot: true, ignore: ['node_modules/**', '.git/**', '**/node_modules/**', '.venv/**', 'target/**'] })
        void zip.finalize()
        return
      }
    }

    // folder picker (main computer)
    if (is('GET', 'fs')) {
      const want = q.get('path') || os.homedir()
      const dir = resolve(want)
      const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$')).map((e) => e.name).sort((a, b) => a.localeCompare(b)).slice(0, 500)
      const roots = process.platform === 'win32' ? 'CDEFGHIJ'.split('').map((d) => d + ':\\').filter((d) => existsSync(d)) : ['/']
      return json(res, { path: dir, parent: dirname(dir) !== dir ? dirname(dir) : null, entries, roots, home: os.homedir(), sep: parse(dir).root.includes('\\') ? '\\' : '/' })
    }

    // notifications
    if (is('GET', 'push', 'key')) return json(res, { key: vapid().publicKey })
    if (is('POST', 'push', 'subscribe')) { const b = await body(req); if (b?.endpoint && !store.data.push.some((s) => s.endpoint === b.endpoint)) { store.data.push.push(b); store.save() } return json(res, { ok: true }) }
    if (is('POST', 'push', 'test')) { await notify('Clawdalla', 'Notifications are working.'); return json(res, { ok: true }) }

    // remote access
    if (is('GET', 'remote')) return json(res, { ...(await remoteStatus()), port, previewPort: port + 1 })
    if (is('POST', 'remote', 'enable')) {
      if (!isLocal(req)) throw new HttpError(403, 'Turn this on from the main computer.')
      await ts(['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`])
      await ts(['serve', '--bg', '--https=8443', `http://127.0.0.1:${port + 1}`]).catch(() => {})
      return json(res, await remoteStatus())
    }
    throw new HttpError(404, 'Not found.')
  }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const url = new URL(req.url || '/', 'http://x')
      // The desktop app on the main computer signs itself in with a one-time local link.
      if (url.pathname === '/' && url.searchParams.get('k') === store.data.localToken) { setCookie(req, res, store.data.localToken); res.writeHead(302, { location: '/' }).end(); return }
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') {
          const origin = req.headers.origin
          if (origin && new URL(origin).host !== req.headers.host && new URL(origin).host !== req.headers['x-forwarded-host']) throw new HttpError(403, 'Cross-site request blocked.')
          if (req.method !== 'DELETE' && !(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'JSON only.')
        }
        return await api(req, res, url.pathname, url.searchParams)
      }
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('referrer-policy', 'no-referrer')
      serveStatic(opts.webDir, url.pathname, res)
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 500
      if (!res.headersSent) json(res, { error: String(e?.message || e) }, status)
      else res.end()
    }
  }

  const servers: http.Server[] = []
  for (const host of bindHosts()) {
    const srv = http.createServer(handler)
    srv.on('error', (e: any) => { if (host === '127.0.0.1') console.error('Clawdalla could not start on port ' + port + ': ' + e.message) })
    await new Promise<void>((ok) => srv.listen(port, host, () => ok()).once('error', () => ok()))
    servers.push(srv)
  }

  return {
    port, store, agent,
    localUrl: `http://127.0.0.1:${port}/?k=${store.data.localToken}`,
    async close() { projects.stopPreview(); projects.previewServer?.close(); for (const s of servers) s.close(); for (const sid of agent.sessions.keys()) agent.stop(sid); await mcp.close() },
  }
}
