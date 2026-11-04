// Validation of a block's JSON against its type's schema (the JSON Schema subset of server/maxxing/blocks.py,
// same messages). Block data is model output: it is checked before any renderer or plugin frame sees it.
import type { JsonSchema, JsonType } from './types'

function typeOk(t: JsonType, v: unknown): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string'
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v)
    case 'boolean':
      return typeof v === 'boolean'
    case 'array':
      return Array.isArray(v)
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v)
    case 'null':
      return v === null
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Readable errors (`series[0].points: expected array`), at most `limit`. */
export function validate(schema: JsonSchema | boolean | undefined, data: unknown, path = '', limit = 20): string[] {
  const errors: string[] = []
  const at = (p: string) => p || '(root)'
  const walk = (s: JsonSchema | boolean | undefined, v: unknown, p: string) => {
    if (errors.length >= limit || s === true || !s || typeof s !== 'object' || !Object.keys(s).length) return
    if (s.type !== undefined) {
      const ts = Array.isArray(s.type) ? s.type : [s.type]
      if (!ts.some((x) => typeOk(x, v))) {
        errors.push(`${at(p)}: expected ${ts.join(' or ')}`)
        return
      }
    }
    if ('const' in s && !same(v, s.const)) errors.push(`${at(p)}: must be ${JSON.stringify(s.const)}`)
    if (s.enum && !s.enum.some((x) => same(x, v))) errors.push(`${at(p)}: must be one of ${s.enum.map((x) => JSON.stringify(x)).join(', ')}`)
    if (typeof v === 'string') {
      if (s.maxLength !== undefined && v.length > s.maxLength) errors.push(`${at(p)}: longer than ${s.maxLength} characters`)
      if (s.minLength !== undefined && v.length < s.minLength) errors.push(`${at(p)}: shorter than ${s.minLength} characters`)
    }
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errors.push(`${at(p)}: below ${s.minimum}`)
      if (s.maximum !== undefined && v > s.maximum) errors.push(`${at(p)}: above ${s.maximum}`)
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${at(p)}: needs at least ${s.minItems} item(s)`)
      if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${at(p)}: more than ${s.maxItems} items`)
      if (Array.isArray(s.items)) s.items.forEach((sub, i) => i < v.length && walk(sub, v[i], `${p}[${i}]`))
      else if (s.items) for (let i = 0; i < v.length && errors.length < limit; i++) walk(s.items, v[i], `${p}[${i}]`)
    }
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const o = v as Record<string, unknown>
      for (const name of s.required ?? []) if (!(name in o) || o[name] === null || o[name] === undefined) errors.push(`${p ? p + '.' : ''}${name}: missing`)
      const props = s.properties ?? {}
      const ap = s.additionalProperties ?? true
      for (const [k, x] of Object.entries(o)) {
        const sub = p ? `${p}.${k}` : k
        if (k in props) walk(props[k], x, sub)
        else if (ap === false) errors.push(`${sub}: unknown field`)
        else if (typeof ap === 'object') walk(ap, x, sub)
      }
    }
    for (const alts of [s.anyOf, s.oneOf]) {
      if (alts?.length && !alts.some((a) => !validate(a, v, p, 1).length)) {
        const first = validate(alts[0], v, p, 1)
        errors.push(first[0] ?? `${at(p)}: does not match any allowed form`)
      }
    }
  }
  walk(schema, data, path)
  return errors.slice(0, limit)
}
