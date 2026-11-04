// The Codex model of a new session, a discussion, a mixed team or a scheduled prompt: the models the server's Codex
// CLI lists (GET /api/system/codex/models), "Default" (the CLI's own choice) and "Other…" for any model id. A saved id
// that is not in the list shows as "Other…" with its text, unchanged.
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useT } from '@/i18n'
import { Input, Select } from '@/components/ui'

export type CodexModel = { id: string; label: string; description: string }
export type CodexModels = { models: CodexModel[]; source: 'cli' | 'bundled' | 'builtin' }

const DEFAULT = '__default'
const OTHER = '__other'

export function useCodexModels() {
  return useQuery({ queryKey: ['codex-models'], queryFn: () => api.get<CodexModels>('/api/system/codex/models'), staleTime: 10 * 60_000 })
}

export function CodexModelField({
  id,
  value,
  onChange,
  disabled,
  ...aria
}: {
  id?: string
  /** The model id ("" = the CLI's default). */
  value: string
  onChange: (model: string) => void
  disabled?: boolean
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}) {
  const t = useT()
  const { data } = useCodexModels()
  const models = data?.models ?? []
  const [other, setOther] = React.useState(false)
  const input = React.useRef<HTMLInputElement>(null)
  const listed = models.some((m) => m.id === value)
  const custom = other || (!!value && !listed)
  const options = [
    { value: DEFAULT, label: t('sessions.model.default') },
    // the id too when the name is not just the id written another way ("GPT-5.5" / "gpt-5.5")
    ...models.map((m) => ({ value: m.id, label: m.label.toLowerCase() === m.id.toLowerCase() ? m.label : `${m.label} · ${m.id}` })),
    { value: OTHER, label: t('sessions.codexModelOther') },
  ]
  return (
    <div className="grid gap-2">
      <Select
        id={id}
        {...aria}
        value={custom ? OTHER : value || DEFAULT}
        disabled={disabled}
        onValueChange={(v) => {
          if (v === OTHER) {
            setOther(true)
            if (listed) onChange('')
            setTimeout(() => input.current?.focus(), 0)
            return
          }
          setOther(false)
          onChange(v === DEFAULT ? '' : v)
        }}
        options={options}
      />
      {custom && (
        <Input
          ref={input}
          value={value}
          maxLength={100}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder={t('sessions.codexModelCustom')}
          aria-label={t('sessions.codexModelCustom')}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
        />
      )}
    </div>
  )
}
