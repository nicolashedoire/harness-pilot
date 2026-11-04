// What a click on a notification does: open it (marks it read, follows its link), run one of its actions (a link,
// or a POST like "Run again" / "Resume"), ask harness-pilot about it.
import * as React from 'react'
import { useNavigate } from 'react-router'
import { useMarkFeedRead, useRunFeedAction } from '@/lib/queries'
import { categoryOf } from '@/lib/feed'
import { fmtDate } from '@/lib/format'
import type { FeedAction, FeedEvent } from '@/lib/types'
import { tDyn, useLang, useT } from '@/i18n'
import { toast } from '@/components/ui'
import { useNotificationCenter } from './store'
import { eventTitle } from './text'

export function useNotificationActions() {
  const t = useT()
  const lang = useLang()
  const navigate = useNavigate()
  const read = useMarkFeedRead()
  const run = useRunFeedAction()

  return React.useMemo(() => {
    /** An app path in the SPA (the centre closes), anything else in a new tab. */
    const go = (url: string) => {
      if (/^\/(?![/\\])/.test(url)) {
        useNotificationCenter.getState().setOpen(false)
        navigate(url)
      } else window.open(url, '_blank', 'noopener,noreferrer')
    }
    const markRead = (ev: FeedEvent) => {
      if (!ev.read) read.mutate({ ids: [ev.id] })
    }
    return {
      markRead,
      /** The row itself: read, then its own page when it has one. */
      open: (ev: FeedEvent) => {
        markRead(ev)
        if (ev.url) go(ev.url)
      },
      act: (ev: FeedEvent, a: FeedAction) => {
        markRead(ev)
        if (a.type === 'link') return go(a.url)
        run.mutate(a, { onSuccess: () => toast.success(tDyn(t, `feed.done.${a.id}`, t('common.done'))) })
      },
      /** A new session about the event (its topic for a session event, else the workspace root), text as data. */
      ask: (ev: FeedEvent) => {
        markRead(ev)
        const path = categoryOf(ev) === 'sessions' && typeof ev.params?.path === 'string' ? ev.params.path : ''
        const quote = [eventTitle(t, ev), ev.body, `${ev.source} · ${fmtDate(ev.at, lang)}`, ev.url].filter(Boolean).join('\n')
        const prompt = `${t('feed.askPrompt')}\n\n"""\n${quote}\n"""`
        go(`/sessions?new=1&path=${encodeURIComponent(path)}&prompt=${encodeURIComponent(prompt)}`)
      },
      running: (a: FeedAction) => run.isPending && run.variables === a,
    }
  }, [t, lang, navigate, read, run])
}
