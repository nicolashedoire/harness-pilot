// Blocks drawn in a sandboxed frame: the built-in HTML mini-app (`app`) and every block extension.
// The frame is a document of its own served by /ext/_blocks/… with its own Content-Security-Policy (sandbox: opaque
// origin, no cookie, no app API; inline code only; network only to the hosts a block extension declared and the user
// allowed). It gets its data and the theme by postMessage - never in the URL - and can only ask for: a height, an
// error to be shown, and a text to send to the conversation (shown to the user, sent only if they confirm).
import * as React from 'react'
import { Globe, ShieldCheck, TriangleAlert, Wrench } from 'lucide-react'
import { useUI, resolveTheme } from '@/stores/ui'
import { useLang, useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { Badge, Button, Sensitive, Skeleton } from '@/components/ui'
import { useBlockConsent } from '../queries'
import { BlockNotice, BlockShell, downloadText, fileName, useDataMenu, useSendToSession } from '../shell'
import type { BlockPlugin } from '../types'
import type { RendererProps } from './types'

const THEME_VARS = [
  'background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground', 'muted', 'muted-foreground', 'accent', 'accent-foreground',
  'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'destructive', 'destructive-foreground', 'success', 'warning', 'border',
  'input', 'ring', 'radius', 'row-h', 'pad-card', 'series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-6',
]

export function themeVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const out: Record<string, string> = {}
  for (const n of THEME_VARS) out[`--${n}`] = cs.getPropertyValue(`--${n}`).trim()
  // the names the dashboard's HTML widgets used first
  Object.assign(out, { '--mx-bg': out['--background'], '--mx-card': out['--card'], '--mx-fg': out['--foreground'], '--mx-muted': out['--muted-foreground'], '--mx-border': out['--border'], '--mx-accent': out['--primary'] })
  return out
}

type FrameMsg = { mx?: string; height?: number; text?: string; message?: string }

/** One sandboxed block frame and its message bridge. `onLoader` answers the app frame's request for its HTML. */
function useBlockFrame({ data, type, onLoader, onError, maxH }: { data: unknown; type: string; onLoader?: (win: Window) => void; onError: (m: string) => void; maxH: number }) {
  const frame = React.useRef<HTMLIFrameElement>(null)
  const theme = resolveTheme(useUI((s) => s.theme))
  const look = useUI((s) => `${s.accent}.${s.tint}.${s.density}`)
  const [ready, setReady] = React.useState(false)
  const [height, setHeight] = React.useState<number | null>(null)
  const [left, setLeft] = React.useState(false)
  const send = useSendToSession()
  const sending = React.useRef(false)
  /** After a refusal the frame may not ask again for a while (no loop of confirmations). */
  const quietUntil = React.useRef(0)
  /** When the frame's document last spoke through the bridge ('loader' / 'ready'). */
  const lastSign = React.useRef(0)
  const lang = useLang()
  const [hash] = React.useState(() => encodeURIComponent(JSON.stringify({ theme: resolveTheme(useUI.getState().theme), vars: themeVars(), lang, type })))

  React.useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const win = frame.current?.contentWindow
      if (!win || e.source !== win) return
      const m = (e.data || {}) as FrameMsg
      if (m.mx === 'loader' && onLoader) {
        lastSign.current = Date.now()
        onLoader(win)
      } else if (m.mx === 'ready') {
        lastSign.current = Date.now()
        setReady(true)
        win.postMessage({ mx: 'data', data }, '*')
      } else if (m.mx === 'resize' && typeof m.height === 'number' && Number.isFinite(m.height)) {
        setHeight(Math.min(maxH, Math.max(48, Math.round(m.height))))
      } else if (m.mx === 'error') {
        onError(String(m.message ?? '').slice(0, 500))
      } else if (m.mx === 'send' && typeof m.text === 'string' && !sending.current && Date.now() > quietUntil.current) {
        sending.current = true
        void send(m.text.slice(0, 4000), frame.current)
          .then((ok) => {
            if (!ok) quietUntil.current = Date.now() + 30_000
          })
          .finally(() => (sending.current = false))
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [data, onLoader, onError, send, maxH])

  React.useEffect(() => {
    const r = requestAnimationFrame(() => frame.current?.contentWindow?.postMessage({ mx: 'theme', theme, vars: themeVars() }, '*'))
    return () => cancelAnimationFrame(r)
  }, [theme, look])

  // A document without the bridge in the frame (it navigated itself elsewhere, or its page failed) is stopped: the
  // bridge speaks while the page is parsed, so just before its load event.
  const onLoad = React.useCallback(() => {
    const at = Date.now()
    setTimeout(() => {
      if (lastSign.current < at - 3000 && frame.current) {
        frame.current.src = 'about:blank'
        setLeft(true)
      }
    }, 1500)
  }, [])

  return { frame, ready, height, hash, onLoad, left }
}

function FrameBox({ src, title, height, ready, frameRef, onLoad, minH }: { src: string; title: string; height: number; ready: boolean; frameRef: React.RefObject<HTMLIFrameElement | null>; onLoad: () => void; minH: number }) {
  return (
    <div className="relative" style={{ height: Math.max(minH, height) }}>
      {!ready && <Skeleton className="absolute inset-0 rounded-lg" />}
      <iframe
        ref={frameRef}
        title={title}
        src={src}
        onLoad={onLoad}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
        className={cn('block size-full rounded-lg border-0 bg-transparent transition-opacity duration-200', ready ? 'opacity-100' : 'opacity-0')}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ app (built-in) */
export function AppBlock({ block, size, onOpenBeside, onRaw }: RendererProps) {
  const t = useT()
  const d = block.data as { title?: string; html: string; height?: number }
  const [error, setError] = React.useState<string | null>(null)
  const onLoader = React.useCallback((win: Window) => win.postMessage({ mx: 'html', html: d.html }, '*'), [d.html])
  const f = useBlockFrame({ data: {}, type: 'app', onLoader, onError: setError, maxH: size === 'panel' ? 2000 : 1200 })
  const title = d.title || t('blocks.type.app')
  const menu = useDataMenu(block.raw, fileName(title, 'app'), onRaw)
  return (
    <BlockShell
      icon="app-window"
      title={<Sensitive>{title}</Sensitive>}
      source={<span className="inline-flex items-center gap-1"><ShieldCheck className="size-3.5" /> {t('blocks.app.isolated')}</span>}
      onOpenBeside={onOpenBeside}
      menu={[...menu, { label: t('blocks.app.downloadHtml'), onSelect: () => downloadText(`${fileName(title, 'app')}.html`, d.html, 'text/html') }]}
      bodyClassName="p-2"
    >
      {f.left ? (
        <p className="flex items-center gap-2 p-3 text-[13px] text-destructive"><TriangleAlert className="size-4" /> {t('blocks.frame.left')}</p>
      ) : (
        <FrameBox src={`/ext/_blocks/app-frame#${f.hash}`} title={title} height={f.height ?? d.height ?? 240} ready={f.ready} frameRef={f.frame} onLoad={f.onLoad} minH={d.height ?? 48} />
      )}
      {error && <p className="mt-2 flex items-start gap-1.5 px-1 text-xs text-destructive"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> <span className="font-mono break-all">{error}</span></p>}
    </BlockShell>
  )
}

/* ------------------------------------------------------------------ block extensions */
export function pluginName(p: BlockPlugin, lang: string) {
  return p.names[lang] || p.names.en || p.name || p.id
}

export function PluginBlock({ block, size, onOpenBeside, onRaw, onAskFix }: RendererProps & { onAskFix: (reason: string) => void }) {
  const t = useT()
  const lang = useLang()
  const p = block.plugin
  const consent = useBlockConsent()
  const [grant, setGrant] = React.useState<string | null>(null)
  const [decided, setDecided] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const name = pluginName(p, lang)
  const asking = p.consent === 'ask' && !grant && !decided
  const f = useBlockFrame({ data: block.data, type: block.type, onError: setError, maxH: size === 'panel' ? 2400 : 1600 })
  const title = (typeof block.data.title === 'string' && block.data.title) || name
  const menu = useDataMenu(block.raw, fileName(title, block.type), onRaw)
  if (asking)
    return (
      <BlockNotice
        tone="warning"
        type={block.type}
        raw={block.raw}
        icon={<Globe />}
        title={t('blocks.consent.title', { name })}
        actions={
          <>
            <Button size="sm" loading={consent.isPending && consent.variables?.decision === 'always'} onClick={() => consent.mutate({ id: p.id, decision: 'always' }, { onSuccess: () => setDecided(true) })}>
              {t('blocks.consent.always')}
            </Button>
            <Button variant="outline" size="sm" loading={consent.isPending && consent.variables?.decision === 'once'} onClick={() => consent.mutate({ id: p.id, decision: 'once' }, { onSuccess: (r) => r.grant && setGrant(r.grant) })}>
              {t('blocks.consent.once')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => consent.mutate({ id: p.id, decision: 'deny' }, { onSuccess: () => setDecided(true) })}>
              {t('blocks.consent.deny')}
            </Button>
          </>
        }
      >
        {t('blocks.consent.desc', { hosts: p.network.join(', ') })}
      </BlockNotice>
    )
  if (error)
    return (
      <BlockNotice
        tone="error"
        type={block.type}
        raw={block.raw}
        icon={<TriangleAlert />}
        title={t('blocks.error.plugin', { name })}
        actions={
          <Button size="sm" onClick={() => onAskFix(error)}>
            <Wrench /> {t('blocks.error.askFix')}
          </Button>
        }
      >
        <span className="font-mono break-all">{error}</span>
        <span className="block pt-1">{t('blocks.error.restSafe')}</span>
      </BlockNotice>
    )
  const net = p.network.length > 0 && (p.consent === 'granted' || grant)
  const src = `/ext/_blocks/${encodeURIComponent(p.id)}/frame?v=${p.entry_v ?? 0}${grant ? `&grant=${encodeURIComponent(grant)}` : ''}#${f.hash}`
  return (
    <BlockShell
      icon={p.icon}
      title={<Sensitive>{title}</Sensitive>}
      meta={
        <span className="inline-flex items-center gap-1.5">
          {name}
          {p.version && ` · v${p.version}`}
          {net ? <Badge variant="warning"><Globe /> {p.network.join(', ')}</Badge> : null}
        </span>
      }
      onOpenBeside={onOpenBeside}
      menu={menu}
      bodyClassName="p-2"
    >
      {f.left ? (
        <p className="flex items-center gap-2 p-3 text-[13px] text-destructive"><TriangleAlert className="size-4" /> {t('blocks.frame.left')}</p>
      ) : (
        <FrameBox src={src} title={title} height={f.height ?? p.height ?? 320} ready={f.ready} frameRef={f.frame} onLoad={f.onLoad} minH={48} />
      )}
    </BlockShell>
  )
}
