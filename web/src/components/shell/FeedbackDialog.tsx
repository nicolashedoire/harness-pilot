import { ExternalLink } from 'lucide-react'
import { useT } from '@/i18n'
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui'
import { useFeedbackDialog } from './feedback-store'

export function FeedbackDialog() {
  const t = useT()
  const { open, setOpen } = useFeedbackDialog()
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="md:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('feedback.title')}</DialogTitle>
          <DialogDescription>{t('feedback.githubDesc')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t('common.close')}</Button>
          <Button asChild><a href="https://github.com/nicolashedoire/harness-pilot/issues/new/choose" target="_blank" rel="noopener noreferrer">{t('feedback.githubOpen')} <ExternalLink /></a></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
