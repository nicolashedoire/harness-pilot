// The `proposal` block (API.md#atelier "Proposal block"): `{draft, title?}` names a draft of the Atelier; the card
// itself (features/atelier/ProposalCard.tsx) reads the draft from the server and loads with the `atelier` texts, in
// its own chunk, the first time a proposal shows.
import * as React from 'react'
import { withGroups } from '@/i18n'
import { Skeleton } from '@/components/ui/skeleton'
import type { RendererProps } from './types'

const Card = React.lazy(withGroups(['atelier'], () => import('@/features/atelier/ProposalCard')))

export function ProposalBlock({ block }: RendererProps) {
  const d = block.data as { draft: string; title?: string }
  return (
    <React.Suspense fallback={<Skeleton className="my-3 h-44 rounded-xl" />}>
      <Card draft={d.draft} title={d.title} />
    </React.Suspense>
  )
}
