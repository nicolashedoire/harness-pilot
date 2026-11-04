// The Settings menu (src/pages/settings/sections): its groups and its search. Run: npm test (plain Node, no dependency).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SETTINGS_GROUPS, SETTINGS_NAV, SETTINGS_SECTIONS, filterSettingsNav } from '../src/pages/settings/sections'
import { en } from '../src/i18n/en'
import { fr } from '../src/i18n/fr'

const ids = (nav: typeof SETTINGS_NAV) => nav.flatMap((g) => g.items.map((s) => s.id))

test('every section sits in one group, the menu follows the list order and Support comes last, alone', () => {
  assert.deepEqual(ids(SETTINGS_NAV), SETTINGS_SECTIONS.map((s) => s.id), 'mobile tabs and the desktop menu share one order')
  assert.equal(new Set(ids(SETTINGS_NAV)).size, SETTINGS_SECTIONS.length)
  assert.deepEqual(SETTINGS_NAV.map((g) => g.group?.id ?? null), [...SETTINGS_GROUPS.map((g) => g.id), null])
  assert.ok(SETTINGS_NAV.slice(0, -1).every((g) => g.items.length > 0), 'no empty group')
  assert.deepEqual(SETTINGS_NAV.at(-1)?.items.map((s) => s.id), ['support'])
  const at = (id: string) => SETTINGS_NAV.find((g) => g.items.some((s) => s.id === id))?.group?.id
  assert.deepEqual(['missions', 'blocks', 'pull-requests', 'stats', 'packs'].map(at), ['agents', 'agents', 'integrations', 'platform', 'platform'])
})

test('group headings exist in both languages', () => {
  for (const g of SETTINGS_GROUPS) {
    assert.ok(en[g.label], g.label)
    assert.ok(fr[g.label], g.label)
  }
  assert.equal(fr['setnav.data'], 'Données')
})

test('the search matches names, descriptions and keywords, every word, without case or accents', () => {
  const tEn = (k: keyof typeof en) => en[k]
  const tFr = (k: keyof typeof en) => fr[k]
  assert.equal(filterSettingsNav(tEn, '  '), SETTINGS_NAV)
  assert.deepEqual(ids(filterSettingsNav(tEn, 'pull')), ['pull-requests'])
  assert.deepEqual(ids(filterSettingsNav(tEn, 'TRASH')), ['trash'])
  assert.ok(ids(filterSettingsNav(tEn, 'password')).includes('security'), 'keywords count')
  assert.deepEqual(ids(filterSettingsNav(tFr, 'securite mot')), ['security'], 'accents ignored, every word must match')
  assert.deepEqual(filterSettingsNav(tEn, 'zzzz'), [])
  const grouped = filterSettingsNav(tEn, 'backup')
  assert.ok(grouped.every((g) => g.items.length > 0), 'groups without a match are dropped')
})
