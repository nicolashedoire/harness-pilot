// Interactive blocks: forms and checklists (what the user answers goes back to the conversation as their next
// message, shown and confirmed first) and the cards of what the agent created.
import * as React from 'react'
import { Link } from 'react-router'
import { Check, ChevronRight, Clock3, Send } from 'lucide-react'
import { cn, store } from '@/lib/utils'
import { useT } from '@/i18n'
import { Badge, Button, Checkbox, Input, Label, NamedIcon, Segmented, Select, Sensitive, Textarea } from '@/components/ui'
import { openFileViewer } from '@/features/files/viewerStore'
import { useBlockHost } from '../host'
import { BlockShell, useDataMenu, useSendToSession } from '../shell'
import type { RendererProps } from './types'

/** Something this browser remembers about one block (sent, postponed, ticked). */
function useMemo2<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = React.useState<T>(() => {
    const s = store.get(key)
    if (s == null) return initial
    try {
      return JSON.parse(s) as T
    } catch {
      return initial
    }
  })
  const set = React.useCallback((x: T) => {
    setV(x)
    store.set(key, JSON.stringify(x))
  }, [key])
  return [v, set]
}

/* ------------------------------------------------------------------ form */
type Opt = { label: string; value: string }
type Field = {
  id: string
  label: string
  type: 'text' | 'textarea' | 'number' | 'select' | 'choice' | 'multi' | 'checkbox' | 'range' | 'date' | 'time'
  options?: (string | { label: string; value?: string })[]
  min?: number
  max?: number
  step?: number
  unit?: string
  default?: unknown
  required?: boolean
  placeholder?: string
  hint?: string
}
type Value = string | number | boolean | string[]

const optsOf = (f: Field): Opt[] => (f.options ?? []).map((o) => (typeof o === 'string' ? { label: o, value: o } : { label: o.label, value: o.value ?? o.label }))

function initialValue(f: Field): Value {
  const d = f.default
  switch (f.type) {
    case 'multi':
      return Array.isArray(d) ? d.map(String) : []
    case 'checkbox':
      return d === true
    case 'range': {
      const min = f.min ?? 0, max = f.max ?? 100
      return typeof d === 'number' ? d : Math.round((min + max) / 2)
    }
    case 'number':
      return typeof d === 'number' ? d : ''
    default:
      return d == null ? '' : String(d)
  }
}

function isEmpty(v: Value) {
  return v === '' || (Array.isArray(v) && !v.length)
}

/** The answer as the user will read it in the confirmation and in the thread. */
function answerText(title: string, fields: Field[], values: Record<string, Value>, yes: string, no: string): string {
  const lines = fields.flatMap((f) => {
    const v = values[f.id]
    if (f.type !== 'checkbox' && isEmpty(v)) return []
    const opts = optsOf(f)
    const label = (x: string) => opts.find((o) => o.value === x)?.label ?? x
    const shown =
      f.type === 'checkbox' ? (v ? yes : no)
      : f.type === 'multi' ? (v as string[]).map(label).join(', ')
      : f.type === 'select' || f.type === 'choice' ? label(String(v))
      : `${v}${f.unit ? ` ${f.unit}` : ''}`
    return [`- ${f.label}: ${shown}`]
  })
  return `${title}:\n${lines.join('\n')}`
}

export function FormBlock({ block, memoKey, onRaw }: RendererProps) {
  const t = useT()
  const host = useBlockHost()
  const send = useSendToSession()
  const d = block.data as { title?: string; description?: string; submit?: string; fields: Field[] }
  const fields = React.useMemo(() => {
    const seen = new Set<string>()
    return d.fields.filter((f) => !seen.has(f.id) && seen.add(f.id))
  }, [d.fields])
  const [values, setValues] = React.useState<Record<string, Value>>(() => Object.fromEntries(fields.map((f) => [f.id, initialValue(f)])))
  const [errors, setErrors] = React.useState<Record<string, boolean>>({})
  const [sent, setSent] = useMemo2<{ at: number } | null>(`mx-block-sent:${memoKey}`, null)
  const [later, setLater] = useMemo2<boolean>(`mx-block-later:${memoKey}`, false)
  const [busy, setBusy] = React.useState(false)
  const ref = React.useRef<HTMLElement>(null)
  const menu = useDataMenu(block.raw, 'form', onRaw)
  const title = d.title || t('blocks.type.form')
  const set = (id: string, v: Value) => {
    setValues((s) => ({ ...s, [id]: v }))
    setErrors((e) => ({ ...e, [id]: false }))
  }
  const submit = async () => {
    const missing = Object.fromEntries(fields.filter((f) => f.required && isEmpty(values[f.id])).map((f) => [f.id, true]))
    if (Object.keys(missing).length) {
      setErrors(missing)
      return
    }
    setBusy(true)
    try {
      if (await send(answerText(title, fields, values, t('blocks.form.yes'), t('blocks.form.no')), ref.current)) setSent({ at: Date.now() })
    } finally {
      setBusy(false)
    }
  }
  const disabled = !!sent
  return (
    <section ref={ref}>
      <BlockShell
        icon="sliders-horizontal"
        title={<Sensitive>{title}</Sensitive>}
        meta={sent ? <Badge variant="success"><Check /> {t('blocks.form.sent')}</Badge> : later ? <Badge variant="muted"><Clock3 /> {t('blocks.form.postponed')}</Badge> : undefined}
        menu={menu}
        footer={
          later && !sent ? (
            <Button variant="outline" size="sm" onClick={() => setLater(false)}>
              <ChevronRight /> {t('blocks.form.reopen')}
            </Button>
          ) : (
            <>
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                {sent ? t('blocks.form.sentHint') : host?.agent ? t('blocks.form.hintAgent', { agent: host.agent }) : t('blocks.form.hint')}
              </span>
              {!sent && (
                <>
                  <Button variant="ghost" size="sm" onClick={() => setLater(true)}>
                    {t('blocks.form.later')}
                  </Button>
                  <Button size="sm" loading={busy} onClick={submit}>
                    <Send /> {d.submit || t('blocks.form.send')}
                  </Button>
                </>
              )}
            </>
          )
        }
      >
        {later && !sent ? (
          <p className="text-[13px] text-muted-foreground">{t('blocks.form.postponedHint')}</p>
        ) : (
          <div className="grid gap-4">
            {d.description && <p className="text-[13px] text-muted-foreground"><Sensitive>{d.description}</Sensitive></p>}
            <div className="grid min-w-0 gap-x-6 gap-y-4 sm:grid-cols-2">
              {fields.map((f) => (
                <FormFieldView key={f.id} f={f} id={`${memoKey}-${f.id}`} value={values[f.id]} onChange={(v) => set(f.id, v)} error={!!errors[f.id]} disabled={disabled} />
              ))}
            </div>
          </div>
        )}
      </BlockShell>
    </section>
  )
}

function FormFieldView({ f, id, value, onChange, error, disabled }: { f: Field; id: string; value: Value; onChange: (v: Value) => void; error: boolean; disabled: boolean }) {
  const t = useT()
  const opts = optsOf(f)
  const wide = f.type === 'textarea' || f.type === 'multi' || (f.type === 'choice' && opts.length > 3)
  const hintId = `${id}-hint`
  const control = (() => {
    switch (f.type) {
      case 'textarea':
        return <Textarea id={id} value={String(value)} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder} minRows={2} maxRows={8} disabled={disabled} aria-invalid={error} aria-describedby={hintId} />
      case 'number':
        return <Input id={id} type="number" inputMode="decimal" value={String(value)} min={f.min} max={f.max} step={f.step} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} placeholder={f.placeholder} disabled={disabled} aria-invalid={error} aria-describedby={hintId} />
      case 'date':
      case 'time':
        return <Input id={id} type={f.type} value={String(value)} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-invalid={error} aria-describedby={hintId} />
      case 'select':
        return <Select id={id} value={String(value) || undefined} onValueChange={onChange} options={opts} placeholder={f.placeholder || t('blocks.form.pick')} disabled={disabled} aria-invalid={error} aria-describedby={hintId} />
      case 'choice':
        return (
          <Segmented
            value={String(value)}
            onChange={(v) => !disabled && onChange(v)}
            options={opts.map((o) => ({ value: o.value, label: o.label }))}
            aria-label={f.label}
            wrap
            className={cn(disabled && 'pointer-events-none opacity-60')}
          />
        )
      case 'multi':
        return (
          <div className="flex flex-wrap gap-x-5 gap-y-2" role="group" aria-labelledby={`${id}-label`}>
            {opts.map((o) => {
              const list = value as string[]
              const on = list.includes(o.value)
              return (
                <label key={o.value} className="inline-flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={on} disabled={disabled} onCheckedChange={(c) => onChange(c ? [...list, o.value] : list.filter((x) => x !== o.value))} />
                  {o.label}
                </label>
              )
            })}
          </div>
        )
      case 'checkbox':
        return (
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox id={id} checked={value === true} disabled={disabled} onCheckedChange={(c) => onChange(c === true)} />
            {f.placeholder || t('blocks.form.yes')}
          </label>
        )
      case 'range': {
        const min = f.min ?? 0, max = f.max ?? 100
        return (
          <div className="flex items-center gap-3">
            <input
              id={id}
              type="range"
              min={min}
              max={max}
              step={f.step ?? 1}
              value={Number(value)}
              disabled={disabled}
              onChange={(e) => onChange(Number(e.target.value))}
              aria-describedby={hintId}
              className="h-2 min-w-0 flex-1 cursor-pointer accent-action disabled:cursor-default"
            />
            <output htmlFor={id} className="w-20 shrink-0 text-right text-sm font-medium tabular-nums">
              {String(value)}
              {f.unit ? ` ${f.unit}` : ''}
            </output>
          </div>
        )
      }
      default:
        return <Input id={id} value={String(value)} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder} disabled={disabled} aria-invalid={error} aria-describedby={hintId} />
    }
  })()
  return (
    <div className={cn('grid min-w-0 content-start gap-1.5', wide && 'sm:col-span-2')}>
      <Label id={`${id}-label`} htmlFor={f.type === 'multi' || f.type === 'choice' ? undefined : id} className="text-[13px] font-medium">
        {f.label}
        {f.required && <span className="text-destructive"> *</span>}
      </Label>
      {control}
      <span id={hintId} className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground', !error && !f.hint && 'sr-only')}>
        {error ? t('blocks.form.required') : f.hint}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ checklist */
type Item = { label: string; hint?: string; checked?: boolean }

export function ChecklistBlock({ block, memoKey, onRaw }: RendererProps) {
  const t = useT()
  const send = useSendToSession()
  const d = block.data as { title?: string; submit?: string; items: (string | Item)[] }
  const items: Item[] = d.items.map((i) => (typeof i === 'string' ? { label: i } : i))
  const [checked, setChecked] = useMemo2<boolean[]>(`mx-block-check:${memoKey}`, items.map((i) => !!i.checked))
  const [sent, setSent] = useMemo2<{ at: number } | null>(`mx-block-sent:${memoKey}`, null)
  const ref = React.useRef<HTMLDivElement>(null)
  const menu = useDataMenu(block.raw, 'checklist', onRaw)
  const done = items.filter((_, i) => checked[i]).length
  const title = d.title || t('blocks.type.checklist')
  return (
    <div ref={ref}>
      <BlockShell
        icon="list-checks"
        title={<Sensitive>{title}</Sensitive>}
        headerExtra={<span className="shrink-0 text-xs text-muted-foreground tabular-nums">{t('blocks.checklist.count', { done, total: items.length })}</span>}
        menu={menu}
        bodyClassName="px-4 py-2"
        footer={
          d.submit ? (
            sent ? (
              <Badge variant="success"><Check /> {t('blocks.form.sent')}</Badge>
            ) : (
              <Button size="sm" onClick={async () => {
                const text = `${title}:\n${items.map((it, i) => `- [${checked[i] ? 'x' : ' '}] ${it.label}`).join('\n')}`
                if (await send(text, ref.current)) setSent({ at: Date.now() })
              }}>
                <Send /> {d.submit}
              </Button>
            )
          ) : undefined
        }
      >
        <ul className="grid">
          {items.map((it, i) => (
            <li key={i}>
              <label className="flex cursor-pointer items-start gap-3 rounded-md py-2">
                <Checkbox className="mt-0.5" checked={!!checked[i]} onCheckedChange={(c) => setChecked(items.map((_, j) => (j === i ? c === true : !!checked[j])))} />
                <span className="grid min-w-0">
                  <span className={cn('text-sm transition-colors', checked[i] && 'text-muted-foreground line-through')}>
                    <Sensitive>{it.label}</Sensitive>
                  </span>
                  {it.hint && <span className="text-xs text-muted-foreground"><Sensitive>{it.hint}</Sensitive></span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </BlockShell>
    </div>
  )
}

/* ------------------------------------------------------------------ created objects */
type Created = { kind: 'task' | 'cron' | 'notification' | 'file' | 'session' | 'project' | 'extension' | 'other'; title: string; subtitle?: string; id?: string; path?: string; href?: string }
const KIND_ICON: Record<Created['kind'], string> = { task: 'list-checks', cron: 'clock', notification: 'bell', file: 'file', session: 'message-square', project: 'folder', extension: 'puzzle', other: 'check-circle' }
const SAFE_HREF = /^(https:\/\/|\/(?!\/))/i

function targetOf(c: Created): { to?: string; href?: string; file?: string } {
  const id = c.id ? encodeURIComponent(c.id) : ''
  if (c.href && SAFE_HREF.test(c.href)) return c.href.startsWith('/') ? { to: c.href } : { href: c.href }
  switch (c.kind) {
    case 'task':
      return { to: id ? `/tasks?task=${id}` : '/tasks' }
    case 'cron':
      return { to: id ? `/crons?job=${id}` : '/crons' }
    case 'notification':
      return { to: '/settings/notifications' }
    case 'session':
      return id ? { to: `/sessions?session=${id}` } : {}
    case 'project':
      return c.path ? { to: `/sessions?path=${encodeURIComponent(c.path)}` } : {}
    case 'extension':
      return { to: '/settings/extensions' }
    case 'file':
      return c.path?.startsWith('/') ? { file: c.path } : {}
    default:
      return {}
  }
}

export function CreatedBlock({ block }: RendererProps) {
  const t = useT()
  const d = block.data as { title?: string; items: Created[] }
  return (
    <div className="mx-block not-prose my-3 grid gap-2">
      {d.title && <h4 className="text-[15px] font-semibold tracking-tight"><Sensitive>{d.title}</Sensitive></h4>}
      <div className="grid gap-2.5 sm:grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
        {d.items.map((c, i) => {
          const target = targetOf(c)
          const label = t(`blocks.created.open.${c.kind}`)
          const link = target.to ? (
            <Link to={target.to} className="text-[13px] font-medium text-primary underline-offset-4 hover:underline">{label}</Link>
          ) : target.href ? (
            <a href={target.href} target="_blank" rel="noopener noreferrer nofollow" className="text-[13px] font-medium text-primary underline-offset-4 hover:underline">{label}</a>
          ) : target.file ? (
            <button type="button" data-mx-file={target.file} onClick={() => openFileViewer(target.file!)} className="w-fit text-[13px] font-medium text-primary underline-offset-4 hover:underline">{label}</button>
          ) : null
          return (
            <div key={i} className="mx-rise grid min-w-0 content-start gap-1 rounded-xl border bg-card p-3.5" style={{ '--i': Math.min(i, 10) } as React.CSSProperties}>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <NamedIcon name={KIND_ICON[c.kind]} className="size-3.5" /> {t(`blocks.created.kind.${c.kind}`)}
              </span>
              <span className="text-sm font-semibold"><Sensitive>{c.title}</Sensitive></span>
              {c.subtitle && <span className="text-[13px] text-muted-foreground"><Sensitive>{c.subtitle}</Sensitive></span>}
              {link && <span className="mt-1.5">{link}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
