export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined || (method !== 'GET' && method !== 'DELETE') ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' && method !== 'DELETE' ? '{}' : undefined,
  })
  const text = await r.text()
  let data: any = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = { error: text } }
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`)
  return data
}

export type Part =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'file'; name: string; mime: string; data?: string }
  | { type: 'tool'; id: string; name: string; input: any; title?: string; status: 'pending' | 'running' | 'done' | 'error' | 'denied'; output?: string; start?: number; end?: number }

export interface Msg { id: string; role: 'user' | 'assistant' | 'note'; parts: Part[]; time: number; synthetic?: string; level?: string; model?: { provider: string; id: string }; error?: string; done?: boolean }
export interface Pending { id: string; type: 'permission' | 'question'; tool?: string; title?: string; detail?: string; questions?: { question: string; options?: string[] }[] }
export interface SessionView {
  id: string; kind: 'chat' | 'code'; projectId?: string; title: string; mode: string; level: string; busy: boolean
  messages: Msg[]; pending: Pending[]; todos: { text: string; status: string }[]; canRedo: boolean
  lastCheck?: { status: 'running' | 'passed' | 'failed'; command: string; output: string }
  model?: { provider: string; id: string }
}
export interface SessionItem { id: string; kind: string; projectId?: string; title: string; updated: number; busy: boolean; waiting: boolean; mode: string }
export interface Project { id: string; name: string; dir: string; check: string; dev: string; checkCommand?: string; devCommand?: string; autoCheck: boolean; neverAsk: boolean; exists: boolean }

export const isElectron = /Electron/i.test(navigator.userAgent)
export const isTouch = matchMedia('(pointer: coarse)').matches

export function fileToAttachment(f: File): Promise<{ name: string; mime: string; data: string }> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(new Error('Could not read ' + f.name))
    r.onload = () => resolve({ name: f.name, mime: f.type || 'text/plain', data: String(r.result).split(',')[1] || '' })
    r.readAsDataURL(f)
  })
}

export function timeAgo(t: number) {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return Math.floor(s / 86400) + 'd'
}
