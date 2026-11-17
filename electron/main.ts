// Clawdalla desktop app. Two modes:
//   host   – this is the main computer: runs the agent and stores everything.
//   client – this is another device: just a window onto the main computer.
import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell, dialog } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startServer } from '../server/index'

if (process.env.CLAWDALLA_USERDATA) app.setPath('userData', process.env.CLAWDALLA_USERDATA)

interface Config { mode?: 'host' | 'client'; url?: string }
const configFile = () => join(app.getPath('userData'), 'config.json')
const readConfig = (): Config => { try { return JSON.parse(readFileSync(configFile(), 'utf8')) } catch { return {} } }
const writeConfig = (c: Config) => { mkdirSync(app.getPath('userData'), { recursive: true }); writeFileSync(configFile(), JSON.stringify(c, null, 2)) }

let win: BrowserWindow | undefined
let tray: Tray | undefined
let server: Awaited<ReturnType<typeof startServer>> | undefined
let quitting = false

const chooser = `<!doctype html><meta charset="utf-8"><title>Clawdalla</title>
<style>
  :root{color-scheme:light dark;--bg:#f6f7f8;--card:#fff;--text:#14171a;--muted:#6b737c;--line:#e2e5e9;--accent:#0d9488}
  @media(prefers-color-scheme:dark){:root{--bg:#0f1113;--card:#15181b;--text:#e8eaed;--muted:#8b949e;--line:#262b30;--accent:#2dd4bf}}
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}
  main{width:440px;display:flex;flex-direction:column;gap:14px}
  h1{font-size:26px;margin:0 0 2px;letter-spacing:-.01em}p{margin:0;color:var(--muted)}
  button.opt{all:unset;box-sizing:border-box;width:100%;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--card);cursor:pointer;display:block}
  button.opt:hover{border-color:var(--accent)}button.opt b{display:block;font-size:16px;margin-bottom:2px}button.opt span{color:var(--muted);font-size:14px}
  .join{display:none;gap:8px}.join.on{display:flex}
  input{flex:1;padding:9px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit;outline:0}input:focus{border-color:var(--accent)}
  .go{padding:9px 16px;border-radius:10px;border:0;background:var(--text);color:var(--bg);font:inherit;font-weight:600;cursor:pointer}
  #err{color:#c2410c;font-size:14px;min-height:20px}
</style>
<main>
  <div><h1>Welcome to Clawdalla</h1><p>How will you use it on this device?</p></div>
  <button class="opt" id="host"><b>This is my main computer</b><span>It stays on, runs the assistant and keeps all your chats and projects. Your other devices connect to it.</span></button>
  <button class="opt" id="client"><b>Connect to my main computer</b><span>Use Clawdalla on this device while everything runs and is stored on the main computer.</span></button>
  <div class="join" id="join"><input id="url" placeholder="https://your-computer.your-tailnet.ts.net" spellcheck="false"><button class="go" id="go">Connect</button></div>
  <div id="err"></div>
</main>
<script>
  const $ = (id) => document.getElementById(id)
  $('host').onclick = () => window.clawdalla.choose({ mode: 'host' })
  $('client').onclick = () => { $('join').classList.add('on'); $('url').focus() }
  const go = async () => { $('err').textContent = ''; const r = await window.clawdalla.choose({ mode: 'client', url: $('url').value.trim() }); if (r) $('err').textContent = r }
  $('go').onclick = go; $('url').onkeydown = (e) => { if (e.key === 'Enter') go() }
</script>`

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 380, minHeight: 520, show: false,
    title: 'Clawdalla', backgroundColor: '#0f1113', autoHideMenuBar: true,
    icon: join(__dirname, 'icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  })
  win.once('ready-to-show', () => win?.show())
  // Smoke-test hook: save a picture of the window, then quit.
  if (process.env.CLAWDALLA_SHOT) win.webContents.on('did-finish-load', () => setTimeout(async () => { const img = await win!.webContents.capturePage(); writeFileSync(process.env.CLAWDALLA_SHOT!, img.toPNG()); quitting = true; app.quit() }, 2500))
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) void shell.openExternal(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (e, url) => {
    const cur = win?.webContents.getURL() || ''
    if (/^https?:/.test(url) && cur.startsWith('http') && new URL(url).origin !== new URL(cur).origin) { e.preventDefault(); void shell.openExternal(url) }
  })
  win.on('close', (e) => {
    // On the main computer, closing the window keeps the assistant running in the tray.
    if (!quitting && readConfig().mode === 'host') { e.preventDefault(); win?.hide() }
  })
  win.on('closed', () => { win = undefined })
  return win
}

function showWindow() { if (!win) { createWindow(); void route() } else { win.show(); win.focus() } }

async function route() {
  if (!win) return
  const cfg = readConfig()
  if (cfg.mode === 'host') {
    try {
      if (!server) {
        const root = app.getAppPath()
        const unpacked = root.replace(/app\.asar$/, 'app.asar.unpacked')
        server = await startServer({
          dataDir: process.env.CLAWDALLA_DATA || join(app.getPath('userData'), 'data'),
          webDir: join(__dirname, 'web'),
          browserCli: join(unpacked, 'node_modules', '@playwright', 'mcp', 'cli.js'),
          version: app.getVersion(),
        })
      }
      await win.loadURL(server.localUrl)
    } catch (e: any) {
      dialog.showErrorBox('Clawdalla could not start', String(e?.message || e))
    }
    ensureTray()
    if (app.isPackaged && !process.env.CLAWDALLA_USERDATA) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] })
  } else if (cfg.mode === 'client' && cfg.url) {
    win.loadURL(cfg.url).catch(() => { void win?.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(offline(cfg.url!))) })
  } else {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(chooser))
  }
}

const offline = (url: string) => `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1113;color:#e8eaed;font:15px system-ui;text-align:center">
<div><h2>Cannot reach your main computer</h2><p style="color:#8b949e">${url.replace(/[<>&"]/g, '')}<br>Check that it is on and that Tailscale is connected on both devices.</p>
<button onclick="location.href='${url.replace(/['"<>]/g, '')}'" style="padding:9px 16px;border-radius:10px;border:0;background:#e8eaed;color:#0f1113;font:inherit;font-weight:600;cursor:pointer">Try again</button>
<button onclick="window.clawdalla.reset()" style="padding:9px 16px;border-radius:10px;border:1px solid #262b30;background:none;color:#e8eaed;font:inherit;cursor:pointer;margin-left:8px">Change connection</button></div>`

function ensureTray() {
  if (tray) return
  const img = nativeImage.createFromPath(join(__dirname, 'tray.png'))
  tray = new Tray(process.platform === 'darwin' ? img.resize({ width: 18, height: 18 }) : img)
  tray.setToolTip('Clawdalla is running')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Clawdalla', click: showWindow },
    { label: 'Open in browser', click: () => server && shell.openExternal(server.localUrl) },
    { type: 'separator' },
    { label: 'Quit (stops the assistant)', click: () => { quitting = true; app.quit() } },
  ]))
  tray.on('click', showWindow)
}

function setMenu() {
  const reset = { label: 'Change how this device connects…', click: async () => {
    const r = await dialog.showMessageBox({ type: 'question', buttons: ['Cancel', 'Change'], defaultId: 0, message: 'Change how this device uses Clawdalla?', detail: 'Nothing is deleted. You will choose again between main computer and connecting to one.' })
    if (r.response === 1) { await server?.close(); server = undefined; writeConfig({}); void route() }
  } }
  const mac = process.platform === 'darwin'
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [reset, { type: 'separator' as const }, { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit() } }] },
    { role: 'editMenu' as const },
    { role: 'viewMenu' as const },
    { role: 'windowMenu' as const },
  ]))
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', showWindow)
  app.whenReady().then(() => {
    setMenu()
    ipcMain.handle('choose', async (_e, c: Config) => {
      if (c.mode === 'host') { writeConfig({ mode: 'host' }); void route(); return '' }
      let url = String(c.url || '').trim()
      if (!url) return 'Enter the address of your main computer.'
      if (!/^https?:\/\//.test(url)) url = 'https://' + url
      try {
        const r = await fetch(new URL('/api/state', url), { signal: AbortSignal.timeout(8000) })
        const j: any = await r.json()
        if (typeof j.setup !== 'boolean') throw new Error('not clawdalla')
      } catch { return 'Could not reach Clawdalla at that address. Check the address and that Tailscale is connected.' }
      writeConfig({ mode: 'client', url: new URL(url).origin })
      void route()
      return ''
    })
    ipcMain.handle('reset', async () => { writeConfig({}); void route() })
    createWindow()
    if (process.argv.includes('--hidden') && readConfig().mode === 'host') win?.once('ready-to-show', () => win?.hide())
    void route()
    app.on('activate', showWindow)
  })
  app.on('window-all-closed', () => { if (readConfig().mode !== 'host' && process.platform !== 'darwin') app.quit() })
  app.on('before-quit', () => { quitting = true; void server?.close() })
}
