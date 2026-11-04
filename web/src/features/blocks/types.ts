// Conversation blocks: payloads of /api/blocks (docs/dev/API.md#conversation-blocks). Kept here, next to the
// feature, so the block plugin system stays one folder (features/blocks) plus a hook in components/ui/markdown.tsx.

/** The JSON Schema subset both the server (maxxing/blocks.py) and ./schema.ts understand. */
export type JsonSchema = {
  type?: JsonType | JsonType[]
  enum?: unknown[]
  const?: unknown
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean | JsonSchema
  items?: JsonSchema | JsonSchema[]
  minItems?: number
  maxItems?: number
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  description?: string
  title?: string
  default?: unknown
}
export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null'

export type BlockCategory = 'data' | 'code' | 'media' | 'interactive' | 'organisation' | 'other'

export type BlockPlugin = {
  /** Built-in: the block type (`chart`). Extension: the extension id (`<workspace>/extensions/<id>/block.json`). */
  id: string
  kind: 'builtin' | 'extension'
  /** Extension name (built-ins are named by the UI: `blocks.type.<id>`). */
  name: string
  names: Record<string, string>
  renders: string[]
  icon: string
  category: BlockCategory
  /** The line the agents get. */
  hint: string
  /** Body summary the agents get (built-ins). */
  fields: string
  schema: JsonSchema
  /** Built-ins that also take raw text: the field the text goes into (terminal: output, diff: diff, app: html). */
  raw: string | null
  version: string
  description: string
  enabled: boolean
  error: string | null
  /** Hosts the plugin's frame may reach (https), after consent. */
  network: string[]
  consent: 'granted' | 'denied' | 'ask' | null
  /** Can be pinned to the dashboard as a widget. */
  pin: boolean
  /** block.html mtime (ms), cache key of the frame. */
  entry_v: number | null
  height: number | null
}

export type BlocksCatalog = {
  plugins: BlockPlugin[]
  /** What the agents are told (the pilot-blocks skill for Claude Code, a context file for Codex, the schemas). */
  agents: { types: string[]; count: number; skill: string; codex: string; reference: string; synced_at: number | null }
}

/** A block ready to draw: its type, its (valid) data, and the plugin that draws it. */
export type BlockInstance = { type: string; data: Record<string, unknown>; plugin: BlockPlugin; raw: string }
