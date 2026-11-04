// A colour theme sent in a Team chat (message kind `theme`): a card with its light and dark previews and Install.
// The theme came from another server: it is normalized again here before anything is drawn, and Install only opens
// the review dialog (preview, checks, then Apply or Save) - a received theme never applies itself.
import * as React from 'react'
import { Download, Palette } from 'lucide-react'
import { deriveTokens, normalizeTheme, type Theme } from '@/lib/theme'
import { useT } from '@/i18n'
import { Button, Sensitive } from '@/components/ui'
import { MiniPreview, themeName } from './Preview'
import { ThemeReviewDialog, type PendingTheme } from './ReviewDialog'

export function ThemeMessageCard({ theme, from, mine }: { theme: Theme | undefined; from: string; mine: boolean }) {
  const t = useT()
  const [pending, setPending] = React.useState<PendingTheme | null>(null)
  const checked = React.useMemo(() => (theme ? normalizeTheme(theme) : null), [theme])
  if (!checked) return null
  const name = themeName(t, checked.theme)
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border bg-card" data-testid="team-theme-card">
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-1">
        <Palette className="size-4 text-primary" />
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t('themegen.team.label')}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 px-3.5 pt-1.5">
        <MiniPreview tokens={deriveTokens(checked.theme, 'light')} />
        <MiniPreview tokens={deriveTokens(checked.theme, 'dark')} />
      </div>
      <div className="grid gap-0.5 px-3.5 pt-2.5">
        <span className="text-[15px] font-semibold [overflow-wrap:anywhere]"><Sensitive>{name}</Sensitive></span>
        {checked.theme.description && <span className="line-clamp-2 text-[13px] text-muted-foreground [overflow-wrap:anywhere]"><Sensitive>{checked.theme.description}</Sensitive></span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3.5 pt-2.5 pb-3">
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
          {checked.report.issues.length ? t('colors.contrastIssues', { count: checked.report.issues.length }) : t('themegen.team.checked')}
        </span>
        <Button size="sm" variant={mine ? 'outline' : 'default'} onClick={() => setPending({ input: theme, source: 'received', from: mine ? '' : from })} data-testid="team-theme-install">
          <Download /> {t('themegen.team.install')}
        </Button>
      </div>
      <ThemeReviewDialog pending={pending} onClose={() => setPending(null)} title={t('themegen.team.reviewTitle')} />
    </div>
  )
}
