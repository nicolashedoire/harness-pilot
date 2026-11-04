// Before every component test file: English dictionaries loaded (core + every group, so no text is blank while a
// chunk downloads), the DOM emptied after each test, and no request leaves the test (fetch answers 404 unless a test
// replaces it with `mockApi`).
import { afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { loadGroups, loadLanguage } from '@/i18n'
import { GROUPS, type Group } from '@/i18n/groups'
import { useUI } from '@/stores/ui'

beforeAll(async () => {
  useUI.setState({ language: 'en' })
  await loadLanguage('en')
  await loadGroups(Object.keys(GROUPS) as Group[])
})

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'not_found', message: 'No route in this test' }), { status: 404, headers: { 'Content-Type': 'application/json' } }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
