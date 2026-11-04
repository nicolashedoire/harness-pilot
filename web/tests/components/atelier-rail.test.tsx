// The Atelier's rail entry (components/shell/AtelierNav.tsx): how many proposals wait, read from the feed's
// `atelier.proposed` rows that are not resolved - asked only once the browser is idle, never on the first paint.
import { describe, expect, test } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { AtelierNavItem } from '@/components/shell/AtelierNav'
import { ATELIER_NAV } from '@/components/shell/nav'
import { mockApi, renderApp } from './render'

const now = Date.now() / 1000
const ev = (id: number, kind: string, resolved: number | null = null) => ({
  id, at: now - id * 60, source: 'system', level: 'warning', title: 't', body: '', url: '', count: 1, read: false, kind, params: {}, actions: [],
  category: 'system', pending: !resolved, resolved_at: resolved, first_at: now - id * 60, quiet: false,
})
const FEED = { events: [ev(1, 'atelier.proposed'), ev(2, 'atelier.proposed'), ev(3, 'atelier.proposed', now - 30), ev(4, 'cron.failed')], more: false, unread: 4, pending: 3 }

const rail = (collapsed = false) => {
  const calls = mockApi({ 'GET /api/feed': FEED })
  renderApp(<AtelierNavItem item={ATELIER_NAV} collapsed={collapsed} active={false} prefetch={{}} />)
  return calls
}

describe('Atelier rail entry', () => {
  test('counts the proposals still waiting, once the browser is idle', async () => {
    const calls = rail()
    // nothing asked on the first paint
    expect(calls.filter((c) => c.path === '/api/feed')).toHaveLength(0)
    expect(await screen.findByText('2', {}, { timeout: 4000 })).toBeTruthy()
    const call = calls.find((c) => c.path === '/api/feed')!
    expect(call.query.get('kind')).toBe('atelier.proposed')
    expect(screen.getByRole('link').textContent).toContain('2 to approve') // the accessible count
  })

  test('the folded rail shows a dot instead', async () => {
    rail(true)
    await waitFor(() => expect(document.querySelector('.bg-draft')).toBeTruthy(), { timeout: 4000 })
    expect(screen.queryByText('2')).toBeNull()
  })

  test('nothing waits: no counter', async () => {
    mockApi({ 'GET /api/feed': { ...FEED, events: [ev(3, 'atelier.proposed', now - 30)] } })
    renderApp(<AtelierNavItem item={ATELIER_NAV} collapsed={false} active={false} prefetch={{}} />)
    await new Promise((r) => setTimeout(r, 1500))
    expect(screen.getByRole('link').textContent).toBe('Studio')
  })
})
