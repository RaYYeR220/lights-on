/* Lights On service worker: shows morning briefings pushed by the server. */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Lights On';
  const body = typeof data.body === 'string' ? data.body : '';
  let url = '/night';
  if (typeof data.url === 'string') {
    try { const u = new URL(data.url, self.location.origin); if (u.origin === self.location.origin) url = u.pathname + u.search; } catch (e) { /* keep default */ }
  }
  event.waitUntil(self.registration.showNotification(title, { body, data: { url }, tag: 'lights-on-briefing' }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let target = new URL('/night', self.location.origin).href;
  try {
    const u = new URL((event.notification.data && event.notification.data.url) || '/night', self.location.origin);
    if (u.origin === self.location.origin) target = u.href;
  } catch (e) { /* keep default */ }
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url === target && 'focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
