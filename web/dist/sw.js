/* Harness Maxxing service worker — hand-written, no dependency.
 * Built by the `maxxing-sw` Vite plugin (vite.config.ts): the VERSION and PRECACHE placeholders are replaced at
 * build time, so every build gets its own cache names and the browser sees a new sw.js (update flow).
 *
 * Strategies
 *   navigations (HTML)      network-first, never cached (index.html is no-store) → offline.html on failure
 *   /assets/* (hashed)      cache-first (immutable), filled at install (app shell) and on demand (lazy chunks)
 *   other static files      stale-while-revalidate (icons, fonts, manifest, favicon)
 *   /api/*, /ext/*, non-GET, cross-origin   never touched (straight to the network)
 *
 * Web Push (docs/dev/API.md "Web Push"): `push` shows the notification - in the UI language and with the sound
 * choices of this browser, read from the JSON the app keeps in the `mx-prefs` cache (features/notifications/push.ts);
 * nothing when a window of the app is focused (the app shows its own notice). `notificationclick` runs an action
 * (a link, or one of the allowed POSTs) or opens the event's page in the running app.
 */
const VERSION = "0d3f20a779fb"
const PRECACHE = ["/assets/index-Cx1kjV4O.js","/assets/rolldown-runtime-hePW80VL.js","/assets/vendor-react-CATZNyVw.js","/assets/createLucideIcon-Bl3st4bB.js","/assets/utils-DXTPoy1H.js","/assets/vendor-router-D1EQYbXg.js","/assets/vendor-ui-frGWvPt-.js","/assets/media-CZHf0Rep.js","/assets/vendor-query-CthOliPc.js","/assets/files-COwfzO_S.js","/assets/queries-YMQpRzsf.js","/assets/sessions-DfcylLN4.js","/assets/circle-alert-CKj6nwHI.js","/assets/info-HsLYbbZe.js","/assets/pause-Cf_UjNFO.js","/assets/triangle-alert-ChjDwiwd.js","/assets/x-cGfvABuH.js","/assets/spinner-pVoEei-M.js","/assets/button-Bd9LfJcS.js","/assets/sensitive-CIl-5cWV.js","/assets/viewerStore-DClrTGcm.js","/assets/store-B_lTs0ox.js","/assets/format-Djj3rPVZ.js","/assets/util-Cm0wcSN_.js","/assets/index-9RPTDoIW.css","/assets/inter-latin-wght-normal-Dx4kXJAl.woff2"]
const SHELL = `mx-shell-${VERSION}`
const ASSETS = `mx-assets-${VERSION}`
const OFFLINE = '/offline.html'
const PREFS = 'mx-prefs'
const PREFS_URL = '/__mx/notify-prefs.json'

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL)
      await shell.addAll([OFFLINE, '/manifest.webmanifest', '/icons/pilot-companion-v2.png', '/icons/pilot-companion-v2-192.png'])
      const assets = await caches.open(ASSETS)
      await assets.addAll(PRECACHE)
      // First install: take over immediately. Updates wait for the page to ask (SKIP_WAITING).
      if (!self.registration.active) await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, ASSETS, PREFS])
      for (const k of await caches.keys()) if (k.startsWith('mx-') && !keep.has(k)) await caches.delete(k)
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {})
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
  if (event.data && event.data.type === 'VERSION') event.ports[0] && event.ports[0].postMessage(VERSION)
})

const bypass = (url) => url.pathname.startsWith('/api/') || url.pathname === '/api' || url.pathname.startsWith('/ext/') || url.pathname === '/sw.js'

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || bypass(url)) return

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const preload = await event.preloadResponse
          if (preload) return preload
          return await fetch(req)
        } catch (e) {
          return (await caches.match(OFFLINE)) || new Response('You are offline - the server could not be reached.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
        }
      })(),
    )
    return
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSETS)
        const hit = await cache.match(req)
        if (hit) return hit
        const res = await fetch(req)
        if (res.ok && !(res.headers.get('content-type') || '').startsWith('text/html'))
          cache.put(req, res.clone()).catch(() => {})
        return res
      })(),
    )
    return
  }

  // Other same-origin static files (icons, fonts, manifest…): stale-while-revalidate.
  // Anything without a file extension or ending in .html is left to the network (SPA routes, documents).
  if (!/\.[a-z0-9]+$/i.test(url.pathname) || url.pathname.endsWith('.html')) return
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL)
      const hit = await cache.match(req)
      const net = fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {})
          return res
        })
        .catch(() => hit || Response.error())
      if (hit) {
        event.waitUntil(net.catch(() => {}))
        return hit
      }
      return net
    })(),
  )
})

/* ------------------------------------------------------------------ Web Push */
const POST_ALLOWED = [/^\/api\/crons\/[A-Za-z0-9_-]{1,64}\/run$/, /^\/api\/sessions\/[A-Za-z0-9_-]{1,64}\/discussion\/resume$/]
const appPath = (u) => typeof u === 'string' && /^\/(?![/\\])/.test(u)

async function notifyPrefs() {
  try {
    const hit = await (await caches.open(PREFS)).match(PREFS_URL)
    return hit ? await hit.json() : null
  } catch (e) {
    return null
  }
}

/** A template of the app's language filled with the event's params, or null (missing param, unknown kind). */
function fill(tpl, params) {
  if (typeof tpl !== 'string') return null
  const s = tpl.replace(/\{([a-z_][a-z0-9_]*)\}/g, (m, k) => (params && params[k] != null ? String(params[k]) : m))
  return /\{[a-z_][a-z0-9_]*\}/.test(s) ? null : s
}

/** Does it ring: the server's `silent` (the subscription's preference for that kind), refined by this browser's
 *  choices the server cannot hold (sounds off on this device, the sound of each webhook / script source). */
function rings(p, d) {
  if (p && p.muted) return false
  if (p && d.category === 'webhooks' && p.soundSources && p.soundSources[d.source] != null) return !!p.soundSources[d.source]
  if (typeof d.silent === 'boolean') return !d.silent
  if (p && d.kind && p.sound && d.kind in p.sound) return !!p.sound[d.kind]
  if (d.category === 'webhooks') return /^(stripe|shopify)\./.test(d.kind || '')
  return d.level === 'warning' || d.level === 'error'
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let d = {}
      try {
        d = event.data ? event.data.json() : {}
      } catch (e) {
        d = { title: event.data ? event.data.text() : '' }
      }
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // the app shows feed events itself; a test from Settings (no feed row) must reach the system notifications
      if (d.kind !== 'push.test' && wins.some((w) => w.focused && w.visibilityState === 'visible')) return
      const p = await notifyPrefs()
      const params = d.params || {}
      const title = (p && p.titles && fill(p.titles[d.kind], params)) || d.title || 'harness-pilot'
      const body = (p && p.bodies && fill(p.bodies[d.kind], params)) || d.body || ''
      const actions = (Array.isArray(d.actions) ? d.actions : [])
        .filter((a) => (a.type === 'post' ? POST_ALLOWED.some((r) => r.test(a.url)) : appPath(a.url) || /^https:\/\//.test(a.url)))
        .slice(0, 2)
      const icon = (p && p.icon) || '/icons/pilot-companion-v2-192.png'
      await self.registration.showNotification(title, {
        body,
        tag: d.tag || (d.id ? `feed-${d.id}` : undefined),
        icon,
        badge: icon,
        silent: !rings(p, d),
        data: { id: d.id, url: d.url || '/notifications', actions },
        actions: actions.map((a, i) => ({ action: `a${i}`, title: (p && p.actions && p.actions[a.id]) || a.label })),
      })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  event.waitUntil(
    (async () => {
      const act = event.action && Array.isArray(data.actions) ? data.actions[Number(event.action.slice(1))] : null
      const api = (path, body) =>
        fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'X-Maxxing': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).catch(() => null)
      if (data.id) await api('/api/feed/read', { ids: [data.id] })
      if (act && act.type === 'post') {
        if (POST_ALLOWED.some((r) => r.test(act.url))) await api(act.url)
        return
      }
      let url = (act && act.url) || data.url || '/notifications'
      if (url === '/feed') url = '/notifications'
      if (!appPath(url)) {
        if (/^https:\/\//.test(url)) return self.clients.openWindow(url)
        url = '/notifications'
      }
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin)
      if (win) {
        await win.focus()
        win.postMessage({ type: 'NAVIGATE', url }) // the app navigates without a reload
        return
      }
      return self.clients.openWindow(url)
    })(),
  )
})
