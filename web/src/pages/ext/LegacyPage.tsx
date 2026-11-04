// /x/:id — extension pages. Loads /ext/<id>/@<page_v>/page.js (ES module) and calls mount(el, ctx).
// ctx = { api(path, {method, body}), navigate(route), theme: 'dark'|'light', lang: 'en'|'fr', t(key), icon(name) }
// The page is mounted inside `.mx-ext`, where the shared UI kit (`/ext/ui-kit.css`, `ui-*` classes) applies.
//   ctx.api('notes') → /api/ext/<id>/notes, JSON body + X-Maxxing header on non-GET, resolves to parsed JSON,
//   rejects with an Error on HTTP errors.
// What breaks in the page is reported to the server as runtime errors of the extension (features/extensions/report.ts):
// a module that fails to load, a mount() that throws, and while it is open the window's uncaught errors whose script is
// under /ext/<id>/ and the unhandled rejections from its code or its ctx.api() (except a 5xx: the server recorded it).
import * as React from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { useNavigate, useParams } from 'react-router'
import { Pin, PinOff, Puzzle, TriangleAlert } from 'lucide-react'
import { request, seg } from '@/lib/api'
import { describe, reportExtensionError, serverRecorded } from '@/features/extensions/report'
import { AskFixButton, FixTarget } from '@/features/extensions/AskFix'
import { useExtensions, usePinExtension } from '@/lib/queries'
import { useUI, resolveTheme } from '@/stores/ui'
import { useLang, useT, tDyn } from '@/i18n'
import { Button, EmptyState, NamedIcon, SkeletonText, Tooltip } from '@/components/ui'
import { PageHeader } from '@/components/shell/Page'

type Mount = (el: HTMLElement, ctx: ExtensionContext) => void | (() => void)
export type ExtensionContext = {
  id: string
  api: <T = unknown>(path: string, opts?: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; query?: Record<string, string | number> }) => Promise<T>
  navigate: (to: string) => void
  theme: 'dark' | 'light'
  /** the UI language */
  lang: string
  t: (key: string) => string
  /** an icon of the app (kebab-case lucide name, the curated set of NamedIcon; unknown -> puzzle) as an <svg> */
  icon: (name: string, opts?: { size?: number; className?: string }) => SVGElement
}

/** The UI kit stylesheet, added once to the document (pages share it, it stays for the next visit). */
function useUiKit() {
  React.useEffect(() => {
    if (document.getElementById('mx-ui-kit')) return
    const link = document.createElement('link')
    link.id = 'mx-ui-kit'
    link.rel = 'stylesheet'
    link.href = '/ext/ui-kit.css'
    document.head.append(link)
  }, [])
}

const iconCache = new Map<string, SVGElement>()
export function iconSvg(name: string, opts: { size?: number; className?: string } = {}): SVGElement {
  const key = String(name || '')
  let svg = iconCache.get(key)
  if (!svg) {
    const box = document.createElement('span')
    const root = createRoot(box)
    flushSync(() => root.render(<NamedIcon name={key} aria-hidden="true" />))
    svg = box.querySelector('svg') as SVGElement
    root.unmount()
    iconCache.set(key, svg)
  }
  const out = svg.cloneNode(true) as SVGElement
  out.setAttribute('class', ['ui-icon', opts.className].filter(Boolean).join(' '))
  if (opts.size) {
    out.setAttribute('width', String(opts.size))
    out.setAttribute('height', String(opts.size))
    out.style.width = out.style.height = `${opts.size}px`
  }
  return out
}

export default function ExtensionPage() {
  const t = useT()
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const theme = resolveTheme(useUI((s) => s.theme))
  const lang = useLang()
  const { data: exts } = useExtensions()
  const ext = exts?.find((e) => e.id === id)
  const pin = usePinExtension()
  const host = React.useRef<HTMLDivElement>(null)
  const [state, setState] = React.useState<{ status: 'loading' | 'ready' | 'error'; error?: string }>({ status: 'loading' })
  const [attempt, setAttempt] = React.useState(0)
  useUiKit()

  // The extensions list is a shell query (there at boot): wait for it to know the page's version.
  const version = exts ? (ext?.page_v ?? 0) : null
  const known = !!ext
  React.useEffect(() => {
    const el = host.current
    if (!el || !id || version === null) return
    let cleanup: void | (() => void)
    let cancelled = false
    let reported = false
    const report = (message: string, stack = '') => {
      reported = true
      if (known) reportExtensionError(id, 'page', message, stack)
    }
    setState({ status: 'loading' })
    const ctx: ExtensionContext = {
      id,
      api: <T,>(path: string, opts: Parameters<ExtensionContext['api']>[1] = {}) =>
        request<T>(`/api/ext/${seg(id)}/${path.replace(/^\/+/, '')}`, { method: opts.method || 'GET', body: opts.method && opts.method !== 'GET' ? (opts.body ?? {}) : undefined, query: opts.query }).catch((e: unknown) => {
          if (e && typeof e === 'object') (e as { mxExt?: string }).mxExt = id // left unhandled: the page's error
          throw e
        }),
      navigate: (to) => navigate(to),
      theme,
      lang,
      t: (key) => tDyn(t, key),
      icon: iconSvg,
    }
    // Versioned in the path (page_v = newest mtime of the page's modules): page.js and the modules it imports
    // relatively (./lib/x.js -> /ext/<id>/@<v>/lib/x.js) are downloaded and evaluated once; editing any of them gives
    // them all a new URL (a query string would not reach the relative imports). A retry (attempt) fetches them again.
    const url = `/ext/${encodeURIComponent(id)}/@${version || Date.now()}${attempt ? `-${attempt}` : ''}/page.js`
    import(/* @vite-ignore */ url)
      .then((mod: { mount?: Mount; default?: { mount?: Mount } }) => {
        if (cancelled) return
        const mount = mod.mount || mod.default?.mount
        if (typeof mount !== 'function') {
          report('page.js does not export mount(el, ctx)')
          throw new Error(t('ext.noMount'))
        }
        el.replaceChildren()
        try {
          cleanup = mount(el, ctx)
        } catch (e) {
          const d = describe(e)
          report(d.message, d.stack)
          throw e
        }
        setState({ status: 'ready' })
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setState({ status: 'error', error: e instanceof Error ? e.message : String(e) })
        if (!reported) {
          const d = describe(e) // the module (or one it imports) did not load: missing, not served, a syntax error
          report(d.message, d.stack)
        }
      })
    return () => {
      cancelled = true
      try {
        if (typeof cleanup === 'function') cleanup()
      } catch {
        /* extension cleanup errors are ignored */
      }
      el.replaceChildren()
    }
  }, [id, version, known, theme, lang, navigate, t, attempt])

  // While the page is open: the window's errors from its own modules, and rejections from its code or its ctx.api().
  React.useEffect(() => {
    if (!id || !known) return
    const mine = `/ext/${encodeURIComponent(id)}/`
    const ours = (s: unknown) => typeof s === 'string' && s.includes(mine)
    const onError = (e: ErrorEvent) => {
      if (!ours(e.filename) && !ours((e.error as Error | undefined)?.stack)) return
      const d = e.error ? describe(e.error) : { message: e.message, stack: '' }
      reportExtensionError(id, 'page', d.message || e.message, d.stack || `at ${e.filename}:${e.lineno}:${e.colno}`)
    }
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason as { mxExt?: string; stack?: unknown } | null | undefined
      if (!(r && typeof r === 'object' && r.mxExt === id) && !ours(r?.stack)) return
      if (serverRecorded(r)) return
      const d = describe(r)
      reportExtensionError(id, 'page', `Unhandled rejection: ${d.message}`, d.stack)
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [id, known])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={ext?.name || id}
        actions={
          ext?.type === 'page' && (
            <Tooltip content={ext.pinned ? t('ext.unpin') : t('ext.pin')}>
              <Button
                variant="ghost"
                size="icon-sm"
                className={ext.pinned ? 'text-primary' : 'text-muted-foreground'}
                aria-label={ext.pinned ? t('ext.unpin') : t('ext.pin')}
                aria-pressed={!!ext.pinned}
                onClick={() => pin.mutate({ id: ext.id, pinned: !ext.pinned })}
              >
                {ext.pinned ? <PinOff /> : <Pin />}
              </Button>
            </Tooltip>
          )
        }
      />
      <div className="relative flex-1 px-4 py-6 md:px-6">
        {state.status === 'loading' && (
          <div className="absolute inset-x-4 top-6 md:inset-x-6">
            <SkeletonText lines={6} className="max-w-2xl" />
          </div>
        )}
        {state.status === 'error' && (
          <EmptyState
            icon={ext ? TriangleAlert : Puzzle}
            tone={ext ? 'error' : 'default'}
            title={ext ? t('ext.loadFailed') : t('ext.notFound')}
            description={
              <span className="grid justify-items-center gap-2">
                <span className="font-mono text-xs break-all">{state.error}</span>
                {ext && <FixTarget ext={ext} className="justify-center text-center" />}
              </span>
            }
            action={
              ext ? (
                <span className="flex flex-wrap justify-center gap-2">
                  <AskFixButton ext={ext} error={{ message: state.error || '' }} size="default" />
                  <Button variant="outline" onClick={() => setAttempt((a) => a + 1)}>
                    {t('common.retry')}
                  </Button>
                </span>
              ) : (
                <Button onClick={() => setAttempt((a) => a + 1)}>{t('common.retry')}</Button>
              )
            }
          />
        )}
        <div ref={host} className="mx-ext" hidden={state.status === 'error'} />
      </div>
    </div>
  )
}
