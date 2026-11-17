// Projects on the main computer: creation, automatic checks, changes, previews.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import { basename, extname, join, resolve, sep } from 'node:path'
import os from 'node:os'
import type { Store, Project } from './store'
import { git, hasGit, type Snapshots } from './agent/snapshot'
import { runShell } from './agent/tools'
import { agentsMd } from './prompts'

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' }
export const mime = (f: string) => MIME[extname(f).toLowerCase()] || 'application/octet-stream'

export function serveStatic(root: string, urlPath: string, res: http.ServerResponse, spaFallback = true) {
  let rel = decodeURIComponent(urlPath.split('?')[0])
  if (rel.endsWith('/')) rel += 'index.html'
  let file = resolve(join(root, rel))
  if (!file.startsWith(resolve(root) + sep) && file !== resolve(root)) { res.writeHead(403).end(); return }
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (!spaFallback || extname(rel)) { res.writeHead(404).end('Not found'); return }
    file = join(root, 'index.html')
    if (!existsSync(file)) { res.writeHead(404).end('Not found'); return }
  }
  res.writeHead(200, { 'content-type': mime(file), 'cache-control': /\/assets\//.test(file.split(sep).join('/')) ? 'public, max-age=31536000, immutable' : 'no-cache' })
  createReadStream(file).pipe(res)
}

function readJson(f: string) { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return undefined } }

export class Projects {
  private preview?: { projectId: string; child?: ChildProcess; port?: number; staticDir?: string; log: string; status: 'starting' | 'running' | 'stopped' | 'error' }
  previewServer?: http.Server
  constructor(private store: Store, readonly previewPort: number, private snapshots: Snapshots) {}

  list() { return this.store.data.projects.map((p) => ({ ...p, exists: existsSync(p.dir), check: p.checkCommand || this.detectCheck(p.dir) || '', dev: p.devCommand || this.detectDev(p.dir) || '' })) }

  async create(input: { name?: string; dir?: string; idea?: string }): Promise<Project> {
    let dir: string
    let name: string
    if (input.dir) {
      dir = resolve(input.dir)
      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('That folder does not exist.')
      const existing = this.store.data.projects.find((p) => resolve(p.dir) === dir)
      if (existing) return existing
      name = input.name?.trim() || basename(dir)
    } else {
      name = (input.name || 'app').trim().slice(0, 60) || 'app'
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app'
      dir = join(this.store.workspacesDir, slug)
      for (let n = 2; existsSync(dir); n++) dir = join(this.store.workspacesDir, `${slug}-${n}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'AGENTS.md'), agentsMd(name, input.idea || ''))
      if (await hasGit()) {
        try {
          await git(dir, ['init', '-q', '-b', 'main'])
          writeFileSync(join(dir, '.gitignore'), 'node_modules/\ndist/\n.env\n*.log\n')
        } catch { /* git init failed: the project still works, without the Changes panel */ }
      }
    }
    const p: Project = { id: 'prj_' + randomBytes(6).toString('hex'), name, dir, created: Date.now(), autoCheck: true, neverAsk: false }
    this.store.data.projects.unshift(p)
    this.store.save()
    return p
  }
  update(id: string, patch: Partial<Project>) {
    const p = this.store.project(id)
    if (!p) throw new Error('Project not found.')
    for (const k of ['name', 'checkCommand', 'devCommand', 'autoCheck', 'neverAsk'] as const) if (k in patch) (p as any)[k] = (patch as any)[k]
    this.store.save()
    return p
  }
  /** Forget a project. Files stay on disk. */
  remove(id: string) {
    this.store.data.projects = this.store.data.projects.filter((p) => p.id !== id)
    this.store.save()
  }

  // ---------- commands ----------
  private fromAgentsMd(dir: string, key: string) {
    try {
      const m = readFileSync(join(dir, 'AGENTS.md'), 'utf8').match(new RegExp(`^[-*]\\s*${key}\\s*:\\s*\`?([^\`\\n]+?)\`?\\s*$`, 'mi'))
      const v = m?.[1].trim()
      return v && !/^(none|n\/a|-)$/i.test(v) ? v : undefined
    } catch { return undefined }
  }
  detectCheck(dir: string): string | undefined {
    const fromDoc = this.fromAgentsMd(dir, 'check')
    if (fromDoc) return fromDoc
    const pkg = readJson(join(dir, 'package.json'))
    if (pkg) {
      const s = pkg.scripts || {}
      const run = (n: string) => (existsSync(join(dir, 'node_modules')) ? '' : 'npm install; ') + `npm run ${n}`
      if (s.check) return run('check')
      if (s.test && !/no test specified/.test(s.test)) return run('test')
      if (s.typecheck) return run('typecheck')
      if (s.build) return run('build')
      if (s.lint) return run('lint')
      if (existsSync(join(dir, 'tsconfig.json'))) return 'npx tsc --noEmit'
      return undefined
    }
    if (existsSync(join(dir, 'Cargo.toml'))) return 'cargo check'
    if (existsSync(join(dir, 'go.mod'))) return 'go build ./...'
    if (existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'pytest.ini')) || existsSync(join(dir, 'tests'))) return 'python -m pytest -q'
    return undefined
  }
  detectDev(dir: string): string | undefined {
    const fromDoc = this.fromAgentsMd(dir, 'run')
    if (fromDoc) return fromDoc
    const s = readJson(join(dir, 'package.json'))?.scripts || {}
    if (s.dev) return 'npm run dev'
    if (s.start) return 'npm start'
    if (s.serve) return 'npm run serve'
    return undefined
  }

  /** Content hash of the whole working folder, including new files. */
  async fingerprint(dir: string) { return (await this.snapshots.take(dir)) ?? String(Date.now()) }
  async runCheck(p: Project, signal: AbortSignal) {
    const command = p.checkCommand || this.detectCheck(p.dir)
    if (!command) return undefined
    const r = await runShell(command, p.dir, signal, 600000)
    const output = r.output.trim()
    return { command, passed: r.code === 0 && !r.timedOut, output: output.length > 12000 ? output.slice(0, 3000) + '\n…\n' + output.slice(-9000) : output }
  }

  // ---------- changes ----------
  async changes(p: Project) {
    if (!(await hasGit())) return { git: false, reason: 'Git is not installed on the main computer.', files: [] as any[] }
    if (!existsSync(join(p.dir, '.git'))) return { git: false, reason: 'This folder is not a git repository yet.', files: [] as any[] }
    const status = await git(p.dir, ['status', '--porcelain', '-uall'])
    const files: { file: string; status: string; patch: string }[] = []
    const hasHead = await git(p.dir, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false)
    for (const line of status.split('\n').filter(Boolean).slice(0, 200)) {
      const code = line.slice(0, 2)
      const file = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()!
      let patch = ''
      try {
        if (code.includes('?') || !hasHead) {
          const full = join(p.dir, file)
          const st = statSync(full)
          if (st.size < 200000) { const b = readFileSync(full); patch = b.subarray(0, 2000).includes(0) ? '(binary file)' : b.toString('utf8').split('\n').map((l) => '+' + l).join('\n') }
          else patch = '(large file)'
        } else patch = (await git(p.dir, ['diff', 'HEAD', '--', file])).split('\n').slice(4).join('\n')
      } catch { patch = '' }
      files.push({ file, status: code.includes('?') || code.includes('A') ? 'added' : code.includes('D') ? 'deleted' : 'modified', patch: patch.slice(0, 60000) })
    }
    const branch = await git(p.dir, ['branch', '--show-current']).then((s) => s.trim(), () => '')
    return { git: true, branch, files }
  }
  async gitInit(p: Project) { await git(p.dir, ['init', '-q', '-b', 'main']) }
  async commit(p: Project, message: string) {
    await git(p.dir, ['add', '-A'])
    await git(p.dir, ['-c', 'user.name=Clawdalla', '-c', 'user.email=clawdalla@localhost', 'commit', '-q', '-m', message || 'Update'])
  }
  async discard(p: Project, file: string) {
    const tracked = await git(p.dir, ['ls-files', '--error-unmatch', '--', file]).then(() => true, () => false)
    if (tracked) await git(p.dir, ['checkout', 'HEAD', '--', file])
    else await fs.rm(join(p.dir, file), { force: true })
  }

  // ---------- preview ----------
  previewState() { const v = this.preview; return v ? { projectId: v.projectId, status: v.status, port: this.previewPort, log: v.log.slice(-4000), kind: v.staticDir ? 'static' : 'server' } : null }
  stopPreview() {
    const v = this.preview
    if (v?.child?.pid) {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(v.child.pid), '/T', '/F'], { windowsHide: true })
        else process.kill(-v.child.pid, 'SIGKILL')
      } catch { /* already gone */ }
    }
    this.preview = undefined
  }
  async startPreview(p: Project) {
    this.stopPreview()
    this.ensurePreviewServer()
    const command = p.devCommand || this.detectDev(p.dir)
    if (!command) {
      const dir = ['', 'dist', 'public', 'build'].map((d) => join(p.dir, d)).find((d) => existsSync(join(d, 'index.html')))
      if (!dir) throw new Error('No run command or index.html found. Ask the coder to add a run command to AGENTS.md, or set one in the project settings.')
      this.preview = { projectId: p.id, staticDir: dir, log: 'Serving files from ' + dir, status: 'running' }
      return this.previewState()
    }
    const v: NonNullable<Projects['preview']> = { projectId: p.id, log: `$ ${command}\n`, status: 'starting' }
    this.preview = v
    const win = process.platform === 'win32'
    const env = { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' }
    const child = win
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { cwd: p.dir, env, windowsHide: true })
      : spawn('/bin/sh', ['-lc', command], { cwd: p.dir, env, detached: true })
    v.child = child
    const onData = (b: Buffer) => {
      const s = b.toString().replace(/\x1b\[[0-9;]*m/g, '')
      v.log = (v.log + s).slice(-20000)
      if (!v.port) {
        const m = s.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/)
        if (m && +m[1] !== this.previewPort) { v.port = +m[1]; v.status = 'running' }
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('close', (code) => { if (this.preview === v) { v.status = code === 0 ? 'stopped' : 'error'; v.log += `\n[exited ${code}]` } })
    return this.previewState()
  }
  private ensurePreviewServer() {
    if (this.previewServer) return
    const server = http.createServer((req, res) => {
      const v = this.preview
      if (!v) { res.writeHead(503, { 'content-type': 'text/plain' }).end('No preview is running. Start one from Clawdalla.'); return }
      if (v.staticDir) return serveStatic(v.staticDir, req.url || '/', res)
      if (!v.port) { res.writeHead(503, { 'content-type': 'text/html' }).end('<meta http-equiv="refresh" content="2"><body style="font-family:system-ui;padding:2rem">Starting the app…</body>'); return }
      const up = http.request({ host: '127.0.0.1', port: v.port, path: req.url, method: req.method, headers: { ...req.headers, host: `localhost:${v.port}` } }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res) })
      up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('The app is not answering yet.') })
      req.pipe(up)
    })
    server.on('upgrade', (req, socket, head) => {
      const v = this.preview
      if (!v?.port) { socket.destroy(); return }
      const up = http.request({ host: '127.0.0.1', port: v.port, path: req.url, method: req.method, headers: { ...req.headers, host: `localhost:${v.port}` } })
      up.on('upgrade', (r, upSocket, upHead) => {
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(r.headers).map(([k, val]) => `${k}: ${val}`).join('\r\n')}\r\n\r\n`)
        if (upHead.length) socket.write(upHead)
        if (head.length) upSocket.write(head)
        upSocket.pipe(socket); socket.pipe(upSocket)
        upSocket.on('error', () => socket.destroy()); socket.on('error', () => upSocket.destroy())
      })
      up.on('error', () => socket.destroy())
      up.end()
    })
    server.on('error', () => { /* port in use: previews unavailable */ })
    for (const host of bindHosts()) {
      if (host === '127.0.0.1') server.listen(this.previewPort, host)
      else http.createServer((req, res) => server.emit('request', req, res)).on('upgrade', (...a) => server.emit('upgrade', ...a)).on('error', () => {}).listen(this.previewPort, host)
    }
    this.previewServer = server
  }
}

/** Loopback plus any Tailscale address (100.64.0.0/10). Never the public or LAN interfaces. */
export function bindHosts() {
  const hosts = ['127.0.0.1']
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4') continue
      const [x, y] = a.address.split('.').map(Number)
      if (x === 100 && y >= 64 && y <= 127) hosts.push(a.address)
    }
  }
  return hosts
}
