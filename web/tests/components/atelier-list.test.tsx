// The Atelier list (pages/atelier/List.tsx): drafts on top with the banner, the kind chips and their counts, the text
// filter, the next action of each state, and the loading, empty and error states.
import { describe, expect, test } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { AtelierList } from '@/pages/atelier/List'
import { mockApi, renderApp } from './render'

const now = Date.now() / 1000
const origin = (title: string, agent = 'claude', ago = 600) => ({ agent, session_id: `s_${title.length}`, session_title: title, at: now - ago })
const item = (id: string, kind: string, name: string, state: string, extra: object = {}) => ({
  id,
  kind,
  name,
  description: `${name} description`,
  state,
  version: 1,
  origin: origin('Sales widget', 'claude'),
  draft_id: null,
  ...extra,
})
const ITEMS = [
  item('shop-sales', 'widget', 'Shop sales', 'active', { version: 3 }),
  item('d_weather', 'widget', 'Weather', 'draft', { draft_id: 'd_weather', origin: origin('Morning card', 'codex', 720) }),
  item('notes', 'page', 'Notes', 'error', { version: 2 }),
  item('ember', 'theme', 'Ember', 'applied'),
  item('d_map', 'block', 'Map', 'draft', { draft_id: 'd_map', origin: origin('Trip planner', 'claude', 300) }),
  item('telegram-format', 'customization', 'Telegram format', 'review'),
]

const show = (items: unknown[] = ITEMS, path = '/atelier') => {
  const calls = mockApi({ 'GET /api/atelier': { items } })
  renderApp(<AtelierList />, { path, route: '/atelier' })
  return calls
}

describe('Atelier list', () => {
  test('says how many creations wait, names them, and Review opens the oldest', async () => {
    show()
    const banner = await screen.findByTestId('atelier-pending')
    expect(within(banner).getByText('2 creations are waiting for your approval')).toBeTruthy()
    expect(within(banner).getByText('Weather · Map')).toBeTruthy()
    expect(within(banner).getByRole('link', { name: 'Review' }).getAttribute('href')).toBe('/atelier/drafts/d_weather')
  })

  test('lists drafts first, then what is broken, each with its next action', async () => {
    show()
    const table = await screen.findByRole('table', { name: 'Studio' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['draft', 'draft', 'error', 'review', 'applied', 'active'])
    expect(within(rows[0]).getByText('To approve')).toBeTruthy()
    expect(within(rows[0]).getByRole('link', { name: 'Review' })).toBeTruthy()
    expect(within(rows[2]).getByRole('link', { name: 'Get it fixed' }).getAttribute('href')).toBe('/atelier/page/notes')
    expect(within(rows[3]).getByRole('link', { name: 'See the conflict' })).toBeTruthy()
    expect(within(rows[3]).getByText('Review after the update')).toBeTruthy()
    expect(within(rows[5]).getByRole('button', { name: 'More actions for Shop sales' })).toBeTruthy()
    expect(within(rows[5]).getByText('v3')).toBeTruthy()
  })

  test('the kind chips count and filter, the text filter narrows by name or session', async () => {
    show()
    const chips = await screen.findByRole('group', { name: 'Filter by kind' })
    expect(within(chips).getByRole('button', { name: 'All 6' })).toBeTruthy()
    const widgets = within(chips).getByRole('button', { name: 'Widgets 2' })
    expect(within(chips).getByRole('button', { name: 'Skills 0' })).toBeTruthy()
    fireEvent.click(widgets)
    await waitFor(() => expect(widgets.getAttribute('aria-pressed')).toBe('true'))
    const table = screen.getByRole('table', { name: 'Studio' })
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter' }), { target: { value: 'morning' } })
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2))
    expect(within(table).getByText('Weather')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter' }), { target: { value: 'nothing like it' } })
    expect(await screen.findByText('Nothing matches')).toBeTruthy()
  })

  test('starts on the kind given in the URL', async () => {
    show(ITEMS, '/atelier?kind=theme')
    const table = await screen.findByRole('table', { name: 'Studio' })
    expect(within(table).getAllByRole('row')).toHaveLength(2)
    expect(within(table).getByText('Ember')).toBeTruthy()
    expect(screen.queryByTestId('atelier-pending')).toBeTruthy() // the banner still counts every draft
  })

  test('nothing yet: says so, and offers to create with an agent in the harness topic', async () => {
    show([])
    expect(await screen.findByText('Nothing created yet')).toBeTruthy()
    expect(screen.queryByTestId('atelier-pending')).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Create with an agent' }).at(-1)!)
    expect(await screen.findByTestId('elsewhere')).toBeTruthy()
  })

  test('a load error shows the reason and Retry asks again', async () => {
    let n = 0
    const calls = mockApi({})
    renderApp(<AtelierList />, { path: '/atelier', route: '/atelier' })
    expect(await screen.findByText('The Studio could not be loaded')).toBeTruthy()
    mockApi({ 'GET /api/atelier': () => (n++, { items: ITEMS }) })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('table', { name: 'Studio' })).toBeTruthy()
    expect(n).toBe(1)
    expect(calls.length).toBeGreaterThan(0)
  })

  test('shows a skeleton while loading', () => {
    mockApi({ 'GET /api/atelier': () => new Promise(() => {}) })
    const { container } = renderApp(<AtelierList />, { path: '/atelier', route: '/atelier' })
    expect(container.querySelector('[aria-busy]')).toBeTruthy()
  })
})
