import { FileCode2 } from 'lucide-react'
import { useT } from '@/i18n'

type Line = { kind: 'add' | 'remove' | 'context' | 'meta' | 'hunk'; text: string; old?: number; next?: number }
type FileDiff = { title: string; lines: Line[]; added: number; removed: number }

/** Keep every line from Git, including binary patches and unusual file headers. */
export function parseProposal(patch: string, untracked: { path: string; content: string }[]): FileDiff[] {
  const files: FileDiff[] = []
  let current: FileDiff | undefined
  let old = 0, next = 0, inHunk = false
  const addFile = (title: string) => { current = { title, lines: [], added: 0, removed: 0 }; files.push(current) }
  for (const text of patch.split('\n')) {
    if (!text && !current) continue
    if (text.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.*?) b\/(.*)$/.exec(text)
      inHunk = false
      addFile(match?.[2] || text.slice(11))
      current!.lines.push({ kind: 'meta', text })
      continue
    }
    if (!current) addFile('Diff')
    if (text.startsWith('@@')) {
      inHunk = true
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
      if (match) { old = Number(match[1]); next = Number(match[2]) }
      current!.lines.push({ kind: 'hunk', text })
    } else if (!inHunk) {
      current!.lines.push({ kind: 'meta', text })
    } else if (text.startsWith('+')) {
      current!.lines.push({ kind: 'add', text, next: next++ }); current!.added++
    } else if (text.startsWith('-')) {
      current!.lines.push({ kind: 'remove', text, old: old++ }); current!.removed++
    } else if (text.startsWith(' ')) {
      current!.lines.push({ kind: 'context', text, old: old++, next: next++ })
    } else if (text) current!.lines.push({ kind: 'meta', text })
  }
  for (const file of untracked) {
    addFile(file.path)
    const lines = file.content.split('\n')
    if (lines.at(-1) === '') lines.pop()
    lines.forEach((text, i) => current!.lines.push({ kind: 'add', text: `+${text}`, next: i + 1 }))
    current!.added = lines.length
    if (file.content && !file.content.endsWith('\n')) current!.lines.push({ kind: 'meta', text: '\\ No newline at end of file' })
  }
  return files
}

export function ProposalDiff({ patch, untracked }: { patch: string; untracked: { path: string; content: string }[] }) {
  const t = useT()
  const files = parseProposal(patch, untracked)
  return <div className="grid gap-4" aria-label={t('companions.changes')}>
    <p className="text-xs text-muted-foreground">{t('companions.filesChanged', { count: files.length })}</p>
    {files.map((file, index) => <details key={`${index}:${file.title}`} open className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2.5 text-sm">
        <FileCode2 className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 break-all font-mono text-xs font-medium">{file.title}</span>
        <span className="font-mono text-xs font-semibold text-green-600 dark:text-green-400">+{file.added}</span><span className="font-mono text-xs font-semibold text-red-600 dark:text-red-400">−{file.removed}</span>
      </summary>
      <div className="max-h-[32rem] overflow-auto"><table className="w-full min-w-max border-collapse font-mono text-xs leading-5"><tbody>
        {file.lines.map((line, i) => <tr key={i} className={line.kind === 'add' ? 'bg-green-500/15' : line.kind === 'remove' ? 'bg-red-500/15' : line.kind === 'hunk' ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300' : line.kind === 'meta' ? 'bg-muted/25 text-muted-foreground' : ''}>
          <td aria-hidden="true" className="w-10 border-r border-border/50 px-2 text-right text-muted-foreground/70 select-none">{line.old ?? ''}</td>
          <td aria-hidden="true" className="w-10 border-r border-border/50 px-2 text-right text-muted-foreground/70 select-none">{line.next ?? ''}</td>
          <td className="w-full whitespace-pre px-3">{line.text || ' '}</td>
        </tr>)}
      </tbody></table></div>
    </details>)}
  </div>
}
