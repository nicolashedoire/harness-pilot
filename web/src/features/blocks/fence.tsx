// The tiny, eager part of conversation blocks, used by components/ui/markdown.tsx: decide whether a fenced code
// block is a block (cheap, synchronous) and hand it to the lazy renderer (./BlockFence, its own chunk + the
// `blocks` dictionary group). Everything else about blocks loads only when a block shows up.
import * as React from 'react'
import { withGroups } from '@/i18n'
import { Skeleton } from '@/components/ui/skeleton'

/** Built-in block types (server/maxxing/blocks.py BUILTINS). */
export const BUILTIN_BLOCK_TYPES = new Set(['chart', 'table', 'stats', 'list', 'timeline', 'progress', 'terminal', 'diff', 'file', 'link', 'form', 'checklist', 'app', 'created'])
/** Built-ins that also take raw text (not JSON) as their body. */
export const RAW_BLOCK_TYPES = new Set(['terminal', 'diff', 'app'])
/** Fence languages never taken for a plugin block (blocks.py RESERVED_TYPES). */
const NOT_PLUGIN = new Set(['json', 'jsonc', 'json5', 'js', 'javascript', 'ts', 'typescript', 'text', 'txt', 'plain', 'md', 'markdown', 'html', 'xml', 'yaml', 'yml', 'toml', 'mermaid', 'git', 'infra', 'block', 'code'])
const TYPE = /^[a-z][a-z0-9-]{1,31}$/
const JSON_OBJECT = /^\s*\{[\s\S]*\}\s*$/

export type FenceBlock = {
  type: string
  /** `block:<type>`: always a block (an unknown type shows "not installed"). */
  explicit: boolean
  /** Not a built-in: a block only if an installed plugin draws this type (else the fence stays code). */
  candidate: boolean
}

/** Is this fence a block? `className` = the code element's (`language-<info>`), `code` = its text. */
export function fenceBlock(className: string | undefined, code: string): FenceBlock | null {
  const lang = /(?:^|\s)language-(\S+)/.exec(className || '')?.[1]
  if (!lang) return null
  const ex = /^block:(.+)$/.exec(lang)
  if (ex) return TYPE.test(ex[1]) ? { type: ex[1], explicit: true, candidate: false } : null
  if (BUILTIN_BLOCK_TYPES.has(lang)) {
    // a JSON object, or the raw text of the types that take it; anything else in a ```table fence stays code
    if (RAW_BLOCK_TYPES.has(lang) || JSON_OBJECT.test(code) || /^\s*[{[]/.test(code)) return { type: lang, explicit: false, candidate: false }
    return null
  }
  if (TYPE.test(lang) && !NOT_PLUGIN.has(lang) && JSON_OBJECT.test(code)) return { type: lang, explicit: false, candidate: true }
  return null
}

/** Markdown without its block fences: what the thread scans for media paths (a `file` block shows its own files). */
export function stripBlockFences(md: string): string {
  if (!md.includes('```') && !md.includes('~~~')) return md
  const lines = md.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[i])
    if (!open) {
      out.push(lines[i])
      continue
    }
    const fence = open[1]
    const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`)
    let j = i + 1
    while (j < lines.length && !close.test(lines[j])) j++
    const body = lines.slice(i + 1, j).join('\n')
    if (!fenceBlock(open[2] ? `language-${open[2]}` : undefined, body)) out.push(...lines.slice(i, j + 1))
    i = j
  }
  return out.join('\n')
}

const LazyBlockFence = React.lazy(withGroups(['blocks'], () => import('./BlockFence')))

/** Where a fenced block becomes a block. `fallback` = how the fence looks as ordinary code (kept for a candidate type
 *  no plugin draws, and for a raw-text fence of a built-in that is turned off). `panel`: its large size (side panel). */
export function BlockFence({ block, code, fallback, className, panel }: { block: FenceBlock; code: string; fallback: React.ReactNode; className?: string; panel?: boolean }) {
  return (
    <React.Suspense fallback={block.candidate ? fallback : <Skeleton className={className ? `${className} h-40 rounded-xl` : 'my-3 h-40 rounded-xl'} />}>
      <LazyBlockFence block={block} code={code} fallback={fallback} className={className} panel={panel} />
    </React.Suspense>
  )
}
