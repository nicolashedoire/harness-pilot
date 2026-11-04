// The dashboard reached by /?widget=<id> (the Atelier's "Open", a creation's href): the card is scrolled to and ringed
// for a moment, then the parameter leaves the URL; a hidden widget is not ringed.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { useLocation } from 'react-router'
import DashboardPage from '@/pages/dashboard'
import { mockApi, renderApp } from './render'

const widget = (id: string, title: string, extra: object = {}) => ({
  id, title, icon: 'puzzle', span: 1, source: 'extension', error: null, hidden: false,
  card: { title, blocks: [{ type: 'markdown', text: `${title} body` }], updated: Date.now() / 1000 }, ...extra,
})
const WIDGETS = [widget('server', 'Server'), widget('shop-sales', 'Shop sales'), widget('notes', 'Notes', { hidden: true, card: null })]

function Where() {
  const loc = useLocation()
  return <output data-testid="where">{loc.search}</output>
}
const open = (search: string) => {
  mockApi({ 'GET /api/dashboard': { widgets: WIDGETS }, 'GET /api/feed': { events: [], more: false, unread: 0, pending: 0 } })
  renderApp(
    <>
      <DashboardPage />
      <Where />
    </>,
    { path: `/${search}`, route: '/' },
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Dashboard link to a widget', () => {
  test('scrolls to the card, rings it, then leaves the URL clean', async () => {
    const scrolled: string[] = []
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
      scrolled.push(this.getAttribute('data-widget') || '')
    })
    open('?widget=shop-sales')
    const card = (await screen.findByText('Shop sales body')).closest('[data-widget]') as HTMLElement
    expect(card.getAttribute('data-widget')).toBe('shop-sales')
    await waitFor(() => expect(within(card).getByTestId('widget-highlight')).toBeTruthy())
    expect(scrolled).toEqual(['shop-sales'])
    // only that card
    expect(screen.getAllByTestId('widget-highlight')).toHaveLength(1)
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(''))
  })

  test('a hidden widget is not ringed (a toast says it is hidden) and the parameter goes', async () => {
    open('?widget=notes')
    await screen.findByText('Server body')
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(''))
    expect(screen.queryByTestId('widget-highlight')).toBeNull()
  })

  test('without the parameter nothing is ringed', async () => {
    open('')
    await screen.findByText('Server body')
    expect(screen.queryByTestId('widget-highlight')).toBeNull()
  })
})
