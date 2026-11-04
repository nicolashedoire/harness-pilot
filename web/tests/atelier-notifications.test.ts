import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserOn, PREF_ROWS, soundDefault } from '../src/features/notifications/prefs'
import { en } from '../src/i18n/en'
import { fr } from '../src/i18n/fr'

test('Atelier proposals have their own preference row, ring by default and are worded in both languages', () => {
  const row = PREF_ROWS.find((item) => item.id === 'atelier')!
  assert.ok(row)
  for (const kind of ['atelier.proposed', 'atelier.activated']) {
    assert.ok(row.kinds.includes(kind))
    assert.equal(browserOn({}, { kind, source: 'system', level: 'warning' }), true)
    assert.equal(soundDefault(kind, 'warning'), true)
  }
  for (const dict of [en, fr] as Record<string, string>[]) {
    assert.match(dict['atelier.kind.proposed.title'], /\{name\}/)
    assert.match(dict['atelier.kind.activated.title'], /\{name\}.*\{version\}/)
    assert.ok(dict['atelier.kind.proposed.body'] && dict['atelier.kind.activated.body'] && dict['nset.row.atelier'])
  }
})
