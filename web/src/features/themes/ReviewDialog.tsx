// The one door for a theme that comes from outside (a file, a pasted code, a Team contact): normalizeTheme ->
// scoped preview + checks -> the user applies it and / or saves it. Nothing is applied without that click.
import * as React from 'react'
import { BookmarkPlus, Moon, Sun } from 'lucide-react'
import { deriveTokens, normalizeTheme, type Mode, type ThemeReport } from '@/lib/theme'
import { useSaveTheme, type ThemeSource } from '@/lib/queries'
import { useUI, resolveTheme } from '@/stores/ui'
import { useT } from '@/i18n'
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Segmented, toast } from '@/components/ui'
import { PalettePreview, ThemeChecks, themeName } from './Preview'

/** A theme waiting for the user's decision. `input` is untrusted (normalized here); `report` = the one of the parser
 *  when it already ran (a file: its refusals), merged with normalizeTheme's. */
export type PendingTheme = { input: unknown; report?: ThemeReport; source: ThemeSource; from?: string; file?: string }

export function ThemeReviewDialog({ pending, onClose, title }: { pending: PendingTheme | null; onClose: () => void; title?: string }) {
  const t = useT()
  const uiTheme = useUI((s) => s.theme)
  const [mode, setMode] = React.useState<Mode>(() => resolveTheme(uiTheme))
  const save = useSaveTheme()
  const checked = React.useMemo(() => {
    if (!pending) return null
    const { theme, report } = normalizeTheme(pending.input)
    const errors = [...new Set([...(pending.report?.errors ?? []), ...report.errors])]
    return { theme, report: { ...report, errors, fixed: [...(pending.report?.fixed ?? []), ...report.fixed] } }
  }, [pending])
  React.useEffect(() => {
    if (pending) setMode(resolveTheme(useUI.getState().theme))
  }, [pending])
  const name = checked ? themeName(t, checked.theme) : ''
  const apply = () => {
    if (!checked) return
    useUI.getState().setPalette(checked.theme)
    toast.success(t('themegen.applied', { name }))
    onClose()
  }
  const keep = () => {
    if (!checked || !pending) return
    save.mutate(
      { theme: { ...checked.theme, name: checked.theme.name || name }, source: pending.source, from: pending.from },
      { onSuccess: () => toast.success(t('themegen.saved', { name })) },
    )
  }
  return (
    <Dialog open={!!pending} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg" data-testid="theme-review">
        <DialogHeader>
          <DialogTitle>{title || t('colors.importTitle')}</DialogTitle>
          <DialogDescription>
            {name}
            {checked?.theme.author ? ` · ${t('colors.by', { author: checked.theme.author })}` : ''}
            {pending?.from ? ` · ${t('themegen.from', { name: pending.from })}` : ''}
          </DialogDescription>
        </DialogHeader>
        {checked && (
          <div className="grid gap-3">
            {checked.theme.description && <p className="text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{checked.theme.description}</p>}
            <Segmented<Mode>
              value={mode}
              onChange={setMode}
              aria-label={t('shell.theme')}
              className="w-fit"
              options={[
                { value: 'dark', label: t('theme.dark'), icon: <Moon /> },
                { value: 'light', label: t('theme.light'), icon: <Sun /> },
              ]}
            />
            <PalettePreview tokens={deriveTokens(checked.theme, mode)} />
            <ThemeChecks report={checked.report} />
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="outline" onClick={keep} loading={save.isPending} data-testid="theme-review-save">
            <BookmarkPlus /> {t('themegen.save')}
          </Button>
          <Button onClick={apply} data-testid="palette-import-apply">
            {t('colors.importApply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
