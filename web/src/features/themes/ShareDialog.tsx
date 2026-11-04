// Share a theme: to a Team contact or group (a card with Install in their chat), as a file, or as a theme code to
// paste. A theme holds colours only: nothing of the user's sessions goes with it. The public gallery is not there yet.
import * as React from 'react'
import { useNavigate } from 'react-router'
import { Copy, Download, Palette, Send } from 'lucide-react'
import { normalizeTheme, themeCode, type Theme } from '@/lib/theme'
import { useSettings, useTeam, useTeamCreateChat, useTeamSendTheme } from '@/lib/queries'
import { useT } from '@/i18n'
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Label, Select, toast } from '@/components/ui'
import { chatTitle, friendsOf } from '@/features/team/people'
import { downloadTheme, themeName } from './Preview'

export function ShareThemeDialog({ theme, open, onOpenChange }: { theme: Theme | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT()
  const navigate = useNavigate()
  const { data: s } = useSettings()
  const { data: team } = useTeam(open && !!s?.team_page)
  const create = useTeamCreateChat()
  const send = useTeamSendTheme()
  const [to, setTo] = React.useState('')
  const name = theme ? themeName(t, theme) : ''
  const targets = React.useMemo(() => {
    if (!team) return []
    const friends = friendsOf(team).map(([id, p]) => ({ value: `p:${id}`, label: p.name }))
    const groups = team.chats.filter((c) => c.kind === 'group' && !c.left).map((c) => ({ value: `c:${c.id}`, label: chatTitle(team, c) }))
    return [...friends, ...groups]
  }, [team])
  React.useEffect(() => {
    if (open && !targets.some((x) => x.value === to)) setTo(targets[0]?.value ?? '')
  }, [open, targets, to])
  if (!theme) return null
  // what leaves this browser: the theme normalized again, named
  const outgoing = () => ({ ...normalizeTheme(theme).theme, name })
  const sendIt = async () => {
    if (!to) return
    try {
      const cid = to.startsWith('c:') ? to.slice(2) : (await create.mutateAsync({ kind: 'dm', members: [to.slice(2)] })).id
      await send.mutateAsync({ cid, theme: outgoing() })
      const who = targets.find((x) => x.value === to)?.label ?? ''
      onOpenChange(false)
      toast.action(t('themegen.share.sent', { name: who }), undefined, { label: t('team.fwd.open'), onClick: () => navigate(`/team?chat=${encodeURIComponent(cid)}`) })
    } catch {
      // the mutation's toast says why
    }
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(themeCode(outgoing()))
      toast.success(t('themegen.share.copied'))
    } catch {
      toast.error(t('themegen.share.copyFailed'))
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="theme-share">
        <DialogHeader className="flex-row items-start gap-3 space-y-0">
          <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Palette className="size-4" />
          </span>
          <div className="grid gap-1">
            <DialogTitle>{t('themegen.share.title', { name })}</DialogTitle>
            <DialogDescription>{t('themegen.share.desc')}</DialogDescription>
          </div>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="theme-share-to">{t('themegen.share.team')}</Label>
          {s?.team_page && targets.length ? (
            <div className="flex gap-2">
              <Select id="theme-share-to" value={to} onValueChange={setTo} options={targets} className="min-w-0 flex-1" aria-label={t('themegen.share.team')} />
              <Button onClick={() => void sendIt()} loading={create.isPending || send.isPending} disabled={!to} data-testid="theme-share-send">
                <Send /> {t('themegen.share.send')}
              </Button>
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">{s?.team_page ? t('themegen.share.noFriends') : t('themegen.share.teamOff')}</p>
          )}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button variant="outline" onClick={() => downloadTheme(theme, name)} data-testid="theme-share-file">
            <Download /> {t('themegen.share.file')}
          </Button>
          <Button variant="outline" onClick={() => void copy()} data-testid="theme-share-code">
            <Copy /> {t('themegen.share.code')}
          </Button>
        </div>
        <div className="flex items-start gap-3 rounded-lg border border-dashed p-3 opacity-70" aria-disabled>
          <div className="grid min-w-0 flex-1 gap-0.5">
            <span className="text-[13px] font-medium">{t('themegen.share.gallery')}</span>
            <span className="text-xs text-muted-foreground">{t('themegen.share.galleryDesc')}</span>
          </div>
          <Badge variant="muted">{t('themegen.soon')}</Badge>
        </div>
      </DialogContent>
    </Dialog>
  )
}
