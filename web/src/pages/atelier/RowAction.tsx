// The next thing to do with a creation, at the end of its row: Review (a draft waits), Get it fixed (broken), See the
// conflict (to review after an update), else a "…" menu: Open, Disable / Turn on, Ask for a change.
import { Link, useNavigate } from 'react-router'
import { Ellipsis, ExternalLink, Info, MessageSquarePlus, Power, PowerOff, Wrench } from 'lucide-react'
import { useToggleCreation } from '@/lib/queries'
import type { AtelierItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, useMask } from '@/components/ui'
import { typeLabel } from '@/features/atelier/parts'
import { HARNESS_TOPIC, itemHref, liveHref, newSessionHref } from './links'

/** A new session in the topic the creation was made in, asking for a change to it (the user writes what). */
export function useAskChange() {
  const t = useT()
  const navigate = useNavigate()
  return (it: AtelierItem) => {
    const prompt = t('atelier.askChangePrompt', { type: typeLabel(t, it.type), name: it.name, id: it.id })
    navigate(newSessionHref(prompt, it.origin?.session_path || HARNESS_TOPIC))
  }
}

export function RowAction({ item: it, wide }: { item: AtelierItem; wide?: boolean }) {
  const t = useT()
  const navigate = useNavigate()
  const mask = useMask()
  const askChange = useAskChange()
  const toggle = useToggleCreation()
  const setOn = (enabled: boolean) => toggle.mutate({ id: it.id, enabled })
  const full = wide ? 'max-md:w-full' : ''
  if (it.pending)
    return (
      <Button size="sm" variant="outline" asChild className={cn('border-draft/40 text-draft hover:bg-draft/10 hover:text-draft', full)}>
        <Link to={itemHref(it)}>{t('atelier.review')}</Link>
      </Button>
    )
  if (it.state === 'error')
    return (
      <Button size="sm" variant="outline" asChild className={cn('border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive', full)}>
        <Link to={itemHref(it)}>
          <Wrench /> {t('atelier.getFixed')}
        </Link>
      </Button>
    )
  if (it.state === 'review')
    return (
      <Button size="sm" variant="outline" asChild className={cn('border-warning/40 text-warning hover:bg-warning/10 hover:text-warning', full)}>
        <Link to={(it.kind === 'customization' && liveHref(it)) || itemHref(it)}>{t('atelier.seeConflict')}</Link>
      </Button>
    )
  const live = liveHref(it)
  const canToggle = it.kind === 'extension' && (it.actions.includes('disable') || it.actions.includes('enable'))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t('atelier.more', { name: mask(it.name, 8) })} className="text-muted-foreground max-md:size-11">
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {live && (
          <DropdownMenuItem onSelect={() => navigate(live)}>
            <ExternalLink /> {t('atelier.open')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => navigate(itemHref(it))}>
          <Info /> {t('atelier.details')}
        </DropdownMenuItem>
        {canToggle &&
          (it.actions.includes('disable') ? (
            <DropdownMenuItem onSelect={() => setOn(false)}>
              <PowerOff /> {t('atelier.disable')}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => setOn(true)}>
              <Power /> {t('atelier.enable')}
            </DropdownMenuItem>
          ))}
        {it.kind === 'extension' && (
          <DropdownMenuItem onSelect={() => askChange(it)}>
            <MessageSquarePlus /> {t('atelier.askChange')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
