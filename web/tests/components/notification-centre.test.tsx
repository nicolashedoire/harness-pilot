// The notifications centre (features/notifications/NotificationCenter.tsx): "To handle" above the activity, the type
// filter, mark all read, the empty state, closing, the link to the full page.
import { describe, expect, test } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import NotificationCenter from '@/features/notifications/NotificationCenter'
import { useNotificationCenter } from '@/features/notifications/store'
import { mockApi, renderApp } from './render'

const now = Date.now() / 1000
const ev = (id: number, source: string, level: string, title: string, extra: object = {}) =>
  ({ id, at: now - id * 60, source, level, title, body: '', url: '', count: 1, read: false, ...extra })
const EVENTS = [
  ev(1, 'crons', 'error', 'Nightly backup failed', { pending: true }),
  ev(2, 'sessions', 'success', 'Draft finished'),
  ev(3, 'security', 'info', 'Signed in', { read: true }),
]
const feed = (events: typeof EVENTS, unread: number) => ({
  'GET /api/feed': (_: unknown, url: URL) => {
    const cat = url.searchParams.get('category'), pending = url.searchParams.get('pending')
    const list = events.filter((e) => (!pending || e.pending) && (!cat || { crons: 'crons', sessions: 'sessions', security: 'system' }[e.source] === cat))
    return { events: list, more: false, unread, pending: events.filter((e) => e.pending).length }
  },
  'GET /api/feed/summary': { unread, pending: events.filter((e) => e.pending).length },
  'POST /api/feed/read': { unread: 0, pending: 0 },
})
const open = () => {
  useNotificationCenter.setState({ open: true })
  renderApp(<NotificationCenter />, { route: '/' })
  return screen.findByRole('dialog', { name: 'Notifications' })
}

describe('Notifications centre', () => {
  test('puts what needs handling on top, then the activity, each once', async () => {
    mockApi(feed(EVENTS, 2))
    const d = await open()
    await within(d).findByText('Nightly backup failed')
    const titles = within(d).getAllByText(/Nightly backup failed|Draft finished|Signed in/).map((x) => x.textContent)
    expect(titles).toEqual(['Nightly backup failed', 'Draft finished', 'Signed in'])
    expect(within(d).getByText('To handle')).toBeTruthy()
  })

  test('the type filter asks the server for that category only', async () => {
    const calls = mockApi(feed(EVENTS, 2))
    const d = await open()
    await within(d).findByText('Draft finished')
    const chip = within(within(d).getByRole('group', { name: 'Filter the notifications' })).getByRole('button', { name: 'Crons' })
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(await within(d).findByText('Nightly backup failed')).toBeTruthy()
    expect(within(d).queryByText('Draft finished')).toBeNull()
    expect(calls.some((c) => c.path === '/api/feed' && c.query.get('category') === 'crons')).toBe(true)
  })

  test('Mark all as read posts once, and is off when nothing is unread', async () => {
    const calls = mockApi(feed(EVENTS, 2))
    const d = await open()
    const btn = within(d).getByRole('button', { name: 'Mark all as read' })
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(btn)
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/feed/read')).toHaveLength(1))
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ all: true })
  })

  test('says so when there is nothing yet', async () => {
    mockApi(feed([], 0))
    const d = await open()
    expect(await within(d).findByText('Nothing yet')).toBeTruthy()
    expect((within(d).getByRole('button', { name: 'Mark all as read' }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('closes with its button', async () => {
    mockApi(feed(EVENTS, 2))
    const d = await open()
    fireEvent.click(within(d).getByRole('button', { name: 'Close the notifications' }))
    expect(useNotificationCenter.getState().open).toBe(false)
  })

  test('See all notifications closes it and opens the full page', async () => {
    mockApi(feed(EVENTS, 2))
    const d = await open()
    fireEvent.click(within(d).getByRole('button', { name: 'See all notifications' }))
    expect(useNotificationCenter.getState().open).toBe(false)
    expect(await screen.findByTestId('elsewhere')).toBeTruthy() // routed to /notifications
  })
})
