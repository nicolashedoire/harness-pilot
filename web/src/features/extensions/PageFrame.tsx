import * as React from 'react'
import { useLocation, useNavigate } from 'react-router'
import type { Extension } from '@/lib/types'
import { ApiError, request, seg } from '@/lib/api'
import { useUI, resolveTheme } from '@/stores/ui'
import { extensionDictionary, useLang, useT } from '@/i18n'
import { ICONS } from '@/components/ui/icon'
import { Button, SkeletonText } from '@/components/ui'
import { themeVars } from '@/pages/dashboard/HtmlWidget'
import { iconSvg } from '@/pages/ext/LegacyPage'
import { AskFixButton } from './AskFix'
import { FrameConsent } from './Permissions'
import { reportExtensionError } from './report'
import { pageApiPath, pageAppRoute } from './pageBridge'

let icons: Record<string, string> | undefined
function publicIcons() {
  return icons ??= Object.fromEntries(Object.keys(ICONS).map((key) => [key, iconSvg(key).outerHTML]))
}

export function PageFrame({ ext }: { ext: Extension }) {
  const t = useT()
  const lang = useLang()
  const theme = resolveTheme(useUI((s) => s.theme))
  const palette = useUI((s) => s.palette)
  const density = useUI((s) => s.density)
  const navigate = useNavigate()
  const location = useLocation()
  const iframe = React.useRef<HTMLIFrameElement>(null)
  const [attempt, retry] = React.useState(0)
  const [grant, setGrant] = React.useState<string | null>(null)
  const [decided, setDecided] = React.useState(false)
  const [state, setState] = React.useState<{ ready: boolean; error?: string }>({ ready: false })
  const permissionKey = JSON.stringify({ network: ext.access?.network, refused: ext.access?.refused })
  const channel = React.useMemo(() => crypto.randomUUID(), [ext.id, ext.page_v, attempt, lang, grant, permissionKey])
  const frameSrc = `/ext/${seg(ext.id)}/page-frame?v=${ext.page_v ?? 0}${grant ? `&grant=${encodeURIComponent(grant)}` : ''}#${encodeURIComponent(JSON.stringify({ channel }))}`
  const route = location.pathname.slice(`/x/${ext.id}`.length) + location.search + location.hash
  const pendingHosts = (ext.access?.network ?? []).filter((x) => x.status === 'pending').map((x) => x.host)
  const asking = pendingHosts.length > 0 && !grant && !decided && !ext.access?.refused
  const contextRef = React.useRef({ theme, lang, route, dictionary: extensionDictionary(lang), timeout: t('ext.isolation.timeout') })
  contextRef.current = { theme, lang, route, dictionary: extensionDictionary(lang), timeout: t('ext.isolation.timeout') }

  React.useEffect(() => {
    if (asking) return
    setState({ ready: false })
    const controller = new AbortController()
    const active = new Set<number>()
    const timer = setTimeout(() => setState({ ready: false, error: contextRef.current.timeout }), 45000)
    const context = () => ({ ...contextRef.current, vars: themeVars() })
    const onMessage = async (event: MessageEvent) => {
      const win = iframe.current?.contentWindow
      if (!win || event.source !== win || event.origin !== 'null') return
      const m = event.data
      if (!m || typeof m !== 'object' || m.channel !== channel) return
      const send = (value: object) => { if (!controller.signal.aborted) win.postMessage({ ...value, channel }, '*') }
      if (m.mx === 'page-hello') send({ mx: 'page-init', id: ext.id, ...context(), icons: publicIcons() })
      if (m.mx === 'page-ready') { clearTimeout(timer); setState({ ready: true }) }
      if (m.mx === 'page-error') {
        const message = String(m.message ?? 'Error').slice(0, 2000)
        if (!m.recorded) reportExtensionError(ext.id, 'page', message, String(m.stack ?? '').slice(0, 8000))
        if (m.fatal) { clearTimeout(timer); setState({ ready: false, error: message }) }
      }
      if (m.mx === 'page-navigate' || m.mx === 'page-route') {
        try {
          const target = m.mx === 'page-route' ? `/x/${ext.id}${typeof m.route === 'string' && m.route.startsWith('/') ? m.route : '/'}` : m.route
          const checked = pageAppRoute(target)
          if (m.mx === 'page-route' && !new URL(checked, window.location.origin).pathname.startsWith(`/x/${ext.id}/`)) throw new Error('Invalid page subroute')
          navigate(checked)
        } catch { /* a frame cannot navigate the host to an API endpoint or another site */ }
      }
      if (m.mx !== 'page-api' || !Number.isSafeInteger(m.seq) || m.seq < 1 || active.has(m.seq)) return
      if (active.size >= 32) { send({ mx: 'page-reply', seq: m.seq, ok: false, status: 429, error: 'Too many extension requests' }); return }
      active.add(m.seq)
      try {
        const method = String(m.method || 'GET').toUpperCase()
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Unsupported method')
        const path = pageApiPath(m.path)
        const query: Record<string, string | number | boolean> = {}
        if (m.query && typeof m.query === 'object' && !Array.isArray(m.query)) {
          for (const [k, v] of Object.entries(m.query).slice(0, 200)) if (['string', 'number', 'boolean'].includes(typeof v)) query[k] = v as string | number | boolean
        }
        const data = await request(`/api/ext/${seg(ext.id)}/${path}`, {
          method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
          body: method === 'GET' ? undefined : m.body ?? {}, query, signal: controller.signal,
        })
        send({ mx: 'page-reply', seq: m.seq, ok: true, data })
      } catch (e) {
        send({ mx: 'page-reply', seq: m.seq, ok: false, status: e instanceof ApiError ? e.status : 400, error: e instanceof Error ? e.message : String(e) })
      } finally { active.delete(m.seq) }
    }
    window.addEventListener('message', onMessage)
    return () => { clearTimeout(timer); controller.abort(); window.removeEventListener('message', onMessage) }
  }, [channel, ext.id, asking, navigate])

  React.useEffect(() => {
    const frame = requestAnimationFrame(() => iframe.current?.contentWindow?.postMessage({ mx: 'page-context', channel, theme, lang, route, vars: themeVars(), dictionary: extensionDictionary(lang) }, '*'))
    return () => cancelAnimationFrame(frame)
  }, [channel, theme, lang, route, palette, density, t])

  if (asking) return <FrameConsent id={ext.id} hosts={pendingHosts} onGrant={setGrant} onDecided={() => setDecided(true)} />
  return <div className="relative flex min-h-[60vh] flex-1 flex-col gap-3" aria-busy={!state.ready && !state.error}>
    {!state.ready && !state.error && <div className="absolute inset-x-4 top-4"><SkeletonText lines={5} /></div>}
    {state.error && <div role="alert" className="grid justify-items-start gap-3 rounded-lg border p-4">
      <p className="font-medium">{t('ext.loadFailed')}</p><p className="font-mono text-xs">{state.error}</p>
      <div className="flex gap-2"><Button variant="outline" onClick={() => retry((n) => n + 1)}>{t('common.retry')}</Button><AskFixButton ext={ext} error={{ message: state.error }} /></div>
    </div>}
    <iframe key={channel} ref={iframe} title={ext.name} src={frameSrc} hidden={!!state.error}
      onLoad={() => iframe.current?.contentWindow?.postMessage({ mx: 'page-ping', channel }, '*')}
      sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
      referrerPolicy="no-referrer" className="block min-h-[60vh] w-full flex-1 border-0" />
  </div>
}
