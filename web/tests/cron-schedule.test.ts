// Unit tests of the schedule presets (src/features/crons/schedule). Run: npm test (plain Node, no dependency).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PRESET, fromPreset, isReboot, toPreset } from '../src/features/crons/schedule'

test('@reboot is its own preset, kept as written', () => {
  assert.equal(toPreset('@reboot').kind, 'reboot')
  assert.equal(toPreset(' @REBOOT ').kind, 'reboot')
  assert.equal(fromPreset({ ...DEFAULT_PRESET, kind: 'reboot' }), '@reboot')
  assert.ok(isReboot('@Reboot') && !isReboot('@daily') && !isReboot('0 7 * * *'))
  // the other presets keep their values when leaving @reboot
  const back = toPreset('@reboot', { ...DEFAULT_PRESET, hour: 9, minute: 30 })
  assert.equal(fromPreset({ ...back, kind: 'daily' }), '30 9 * * *')
})
