// The next thing to do with a creation, at the end of its row: Review (a draft), Get it fixed (broken), See the
// conflict (a customization to review after an update), else a "…" menu (Open, Disable, Ask for a change, Delete).
import { Link, useNavigate } from 'react-router'
import { Ellipsis, ExternalLink, MessageSquarePlus, Power, Trash2, Wrench } from 'lucide-react'
import type { AtelierItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui'
import { itemHref } from './links'

export function RowAction({ item: it, wide }: { item: AtelierItem; wide?: boolean }) {
  const t = useT()
  const navigate = useNavigate()
  const full = wide ? 'max-md:w-full' : ''
  if (it.state === 'draft' || it.draft_id)
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
        <Link to={itemHref(it)}>{t('atelier.seeConflict')}</Link>
      </Button>
    )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t('atelier.more', { name: it.name })} className="text-muted-foreground">
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => navigate(itemHref(it))}>
          <ExternalLink /> {t('atelier.open')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <Power /> {t('atelier.disable')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <MessageSquarePlus /> {t('atelier.askChange')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive disabled>
          <Trash2 /> {t('atelier.trash')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
