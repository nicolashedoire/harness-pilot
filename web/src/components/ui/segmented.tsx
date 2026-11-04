import * as React from 'react'
import { cn } from '@/lib/utils'

/** Segmented control (radio group look-alike) for 2-5 exclusive options. Keyboard: arrows. `wrap`: options that do
 *  not fit go to the next line (and a long label wraps) instead of scrolling sideways - for labels chosen by
 *  someone else (an agent's form), which may not fit a phone. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  'aria-label': ariaLabel,
  size = 'default',
  wrap = false,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: React.ReactNode; icon?: React.ReactNode }[]
  className?: string
  'aria-label'?: string
  size?: 'default' | 'sm'
  wrap?: boolean
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([])
  // the checked option takes the Tab stop; with none checked yet, the first one does
  const stop = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn('inline-flex w-fit max-w-full items-center gap-0.5 rounded-lg bg-muted p-1', wrap ? 'flex-wrap' : 'overflow-x-auto', className)}
    >
      {options.map((o, i) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={i === stop ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
              if (!d) return
              e.preventDefault()
              const n = (i + d + options.length) % options.length
              onChange(options[n].value)
              refs.current[n]?.focus()
            }}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-md px-3 font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4',
              size === 'sm' ? 'text-[13px]' : 'text-sm',
              wrap
                ? 'min-h-7 max-w-full min-w-0 py-1 text-center [overflow-wrap:anywhere] max-md:min-h-10 pointer-coarse:min-h-10'
                : 'h-7 whitespace-nowrap max-md:h-10 pointer-coarse:h-10',
              active && 'bg-background text-foreground shadow-xs dark:bg-secondary',
            )}
          >
            {o.icon}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
