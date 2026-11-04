// /atelier - everything the agents created for the platform (widgets, pages, conversation blocks, themes, skills,
// customizations of the product). Nothing is active before the user validates it; every version is kept.
//   /atelier                 the list (?show=<type group> filter, ?q= text filter)
//   /atelier/drafts/<id>     the validation screen of a draft
//   /atelier/<kind>/<id>     one creation: its state, its error, its versions (rollback)
import { Link, Route, Routes } from 'react-router'
import { SearchX } from 'lucide-react'
import { useT } from '@/i18n'
import { Button, EmptyState } from '@/components/ui'
import { Page } from '@/components/shell/Page'
import { AtelierList } from './List'
import { DraftReview } from './Review'
import { CreationDetail } from './Detail'

function Missing() {
  const t = useT()
  return (
    <Page title={t('nav.atelier')} width="narrow">
      <EmptyState
        icon={SearchX}
        title={t('atelier.missing')}
        description={t('atelier.missingDesc')}
        action={
          <Button variant="outline" asChild>
            <Link to="/atelier">{t('atelier.backToList')}</Link>
          </Button>
        }
      />
    </Page>
  )
}

export default function AtelierPage() {
  return (
    <Routes>
      <Route index element={<AtelierList />} />
      <Route path="drafts/:id" element={<DraftReview />} />
      <Route path=":kind/:id" element={<CreationDetail />} />
      <Route path="*" element={<Missing />} />
    </Routes>
  )
}
