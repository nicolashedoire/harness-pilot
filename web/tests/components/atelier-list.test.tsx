// The Atelier list (pages/atelier/List.tsx, GET /api/atelier): the drafts waiting on top with the banner, the type chips
// and their counts, the text filter, the next action of each state, the row menu, and the loading, empty and error
// states.
import { describe, expect, test } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { AtelierList } from '@/pages/atelier/List'
import { mockApi, renderApp } from './render'

const now = Date.now() / 1000
const origin = (title: string | null, agent = 'claude', ago = 600, summary: string | null = null) => ({
  agent,
  session: title ? `s_${title.length}` : null,
  session_title: title,
  session_path: title ? 'projects/acme/topics/blog' : null,
  at: now - ago,
  summary,
})
const item = (kind: string, id: string, type: string, name: string, state: string, extra: object = {}) => ({
  kind, id, type, name, icon: null, state, version: 1, version_label: null, versions: 1, pending: null, unreviewed: false,
  unreviewed_since: null, origin: origin('Sales widget', 'claude', 3600, `${name} does things`), approval: { by: 'user', at: now - 3600 },
  error: null, updated: now, href: null, actions: [], ...extra,
})
const weatherFrom = origin('Morning card', 'codex', 720, 'Today and the next three days')
// in the server's order: drafts, broken, to review, changed outside, the rest
const ITEMS = [
  item('extension', 'weather', 'html_widget', 'Weather', 'pending', { version: null, versions: 0, origin: weatherFrom, pending: { draft: 'd_weather', at: now - 720, change: 'new', origin: weatherFrom }, actions: ['approve', 'reject', 'request_change'] }),
  item('extension', 'shop-sales', 'widget', 'Shop sales', 'active', { version: 3, pending: { draft: 'd_refunds', at: now - 300, change: 'update', origin: origin('Refunds', 'claude', 300, 'Adds the refunds') }, actions: ['approve', 'reject', 'request_change', 'rollback', 'disable'] }),
  item('extension', 'notes', 'page', 'Notes', 'error', { version: 2, error: { message: 'TypeError: x is undefined', where: 'page', at: now - 60, count: 2 }, href: '/x/notes', actions: ['rollback', 'disable'] }),
  item('customization', 'c-1', 'customization', 'Telegram threads limit', 'review', { version: null, href: '/settings/updates' }),
  item('extension', 'trip-map', 'block', 'Trip map', 'active', { unreviewed: true, actions: ['rollback', 'accept', 'disable'], href: '/ext/trip-map' }),
  item('theme', 'ember', 'theme', 'Ember', 'active', { version: null, href: '/settings/appearance' }),
  item('extension', 'clock', 'widget', 'Server clock', 'disabled', { origin: origin(null, 'unknown'), actions: ['rollback', 'enable'] }),
]
const COUNTS = { pending: 2, error: 1, unreviewed: 1, review: 1, disabled: 1, total: ITEMS.length }

const show = (items: unknown[] = ITEMS, path = '/atelier', extra: Record<string, unknown> = {}) => {
  const calls = mockApi({ 'GET /api/atelier': { items, counts: COUNTS }, ...extra })
  renderApp(<AtelierList />, { path, route: '/atelier' })
  return calls
}
const table = () => screen.findByRole('table', { name: 'Studio' })
const rows = async () => within(await table()).getAllByRole('row').slice(1)

describe('Atelier list', () => {
  test('says how many creations wait, names them, and Review opens the first draft', async () => {
    show()
    const banner = await screen.findByTestId('atelier-pending')
    expect(within(banner).getByText('2 creations are waiting for your approval')).toBeTruthy()
    expect(within(banner).getByText('Weather · Shop sales')).toBeTruthy()
    expect(within(banner).getByRole('link', { name: 'Review' }).getAttribute('href')).toBe('/atelier/drafts/d_weather')
  })

  test('each row shows its state, what it does, where it comes from and its next action', async () => {
    show()
    const r = await rows()
    expect(r.map((x) => x.getAttribute('data-state'))).toEqual(['pending', 'pending', 'error', 'review', 'active', 'applied', 'disabled'])
    // a new draft and an update of an active widget both wait: To approve, the draft's own summary and origin
    expect(within(r[0]).getByText('To approve')).toBeTruthy()
    expect(within(r[0]).getByText('Today and the next three days')).toBeTruthy()
    expect(within(r[0]).getByRole('link', { name: 'Morning card' }).getAttribute('href')).toBe('/sessions?path=projects%2Facme%2Ftopics%2Fblog&session=s_12')
    expect(within(r[1]).getByRole('link', { name: 'Review' }).getAttribute('href')).toBe('/atelier/drafts/d_refunds')
    expect(within(r[1]).getByText('Adds the refunds')).toBeTruthy()
    expect(within(r[1]).getByText('v3')).toBeTruthy()
    // broken: the error instead of the summary, Get it fixed opens its page
    expect(within(r[2]).getByText('TypeError: x is undefined')).toBeTruthy()
    expect(within(r[2]).getByRole('link', { name: 'Get it fixed' }).getAttribute('href')).toBe('/atelier/extension/notes')
    // a customization in conflict after an update: where the update explains it
    expect(within(r[3]).getByText('Review after the update')).toBeTruthy()
    expect(within(r[3]).getByRole('link', { name: 'See the conflict' }).getAttribute('href')).toBe('/settings/updates')
    expect(within(r[4]).getByText('Changed outside')).toBeTruthy()
    expect(within(r[5]).getByText('Applied')).toBeTruthy()
    expect(within(r[6]).getByText('Origin unknown')).toBeTruthy()
  })

  test('the row menu opens the creation where it lives and turns it off at once', async () => {
    let patched: unknown = null
    // the request never answers: what shows is the optimistic change
    const calls = show(ITEMS, '/atelier', { 'PATCH /api/extensions/trip-map': (b: unknown) => ((patched = b), new Promise(() => {})) })
    const r = await rows()
    fireEvent.pointerDown(within(r[4]).getByRole('button', { name: 'More actions for Trip map' }), { button: 0, ctrlKey: false })
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'Open' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Ask for a change' })).toBeTruthy()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Disable' }))
    await waitFor(() => expect(patched).toEqual({ enabled: false }))
    expect(calls.some((c) => c.method === 'PATCH' && c.path === '/api/extensions/trip-map')).toBe(true)
    await waitFor(async () => expect(within((await rows())[4]).getByText('Disabled')).toBeTruthy())
  })

  test('the type chips count and filter, the text filter narrows by name, summary or session', async () => {
    show()
    const chips = await screen.findByRole('group', { name: 'Filter by type' })
    expect(within(chips).getByRole('button', { name: 'All 7' })).toBeTruthy()
    expect(within(chips).getByRole('button', { name: 'Skills 0' })).toBeTruthy()
    expect(within(chips).queryByRole('button', { name: /Crons/ })).toBeNull() // only when there are some
    const widgets = within(chips).getByRole('button', { name: 'Widgets 3' })
    fireEvent.click(widgets)
    await waitFor(() => expect(widgets.getAttribute('aria-pressed')).toBe('true'))
    expect(await rows()).toHaveLength(3)
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter' }), { target: { value: 'morning' } })
    await waitFor(async () => expect(await rows()).toHaveLength(1))
    expect(within(await table()).getByText('Weather')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter' }), { target: { value: 'nothing like it' } })
    expect(await screen.findByText('Nothing matches')).toBeTruthy()
  })

  test('starts on the filter given in the URL; the banner still counts every draft', async () => {
    show(ITEMS, '/atelier?show=themes')
    expect(await rows()).toHaveLength(1)
    expect(within(await table()).getByText('Ember')).toBeTruthy()
    expect(screen.getByTestId('atelier-pending')).toBeTruthy()
  })

  test('nothing yet: says so, and Create with an agent opens a new session in the harness topic', async () => {
    show([])
    expect(await screen.findByText('Nothing created yet')).toBeTruthy()
    expect(screen.queryByTestId('atelier-pending')).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Create with an agent' }).at(-1)!)
    expect(await screen.findByTestId('elsewhere')).toBeTruthy()
  })

  test('a load error shows the reason, and Retry asks again', async () => {
    mockApi({})
    renderApp(<AtelierList />, { path: '/atelier', route: '/atelier' })
    expect(await screen.findByText('The Studio could not be loaded')).toBeTruthy()
    let n = 0
    mockApi({ 'GET /api/atelier': () => (n++, { items: ITEMS, counts: COUNTS }) })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await table()).toBeTruthy()
    expect(n).toBe(1)
  })

  test('shows a skeleton while loading', () => {
    mockApi({ 'GET /api/atelier': () => new Promise(() => {}) })
    const { container } = renderApp(<AtelierList />, { path: '/atelier', route: '/atelier' })
    expect(container.querySelector('[aria-busy]')).toBeTruthy()
  })
})
