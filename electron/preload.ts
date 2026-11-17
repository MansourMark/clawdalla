import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('clawdalla', {
  choose: (c: { mode: 'host' | 'client'; url?: string }) => ipcRenderer.invoke('choose', c),
  reset: () => ipcRenderer.invoke('reset'),
})
