// "Ask for a fix" on a broken extension (a dashboard card, a page that does not load, its row in Settings ->
// Extensions), like the "Ask for a fix" of a broken conversation block (features/blocks): the message is shown, then
// sent once confirmed. The server writes it (POST /api/extensions/{id}/fix, maxxing/extfix.py: the error, the extension,
// its files) and sends it to the session that made the extension, or opens one in system › harness; the app then
// opens that session. `FixTarget` is the line saying where it goes.
import * as React from 'react'
import { useNavigate } from 'react-router'
import { MessageSquareText, Wrench } from 'lucide-react'
import { previewExtensionFix, useAskExtensionFix } from '@/lib/queries'
import { errorMessage } from '@/lib/api'
import type { Extension, Session } from '@/lib/types'
import { useT } from '@/i18n'
import { Button, confirm, Sensitive, toast, type ButtonProps } from '@/components/ui'
import { cn } from '@/lib/utils'

export type SeenError = { message: string; stack?: string }

const sessionHref = (s: Pick<Session, 'id' | 'path'>) => `/sessions?path=${encodeURIComponent(s.path)}&session=${s.id}`

/** Where the fix goes: the session that made the extension, or a new one in system › harness. */
export function FixTarget({ ext, className }: { ext: Pick<Extension, 'origin'>; className?: string }) {
  const t = useT()
  return (
    // a span (inline-level markup): it also sits in an EmptyState's description paragraph
    <span className={cn('flex items-start gap-1.5 text-xs text-muted-foreground', className)} data-testid="ext-fix-target">
      <MessageSquareText className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">{ext.origin ? t('exterr.toOrigin', { title: ext.origin.title }) : t('exterr.toHarness')}</span>
    </span>
  )
}

/** Shows the message the agent will get, then sends it and opens the session. Resolves to true when sent. */
export function useAskFix() {
  const t = useT()
  const navigate = useNavigate()
  const ask = useAskExtensionFix()
  const run = React.useCallback(
    async (ext: Pick<Extension, 'id' | 'origin'>, error?: SeenError): Promise<boolean> => {
      let prompt = ''
      try {
        prompt = (await previewExtensionFix(ext.id, error)).prompt
      } catch (e) {
        toast.error(errorMessage(e))
        return false
      }
      const ok = await confirm({
        title: t('exterr.fixTitle'),
        description: (
          <span className="grid gap-2">
            <span>{ext.origin ? t('exterr.toOrigin', { title: ext.origin.title }) : t('exterr.toHarness')}</span>
            <Sensitive block>
              <span className="block max-h-60 overflow-auto rounded-md border bg-muted/40 p-2.5 text-left font-mono text-[12px] whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground" data-testid="ext-fix-prompt">
                {prompt}
              </span>
            </Sensitive>
          </span>
        ),
        confirmText: t('exterr.send'),
      })
      if (!ok) return false
      try {
        const out = await ask.mutateAsync({ id: ext.id, error })
        toast.success(t('exterr.sent'))
        navigate(sessionHref(out.session))
        return true
      } catch {
        return false // the mutation already said why (toast)
      }
    },
    [ask, navigate, t],
  )
  return { run, pending: ask.isPending }
}

/** The "Ask for a fix" button (primary by default). */
export function AskFixButton({ ext, error, ...props }: { ext: Pick<Extension, 'id' | 'origin'>; error?: SeenError } & Omit<ButtonProps, 'onClick'>) {
  const t = useT()
  const { run, pending } = useAskFix()
  const [busy, setBusy] = React.useState(false)
  return (
    <Button
      size="sm"
      {...props}
      loading={busy || pending}
      onClick={async () => {
        setBusy(true)
        try {
          await run(ext, error)
        } finally {
          setBusy(false)
        }
      }}
    >
      <Wrench /> {t('exterr.askFix')}
    </Button>
  )
}
