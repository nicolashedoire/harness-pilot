// Names of the agents a session talks to. Plain module (no React): AgentIcon and the unit tests use it.
import type { TFn } from '@/i18n'

export type AgentId = 'claude' | 'codex' | 'plugin'

/** Product names: never translated. */
export const AGENT_NAME: Record<Exclude<AgentId, 'plugin'>, string> = { claude: 'Claude Code', codex: 'Codex' }

/** The name shown for an agent: the product name, or for an extension engine its own name (`provider_name`),
 *  else a translated fallback. */
export function agentName(agent: AgentId, t: TFn, providerName?: string | null): string {
  return agent === 'plugin' ? providerName || t('agentProviders.fallbackName') : AGENT_NAME[agent]
}
