import { cn } from '@/lib/utils'
import { logoSrc } from '@/lib/accent'

export function LogoMark({ className }: { className?: string }) {
  return (
    <img src={logoSrc()} alt="" width={28} height={28} draggable={false} className={cn('size-7 shrink-0 select-none', className)} aria-hidden />
  )
}

export function Logo({ collapsed, className, nameClassName }: { collapsed?: boolean; className?: string; nameClassName?: string }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <LogoMark />
      {!collapsed && <span className={cn('truncate text-[15px] font-semibold tracking-tight', nameClassName)}>harness-pilot</span>}
    </span>
  )
}
