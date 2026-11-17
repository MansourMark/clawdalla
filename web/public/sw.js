// Clawdalla service worker: shows notifications sent by the main computer.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data.json() } catch {}
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (open.some((c) => c.visibilityState === 'visible')) return
    await self.registration.showNotification(d.title || 'Clawdalla', { body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: d.sessionId || 'clawdalla', data: d })
  })())
})
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const sid = e.notification.data && e.notification.data.sessionId
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (open[0]) { open[0].focus(); if (sid) open[0].postMessage({ openSession: sid }); return }
    await self.clients.openWindow(sid ? '/#s=' + sid : '/')
  })())
})
