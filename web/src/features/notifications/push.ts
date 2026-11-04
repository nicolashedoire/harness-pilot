// Web Push in this browser (API.md "Web Push"): subscribe through the service worker with the server's VAPID key,
// keep the subscription's per-kind preferences in line with the "Browser" column, and hand the service worker
// what it needs to show a push without the app (texts in the UI language, which kinds ring, the logo of the
// accent) through a small JSON in Cache Storage. Also: a click on a push opens its page in the running app.
import * as React from 'react'
import { browserRequest } from '@/lib/browser-request'
import { activeRegistration, enrollPush } from './enrollment'
import { useNavigate } from 'react-router'
import { translate, type TKey } from '@/i18n'
import { appIconSrc } from '@/lib/accent'
import { nearestAccent } from '@/lib/theme'
import { useDeletePush, useFeedSettings, usePatchPush, usePushInfo, useSubscribePush } from '@/lib/queries'
import type { PushInfo, PushPrefs, PushSubscribeBody } from '@/lib/types'
import { useUI } from '@/stores/ui'
import { PREF_ROWS, pushPrefs, pushSources, rowSound, sourceKey, type PushSource } from './prefs'
import { keyBytes, sameServerKey } from './pushKey'

/** Read by sw/sw.js (same names there). */
const PREFS_CACHE = 'mx-prefs'
const PREFS_URL = '/__mx/notify-prefs.json'

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  return (await navigator.serviceWorker.getRegistration().catch(() => undefined)) ?? null
}

/** An active service worker is available (production build on HTTPS or localhost, including first install). */
export async function pushReady(signal?: AbortSignal): Promise<boolean> {
  return pushSupported() && !!await activeRegistration({ current: registration, ready: () => navigator.serviceWorker.ready }, signal)
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const r = await registration()
  return r ? r.pushManager.getSubscription().catch(() => null) : null
}

/** Asks the browser for a subscription (permission prompt) and returns the body for the server. `sources`: the
 *  webhooks and scripts of the matrix (pushSources). A subscription made with another server key is replaced. */
export async function subscribeBrowser(publicKey: string, sources: PushSource[] = [], signal?: AbortSignal): Promise<PushSubscribeBody> {
  const r = await browserRequest(registration, { signal })
  if (!r) throw new Error('no_service_worker')
  const sub = await enrollPush({
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    getSubscription: () => r.pushManager.getSubscription(),
    matches: (existing) => sameServerKey(existing.options?.applicationServerKey, publicKey),
    // as before: a failed unsubscribe still lets the browser try the new key (it answers for itself)
    unsubscribe: (existing) => existing.unsubscribe().catch(() => false),
    subscribe: () => r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }),
  }, signal)
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }
  const { notifyPrefs, soundPrefs, soundSet } = useUI.getState()
  return { endpoint: json.endpoint, keys: json.keys, label: deviceLabel(), prefs: pushPrefs(notifyPrefs, soundPrefs, soundSet, sources) }
}

export async function unsubscribeBrowser(): Promise<string | null> {
  const sub = await currentSubscription()
  if (!sub) return null
  const endpoint = sub.endpoint
  await sub.unsubscribe().catch(() => {})
  return endpoint
}

/** "Chrome on macOS" - the subscriptions list of the server shows it. */
function deviceLabel(): string {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${browser} · ${os}` : browser
}

/** Kinds the service worker can word itself (the others show the server's English title). */
const KINDS = [
  ...PREF_ROWS.flatMap((r) => r.kinds),
  'push.test',
  'webhook.test',
  ...['sale', 'payment', 'refund', 'payment_failed', 'dispute', 'subscription_created', 'subscription_cancelled', 'event'].map((k) => `stripe.${k}`),
  ...['order_created', 'order_paid', 'order_cancelled', 'refund', 'stock', 'event'].map((k) => `shopify.${k}`),
  ...['ping', 'push', 'pull_request', 'issue', 'workflow', 'release', 'star', 'event'].map((k) => `github.${k}`),
]
const ACTIONS = ['open', 'open_run', 'rerun', 'open_session', 'resume', 'add_secret']

/** Templates of the current language, with their `{params}` (the worker fills them, or falls back). */
function templates(lang: 'en' | 'fr', suffix: string) {
  const out: Record<string, string> = {}
  for (const k of KINDS) {
    const key = `feed.kind.${k}.${suffix}`
    const s = translate(lang, key as TKey)
    if (s && s !== key) out[k] = s
  }
  return out
}

/** What the service worker reads to show a push (see sw/sw.js). */
export function swPrefs() {
  const { language, palette, soundSet, soundPrefs } = useUI.getState()
  const sound: Record<string, boolean> = {}
  for (const r of PREF_ROWS) for (const k of r.kinds) sound[k] = rowSound(soundPrefs, r)
  const sources: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(soundPrefs)) if (k.startsWith(sourceKey(''))) sources[k.slice(sourceKey('').length)] = v
  return {
    lang: language,
    icon: appIconSrc(nearestAccent(palette.accent)),
    sound: soundSet === 'none' ? {} : sound,
    soundSources: soundSet === 'none' ? {} : sources,
    muted: soundSet === 'none',
    titles: templates(language, 'title'),
    bodies: templates(language, 'body'),
    actions: Object.fromEntries(ACTIONS.map((a) => [a, translate(language, `feed.action.${a}` as TKey)])),
  }
}

async function writeSwPrefs() {
  if (typeof caches === 'undefined') return
  try {
    const c = await caches.open(PREFS_CACHE)
    await c.put(PREFS_URL, new Response(JSON.stringify(swPrefs()), { headers: { 'Content-Type': 'application/json' } }))
  } catch {
    /* private mode / storage blocked: the worker uses the server's texts and the default sounds */
  }
}

function sameMap(a: PushPrefs['kinds'], b: PushPrefs['kinds']): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.entries(b).every(([k, v]) => a[k]?.enabled === v.enabled && a[k]?.sound === v.sound)
}

/** Same preferences whatever the key order of the server's copy. `sources` only when the server keeps them (an
 *  older one drops the map: comparing it would patch forever). */
function samePrefs(a: PushPrefs | undefined, b: PushPrefs): boolean {
  if (!a || a.sound !== b.sound || [...(a.levels ?? [])].sort().join() !== [...b.levels].sort().join()) return false
  return sameMap(a.kinds ?? {}, b.kinds) && (a.sources === undefined || sameMap(a.sources, b.sources ?? {}))
}

/** The subscription of this browser among the server's ones. */
export async function ownSubscription(info: PushInfo | undefined) {
  const sub = await currentSubscription()
  return sub ? (info?.subscriptions.find((s) => s.endpoint === sub.endpoint) ?? null) : null
}

/** Mounted once (AppShell): while this browser is subscribed, its preferences follow the settings; a push click
 *  navigates inside the running app. */
export function usePushSync() {
  const navigate = useNavigate()
  const pushOn = useUI((s) => s.pushOn)
  const notifyPrefs = useUI((s) => s.notifyPrefs)
  const soundPrefs = useUI((s) => s.soundPrefs)
  const soundSet = useUI((s) => s.soundSet)
  const language = useUI((s) => s.language)
  const accent = useUI((s) => s.palette.accent)
  const { data: info } = usePushInfo(pushOn)
  // the webhooks and scripts of the matrix: pushed per source
  const { data: feedSettings, isPending: feedPending } = useFeedSettings(pushOn)
  const patch = usePatchPush()
  const patchRef = React.useRef(patch.mutate)
  patchRef.current = patch.mutate
  const subscribe = useSubscribePush()
  const del = useDeletePush()
  const renewRef = React.useRef({ subscribe: subscribe.mutateAsync, del: del.mutateAsync })
  renewRef.current = { subscribe: subscribe.mutateAsync, del: del.mutateAsync }

  // the worker's copy of the texts and sounds
  React.useEffect(() => {
    if (pushOn) void writeSwPrefs()
  }, [pushOn, soundPrefs, soundSet, language, accent])

  // the server's copy of what to push (debounced: a row of checkboxes is several clicks)
  React.useEffect(() => {
    if (!pushOn || !info || feedPending) return
    const id = setTimeout(async () => {
      const own = await ownSubscription(info)
      if (!own) {
        // unsubscribed elsewhere (another browser profile reset, the server removed a dead endpoint)
        if (!(await currentSubscription())) useUI.getState().setNotify({ pushOn: false })
        return
      }
      // subscribed with a key the server no longer has: every push is refused, subscribe again (no prompt: allowed)
      const sub = await currentSubscription()
      if (sub && info.public_key && Notification.permission === 'granted' && !sameServerKey(sub.options?.applicationServerKey, info.public_key)) {
        try {
          const body = await subscribeBrowser(info.public_key, pushSources(feedSettings))
          await renewRef.current.subscribe(body)
          if (body.endpoint !== own.endpoint) await renewRef.current.del(own.id)
        } catch {
          /* the browser or the server refused: the switch in Settings -> Notifications tries again */
        }
        return
      }
      const want = pushPrefs(notifyPrefs, soundPrefs, soundSet, pushSources(feedSettings))
      if (!samePrefs(own.prefs, want)) patchRef.current({ id: own.id, prefs: want })
    }, 800)
    return () => clearTimeout(id)
  }, [pushOn, info, notifyPrefs, soundPrefs, soundSet, feedSettings, feedPending])

  // sw.js asks the app to open a page (a click on a push while the app is running)
  React.useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | null
      if (d?.type === 'NAVIGATE' && typeof d.url === 'string' && /^\/(?![/\\])/.test(d.url)) navigate(d.url === '/feed' ? '/notifications' : d.url)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [navigate])
}
