// Interface texts go through i18n: no literal accessible names in the components, and the browser's own
// "server could not be reached" error follows the language. Run: npm test (plain Node, no dependency).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ApiError, errorMessage, onLocalErrorText } from '../src/lib/api'
import { en } from '../src/i18n/en'
import { fr } from '../src/i18n/fr'

const SRC = new URL('../src/', import.meta.url).pathname
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith('.tsx') ? [join(dir, n)] : []))
// names, not words: the same in every language
const NAMES = new Set(['GitHub', 'harness-pilot', 'Emoji'])

test('accessible names and screen-reader texts are translated', () => {
  const found: string[] = []
  for (const f of files(SRC)) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\b(aria-label|title|alt)=(["'])([^"'{}]*[A-Za-z]{2,}[^"'{}]*)\2/g))
        if (!NAMES.has(m[3])) found.push(`${f.slice(SRC.length)}:${i + 1} ${m[1]}="${m[3]}"`)
      for (const m of line.matchAll(/sr-only[^>]*>\s*([A-Za-z][^<{]*)</g)) found.push(`${f.slice(SRC.length)}:${i + 1} sr-only "${m[1]}"`)
    })
  }
  assert.deepEqual(found, [], 'use t() for these texts')
})

test('a network error raised in the browser is worded in the UI language', () => {
  const network = new ApiError(0, 'network', 'Network error — the server could not be reached.')
  const server = new ApiError(404, 'not_found', 'no job c_1')
  assert.equal(errorMessage(network), 'Network error — the server could not be reached.', 'English until the app registers its words')
  onLocalErrorText((code) => (code === 'network' ? fr['common.networkError'] : undefined))
  assert.equal(errorMessage(network), 'Erreur réseau : le serveur est injoignable.')
  assert.equal(errorMessage(server), 'no job c_1', 'server messages are untouched')
  assert.equal(errorMessage(new ApiError(0, 'other')), 'other')
  assert.ok(en['common.networkError'])
})
