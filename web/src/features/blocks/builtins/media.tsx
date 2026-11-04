// Media blocks: files of the server (image, video, audio, PDF, documents - the file viewer opens them) and link cards.
import * as React from 'react'
import { Link } from 'react-router'
import { Download, ExternalLink, Globe, Maximize2, Play } from 'lucide-react'
import { useT, withGroups } from '@/i18n'
import { Button, Sensitive, Skeleton } from '@/components/ui'
import { Thumb } from '@/features/files/Thumb'
import { iconFor, kindOf } from '@/features/files/kinds'
import { openFileViewer } from '@/features/files/viewerStore'
import { downloadProps } from '@/features/files/download'
import { BlockShell, useDataMenu } from '../shell'
import type { RendererProps } from './types'

const MediaPlayer = React.lazy(withGroups(['media'], () => import('@/features/files/MediaPlayer').then((m) => ({ default: m.MediaPlayer }))))

type FileItem = { path: string; caption?: string }
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p

export function FileBlock({ block, onRaw }: RendererProps) {
  const t = useT()
  const d = block.data as { title?: string; source?: string; path?: string; caption?: string; items?: FileItem[] }
  const items: FileItem[] = d.items ?? (d.path ? [{ path: d.path, caption: d.caption }] : [])
  const paths = items.map((i) => i.path)
  const visual = items.filter((i) => ['image', 'video'].includes(kindOf(i.path)))
  const audio = items.filter((i) => kindOf(i.path) === 'audio')
  const docs = items.filter((i) => !['image', 'video', 'audio'].includes(kindOf(i.path)))
  const single = items.length === 1 ? items[0] : null
  const menu = useDataMenu(block.raw, 'files', onRaw)
  const title = d.title || (single ? base(single.path) : t('blocks.file.count', { count: items.length }))
  return (
    <BlockShell
      icon={single && kindOf(single.path) === 'audio' ? 'music' : single && kindOf(single.path) === 'video' ? 'video' : single && docs.length ? 'file-text' : 'image'}
      title={<Sensitive>{title}</Sensitive>}
      source={d.source ? <Sensitive>{d.source}</Sensitive> : undefined}
      menu={menu}
      footer={
        single ? (
          <>
            <Button variant="outline" size="sm" onClick={() => openFileViewer(single.path, paths)}>
              <Maximize2 /> {t('blocks.file.open')}
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a {...downloadProps(single.path)}>
                <Download /> {t('blocks.action.download')}
              </a>
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="grid gap-3">
        {visual.length > 0 && (
          <div className={visual.length === 1 ? 'grid' : 'flex flex-wrap gap-2.5'}>
            {visual.map((it) => {
              const video = kindOf(it.path) === 'video'
              return (
                <figure key={it.path} className={visual.length === 1 ? 'grid min-w-0 gap-1.5' : 'grid w-44 min-w-0 gap-1.5 max-sm:w-[calc(50%-0.35rem)]'}>
                  <button
                    type="button"
                    data-mx-file={it.path}
                    onClick={() => openFileViewer(it.path, paths)}
                    aria-label={`${t('blocks.file.open')} ${base(it.path)}`}
                    className={
                      'relative overflow-hidden rounded-lg border bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ' +
                      (visual.length === 1 ? 'max-h-[420px] min-h-40' : 'aspect-[4/3]')
                    }
                  >
                    <Sensitive placeholder={<span className="block size-full bg-muted" />}>
                      <Thumb path={it.path} w={visual.length === 1 ? 960 : 360} anim alt={it.caption || base(it.path)} loading="lazy" className={visual.length === 1 ? 'mx-auto block max-h-[420px] w-auto max-w-full object-contain' : 'size-full object-cover'} />
                    </Sensitive>
                    {video && (
                      <span className="absolute inset-0 flex items-center justify-center bg-black/25">
                        <Play className="size-8 fill-white text-white" />
                      </span>
                    )}
                  </button>
                  {(it.caption || visual.length > 1) && (
                    <figcaption className="truncate text-xs text-muted-foreground">
                      <Sensitive>{it.caption || base(it.path)}</Sensitive>
                    </figcaption>
                  )}
                </figure>
              )
            })}
          </div>
        )}
        {audio.map((it) => (
          <div key={it.path} data-mx-file={it.path} className="grid gap-1">
            <React.Suspense fallback={<Skeleton className="h-16" />}>
              <MediaPlayer path={it.path} kind="audio" onOpen={() => openFileViewer(it.path, paths)} className="gap-2 p-3" />
            </React.Suspense>
            {it.caption && <span className="text-xs text-muted-foreground"><Sensitive>{it.caption}</Sensitive></span>}
          </div>
        ))}
        {docs.length > 0 && (
          <ul className="grid gap-2">
            {docs.map((it) => {
              const Icon = iconFor('file', it.path)
              return (
                <li key={it.path}>
                  <button
                    type="button"
                    data-mx-file={it.path}
                    onClick={() => openFileViewer(it.path, paths)}
                    className="flex w-full min-w-0 items-center gap-3 rounded-lg border bg-background/40 px-3 py-2.5 text-left transition-colors hover:border-primary/50 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <Icon className="size-4.5" />
                    </span>
                    <span className="grid min-w-0 flex-1">
                      <span className="truncate text-sm font-medium">
                        <Sensitive>{base(it.path)}</Sensitive>
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        <Sensitive>{it.caption || it.path}</Sensitive>
                      </span>
                    </span>
                    <span className="shrink-0 text-xs font-medium text-primary uppercase">{kindOf(it.path) === 'binary' ? '' : kindOf(it.path)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </BlockShell>
  )
}

/* ------------------------------------------------------------------ link */
export function LinkBlock({ block }: RendererProps) {
  const t = useT()
  const d = block.data as { url: string; title?: string; description?: string; site?: string }
  const internal = d.url.startsWith('/') && !d.url.startsWith('//')
  let host = d.site || ''
  if (!host && !internal) {
    try {
      host = new URL(d.url).host
    } catch {
      host = d.url
    }
  }
  const inner = (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground">
        <Globe className="size-4.5" />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-xs text-muted-foreground">
          <Sensitive>{host || t('blocks.link.app')}</Sensitive>
        </span>
        <span className="line-clamp-2 text-[14px] font-semibold">
          <Sensitive>{d.title || d.url}</Sensitive>
        </span>
        {d.description && (
          <span className="line-clamp-2 text-[13px] text-muted-foreground">
            <Sensitive>{d.description}</Sensitive>
          </span>
        )}
      </span>
      <ExternalLink className="size-4 shrink-0 self-start text-muted-foreground" />
    </>
  )
  const cls = 'mx-block not-prose my-3 flex min-w-0 items-start gap-3 rounded-xl border bg-card p-4 no-underline transition-colors hover:border-primary/50 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
  return internal ? (
    <Link to={d.url} className={cls}>
      {inner}
    </Link>
  ) : (
    <a href={d.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className={cls}>
      {inner}
    </a>
  )
}
