// Settings -> Appearance -> Create with harness-pilot (the theme generator): the user describes a theme (and may
// attach an image), a session in the topic `system/themes` runs the skill `pilot-theme`, which writes a
// `<name>.theme.json`; the server reads it back validated (GET /api/settings/themes/session/{id}), normalizeTheme
// checks it again, and the proposal is previewed in place. Refinements are follow-up messages to the same session.
// Nothing is applied until the user clicks Apply. URL: /settings/appearance?create=1&session=<id>.
import * as React from 'react'
import { Link, useSearchParams } from 'react-router'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, ArrowUp, BookmarkPlus, ExternalLink, ImagePlus, Moon, Palette, Sparkles, Sun, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { deriveTokens, normalizeTheme, type Mode } from '@/lib/theme'
import { fetchSessionTheme, fileThumbUrl, qk, useCreateSession, useSaveTheme, useSendMessage, useSession, workspaceQuery } from '@/lib/queries'
import type { UploadResult } from '@/lib/types'
import { useUI, resolveTheme } from '@/stores/ui'
import { cn } from '@/lib/utils'
import { useT, type TKey } from '@/i18n'
import { Button, Segmented, Sensitive, Skeleton, Spinner, Textarea, toast } from '@/components/ui'
import { SwatchStrip, ThemeChecks, ThemeSample, themeName } from './Preview'

export const THEME_TOPIC = { project: 'system', topic: 'themes', path: 'projects/system/topics/themes' }
const TOPIC_DESC = 'Colour themes made from your words with the pilot-theme skill (Settings -> Appearance -> Create).'
const IMAGES_MAX = 3
const IMAGE_MB = 10

/** The dedicated topic, created on first use (and its project, if it was deleted). */
async function ensureThemeTopic(qc: QueryClient): Promise<string> {
  const tree = await qc.fetchQuery(workspaceQuery())
  const project = tree.projects.find((p) => p.name === THEME_TOPIC.project)
  if (project?.topics.some((x) => x.name === THEME_TOPIC.topic)) return THEME_TOPIC.path
  const ok409 = (e: unknown) => {
    if (!(e instanceof ApiError && e.status === 409)) throw e
  }
  if (!project) await api.post('/api/workspace/projects', { name: THEME_TOPIC.project }).catch(ok409)
  await api.post(`/api/workspace/projects/${THEME_TOPIC.project}/topics`, { name: THEME_TOPIC.topic, description: TOPIC_DESC }).catch(ok409)
  void qc.invalidateQueries({ queryKey: qk.workspace })
  return THEME_TOPIC.path
}

const SINCE = (sid: string) => `mx-themegen-since:${sid}`
const readSince = (sid: string | null) => {
  try {
    const v = sid ? Number(sessionStorage.getItem(SINCE(sid))) : 0
    return v > 0 ? v : null
  } catch {
    return null
  }
}
const writeSince = (sid: string, v: number | null) => {
  try {
    if (v) sessionStorage.setItem(SINCE(sid), String(v))
    else sessionStorage.removeItem(SINCE(sid))
  } catch {
    // private mode: the proposal is read from the session's start
  }
}

const CHIPS: [TKey, TKey][] = [
  ['themegen.chip.contrast', 'themegen.chip.contrastDo'],
  ['themegen.chip.neutral', 'themegen.chip.neutralDo'],
  ['themegen.chip.cooler', 'themegen.chip.coolerDo'],
  ['themegen.chip.light', 'themegen.chip.lightDo'],
]

type Image = { path: string; name: string }

export function ThemeCreator({ backTo }: { backTo: string }) {
  const t = useT()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const sid = params.get('session')
  const { data: session } = useSession(sid)
  const create = useCreateSession()
  const send = useSendMessage()
  const save = useSaveTheme()
  const [prompt, setPrompt] = React.useState('')
  const [images, setImages] = React.useState<Image[]>([])
  const [uploading, setUploading] = React.useState(false)
  const [refineText, setRefineText] = React.useState('')
  const [starting, setStarting] = React.useState(false)
  const [mode, setMode] = React.useState<Mode>(() => resolveTheme(useUI.getState().theme))
  const [since, setSince] = React.useState<number | null>(() => readSince(sid))
  // a message just sent: "working" until its turn shows up as started / finished (no flash of "nothing yet")
  const [sent, setSent] = React.useState<{ turns: number; at: number } | null>(null)
  const file = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => setSince(readSince(sid)), [sid])

  const running = !!session && (session.state === 'running' || session.queue > 0)
  React.useEffect(() => {
    if (!sent || !session) return
    if (session.turns > sent.turns || session.state === 'error') return setSent(null)
    if (!running) {
      const id = setTimeout(() => setSent(null), Math.max(0, 20_000 - (Date.now() - sent.at)))
      return () => clearTimeout(id)
    }
  }, [sent, session, running])
  const working = starting || running || !!sent

  const proposalQ = useQuery({
    queryKey: ['themegen', sid, since, session?.turns],
    queryFn: () => fetchSessionTheme(sid!, since),
    enabled: !!sid && !!session && !working && session.state !== 'error',
    retry: false,
    staleTime: Infinity,
  })
  const proposal = React.useMemo(() => (proposalQ.data ? { ...proposalQ.data, ...normalizeTheme(proposalQ.data.theme) } : null), [proposalQ.data])
  const err = proposalQ.error instanceof ApiError ? proposalQ.error : null
  const tokens = proposal ? deriveTokens(proposal.theme, mode) : null
  const name = proposal ? themeName(t, proposal.theme) : ''
  const sessionUrl = sid ? `/sessions?path=${encodeURIComponent(session?.path || THEME_TOPIC.path)}&session=${encodeURIComponent(sid)}` : ''

  const addImages = async (list: FileList | null) => {
    const files = [...(list || [])].filter((f) => f.type.startsWith('image/'))
    if (!files.length) return
    if (files.some((f) => f.size > IMAGE_MB * 1024 * 1024)) return toast.error(t('themegen.image.tooBig', { mb: IMAGE_MB }))
    setUploading(true)
    try {
      const path = await ensureThemeTopic(qc)
      const r = await api.upload<UploadResult>('/api/uploads', files.slice(0, IMAGES_MAX - images.length), { path })
      setImages((cur) => [...cur, ...r.files.map((f) => ({ path: f.path, name: f.name }))].slice(0, IMAGES_MAX))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  const generate = async () => {
    const request = prompt.trim()
    if (!request || working) return
    setStarting(true)
    try {
      const path = await ensureThemeTopic(qc)
      const message = [t('themegen.prompt.create', { request }), images.length ? t('themegen.prompt.images', { count: images.length }) : '', t('themegen.prompt.deliver')]
        .filter(Boolean)
        .join('\n\n')
      const s = await create.mutateAsync({ path, message, title: t('themegen.sessionTitle', { request: request.slice(0, 48) }), attachments: images.map((i) => i.path) })
      setSent({ turns: s.turns, at: Date.now() })
      writeSince(s.id, null)
      setParams((p) => {
        const n = new URLSearchParams(p)
        n.set('create', '1')
        n.set('session', s.id)
        return n
      })
      setImages([])
    } catch {
      // the mutation's toast says why
    } finally {
      setStarting(false)
    }
  }

  const refine = async (instruction: string) => {
    if (!sid || !session || working || !instruction.trim()) return
    // a file newer than the proposal shown (server clock on both sides), else anything after the last turn
    const next = proposal ? proposal.at + 0.001 : session.updated
    try {
      const r = await send.mutateAsync({ id: sid, text: t('themegen.prompt.refine', { request: instruction.trim(), file: proposal?.file || '*.theme.json' }) })
      setSent({ turns: r.session.turns, at: Date.now() })
      writeSince(sid, next)
      setSince(next)
      setRefineText('')
    } catch {
      // toast
    }
  }

  const discard = () => {
    if (sid) writeSince(sid, null)
    setSent(null)
    setParams((p) => {
      const n = new URLSearchParams(p)
      n.delete('session')
      return n
    })
  }

  const apply = () => {
    if (!proposal) return
    useUI.getState().setPalette(proposal.theme)
    toast.success(t('themegen.applied', { name }))
  }

  return (
    <div className="grid gap-5" data-testid="theme-creator">
      <nav className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground" aria-label={t('themegen.title')}>
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link to={backTo}>
            <ArrowLeft /> {t('settings.appearance')}
          </Link>
        </Button>
        <span aria-hidden>/</span>
        <span className="truncate font-medium text-foreground">{t('themegen.title')}</span>
      </nav>
      <div className="flex flex-wrap items-start gap-6">
        <section className="flex min-w-0 flex-[1_1_21rem] flex-col gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">{t('themegen.heading')}</h2>
            <p className="mt-1.5 text-[14px] text-muted-foreground">{t('themegen.intro')}</p>
          </div>
          <form
            className="flex flex-col gap-3 rounded-xl border bg-card p-3.5 focus-within:border-ring/60"
            onSubmit={(e) => {
              e.preventDefault()
              void generate()
            }}
          >
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              minRows={3}
              maxRows={8}
              maxLength={2000}
              placeholder={t('themegen.placeholder')}
              aria-label={t('themegen.promptLabel')}
              className="resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void generate()
                }
              }}
              data-testid="themegen-prompt"
            />
            <div className="flex flex-wrap items-center gap-2">
              {images.map((img) => (
                <span key={img.path} className="flex h-8 max-w-48 items-center gap-2 rounded-lg border bg-muted/50 pr-1 pl-1 text-xs">
                  <img src={fileThumbUrl(img.path, 48)} alt="" className="size-6 shrink-0 rounded-[5px] object-cover" />
                  <span className="min-w-0 truncate"><Sensitive>{img.name}</Sensitive></span>
                  <Button type="button" variant="ghost" size="icon-sm" className="size-6" aria-label={t('themegen.image.remove', { name: img.name })} onClick={() => setImages((cur) => cur.filter((x) => x !== img))}>
                    <X className="size-3.5" />
                  </Button>
                </span>
              ))}
              {images.length < IMAGES_MAX && (
                <Button type="button" variant="outline" size="sm" className="border-dashed" onClick={() => file.current?.click()} loading={uploading} disabled={working}>
                  <ImagePlus /> {t('themegen.image.add')}
                </Button>
              )}
              <input ref={file} type="file" accept="image/*" multiple className="hidden" onChange={(e) => (void addImages(e.target.files), (e.target.value = ''))} />
              <span className="flex-1" />
              <span className="text-xs text-muted-foreground">{t('themegen.cost')}</span>
              <Button type="submit" disabled={!prompt.trim() || working} loading={starting} data-testid="themegen-generate">
                <Sparkles /> {t('themegen.generate')}
              </Button>
            </div>
          </form>

          <div className={cn('grid gap-2.5', (!sid || !session) && 'opacity-60')}>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('themegen.refine')}</h3>
            <div className="flex flex-wrap gap-1.5">
              {CHIPS.map(([label, todo]) => (
                <Button key={label} type="button" variant="outline" size="sm" className="rounded-full" disabled={!proposal || working} onClick={() => void refine(t(todo))}>
                  {t(label)}
                </Button>
              ))}
            </div>
            <form
              className="flex h-11 items-center gap-2 rounded-lg border bg-background pr-1.5 pl-3 focus-within:border-ring/60"
              onSubmit={(e) => {
                e.preventDefault()
                void refine(refineText)
              }}
            >
              <input
                value={refineText}
                onChange={(e) => setRefineText(e.target.value)}
                placeholder={t('themegen.refinePlaceholder')}
                aria-label={t('themegen.refineLabel')}
                maxLength={1000}
                disabled={!sid || !session || working}
                className="min-w-0 flex-1 bg-transparent text-[14px] outline-none disabled:cursor-not-allowed"
                data-testid="themegen-refine"
              />
              <Button type="submit" size="icon-sm" variant="secondary" aria-label={t('themegen.refineSend')} disabled={!refineText.trim() || !sid || working}>
                <ArrowUp />
              </Button>
            </form>
          </div>

          {proposal && (
            <div className="grid gap-2.5 rounded-xl border p-4">
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('themegen.checks')}</h3>
              <ThemeChecks report={proposal.report} />
            </div>
          )}
        </section>

        <section aria-label={t('themegen.proposal')} className="flex min-w-0 flex-[1_1_24rem] flex-col gap-3.5" aria-busy={working} aria-live="polite">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="min-w-0 flex-1 truncate text-base font-semibold">
              {proposal ? t('themegen.proposalOf', { name }) : t('themegen.proposal')}
            </h2>
            <Segmented<Mode>
              value={mode}
              onChange={setMode}
              aria-label={t('colors.preview')}
              options={[
                { value: 'dark', label: t('theme.dark'), icon: <Moon /> },
                { value: 'light', label: t('theme.light'), icon: <Sun /> },
              ]}
            />
          </div>

          {working ? (
            <div className="grid gap-3">
              <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Spinner className="size-4" /> {t('themegen.working')}
                {sid && (
                  <Link to={sessionUrl} className="ml-auto inline-flex items-center gap-1 text-primary hover:underline">
                    {t('themegen.openSession')} <ExternalLink className="size-3.5" />
                  </Link>
                )}
              </div>
              <Skeleton className="h-[22rem] rounded-xl" />
              <Skeleton className="h-10 rounded-lg" />
            </div>
          ) : proposal && tokens ? (
            <>
              {proposal.theme.description && <p className="text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{proposal.theme.description}</p>}
              <ThemeSample tokens={tokens} label={t('themegen.sampleOf', { name })} />
              <SwatchStrip tokens={tokens} />
              {session?.last_text && (
                <p className="line-clamp-3 rounded-lg bg-muted/50 px-3 py-2 text-[13px] text-muted-foreground [overflow-wrap:anywhere]">
                  <Sensitive>{session.last_text}</Sensitive>
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button size="lg" onClick={apply} data-testid="themegen-apply">{t('themegen.apply')}</Button>
                <Button
                  size="lg"
                  variant="outline"
                  loading={save.isPending}
                  onClick={() => save.mutate({ theme: { ...proposal.theme, name }, source: 'created' }, { onSuccess: () => toast.success(t('themegen.saved', { name })) })}
                  data-testid="themegen-save"
                >
                  <BookmarkPlus /> {t('themegen.save')}
                </Button>
                <Button size="lg" variant="ghost" onClick={discard} data-testid="themegen-discard">{t('themegen.discard')}</Button>
                <Link to={sessionUrl} className="ml-auto inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
                  {t('themegen.openSession')} <ExternalLink className="size-3.5" />
                </Link>
              </div>
            </>
          ) : sid && (err || session?.state === 'error') ? (
            <div className="grid gap-3 rounded-xl border border-dashed p-5 text-[13px]" role="status">
              <span className="flex items-start gap-2 font-medium">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                {session?.state === 'error' ? t('themegen.err.session') : err?.code === 'no_theme' ? t('themegen.err.none') : t('themegen.err.invalid')}
              </span>
              {(session?.state === 'error' ? session.error : err?.code !== 'no_theme' ? err?.message : session?.last_text) && (
                <p className="line-clamp-4 text-muted-foreground [overflow-wrap:anywhere]">
                  <Sensitive>{session?.state === 'error' ? session.error : err?.code !== 'no_theme' ? err?.message : session?.last_text}</Sensitive>
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {session?.state !== 'error' && (
                  <Button size="sm" variant="outline" onClick={() => void refine(t('themegen.prompt.retry'))}>{t('themegen.retry')}</Button>
                )}
                <Button size="sm" variant="ghost" asChild>
                  <Link to={sessionUrl}>{t('themegen.openSession')}</Link>
                </Button>
                <Button size="sm" variant="ghost" onClick={discard}>{t('themegen.discard')}</Button>
              </div>
            </div>
          ) : (
            <div className="grid min-h-[22rem] place-items-center rounded-xl border border-dashed p-6 text-center" data-testid="themegen-empty">
              <div className="grid max-w-xs justify-items-center gap-2 text-[13px] text-muted-foreground">
                <span className="grid size-10 place-items-center rounded-full bg-primary/10 text-primary">
                  <Palette className="size-5" />
                </span>
                {sid && !session ? <Spinner className="size-4" /> : t('themegen.empty')}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
