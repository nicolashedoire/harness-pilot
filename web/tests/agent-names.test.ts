// Agent names (src/features/agents/names): product names, extension engines and their translated fallback.
// Run: npm test (plain Node, no dependency).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentName } from '../src/features/agents/names'
import { en } from '../src/i18n/en'
import { fr } from '../src/i18n/fr'

const tEn = (k: keyof typeof en) => en[k]
const tFr = (k: keyof typeof en) => fr[k]

test('product names are never translated', () => {
  assert.equal(agentName('claude', tFr), 'Claude Code')
  assert.equal(agentName('codex', tFr, 'ignored'), 'Codex')
})

test('an extension engine shows its own name, else a translated fallback', () => {
  assert.equal(agentName('plugin', tEn, 'Local Llama'), 'Local Llama')
  assert.equal(agentName('plugin', tEn), 'Extension agent')
  assert.equal(agentName('plugin', tFr, ''), 'Agent d’extension')
})

test('extension engines have their own model hint, not the Codex one', () => {
  for (const d of [en, fr]) {
    assert.notEqual(d['agentProviders.modelHint'], d['sessions.codexModelHint'])
    assert.ok(d['agentProviders.modelHint'].includes('{name}'))
    assert.ok(!/codex/i.test(d['agentProviders.modelHint']))
  }
})
