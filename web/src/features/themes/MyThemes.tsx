// Settings -> Appearance -> My themes: the presets, the themes the user saved (created with the theme generator,
// imported from a file or a code, received from a Team contact) with apply / rename / share / delete, and the ways in:
// a file (button or drop), a pasted theme code, the theme generator. Saved themes live on the server
// (/api/settings/themes): the same list on every device.
import * as React from 'react'
import { Link } from 'react-router'
import { BookmarkPlus, ClipboardPaste, MoreHorizontal, Pencil, Share2, Sparkles, Trash2, Upload, Check } from 'lucide-react'
import { deriveTokens, matchPreset, parseThemeFile, parseThemeText, PRESETS, sameLook, type Mode, type Theme } from '@/lib/theme'
import { useDeleteTheme, useRenameTheme, useSaveTheme, useSavedThemes, type SavedTheme } from '@/lib/queries'
import { useUI } from '@/stores/ui'
import { cn } from '@/lib/utils'
import { useT, type TKey } from '@/i18n'
import {
  Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger, Input, Sensitive, Skeleton, Textarea, confirm, toast,
} from '@/components/ui'
import { MiniPreview, themeName } from './Preview'
import { ThemeReviewDialog, type PendingTheme } from './ReviewDialog'
import { ShareThemeDialog } from './ShareDialog'

const SOURCE_LABEL: Record<SavedTheme['source'], TKey> = {
  created: 'themegen.source.created',
  imported: 'themegen.source.imported',
  received: 'themegen.source.received',
  custom: 'themegen.source.custom',
}

type Tile = { key: string; theme: Theme; saved?: SavedTheme }

function ThemeTile({ tile, mode, active, onApply, onShare, onRename, onDelete }: {
  tile: Tile; mode: Mode; active: boolean; onApply: () => void; onShare: () => void; onRename?: () => void; onDelete?: () => void
}) {
  const t = useT()
  const s = tile.saved
  const name = themeName(t, tile.theme)
  return (
    <article className={cn('relative flex min-w-0 flex-col gap-2 rounded-xl border p-2.5 transition-colors', active ? 'border-foreground/80 ring-1 ring-foreground/80' : 'hover:border-foreground/30')} data-testid={`my-theme-${tile.key}`}>
      <button type="button" onClick={onApply} className="rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t('themegen.mine.apply', { name })}>
        <MiniPreview tokens={deriveTokens(tile.theme, mode)} />
      </button>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{s ? <Sensitive>{name}</Sensitive> : name}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('themegen.mine.menu', { name })} className="-my-1 -mr-1 shrink-0">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onApply} disabled={active}><Check /> {t('themegen.apply')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={onShare}><Share2 /> {t('themegen.share')}</DropdownMenuItem>
            {onRename && <DropdownMenuItem onSelect={onRename}><Pencil /> {t('themegen.mine.rename')}</DropdownMenuItem>}
            {onDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={onDelete}><Trash2 /> {t('common.delete')}</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="-mt-1 flex min-h-5 min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
        {active ? (
          <Badge variant="success" className="shrink-0 gap-1"><Check className="size-3" /> {t('themegen.mine.active')}</Badge>
        ) : !s ? (
          <Badge variant="muted" className="shrink-0">{t('themegen.mine.preset')}</Badge>
        ) : null}
        {s && (
          <span className="line-clamp-2 min-w-0 leading-snug">
            {t(SOURCE_LABEL[s.source])}
            {s.from && (
              <>
                {' · '}
                {t('themegen.fromWord')} <Sensitive>{s.from}</Sensitive>
              </>
            )}
          </span>
        )}
      </div>
    </article>
  )
}

function RenameDialog({ entry, onClose }: { entry: SavedTheme | null; onClose: () => void }) {
  const t = useT()
  const rename = useRenameTheme()
  const [name, setName] = React.useState('')
  React.useEffect(() => {
    if (entry) setName(entry.theme.name)
  }, [entry])
  const submit = () => {
    if (!entry || !name.trim()) return
    rename.mutate({ id: entry.id, name: name.trim() }, { onSuccess: onClose })
  }
  return (
    <Dialog open={!!entry} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('themegen.mine.rename')}</DialogTitle>
        </DialogHeader>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus onKeyDown={(e) => e.key === 'Enter' && submit()} aria-label={t('themegen.mine.name')} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={submit} disabled={!name.trim()} loading={rename.isPending}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PasteDialog({ open, onOpenChange, onTheme }: { open: boolean; onOpenChange: (o: boolean) => void; onTheme: (p: PendingTheme) => void }) {
  const t = useT()
  const [text, setText] = React.useState('')
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    if (open) (setText(''), setError(''))
  }, [open])
  const check = () => {
    const parsed = parseThemeText(text)
    if (!parsed.theme) return setError(t('themegen.paste.bad'))
    onOpenChange(false)
    onTheme({ input: parsed.theme, report: parsed.report, source: 'imported' })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('themegen.paste.title')}</DialogTitle>
          <DialogDescription>{t('themegen.paste.desc')}</DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => (setText(e.target.value), setError(''))}
          minRows={4}
          maxRows={10}
          maxLength={40000}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder="theme1:…"
          aria-label={t('themegen.paste.title')}
          aria-invalid={!!error}
          data-testid="theme-paste-text"
        />
        {error && <p className="text-[13px] text-destructive" role="alert">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={check} disabled={!text.trim()} data-testid="theme-paste-check">{t('themegen.paste.check')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function MyThemesCard({ mode, onCreate }: { mode: Mode; onCreate: string }) {
  const t = useT()
  const palette = useUI((s) => s.palette)
  const { data, isLoading } = useSavedThemes()
  const save = useSaveTheme()
  const del = useDeleteTheme()
  const input = React.useRef<HTMLInputElement>(null)
  const [pending, setPending] = React.useState<PendingTheme | null>(null)
  const [paste, setPaste] = React.useState(false)
  const [sharing, setSharing] = React.useState<Theme | null>(null)
  const [renaming, setRenaming] = React.useState<SavedTheme | null>(null)
  const [drag, setDrag] = React.useState(false)
  const [lastCheck, setLastCheck] = React.useState<{ file: string; ok: boolean; issues: number } | null>(null)
  const saved = data?.themes ?? []
  const tiles: Tile[] = [...PRESETS.map((p) => ({ key: p.id, theme: p })), ...saved.map((e) => ({ key: e.id, theme: e.theme, saved: e }))]
  const activeKey = tiles.find((x) => sameLook(x.theme, palette))?.key
  const canSaveCurrent = !matchPreset(palette) && !activeKey && !isLoading

  const onFile = async (f: File | undefined) => {
    if (!f) return
    if (f.size > 64 * 1024) return toast.error(t('colors.importBad'))
    const parsed = parseThemeFile(await f.text())
    setLastCheck({ file: f.name, ok: !!parsed.theme, issues: parsed.report.issues.length })
    if (!parsed.theme) toast.error(t('colors.importBad'))
    else setPending({ input: parsed.theme, report: parsed.report, source: 'imported', file: f.name })
  }
  const remove = async (e: SavedTheme) => {
    if (await confirm({ title: t('themegen.mine.deleteTitle', { name: e.theme.name || t('colors.preset.custom') }), description: t('themegen.mine.deleteDesc'), destructive: true, confirmText: t('common.delete') }))
      del.mutate(e.id)
  }
  return (
    <section className="grid gap-4 rounded-xl border bg-card p-[var(--pad-card)] text-card-foreground" aria-labelledby="my-themes-title" data-tour="my-themes">
      <div className="flex flex-wrap items-start gap-3">
        <div className="grid min-w-[16rem] flex-1 gap-1">
          <h3 id="my-themes-title" className="text-[15px] font-semibold tracking-tight">{t('themegen.mine.title')}</h3>
          <p className="max-w-2xl text-[13px] text-muted-foreground">{t('themegen.mine.desc')}</p>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => input.current?.click()} data-testid="palette-import">
            <Upload /> {t('themegen.mine.importFile')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPaste(true)} data-testid="theme-paste">
            <ClipboardPaste /> {t('themegen.mine.paste')}
          </Button>
          <Button size="sm" asChild data-testid="theme-create">
            <Link to={onCreate}>
              <Sparkles /> {t('themegen.create')}
            </Link>
          </Button>
        </div>
        <input
          ref={input}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            void onFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2.5">
        {tiles.map((tile) => (
          <ThemeTile
            key={tile.key}
            tile={tile}
            mode={mode}
            active={tile.key === activeKey}
            onApply={() => {
              useUI.getState().setPalette(tile.theme)
              toast.success(t('themegen.applied', { name: themeName(t, tile.theme) }))
            }}
            onShare={() => setSharing(tile.theme)}
            onRename={tile.saved ? () => setRenaming(tile.saved!) : undefined}
            onDelete={tile.saved ? () => void remove(tile.saved!) : undefined}
          />
        ))}
        {isLoading && <Skeleton className="h-[7.25rem] rounded-xl" />}
        {canSaveCurrent && (
          <button
            type="button"
            onClick={() => save.mutate({ theme: { ...palette, name: palette.name || t('colors.preset.custom') }, source: 'custom' }, { onSuccess: () => toast.success(t('themegen.saved', { name: palette.name || t('colors.preset.custom') })) })}
            className="flex min-h-[7.25rem] flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-2.5 text-[13px] text-muted-foreground outline-none hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="theme-save-current"
          >
            <BookmarkPlus className="size-5" /> {t('themegen.mine.saveCurrent')}
          </button>
        )}
      </div>
      <div
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          void onFile(e.dataTransfer.files?.[0])
        }}
        className={cn('flex flex-wrap items-center gap-3 rounded-xl border border-dashed p-3.5 transition-colors', drag && 'border-primary bg-primary/5')}
        data-testid="theme-drop"
      >
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-[13px] font-medium">{t('themegen.drop.title')}</span>
          <span className="text-xs text-muted-foreground">{t('themegen.drop.desc')}</span>
        </div>
        {lastCheck && (
          <span role="status" className={cn('flex min-w-0 items-center gap-1.5 text-xs', lastCheck.ok ? 'text-success' : 'text-destructive')}>
            <Check className="size-3.5 shrink-0" />
            <span className="truncate">
              <Sensitive>{lastCheck.file}</Sensitive>
              {' : '}
              {!lastCheck.ok ? t('colors.importBad') : lastCheck.issues ? t('colors.contrastIssues', { count: lastCheck.issues }) : t('themegen.drop.ok')}
            </span>
          </span>
        )}
      </div>
      <ThemeReviewDialog pending={pending} onClose={() => setPending(null)} />
      <PasteDialog open={paste} onOpenChange={setPaste} onTheme={setPending} />
      <ShareThemeDialog theme={sharing} open={!!sharing} onOpenChange={(o) => !o && setSharing(null)} />
      <RenameDialog entry={renaming} onClose={() => setRenaming(null)} />
    </section>
  )
}
