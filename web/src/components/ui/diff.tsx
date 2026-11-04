// A unified diff drawn as a table: old and new line numbers, + / − marks, hunks. Shared by the conversation `diff`
// block (features/blocks/builtins/code.tsx) and the Atelier's file review. Not in the barrel: import it from here.
import { cn } from '@/lib/utils'

export type DiffRow = { kind: 'add' | 'del' | 'ctx' | 'hunk' | 'file' | 'note'; text: string; old?: number; new?: number }

export function parseDiff(diff: string): { rows: DiffRow[]; add: number; del: number; path: string } {
  const rows: DiffRow[] = []
  let o = 0, n = 0, add = 0, del = 0, path = ''
  for (const line of diff.replace(/\n$/, '').split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (h) {
      o = Number(h[1])
      n = Number(h[2])
      rows.push({ kind: 'hunk', text: line })
    } else if (line.startsWith('+++ ')) {
      path = line.slice(4).replace(/^b\//, '').trim()
      rows.push({ kind: 'file', text: line })
    } else if (line.startsWith('--- ') || line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
      rows.push({ kind: 'file', text: line })
    } else if (line.startsWith('+')) {
      add++
      rows.push({ kind: 'add', text: line.slice(1), new: n++ })
    } else if (line.startsWith('-')) {
      del++
      rows.push({ kind: 'del', text: line.slice(1), old: o++ })
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'note', text: line })
    } else {
      rows.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, old: o ? o++ : undefined, new: n ? n++ : undefined })
    }
  }
  return { rows, add, del, path }
}

/** The rows of `parseDiff` (file headers left out), in a scrolling box (`className` sets its height). */
export function DiffTable({ rows, className }: { rows: DiffRow[]; className?: string }) {
  return (
    <div className={cn('overflow-auto font-mono text-[12.5px] leading-[1.6]', className)}>
      <table className="w-full border-collapse">
        <tbody>
          {rows.map((r, i) =>
            r.kind === 'file' ? null : r.kind === 'hunk' || r.kind === 'note' ? (
              <tr key={i} className="bg-muted/40 text-muted-foreground">
                <td colSpan={4} className="px-3 py-0.5 text-[11.5px]">
                  {r.text}
                </td>
              </tr>
            ) : (
              <tr key={i} className={cn(r.kind === 'add' && 'bg-success/10', r.kind === 'del' && 'bg-destructive/10')}>
                <td className="w-10 px-2 text-right text-muted-foreground/70 tabular-nums select-none">{r.old ?? ''}</td>
                <td className="w-10 px-2 text-right text-muted-foreground/70 tabular-nums select-none">{r.new ?? ''}</td>
                <td className={cn('w-4 text-center select-none', r.kind === 'add' && 'text-success', r.kind === 'del' && 'text-destructive')}>{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</td>
                <td className="pr-3 whitespace-pre-wrap [overflow-wrap:anywhere]">{r.text || ' '}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  )
}
