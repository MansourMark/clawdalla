// Plugins: connects to MCP servers and exposes their tools to the agent.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { existsSync } from 'node:fs'
import type { Store } from '../store'
import type { Tool } from './tools'

interface Conn { name: string; client?: Client; tools: Tool[]; status: 'connecting' | 'ready' | 'error'; error?: string }

export class Mcp {
  private conns = new Map<string, Conn>()
  ready: Promise<void> = Promise.resolve()
  constructor(private store: Store, private browserCli?: string) {}

  status() { return [...this.conns.values()].map((c) => ({ name: c.name, status: c.status, error: c.error, tools: c.tools.length })) }
  tools(): Tool[] { return [...this.conns.values()].flatMap((c) => c.tools) }

  async reload() {
    await this.close()
    const s = this.store.data
    const defs: Record<string, { command?: string[]; url?: string; env?: Record<string, string> }> = {}
    if (s.browserTool && this.browserCli && existsSync(this.browserCli)) {
      defs.browser = { command: [process.execPath, this.browserCli, '--browser', process.platform === 'win32' ? 'msedge' : 'chrome'], env: { ELECTRON_RUN_AS_NODE: '1' } }
    }
    for (const [name, m] of Object.entries(s.mcp)) {
      if (m.disabled) continue
      if (m.type === 'local' && m.command?.length) defs[name] = { command: m.command }
      if (m.type === 'remote' && m.url) defs[name] = { url: m.url }
    }
    const jobs = Object.entries(defs).map(([name, def]) => this.connect(name, def))
    this.ready = Promise.race([Promise.allSettled(jobs).then(() => {}), new Promise<void>((r) => setTimeout(r, 8000))])
    return this.ready
  }

  private async connect(name: string, def: { command?: string[]; url?: string; env?: Record<string, string> }) {
    const conn: Conn = { name, tools: [], status: 'connecting' }
    this.conns.set(name, conn)
    try {
      const client = new Client({ name: 'clawdalla', version: '1.0.0' })
      const transport = def.command
        ? new StdioClientTransport({ command: def.command[0], args: def.command.slice(1), env: { ...(process.env as Record<string, string>), ...def.env }, stderr: 'ignore' })
        : new StreamableHTTPClientTransport(new URL(def.url!))
      await client.connect(transport)
      conn.client = client
      const listed = await client.listTools()
      const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')
      conn.tools = listed.tools.map((t) => ({
        name: `${safe(name)}_${safe(t.name)}`.slice(0, 64),
        description: (t.description || t.name).slice(0, 1000),
        schema: t.inputSchema && (t.inputSchema as any).type === 'object' ? t.inputSchema : { type: 'object', properties: {} },
        kind: 'act' as const,
        allowKey: () => 'plugin:' + name,
        title: (i: any) => `${name}: ${t.name}${i && Object.keys(i).length ? ' ' + JSON.stringify(i).slice(0, 100) : ''}`,
        run: async (input: any, ctx) => {
          const res: any = await client.callTool({ name: t.name, arguments: input ?? {} }, undefined, { signal: ctx.signal, timeout: 300000 })
          const text = (res.content || []).map((c: any) => (c.type === 'text' ? c.text : c.type === 'image' ? '(image returned)' : c.type === 'resource' ? (c.resource?.text ?? '(resource)') : '')).filter(Boolean).join('\n')
          if (res.isError) throw new Error(text || 'The plugin reported an error.')
          return text.slice(0, 40000) || '(done)'
        },
      }))
      conn.status = 'ready'
    } catch (e: any) {
      conn.status = 'error'
      conn.error = String(e?.message || e).slice(0, 300)
    }
  }

  async close() {
    const all = [...this.conns.values()]
    this.conns.clear()
    await Promise.allSettled(all.map((c) => c.client?.close()))
  }
}
