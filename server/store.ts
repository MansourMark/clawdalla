import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export type Level = 'fast' | 'medium' | 'smart'
export interface ModelRef { provider: string; id: string }
export interface Project {
  id: string
  name: string
  dir: string
  created: number
  checkCommand?: string
  devCommand?: string
  autoCheck: boolean
  neverAsk: boolean
}
export interface McpServer { type: 'local' | 'remote'; command?: string[]; url?: string; disabled?: boolean }
export interface Settings {
  passwordHash?: string
  localToken: string
  tokens: Record<string, { created: number; label: string }>
  humor: boolean
  permission: 'all' | 'risky' | 'never'
  providers: Record<string, { key?: string; baseURL?: string }>
  levels: Record<Level, ModelRef | null>
  browserTool: boolean
  mcp: Record<string, McpServer>
  websearch?: { provider: string; key: string }
  projects: Project[]
  vapid?: { publicKey: string; privateKey: string }
  push: any[]
  maxFixRounds: number
}

const defaults = (): Settings => ({
  localToken: randomBytes(24).toString('hex'),
  tokens: {},
  humor: true,
  permission: 'risky',
  providers: {},
  levels: { fast: null, medium: null, smart: null },
  browserTool: true,
  mcp: {},
  projects: [],
  push: [],
  maxFixRounds: 3,
})

export class Store {
  readonly file: string
  data: Settings
  constructor(readonly dataDir: string) {
    for (const d of ['', 'chat', 'workspaces', 'sessions', 'snapshots']) mkdirSync(join(dataDir, d), { recursive: true })
    this.file = join(dataDir, 'settings.json')
    let loaded: Partial<Settings> = {}
    if (existsSync(this.file)) {
      try { loaded = JSON.parse(readFileSync(this.file, 'utf8')) } catch { /* corrupt file: start from defaults */ }
    }
    this.data = { ...defaults(), ...loaded }
    this.save()
  }
  save() {
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file)
  }
  get chatDir() { return join(this.dataDir, 'chat') }
  get workspacesDir() { return join(this.dataDir, 'workspaces') }
  get sessionsDir() { return join(this.dataDir, 'sessions') }
  project(id?: string) { return this.data.projects.find((p) => p.id === id) }
  /** Settings safe to send to a browser: no secrets. */
  public() {
    const d = this.data
    return {
      humor: d.humor,
      permission: d.permission,
      levels: d.levels,
      browserTool: d.browserTool,
      mcp: d.mcp,
      websearch: d.websearch ? { provider: d.websearch.provider, set: !!d.websearch.key } : null,
      maxFixRounds: d.maxFixRounds,
      devices: Object.keys(d.tokens).length,
      hasPassword: !!d.passwordHash,
    }
  }
}
