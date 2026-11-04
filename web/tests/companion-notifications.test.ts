import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserOn, PREF_ROWS, pushPrefs, soundDefault } from '../src/features/notifications/prefs'

test('companion reviews have a visible preference row and audible push defaults', () => {
  const row = PREF_ROWS.find((item) => item.id === 'companions')!
  assert.ok(row)
  for (const kind of ['companion.ready', 'companion.error', 'mission.review']) {
    assert.ok(row.kinds.includes(kind))
    assert.equal(browserOn({}, { kind, source: 'system', level: 'warning' }), true)
    assert.equal(soundDefault(kind, 'warning'), true)
    assert.deepEqual(pushPrefs({}, {}, 'chime').kinds[kind], { enabled: true, sound: true })
    assert.deepEqual(pushPrefs(Object.fromEntries(row.kinds.map((item) => [item, false])), {}, 'chime').kinds[kind], { enabled: false, sound: false })
    assert.equal(pushPrefs({}, {}, 'none').kinds[kind].sound, false)
  }
})
