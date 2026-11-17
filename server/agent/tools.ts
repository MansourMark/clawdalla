// Built-in tools the agent can call. Each returns plain text for the model.
import { spawn } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Session } from './types'

export interface ToolCtx {
  session: Session
  dir: string
  signal: AbortSignal
  ask(questions: { question: string; options?: string[] }[]): Promise<string>
  subtask(prompt: string): Promise<string>
  websearchKey?: { provider: string; key: string }
  changed(): void
}
export interface Tool {
  name: string
  description: string
  schema: any
  /** read = safe, web = leaves the computer, act = changes things */
  kind: 'read' | 'web' | 'act'
  /** key used for "always allow" */
  allowKey?: (input: any) => string
  title(input: any): string
  paths?: (input: any, dir: string) => string[]
  run(input: any, ctx: ToolCtx): Promise<string>
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__', '.venv', 'venv', '.cache', 'release', '.turbo', 'coverage'])
const MAX_OUT = 30000
const clip = (s: string, n = MAX_OUT) => (s.length > n ? s.slice(0, n / 2) + `\n\n… [${s.length - n} characters omitted] …\n\n` + s.slice(-n / 2) : s)
export const abs = (dir: string, p: string) => (isAbsolute(p) ? resolve(p) : resolve(dir, p))
export const inside = (dir: string, p: string) => { const r = relative(resolve(dir), resolve(p)); return !r.startsWith('..') && !isAbsolute(r) }
const obj = (properties: any, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const need = (input: any, keys: string[]) => { for (const k of keys) if (typeof input?.[k] !== 'string' || !input[k]) throw new Error(`Missing required parameter "${k}".`) }

async function* walk(root: string, signal: AbortSignal): AsyncGenerator<string> {
  const stack = [root]
  while (stack.length) {
    if (signal.aborted) return
    const d = stack.pop()!
    let entries
    try { entries = await fs.readdir(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP.has(e.name)) stack.push(join(d, e.name)) }
      else if (e.isFile()) yield join(d, e.name)
    }
  }
}

export function globToRegex(glob: string) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1 }
      else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') { const end = glob.indexOf('}', i); if (end < 0) re += '\\{'; else { re += '(?:' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = end } }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$', 'i')
}

export function runShell(command: string, cwd: string, signal: AbortSignal, timeoutMs = 120000, onData?: (s: string) => void): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((done) => {
    const win = process.platform === 'win32'
    const child = win
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { cwd, windowsHide: true })
      : spawn(existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', ['-lc', command], { cwd, detached: true })
    let output = ''
    let timedOut = false
    const kill = () => {
      try {
        if (win) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        else process.kill(-child.pid!, 'SIGKILL')
      } catch { /* already gone */ }
    }
    const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
    const onAbort = () => kill()
    signal.addEventListener('abort', onAbort)
    const add = (b: Buffer) => { const s = b.toString(); output += s; if (output.length > 400000) output = output.slice(-300000); onData?.(s) }
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    child.on('error', (e) => { output += String(e) })
    child.on('close', (code) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); done({ code, output, timedOut }) })
  })
}

function htmlToText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => `${t.replace(/<[^>]+>/g, '')} (${href})`)
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim()
}

async function search(query: string, ctx: ToolCtx): Promise<string> {
  const k = ctx.websearchKey
  if (k?.key && k.provider === 'tavily') {
    const r = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + k.key }, body: JSON.stringify({ query, max_results: 8 }), signal: ctx.signal })
    if (!r.ok) throw new Error(`Search failed: ${r.status} ${(await r.text()).slice(0, 200)}`)
    const j: any = await r.json()
    return (j.results || []).map((x: any, i: number) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${String(x.content || '').slice(0, 400)}`).join('\n\n') || 'No results.'
  }
  if (k?.key && k.provider === 'brave') {
    const r = await fetch('https://api.search.brave.com/res/v1/web/search?count=8&q=' + encodeURIComponent(query), { headers: { 'x-subscription-token': k.key, accept: 'application/json' }, signal: ctx.signal })
    if (!r.ok) throw new Error(`Search failed: ${r.status}`)
    const j: any = await r.json()
    return (j.web?.results || []).map((x: any, i: number) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${htmlToText(x.description || '')}`).join('\n\n') || 'No results.'
  }
  // No key: fall back to DuckDuckGo's plain HTML results.
  const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), { headers: { 'user-agent': 'Mozilla/5.0 (compatible; assistant)' }, signal: ctx.signal })
  if (!r.ok) throw new Error(`Search failed: ${r.status}`)
  const html = await r.text()
  const out: string[] = []
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g
  let m
  while ((m = re.exec(html)) && out.length < 8) {
    let url = m[1].replace(/&amp;/g, '&')
    const u = url.match(/[?&]uddg=([^&]+)/)
    if (u) url = decodeURIComponent(u[1])
    out.push(`${out.length + 1}. ${htmlToText(m[2])}\n   ${url}\n   ${htmlToText(m[3] || '')}`)
  }
  return out.join('\n\n') || 'No results (the keyless search may be rate-limited; a search key can be added in Settings).'
}

export const builtinTools: Tool[] = [
  {
    name: 'read', kind: 'read',
    description: 'Read a text file. Returns numbered lines. Use offset/limit for large files.',
    schema: obj({ path: { type: 'string', description: 'File path, absolute or relative to the working folder' }, offset: { type: 'integer', description: 'First line to read (1-based)' }, limit: { type: 'integer', description: 'Maximum lines (default 2000)' } }, ['path']),
    title: (i) => `Read ${i.path}`,
    paths: (i, dir) => [abs(dir, i.path)],
    async run(i, ctx) {
      need(i, ['path'])
      const p = abs(ctx.dir, i.path)
      const st = await fs.stat(p)
      if (st.isDirectory()) throw new Error('That is a folder. Use the list tool.')
      if (st.size > 5_000_000) throw new Error('File is larger than 5 MB. Use grep or read a range with the shell.')
      const buf = await fs.readFile(p)
      if (buf.subarray(0, 4000).includes(0)) return `(binary file, ${st.size} bytes)`
      const lines = buf.toString('utf8').split('\n')
      const start = Math.max(1, i.offset || 1)
      const lim = Math.min(i.limit || 2000, 2000)
      const slice = lines.slice(start - 1, start - 1 + lim)
      const body = slice.map((l, n) => `${start + n}\t${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n')
      return body + (start - 1 + lim < lines.length ? `\n… (${lines.length} lines total; read more with offset)` : '')
    },
  },
  {
    name: 'write', kind: 'act',
    description: 'Create or overwrite a file with the given content. Creates folders as needed.',
    schema: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
    title: (i) => `Write ${i.path}`,
    paths: (i, dir) => [abs(dir, i.path)],
    async run(i, ctx) {
      need(i, ['path'])
      if (typeof i.content !== 'string') throw new Error('Missing required parameter "content".')
      const p = abs(ctx.dir, i.path)
      await fs.mkdir(dirname(p), { recursive: true })
      const existed = existsSync(p)
      await fs.writeFile(p, i.content)
      ctx.changed()
      return `${existed ? 'Overwrote' : 'Created'} ${i.path} (${i.content.split('\n').length} lines).`
    },
  },
  {
    name: 'edit', kind: 'act',
    description: 'Replace exact text in a file. old_string must match the file exactly (including whitespace) and be unique unless replace_all is true. Read the file first.',
    schema: obj({ path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']),
    title: (i) => `Edit ${i.path}`,
    paths: (i, dir) => [abs(dir, i.path)],
    async run(i, ctx) {
      need(i, ['path', 'old_string'])
      if (typeof i.new_string !== 'string') throw new Error('Missing required parameter "new_string".')
      const p = abs(ctx.dir, i.path)
      let text = await fs.readFile(p, 'utf8')
      let oldS: string = i.old_string
      let newS: string = i.new_string
      if (!text.includes(oldS) && text.includes('\r\n')) { oldS = oldS.replace(/\r?\n/g, '\r\n'); newS = newS.replace(/\r?\n/g, '\r\n') }
      const count = text.split(oldS).length - 1
      if (count === 0) throw new Error('old_string was not found in the file. Read the file again and match it exactly.')
      if (count > 1 && !i.replace_all) throw new Error(`old_string appears ${count} times. Add more surrounding lines to make it unique, or set replace_all.`)
      text = i.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS)
      await fs.writeFile(p, text)
      ctx.changed()
      return `Edited ${i.path} (${count} replacement${count > 1 ? 's' : ''}).`
    },
  },
  {
    name: 'list', kind: 'read',
    description: 'List the files and folders in a folder.',
    schema: obj({ path: { type: 'string', description: 'Folder (default: working folder)' } }),
    title: (i) => `List ${i.path || '.'}`,
    paths: (i, dir) => [abs(dir, i.path || '.')],
    async run(i, ctx) {
      const p = abs(ctx.dir, i.path || '.')
      const entries = await fs.readdir(p, { withFileTypes: true })
      return entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).slice(0, 500).map((e) => e.name + (e.isDirectory() ? '/' : '')).join('\n') || '(empty folder)'
    },
  },
  {
    name: 'glob', kind: 'read',
    description: 'Find files by name pattern, e.g. "**/*.ts" or "src/**/*.{js,jsx}". Skips node_modules, .git and build output.',
    schema: obj({ pattern: { type: 'string' }, path: { type: 'string', description: 'Folder to search (default: working folder)' } }, ['pattern']),
    title: (i) => `Find ${i.pattern}`,
    paths: (i, dir) => [abs(dir, i.path || '.')],
    async run(i, ctx) {
      need(i, ['pattern'])
      const root = abs(ctx.dir, i.path || '.')
      const re = globToRegex(i.pattern.includes('/') ? i.pattern : '**/' + i.pattern)
      const hits: string[] = []
      for await (const f of walk(root, ctx.signal)) {
        const rel = relative(root, f).split(sep).join('/')
        if (re.test(rel)) { hits.push(rel); if (hits.length >= 300) break }
      }
      return hits.length ? hits.join('\n') + (hits.length >= 300 ? '\n… (more matches; narrow the pattern)' : '') : 'No files matched.'
    },
  },
  {
    name: 'grep', kind: 'read',
    description: 'Search file contents with a regular expression. Returns file:line: text. Skips node_modules, .git and build output.',
    schema: obj({ pattern: { type: 'string', description: 'Regular expression' }, path: { type: 'string' }, include: { type: 'string', description: 'Only files matching this glob, e.g. "*.ts"' }, ignore_case: { type: 'boolean' } }, ['pattern']),
    title: (i) => `Search "${i.pattern}"`,
    paths: (i, dir) => [abs(dir, i.path || '.')],
    async run(i, ctx) {
      need(i, ['pattern'])
      const root = abs(ctx.dir, i.path || '.')
      let re: RegExp
      try { re = new RegExp(i.pattern, i.ignore_case ? 'i' : '') } catch (e: any) { throw new Error('Invalid regular expression: ' + e.message) }
      const inc = i.include ? globToRegex(i.include.includes('/') ? i.include : '**/' + i.include) : null
      const out: string[] = []
      const st = await fs.stat(root)
      const files = st.isFile() ? (async function* () { yield root })() : walk(root, ctx.signal)
      for await (const f of files) {
        const rel = st.isFile() ? i.path : relative(root, f).split(sep).join('/')
        if (inc && !inc.test(rel)) continue
        let buf
        try { const s = await fs.stat(f); if (s.size > 1_500_000) continue; buf = await fs.readFile(f) } catch { continue }
        if (buf.subarray(0, 2000).includes(0)) continue
        const lines = buf.toString('utf8').split('\n')
        for (let n = 0; n < lines.length; n++) {
          if (re.test(lines[n])) { out.push(`${rel}:${n + 1}: ${lines[n].trim().slice(0, 300)}`); if (out.length >= 200) break }
        }
        if (out.length >= 200) break
      }
      return out.length ? out.join('\n') + (out.length >= 200 ? '\n… (more matches; narrow the search)' : '') : 'No matches.'
    },
  },
  {
    name: 'shell', kind: 'act',
    description: `Run a command in the working folder and return its output. The shell is ${process.platform === 'win32' ? 'Windows PowerShell (use PowerShell syntax; chain with ";")' : 'bash'}. Do not start long-running servers here; they would block until the timeout.`,
    schema: obj({ command: { type: 'string' }, timeout_ms: { type: 'integer', description: 'Default 120000, maximum 600000' } }, ['command']),
    title: (i) => `Run: ${String(i.command).slice(0, 120)}`,
    allowKey: (i) => 'shell:' + String(i.command).trim().split(/\s+/)[0],
    async run(i, ctx) {
      need(i, ['command'])
      const r = await runShell(i.command, ctx.dir, ctx.signal, Math.min(i.timeout_ms || 120000, 600000))
      ctx.changed()
      const tail = r.timedOut ? '\n[Timed out and was stopped]' : `\n[exit code ${r.code}]`
      return clip(r.output.trim() || '(no output)') + tail
    },
  },
  {
    name: 'webfetch', kind: 'web',
    description: 'Fetch a web page or file by URL and return its text.',
    schema: obj({ url: { type: 'string' } }, ['url']),
    title: (i) => `Fetch ${i.url}`,
    async run(i, ctx) {
      need(i, ['url'])
      if (!/^https?:\/\//i.test(i.url)) throw new Error('URL must start with http:// or https://')
      const r = await fetch(i.url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; assistant)', accept: 'text/html,text/plain,application/json,*/*' }, signal: ctx.signal, redirect: 'follow' })
      const type = r.headers.get('content-type') || ''
      if (!r.ok) throw new Error(`The page returned ${r.status}.`)
      if (!/text|json|xml|javascript/.test(type)) return `(not a text page: ${type})`
      const body = await r.text()
      return clip(/html/.test(type) ? htmlToText(body) : body, 50000)
    },
  },
  {
    name: 'websearch', kind: 'web',
    description: 'Search the web. Returns titles, links and snippets. Fetch a result with webfetch to read it.',
    schema: obj({ query: { type: 'string' } }, ['query']),
    title: (i) => `Search the web: ${i.query}`,
    async run(i, ctx) { need(i, ['query']); return search(i.query, ctx) },
  },
  {
    name: 'todo', kind: 'read',
    description: 'Keep a short task list for multi-step work. Send the whole list each time.',
    schema: obj({ items: { type: 'array', items: obj({ text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } }, ['text', 'status']) } }, ['items']),
    title: () => 'Update task list',
    async run(i, ctx) {
      if (!Array.isArray(i.items)) throw new Error('Missing required parameter "items".')
      ctx.session.todos = i.items.filter((t: any) => t && typeof t.text === 'string').map((t: any) => ({ text: t.text, status: ['pending', 'in_progress', 'done'].includes(t.status) ? t.status : 'pending' }))
      return 'Task list updated.'
    },
  },
  {
    name: 'question', kind: 'read',
    description: 'Ask the owner one to three short questions when something important is unclear. Offer options when you can.',
    schema: obj({ questions: { type: 'array', items: obj({ question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['question']) } }, ['questions']),
    title: (i) => `Ask: ${i.questions?.[0]?.question ?? ''}`,
    async run(i, ctx) {
      if (!Array.isArray(i.questions) || !i.questions.length) throw new Error('Missing required parameter "questions".')
      return ctx.ask(i.questions.slice(0, 3).map((q: any) => ({ question: String(q.question), options: Array.isArray(q.options) ? q.options.map(String) : undefined })))
    },
  },
  {
    name: 'task', kind: 'read',
    description: 'Hand a self-contained research or search job to a helper that can only read files and the web. It returns a written report. Use it to explore a large codebase without filling your own context.',
    schema: obj({ description: { type: 'string', description: 'Three to five words' }, prompt: { type: 'string', description: 'Everything the helper needs to know' } }, ['prompt']),
    title: (i) => `Helper: ${i.description || String(i.prompt).slice(0, 60)}`,
    async run(i, ctx) { need(i, ['prompt']); return ctx.subtask(i.prompt) },
  },
]
