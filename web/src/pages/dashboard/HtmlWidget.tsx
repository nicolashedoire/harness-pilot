// HTML widget: an extension's widget.html drawn in a sandboxed iframe (scripts allowed, no same-origin -> no
// cookies, no access to the app or its API). The server serves it as its own document (`/ext/<id>/widget-frame`:
// an srcdoc frame would inherit the app's strict script policy), with a tiny bridge first (WIDGET_BRIDGE in
// server/maxxing/api/extensions.py); the theme goes in the URL fragment, then by message:
//   maxxing.api(path, {method, body, query}) -> Promise   (calls the extension's own api.py handle())
//   maxxing.resize(px) · maxxing.theme ('dark'|'light') · maxxing.onTheme(fn)
// The frame's uncaught errors and rejected promises come as {mx:'error', message, stack}: reported to the server as
// runtime errors of the extension (features/extensions/report.ts), read by the agent that fixes it, and the card shows
// the latest one under the frame with "Ask for a fix" (features/extensions/AskFix.tsx).
// and the app's theme variables (--background, --card, --primary, --border… and the older --mx-bg --mx-card --mx-fg
// --mx-muted --mx-border --mx-accent) follow the app theme; the UI kit (`ui-*` classes) is inlined by the server.
// Network: the frame's own policy only lets it reach the sites its manifest declares and the user allowed (card
// `network`); while a declared site waits for the user, the card asks first (Always / Once / Refuse, FrameConsent),
// and "Once" loads the frame with a one-hour grant (`?grant=`).
import * as React from 'react'
import { TriangleAlert, X } from 'lucide-react'
import { ApiError, request, seg } from '@/lib/api'
import { reportExtensionError } from '@/features/extensions/report'
import { AskFixButton } from '@/features/extensions/AskFix'
import { FrameConsent } from '@/features/extensions/Permissions'
import type { CardNetwork } from '@/lib/types'
import { useExtensions } from '@/lib/queries'
import { useUI, resolveTheme } from '@/stores/ui'
import { useT } from '@/i18n'
import { Button, Skeleton } from '@/components/ui'
import { cn } from '@/lib/utils'

const VARS: [string, string][] = [
  ['--mx-bg', '--background'],
  ['--mx-card', '--card'],
  ['--mx-fg', '--foreground'],
  ['--mx-muted', '--muted-foreground'],
  ['--mx-border', '--border'],
  ['--mx-accent', '--primary'],
  // the same names as the app, for the UI kit (server/maxxing/assets/ui-kit.css) and the widget's own CSS
  ...[
    'background', 'foreground', 'card', 'card-foreground', 'muted', 'muted-foreground', 'accent', 'accent-foreground',
    'primary', 'primary-foreground', 'action', 'action-foreground', 'secondary', 'secondary-foreground', 'destructive', 'destructive-foreground',
    'success', 'warning', 'border', 'input', 'ring', 'radius', 'row-h', 'pad-card', 'mx-font-sans', 'mx-font-mono',
  ].map((n): [string, string] => [`--${n}`, `--${n}`]),
]

export function themeVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  return Object.fromEntries(VARS.map(([k, v]) => [k, cs.getPropertyValue(v).trim()]))
}

// A path from the frame, made safe to append to /api/ext/<id>/: each segment encoded, '.' / '..'
// refused (also their percent-encoded forms), so a widget can only reach its own extension's API.
function extPath(raw: unknown): string {
  const parts = String(raw ?? '').replace(/^\/+/, '').split('/')
  return parts
    .map((p) => {
      let d = p
      try {
        d = decodeURIComponent(p)
      } catch {
        /* keep it as typed */
      }
      if (d.trim() === '.' || d.trim() === '..') throw new Error('Invalid path')
      return encodeURIComponent(d)
    })
    .join('/')
}

export function HtmlWidget({
  id,
  src,
  height,
  title,
  frameUrl,
  apiBase,
  onError,
  network,
}: {
  id: string
  src: string
  height: number
  title: string
  /** the frame document (default: `src` with widget.html -> widget-frame); a draft's preview passes its own */
  frameUrl?: string
  /** where `maxxing.api()` goes (default `/api/ext/<id>`; a draft's preview: `/api/atelier/drafts/<id>/api`) */
  apiBase?: string
  /** a script error of the widget (default: recorded against the installed extension) */
  onError?: (message: string, stack: string) => void
  /** what the frame may reach (the card's `network`): `ask` shows FrameConsent first */
  network?: CardNetwork
}) {
  const t = useT()
  const theme = resolveTheme(useUI((s) => s.theme))
  const palette = useUI((s) => s.palette)
  const density = useUI((s) => s.density)
  const frame = React.useRef<HTMLIFrameElement>(null)
  const [loaded, setLoaded] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [runtime, setRuntime] = React.useState<{ message: string; stack: string } | null>(null)
  const { data: exts } = useExtensions()
  const ext = exts?.find((e) => e.id === id) ?? { id, origin: null }
  const [h, setH] = React.useState(height)
  const errorRef = React.useRef(onError)
  errorRef.current = onError
  const [grant, setGrant] = React.useState<string | null>(null)
  const [decided, setDecided] = React.useState(false)
  const asking = network?.state === 'ask' && !grant && !decided
  // The frame URL is fixed once it shows (theme changes go by message): a new fragment would not reload it anyway.
  const frameSrc = React.useMemo(
    () =>
      `${frameUrl ?? src.replace(/widget\.html$/, 'widget-frame')}${grant ? `?grant=${encodeURIComponent(grant)}` : ''}#${encodeURIComponent(JSON.stringify({ theme: resolveTheme(useUI.getState().theme), vars: themeVars() }))}`,
    [src, frameUrl, grant],
  )

  // A missing or disabled widget: say so instead of an empty frame.
  React.useEffect(() => {
    let cancelled = false
    setError(null)
    fetch(src, { credentials: 'same-origin', cache: 'no-store', method: 'GET' })
      .then((r) => !cancelled && !r.ok && setError(`HTTP ${r.status}`))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [src])

  // Bridge: API calls (to this extension only), resize.
  React.useEffect(() => {
    const onMsg = async (e: MessageEvent) => {
      const win = frame.current?.contentWindow
      if (!win || e.source !== win) return
      const m = (e.data || {}) as { mx?: string; seq?: number; path?: string; method?: string; body?: unknown; query?: Record<string, string>; height?: number; message?: unknown; stack?: unknown }
      if (m.mx === 'resize' && typeof m.height === 'number') setH(Math.min(1200, Math.max(80, Math.round(m.height))))
      if (m.mx === 'error') {
        const message = String(m.message ?? ''), stack = typeof m.stack === 'string' ? m.stack : ''
        // a draft's preview keeps its errors to itself (nothing installed to record them against)
        if (errorRef.current) errorRef.current(message, stack)
        else {
          reportExtensionError(id, 'widget', message, stack)
          setRuntime({ message: message || 'Error', stack })
        }
      }
      if (m.mx === 'api') {
        const up = (m.method || 'GET').toUpperCase()
        const method = (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(up) ? up : 'GET') as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
        try {
          const data = await request(`${apiBase ?? `/api/ext/${seg(id)}`}/${extPath(m.path)}`, {
            method,
            body: method === 'GET' ? undefined : (m.body ?? {}),
            query: m.query,
          })
          win.postMessage({ mx: 'reply', seq: m.seq, ok: true, data }, '*')
        } catch (err) {
          // the status lets the bridge leave out what the server records itself (a failing handle(): 5xx)
          win.postMessage({ mx: 'reply', seq: m.seq, ok: false, status: err instanceof ApiError ? err.status : 0, error: err instanceof Error ? err.message : String(err) }, '*')
        }
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [id, apiBase])

  React.useEffect(() => {
    // after the <html> attributes changed (accent, tint, density set them in an effect too)
    const r = requestAnimationFrame(() => frame.current?.contentWindow?.postMessage({ mx: 'theme', theme, vars: themeVars() }, '*'))
    return () => cancelAnimationFrame(r)
  }, [theme, palette, density])

  if (asking && network)
    return <FrameConsent id={id} hosts={network.hosts} onGrant={setGrant} onDecided={() => setDecided(true)} />
  if (error)
    return (
      <div className="flex min-h-24 flex-col items-center justify-center gap-2 text-center">
        <TriangleAlert className="size-5 text-destructive" />
        <p className="text-[13px] text-muted-foreground">
          {t('ext.loadFailed')} ({error})
        </p>
      </div>
    )
  return (
    <>
    <div className="relative" style={{ height: h }}>
      {!loaded && <Skeleton className="absolute inset-0 rounded-lg" />}
      <iframe
        ref={frame}
        title={title}
        src={frameSrc}
        onLoad={() => setLoaded(true)}
        sandbox="allow-scripts allow-pointer-lock"
        referrerPolicy="no-referrer"
        className={cn('block size-full rounded-lg border-0 bg-transparent transition-opacity duration-200', loaded ? 'opacity-100' : 'opacity-0')}
      />
    </div>
    {runtime && (
      <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2" data-testid="widget-runtime-error">
        <TriangleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden />
        <span className="min-w-0 flex-[1_1_10rem] text-xs">
          <span className="font-medium">{t('exterr.widgetError')}</span>{' '}
          <span className="font-mono [overflow-wrap:anywhere] text-destructive">{runtime.message}</span>
        </span>
        <AskFixButton ext={ext} error={runtime} className="h-7" />
        <Button variant="ghost" size="icon-sm" className="size-7" aria-label={t('exterr.dismiss')} onClick={() => setRuntime(null)}>
          <X />
        </Button>
      </div>
    )}
    </>
  )
}
