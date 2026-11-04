import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, CircleHelp, Users, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage } from '@/lib/api'
import { useT } from '@/i18n'
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui'

type Label = 'personal' | 'agents' | 'shared' | 'unclassified'
const options = [
  { value: 'personal', key: 'space.personal', Icon: UserRound },
  { value: 'agents', key: 'space.agents', Icon: Bot },
  { value: 'shared', key: 'space.shared', Icon: Users },
  { value: 'unclassified', key: 'space.unclassified', Icon: CircleHelp },
] as const
const query = () => ({ queryKey: ['space-labels'], queryFn: () => api.get<Record<string, Label>>('/api/space-labels'), staleTime: 3000 })

// Every explicit label shows a badge; an unclassified item (the default) shows none, so a workspace nobody has
// classified carries no badge on every row. The menu still sets and ticks every label.
const BADGED: ReadonlySet<Label> = new Set(['personal', 'agents', 'shared'])

export function SpaceBadge({ path }: { path: string | null }) {
  const t = useT()
  const labels = useQuery(query())
  const value = path ? labels.data?.[path] : undefined
  const option = value && BADGED.has(value) ? options.find((o) => o.value === value) : undefined
  if (!option) return null
  return <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground" title={t('space.explanation')}>{t(option.key)}</span>
}

export function SpaceMenuItems({ path }: { path: string | null }) {
  const t = useT(), qc = useQueryClient()
  const labels = useQuery(query())
  const mutation = useMutation({ mutationFn: (label: Label) => api.put('/api/space-labels', { path, label }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['space-labels'] }), onError: (e) => toast.error(errorMessage(e)) })
  return <><DropdownMenuSeparator /><DropdownMenuLabel>{t('space.label')}</DropdownMenuLabel>{options.map(({ value, key, Icon }) => <DropdownMenuItem key={value} disabled={!path || mutation.isPending} onSelect={() => mutation.mutate(value)}><Icon /> {t(key)} {path && (labels.data?.[path] || 'unclassified') === value ? '✓' : ''}</DropdownMenuItem>)}</>
}
