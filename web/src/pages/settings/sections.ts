// Settings sub-navigation (route /settings/:section), grouped under headings. Lightweight on purpose: also used by the palette.
// Menu order = the order below, group by group; Support (donation) stays last, without a group, in the accent colour.
import { GitPullRequest, ListChecks, Building2, UserRound, BarChart3, Bell, Palette, FolderKanban, HandHeart, History, ToggleRight, Blocks, BookOpen, Shapes, Bot, Brain, DatabaseBackup, FileInput, KeyRound, Mic, Plug, Send, Server, Shield, SlidersHorizontal, Trash2, type LucideIcon } from 'lucide-react'
import type { TKey } from '@/i18n'

export type SettingsSectionId = 'general' | 'appearance' | 'profile' | 'license' | 'support' | 'packs' | 'features' | 'notifications' | 'security' | 'claude' | 'codex' | 'companions' | 'missions' | 'pull-requests' | 'stats' | 'memory' | 'telegram' | 'voice' | 'backup' | 'keys' | 'mcp' | 'extensions' | 'blocks' | 'import' | 'trash' | 'system' | 'updates' | 'docs'

export type SettingsGroupId = 'you' | 'agents' | 'data' | 'integrations' | 'platform'

export const SETTINGS_GROUPS: { id: SettingsGroupId; label: TKey }[] = [
  { id: 'you', label: 'setnav.you' },
  { id: 'agents', label: 'setnav.agents' },
  { id: 'data', label: 'setnav.data' },
  { id: 'integrations', label: 'setnav.integrations' },
  { id: 'platform', label: 'setnav.platform' },
]

export type SettingsSection = { id: SettingsSectionId; group?: SettingsGroupId; label: TKey; description: TKey; icon: LucideIcon; keywords?: string }

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'general', group: 'you', label: 'settings.general', description: 'settings.general.desc', icon: SlidersHorizontal, keywords: 'layout language timezone server address' },
  { id: 'appearance', group: 'you', label: 'settings.appearance', description: 'settings.appearance.desc', icon: Palette, keywords: 'theme dark light palette colour color accent buttons tint background font density export import' },
  { id: 'notifications', group: 'you', label: 'settings.notifications', description: 'settings.notifications.desc', icon: Bell, keywords: 'notification alert sound badge pulse finished done' },
  { id: 'profile', group: 'you', label: 'settings.profile', description: 'settings.profile.desc', icon: UserRound, keywords: 'pseudo name nickname avatar color emoji identity' },
  { id: 'security', group: 'you', label: 'settings.security', description: 'settings.security.desc', icon: Shield, keywords: 'password sign out' },
  { id: 'claude', group: 'agents', label: 'settings.claude', description: 'settings.claude.desc', icon: Bot, keywords: 'model token api key permission' },
  { id: 'codex', group: 'agents', label: 'settings.codex', description: 'settings.codex.desc', icon: Bot, keywords: 'openai codex chatgpt login agent' },
  { id: 'companions', group: 'agents', label: 'companions.section', description: 'companions.section.desc', icon: Bot, keywords: 'agents roles review proposal' },
  { id: 'missions', group: 'agents', label: 'settings.missions', description: 'settings.missions.desc', icon: ListChecks, keywords: 'resident missions plans roles recurring security audit automation' },
  { id: 'blocks', group: 'agents', label: 'blocks.section', description: 'blocks.section.desc', icon: Shapes, keywords: 'conversation blocks plugins chart table form charts tables forms answers rich content' },
  { id: 'memory', group: 'agents', label: 'settings.memory', description: 'settings.memory.desc', icon: Brain, keywords: 'second brain memory.md clean compaction lines' },
  { id: 'voice', group: 'agents', label: 'settings.voice', description: 'settings.voice.desc', icon: Mic, keywords: 'microphone speech transcription whisper dictation audio' },
  { id: 'backup', group: 'data', label: 'settings.backup', description: 'settings.backup.desc', icon: DatabaseBackup, keywords: 'github memory restore' },
  { id: 'keys', group: 'data', label: 'settings.keys', description: 'settings.keys.desc', icon: KeyRound, keywords: 'secrets vault env api keys' },
  { id: 'import', group: 'data', label: 'settings.import', description: 'settings.import.desc', icon: FileInput, keywords: 'import migrate hermes openclaw claude code zip memory' },
  { id: 'trash', group: 'data', label: 'settings.trash', description: 'settings.trash.desc', icon: Trash2, keywords: 'deleted restore recycle bin undo corbeille' },
  { id: 'mcp', group: 'integrations', label: 'settings.mcp', description: 'settings.mcp.desc', icon: Plug, keywords: 'mcp servers tools connectors oauth model context protocol' },
  { id: 'extensions', group: 'integrations', label: 'settings.extensions', description: 'settings.extensions.desc', icon: Blocks, keywords: 'widgets pages plugins' },
  { id: 'telegram', group: 'integrations', label: 'settings.telegram', description: 'settings.telegram.desc', icon: Send, keywords: 'bot threads' },
  { id: 'pull-requests', group: 'integrations', label: 'prQueue.section', description: 'prQueue.section.desc', icon: GitPullRequest, keywords: 'pull requests git merge review dependency queue approval' },
  { id: 'system', group: 'platform', label: 'settings.system', description: 'settings.system.desc', icon: Server, keywords: 'health services logs update version background service launchd mac git pull' },
  { id: 'updates', group: 'platform', label: 'settings.updates', description: 'settings.updates.desc', icon: History, keywords: 'changelog what is new versions release notes history' },
  { id: 'stats', group: 'platform', label: 'settings.stats', description: 'settings.stats.desc', icon: BarChart3, keywords: 'usage quota tokens statistics plan limit' },
  { id: 'features', group: 'platform', label: 'settings.features', description: 'settings.features.desc', icon: ToggleRight, keywords: 'features options hud mirror telegram usage presentation enable experimental' },
  { id: 'license', group: 'platform', label: 'settings.license', description: 'settings.license.desc', icon: Building2, keywords: 'license licence enterprise company key business fair source' },
  { id: 'docs', group: 'platform', label: 'settings.docs', description: 'settings.docs.desc', icon: BookOpen, keywords: 'help documentation guide' },
  { id: 'packs', group: 'platform', label: 'settings.projects', description: 'settings.projects.desc', icon: FolderKanban, keywords: 'packs starter projects ecommerce affiliate creator apps second brain freelance templates' },
  { id: 'support', label: 'settings.support', description: 'settings.support.desc', icon: HandHeart, keywords: 'support donate donation sponsor fund contribute help the project' },
]

/** The menu: one entry per group with its sections, then Support alone (`group: null`, no heading). */
export const SETTINGS_NAV: { group: (typeof SETTINGS_GROUPS)[number] | null; items: SettingsSection[] }[] = [
  ...SETTINGS_GROUPS.map((group) => ({ group, items: SETTINGS_SECTIONS.filter((s) => s.group === group.id) })),
  { group: null, items: SETTINGS_SECTIONS.filter((s) => !s.group) },
]

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
/** The menu search: the groups with the sections whose name, description or keywords hold every word of `query`
 * (case and accents ignored); the whole menu when the query is blank. */
export function filterSettingsNav(t: (key: TKey) => string, query: string): typeof SETTINGS_NAV {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return SETTINGS_NAV
  const match = (s: SettingsSection) => {
    const text = fold(`${t(s.label)} ${t(s.description)} ${s.keywords ?? ''}`)
    return words.every((w) => text.includes(w))
  }
  return SETTINGS_NAV.map((g) => ({ ...g, items: g.items.filter(match) })).filter((g) => g.items.length)
}
