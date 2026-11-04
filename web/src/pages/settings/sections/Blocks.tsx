// Settings > Conversation blocks: every block type an agent can show is a plugin (built-in or block extension),
// turned on or off here; the agents are told the enabled list. Detail panel, catalogue of ideas, "create one".
import * as React from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { Bot, ChevronRight, Globe, Plus, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLang, useT } from '@/i18n'
import { Badge, Button, EmptyState, NamedIcon, Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle, Skeleton, Switch, Textarea, confirm } from '@/components/ui'
import { api, ApiError } from '@/lib/api'
import { qk, useCreateSession, workspaceQuery } from '@/lib/queries'
import { useBlockConsent, useBlocks, useToggleBlock } from '@/features/blocks/queries'
import { builtinDesc, categoryLabel, pluginLabel } from '@/features/blocks/labels'
import { SAMPLES } from '@/features/blocks/samples'
import type { BlockCategory, BlockPlugin } from '@/features/blocks/types'
import { SettingsCard, SectionStack } from './ui'

const BlockPreview = React.lazy(() => import('@/features/blocks/BlockFence').then((m) => ({ default: m.BlockPreview })))

const CATEGORIES: BlockCategory[] = ['data', 'interactive', 'code', 'media', 'organisation', 'other']
type Filter = 'all' | 'enabled' | 'builtin' | 'extension'

/** Ideas the catalogue offers: harness-pilot builds them as block extensions (no remote marketplace). */
const IDEAS = [
  { id: 'calendar', icon: 'calendar-days', net: false },
  { id: 'kanban', icon: 'kanban', net: false },
  { id: 'formula', icon: 'sigma', net: false },
  { id: 'sheet', icon: 'table', net: false },
  { id: 'mindmap', icon: 'network', net: false },
  { id: 'compare', icon: 'image', net: false },
  { id: 'map', icon: 'map', net: true },
  { id: 'roadmap', icon: 'calendar-range', net: false },
] as const

const HARNESS = { project: 'system', topic: 'harness', path: 'projects/system/topics/harness' }
const HARNESS_DESC = 'Updates and customizations of this server'

/** The topic that builds the plugin: system/harness (system/update on older workspaces), created again (with its
 *  project) when the user deleted it - never the workspace root, where a session reaches every project's files. */
async function ensureHarnessTopic(qc: QueryClient): Promise<string> {
  const tree = await qc.fetchQuery(workspaceQuery())
  const project = tree.projects.find((p) => p.name === HARNESS.project)
  const found = project?.topics.find((x) => x.name === HARNESS.topic) ?? project?.topics.find((x) => x.name === 'update')
  if (found) return found.path
  const ok409 = (e: unknown) => {
    if (!(e instanceof ApiError && e.status === 409)) throw e
  }
  if (!project) await api.post('/api/workspace/projects', { name: HARNESS.project }).catch(ok409)
  await api.post(`/api/workspace/projects/${HARNESS.project}/topics`, { name: HARNESS.topic, description: HARNESS_DESC }).catch(ok409)
  void qc.invalidateQueries({ queryKey: qk.workspace })
  return HARNESS.path
}

/** A session in the system topic asking harness-pilot to build a block plugin. */
function useCreatePlugin() {
  const t = useT()
  const navigate = useNavigate()
  const create = useCreateSession()
  const qc = useQueryClient()
  return React.useCallback(
    async (what: string) => {
      const prompt = t('blocks.create.prompt', { what: what.trim() || t('blocks.create.what') })
      const ok = await confirm({
        title: t('blocks.create.confirmTitle'),
        description: (
          <span className="grid gap-2">
            <span>{t('blocks.create.confirmDesc')}</span>
            <span className="block max-h-48 overflow-auto rounded-md border bg-muted/40 p-2.5 text-left text-[13px] whitespace-pre-wrap text-foreground">{prompt}</span>
          </span>
        ),
        confirmText: t('blocks.create.start'),
      })
      if (!ok) return
      const path = await ensureHarnessTopic(qc)
      const s = await create.mutateAsync({ path, message: prompt, title: t('blocks.create.sessionTitle') })
      navigate(`/sessions?session=${encodeURIComponent(s.id)}`)
    },
    [t, qc, create, navigate],
  )
}

export function BlocksSection() {
  const t = useT()
  const lang = useLang()
  const { data, isLoading, isError, refetch } = useBlocks()
  const toggle = useToggleBlock()
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = React.useState<Filter>('all')
  const [open, setOpen] = React.useState<string | null>(null)
  const catalogue = params.get('catalogue') === '1'
  const createPlugin = useCreatePlugin()
  const showCatalogue = (on: boolean) => {
    const next = new URLSearchParams(params)
    if (on) next.set('catalogue', '1')
    else next.delete('catalogue')
    setParams(next, { replace: true })
  }

  const plugins = data?.plugins ?? []
  const counts = { all: plugins.length, enabled: plugins.filter((p) => p.enabled && !p.error).length, builtin: plugins.filter((p) => p.kind === 'builtin').length, extension: plugins.filter((p) => p.kind === 'extension').length }
  const shown = plugins.filter((p) => filter === 'all' || (filter === 'enabled' ? p.enabled && !p.error : p.kind === filter))
  const selected = plugins.find((p) => p.id === open) ?? null

  return (
    <SectionStack>
      <SettingsCard
        title={t('blocks.plugins')}
        description={t('blocks.section.intro')}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => showCatalogue(!catalogue)} aria-pressed={catalogue}>
              <Sparkles /> {catalogue ? t('blocks.catalogue.close') : t('blocks.catalogue.open')}
            </Button>
            <Button size="sm" onClick={() => void createPlugin('')}>
              <Plus /> {t('blocks.create.button')}
            </Button>
          </>
        }
        className="[&>div:last-child]:p-0 [&>div:last-child]:pt-4"
      >
        <div className="flex flex-wrap gap-2 px-[var(--pad-card)] pb-3" role="radiogroup" aria-label={t('blocks.filter.label')}>
          {(['all', 'enabled', 'builtin', 'extension'] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-md:h-10',
                filter === f ? 'border-transparent bg-secondary font-medium text-secondary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {t(`blocks.filter.${f}`)}
              <span className="tabular-nums opacity-70">{counts[f]}</span>
            </button>
          ))}
        </div>
        {isLoading ? (
          <div className="grid gap-2 p-[var(--pad-card)] pt-0">
            {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-16" />)}
          </div>
        ) : isError ? (
          <EmptyState compact tone="error" icon={TriangleAlert} title={t('blocks.error.catalog')} action={<Button variant="outline" size="sm" onClick={() => refetch()}>{t('common.retry')}</Button>} />
        ) : !shown.length ? (
          <EmptyState compact icon={Sparkles} title={t('blocks.empty')} description={t('blocks.emptyDesc')} />
        ) : (
          <div className="grid gap-5 border-t px-[var(--pad-card)] py-4">
            {CATEGORIES.map((cat) => {
              const list = shown.filter((p) => p.category === cat)
              if (!list.length) return null
              return (
                <div key={cat} className="grid gap-2">
                  <h4 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{categoryLabel(t, cat)}</h4>
                  <ul className="grid gap-2">
                    {list.map((p) => (
                      <PluginRow key={p.id} p={p} lang={lang} selected={open === p.id} onOpen={() => setOpen(p.id)} onToggle={(v) => toggle.mutate({ id: p.id, enabled: v })} />
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        )}
      </SettingsCard>

      {catalogue && <CatalogueCard plugins={plugins} onCreate={createPlugin} onClose={() => showCatalogue(false)} />}

      {data && <AgentsCard types={data.agents.types} paths={[data.agents.skill, data.agents.codex]} />}

      <Sheet open={!!selected} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent className="md:w-[460px]">
          {selected && <PluginDetail p={selected} lang={lang} onToggle={(v) => toggle.mutate({ id: selected.id, enabled: v })} />}
        </SheetContent>
      </Sheet>
    </SectionStack>
  )
}

function PluginRow({ p, lang, selected, onOpen, onToggle }: { p: BlockPlugin; lang: string; selected: boolean; onOpen: () => void; onToggle: (v: boolean) => void }) {
  const t = useT()
  const name = pluginLabel(t, p, lang)
  const desc = p.kind === 'builtin' ? builtinDesc(t, p.id) : p.description || p.hint
  return (
    <li
      className={cn(
        'flex items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors',
        selected ? 'border-primary/60 bg-primary/5' : 'hover:bg-accent/40',
        !p.enabled && 'opacity-75',
      )}
    >
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md" aria-label={`${name}: ${t('blocks.detail.open')}`}>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
          <NamedIcon name={p.icon} className="size-4.5 text-muted-foreground" />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{name}</span>
            {p.kind === 'builtin' ? (
              <Badge variant="muted">{t('blocks.kind.builtin')}</Badge>
            ) : (
              <Badge variant="muted">{t('blocks.kind.extension')}{p.version ? ` · v${p.version}` : ''}</Badge>
            )}
            {p.network.length > 0 && (
              <Badge variant="warning">
                <Globe /> {t('blocks.network.badge', { hosts: p.network.join(', ') })}
              </Badge>
            )}
            {p.error && <Badge variant="destructive"><TriangleAlert /> {t('blocks.badge.error')}</Badge>}
          </span>
          <span className="truncate text-[13px] text-muted-foreground">{p.error || desc}</span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground max-sm:hidden" />
      </button>
      <Switch checked={p.enabled} onCheckedChange={onToggle} aria-label={`${t('blocks.detail.enabled')}: ${name}`} />
    </li>
  )
}

function PluginDetail({ p, lang, onToggle }: { p: BlockPlugin; lang: string; onToggle: (v: boolean) => void }) {
  const t = useT()
  const consent = useBlockConsent()
  const name = pluginLabel(t, p, lang)
  const sample = p.kind === 'builtin' ? SAMPLES[p.id] : undefined
  const access =
    p.network.length === 0
      ? t('blocks.detail.noAccess')
      : p.consent === 'granted'
        ? t('blocks.detail.netGranted', { hosts: p.network.join(', ') })
        : p.consent === 'denied'
          ? t('blocks.detail.netDenied', { hosts: p.network.join(', ') })
          : t('blocks.detail.netAsk', { hosts: p.network.join(', ') })
  return (
    <>
      <SheetHeader className="flex-row items-center gap-3 pr-12">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border bg-muted/50">
          <NamedIcon name={p.icon} className="size-5 text-primary" />
        </span>
        <span className="grid min-w-0 gap-0.5">
          <SheetTitle className="truncate">{name}</SheetTitle>
          <SheetDescription>
            {p.kind === 'builtin' ? t('blocks.kind.builtin') : t('blocks.kind.extension')}
            {p.version ? ` · v${p.version}` : ''}
          </SheetDescription>
        </span>
      </SheetHeader>
      <SheetBody className="grid content-start gap-5">
        {sample && (
          <div className="overflow-hidden rounded-xl border bg-background/60 p-3">
            <React.Suspense fallback={<Skeleton className="h-40" />}>
              <BlockPreview plugin={p} data={sample} />
            </React.Suspense>
          </div>
        )}
        {p.error && (
          <p className="flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-[13px] text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> <span className="font-mono break-all">{p.error}</span>
          </p>
        )}
        <dl className="grid grid-cols-[7.5rem_1fr] gap-x-4 gap-y-2.5 text-[13px]">
          <dt className="text-muted-foreground">{t('blocks.detail.renders')}</dt>
          <dd className="flex flex-wrap gap-1.5">{p.renders.map((r) => <code key={r} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">{r}</code>)}</dd>
          <dt className="text-muted-foreground">{t('blocks.detail.access')}</dt>
          <dd>{access}</dd>
          <dt className="text-muted-foreground">{t('blocks.detail.colors')}</dt>
          <dd>{t('blocks.detail.colorsValue')}</dd>
          <dt className="text-muted-foreground">{t('blocks.detail.offered')}</dt>
          <dd className="flex flex-wrap gap-1.5">
            {p.enabled && !p.error ? (
              <>
                <Badge variant="outline"><Bot /> Claude Code</Badge>
                <Badge variant="outline"><Bot /> Codex</Badge>
              </>
            ) : (
              <span className="text-muted-foreground">{t('blocks.detail.notOffered')}</span>
            )}
          </dd>
          <dt className="text-muted-foreground">{t('blocks.detail.hint')}</dt>
          <dd className="text-muted-foreground italic">{p.hint || '—'}</dd>
          {p.fields && (
            <>
              <dt className="text-muted-foreground">{t('blocks.detail.fields')}</dt>
              <dd><code className="font-mono text-[12px] break-words">{p.fields}</code></dd>
            </>
          )}
        </dl>
        {p.network.length > 0 && p.consent !== 'ask' && (
          <Button variant="outline" size="sm" className="w-fit" loading={consent.isPending} onClick={() => consent.mutate({ id: p.id, decision: 'reset' })}>
            <ShieldCheck /> {t('blocks.detail.resetConsent')}
          </Button>
        )}
        <p className="text-xs text-muted-foreground">{p.kind === 'builtin' ? t('blocks.detail.builtinNote') : t('blocks.detail.extensionNote', { id: p.id })}</p>
        <Button variant={p.enabled ? 'outline' : 'default'} className="w-fit" onClick={() => onToggle(!p.enabled)}>
          {p.enabled ? t('blocks.detail.disable') : t('blocks.detail.enable')}
        </Button>
      </SheetBody>
    </>
  )
}

function AgentsCard({ types, paths }: { types: string[]; paths: string[] }) {
  const t = useT()
  const first = types.slice(0, 10)
  return (
    <SettingsCard title={t('blocks.agents.title', { count: types.length })} description={t('blocks.agents.desc')}>
      {types.length ? (
        <div className="flex flex-wrap gap-1.5">
          {first.map((ty) => (
            <code key={ty} className="rounded-md bg-muted px-2 py-1 font-mono text-[12px]">{ty}</code>
          ))}
          {types.length > first.length && <span className="px-1 py-1 text-[12px] text-muted-foreground">+ {types.length - first.length}</span>}
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">{t('blocks.agents.none')}</p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        {t('blocks.agents.where')} <span className="font-mono break-all">{paths.join(' · ')}</span>
      </p>
    </SettingsCard>
  )
}

function CatalogueCard({ plugins, onCreate, onClose }: { plugins: BlockPlugin[]; onCreate: (what: string) => Promise<void>; onClose: () => void }) {
  const t = useT()
  const [what, setWhat] = React.useState('')
  const installed = (idea: string) => plugins.find((p) => p.kind === 'extension' && (p.renders.includes(idea) || p.id === idea || p.id === `${idea}-block`))
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), [])
  return (
    <div ref={ref} className="scroll-mt-4">
    <SettingsCard
      title={t('blocks.catalogue.title')}
      description={t('blocks.catalogue.desc')}
      actions={<Button variant="ghost" size="sm" onClick={onClose}>{t('blocks.catalogue.close')}</Button>}
    >
      <div className="grid gap-4">
        <div className="grid gap-2 rounded-xl border border-primary/30 bg-primary/5 p-4">
          <span className="text-sm font-semibold">{t('blocks.catalogue.missing')}</span>
          <span className="text-[13px] text-muted-foreground">{t('blocks.catalogue.missingDesc')}</span>
          <Textarea value={what} onChange={(e) => setWhat(e.target.value)} minRows={2} maxRows={6} placeholder={t('blocks.catalogue.placeholder')} aria-label={t('blocks.catalogue.missing')} />
          <Button size="sm" className="w-fit" disabled={!what.trim()} onClick={() => void onCreate(what)}>
            <Sparkles /> {t('blocks.create.start')}
          </Button>
        </div>
        <ul className="grid gap-2.5 sm:grid-cols-2">
          {IDEAS.map((idea) => {
            const have = installed(idea.id)
            return (
              <li key={idea.id} className="flex items-start gap-3 rounded-xl border p-3.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
                  <NamedIcon name={idea.icon} className="size-4 text-muted-foreground" />
                </span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="text-sm font-semibold">{t(`blocks.idea.${idea.id}`)}</span>
                  <span className="text-[13px] text-muted-foreground">{t(`blocks.idea.${idea.id}.desc`)}</span>
                  <span className="text-xs text-muted-foreground">{idea.net ? t('blocks.idea.withNet') : t('blocks.idea.noNet')}</span>
                </span>
                {have ? (
                  <Badge variant={have.enabled ? 'success' : 'muted'}>{have.enabled ? t('blocks.idea.installed') : t('blocks.idea.installedOff')}</Badge>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => void onCreate(`${t(`blocks.idea.${idea.id}`)}: ${t(`blocks.idea.${idea.id}.desc`)}`)}>
                    {t('blocks.idea.create')}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
        <p className="text-xs text-muted-foreground">
          {t('blocks.catalogue.safety')} <Link to="/docs/conversation-blocks" className="text-primary hover:underline">{t('blocks.catalogue.docs')}</Link>
        </p>
      </div>
    </SettingsCard>
    </div>
  )
}
