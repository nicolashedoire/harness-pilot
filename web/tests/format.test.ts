// Unit tests of the formatting helpers (src/lib/format). Run: npm test (plain Node, no dependency).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtClockTimes, fmtDate, fmtQuantity } from '../src/lib/format'

const plain = (s: string) => s.replace(/[  ]/g, ' ')

test('schedule times follow the language, like the dates next to them', () => {
  assert.equal(plain(fmtClockTimes('every day at 04:40', 'en')), 'every day at 4:40 AM')
  assert.equal(plain(fmtClockTimes('every day at 06:00 and 18:00', 'en')), 'every day at 6:00 AM and 6:00 PM')
  assert.equal(fmtClockTimes('every day at 04:40', 'fr'), 'every day at 04:40')
  assert.equal(fmtClockTimes('at 00:00 on the 1st of the month', 'fr'), 'at 00:00 on the 1st of the month')
  // the same clock as a next run formatted for the same language and zone
  const at = Date.UTC(2026, 10, 5, 3, 40) / 1000 // 04:40 in Paris
  const time = fmtDate(at, 'en', 'Europe/Paris', { dateStyle: undefined, timeStyle: 'short' })
  assert.equal(fmtClockTimes('04:40', 'en'), time)
})

test('only whole HH:MM times are rewritten', () => {
  for (const s of ['every 6 hours at :00', 'every minute during hours 04 and 05', 'every hour at minute 15', 'Custom schedule (40 4 * * *)', '24:00', '123:45'])
    assert.equal(fmtClockTimes(s, 'en'), s)
})

test('block figures follow the language, units and percentages included', () => {
  const en = (n: number, unit?: string | null, signed?: boolean) => plain(fmtQuantity(n, 'en', unit, signed))
  const fr = (n: number, unit?: string | null, signed?: boolean) => plain(fmtQuantity(n, 'fr', unit, signed))
  assert.deepEqual([en(12480, '€'), en(40.25, '€'), en(3120), en(64, '%'), en(32, '%', true), en(-4, '%', true), en(2, null, true), en(0, null, true)],
    ['12,480 €', '40.25 €', '3,120', '64%', '+32%', '-4%', '+2', '0'])
  assert.deepEqual([fr(12480, '€'), fr(40.25, '€'), fr(3120), fr(64, '%'), fr(32, '%', true)], ['12 480 €', '40,25 €', '3 120', '64 %', '+32 %'])
  assert.ok(fmtQuantity(12480, 'en', '€').includes('\u00a0€'), 'the unit never wraps away from its number')
})
