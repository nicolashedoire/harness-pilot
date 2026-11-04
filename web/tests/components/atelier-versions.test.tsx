// A creation's page (pages/atelier/Detail.tsx, GET /api/atelier/{kind}/{id}): the versions timeline (active one,
// health, approval, Changes, Back here -> rollback after a confirmation), the broken state (error, stack, Ask for a
// fix, back to the last version that worked), files changed outside (accept), a read-only kind, and the list's History.
import { describe, expect, test } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { CreationDetail } from '@/pages/atelier/Detail'
import { HistorySheet } from '@/pages/atelier/History'
import { ConfirmHost } from '@/components/ui'
import { mockApi, renderApp } from './render'

const now = Date.now() / 1000
const DAY = 86400
const origin = (agent: string, title: string | null, summary: string | null, at: number) => ({
  agent,
  session: title ? `s_${title.length}` : null,
  session_title: title,
  session_path: title ? 'projects/acme/topics/blog' : null,
  at,
  summary,
})
const version = (n: number, extra: object = {}) => ({
  n, at: now - (5 - n) * DAY, active: false, origin: origin('claude', 'Shop card', `Summary of v${n}`, now - (5 - n) * DAY), approval: { by: 'user', at: now - (5 - n) * DAY },
  base: n > 1 ? n - 1 : null, files: 2, size: 1200, hash: `h${n}`, restorable: true, health: 'ok', error: null, note: null, ...extra,
})
const item = (extra: object = {}) => ({
  kind: 'extension', id: 'shop-sales', type: 'widget', name: 'Shop sales', icon: 'shopping-cart', state: 'active', version: 4, version_label: '1.3', versions: 4,
  pending: null, unreviewed: false, unreviewed_since: null, origin: origin('claude', 'Shop card', 'Adds the revenue next to the orders.', now - DAY),
  approval: { by: 'user', at: now - DAY }, error: null, updated: now - DAY, href: '/?widget=shop-sales', actions: ['rollback', 'disable'], ...extra,
})
const VERSIONS = [
  version(4, { active: true, health: 'unknown' }),
  version(3),
  version(2, { health: 'error', error: { message: "KeyError: 'orders'", where: 'card', at: now - 3 * DAY, count: 3 } }),
  version(1, { origin: origin('unknown', null, null, now - 30 * DAY), approval: { by: 'migration', at: now - 30 * DAY }, note: 'existed before the Atelier', restorable: false }),
]
const detail = (it: object = {}, extra: object = {}) => ({
  item: item(it),
  versions: VERSIONS,
  history: [
    { at: now - DAY, action: 'approve', version: 4, draft: 'd_4', by: 'user', note: null },
    { at: now - 30 * DAY, action: 'migrate', version: 1, draft: null, by: 'system', note: null },
  ],
  drafts: [],
  files: [{ path: 'api.py', size: 1210 }, { path: 'manifest.json', size: 142 }],
  permissions: { network: ['acme.example.com'], secrets: [], read: [], declared: true },
  health: { state: 'active', error: null, errors: [], checked_at: now },
  ...extra,
})

const open = (routes: Record<string, unknown>, path = '/atelier/extension/shop-sales') => {
  const calls = mockApi({ 'GET /api/extensions': [], 'GET /api/atelier/settings': { auto_activate_safe: false, keep_days: 90, keep_versions: 10 }, ...routes })
  renderApp(
    <>
      <CreationDetail />
      <ConfirmHost />
    </>,
    { path, route: '/atelier/:kind/:id' },
  )
  return calls
}
/** Clicks the confirm button of the confirmation dialog (ConfirmHost). */
const confirmWith = async (label: string) => {
  const d = await screen.findByRole('alertdialog')
  fireEvent.click(within(d).getByRole('button', { name: label }))
}
const timeline = () => screen.findByRole('list', { name: 'Versions' })

describe('Atelier creation and versions', () => {
  test('the timeline marks the active version, says how each one was approved and whether it worked', async () => {
    open({ 'GET /api/atelier/extension/shop-sales': detail() })
    expect(await screen.findByRole('heading', { name: 'Shop sales', level: 2 })).toBeTruthy()
    const list = await timeline()
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['atelier-version-4', 'atelier-version-3', 'atelier-version-2', 'atelier-version-1'])
    expect(rows[0].getAttribute('data-active')).toBe('true')
    expect(within(rows[0]).getByText('Active')).toBeTruthy()
    expect(within(rows[0]).queryByRole('button', { name: 'Back here' })).toBeNull()
    expect(within(rows[1]).getByText('Worked')).toBeTruthy()
    expect(within(rows[1]).getByText('Summary of v3')).toBeTruthy()
    expect(within(rows[1]).getByText('approved by you')).toBeTruthy()
    expect(within(rows[2]).getByText('Broke while active')).toBeTruthy()
    expect(within(rows[3]).getByText('existed before the Studio')).toBeTruthy()
    expect(within(rows[3]).getByText('Files not kept')).toBeTruthy() // not restorable: no Back here
    // retention from the settings
    expect(await screen.findByText(/Every version is kept 90 days, and the 10 newest always\./)).toBeTruthy()
    // the history, folded
    expect(screen.getByText('History (2)')).toBeTruthy()
  })

  test('Changes shows what a version changed against the one before', async () => {
    open({
      'GET /api/atelier/extension/shop-sales': detail(),
      'GET /api/atelier/extension/shop-sales/versions/3': {
        version: version(3),
        against: 2,
        files: [{ path: 'api.py', status: 'changed', size: 905, old_size: 820, binary: false, diff: '--- a/api.py\n+++ b/api.py\n@@ -1,1 +1,1 @@\n-old line\n+new line\n', truncated: false }],
      },
    })
    const rows = within(await timeline()).getAllByRole('listitem')
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Changes' }))
    const dialog = await screen.findByRole('dialog', { name: 'Changes of v3' })
    expect(await within(dialog).findByText('new line')).toBeTruthy()
    expect(within(dialog).getByText(/Compared with v2/)).toBeTruthy()
  })

  test('Back here asks first, then rolls back to that version', async () => {
    let body: unknown = null
    const calls = open({
      'GET /api/atelier/extension/shop-sales': detail(),
      'POST /api/atelier/extension/shop-sales/rollback': (b: unknown) => ((body = b), { ok: true, item: item({ version: 3 }), version: 3 }),
    })
    const rows = within(await timeline()).getAllByRole('listitem')
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Back here' }))
    await confirmWith('Go back to v3')
    await waitFor(() => expect(body).toEqual({ version: 3 }))
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  test('a broken creation shows its error with the stack, Ask for a fix, and goes back to the last version that worked', async () => {
    let body: unknown = null
    open({
      'GET /api/atelier/extension/shop-sales': detail({ state: 'error', error: { message: 'TypeError: x is undefined', where: 'widget', at: now - 60, count: 2 } }),
      'GET /api/extensions': [{ id: 'shop-sales', name: 'Shop sales', type: 'widget', icon: 'shopping-cart', version: '1.3', enabled: true, error: null, has_api: true, pinned: false, page_v: 0, origin: { id: 's_9', title: 'Shop card', path: 'projects/acme/topics/blog' }, runtime_errors: [{ where: 'widget', message: 'TypeError: x is undefined', stack: 'TypeError: x is undefined\nat draw (widget.html:12:5)', at: now - 60, count: 2 }] }],
      'POST /api/atelier/extension/shop-sales/rollback': (b: unknown) => ((body = b), { ok: true, item: item(), version: 3 }),
    })
    const card = await screen.findByTestId('atelier-error')
    expect(within(card).getByText('It is broken')).toBeTruthy()
    expect(within(card).getByText(/failed in the dashboard while you used it/)).toBeTruthy()
    expect(within(card).getByText('TypeError: x is undefined')).toBeTruthy()
    // the stack without its first line (the message again)
    await waitFor(() => expect(within(card).getByText('at draw (widget.html:12:5)')).toBeTruthy())
    expect(within(card).getByRole('button', { name: 'Ask for a fix' })).toBeTruthy()
    expect(within(card).getByTestId('ext-fix-target').textContent).toContain('Shop card')
    fireEvent.click(within(card).getByRole('button', { name: 'Go back to v3' }))
    await confirmWith('Go back to v3')
    await waitFor(() => expect(body).toEqual({ version: 3 }))
  })

  test('files changed outside the Studio can be accepted as a version; a waiting draft links to its review', async () => {
    let accepted = false
    open({
      'GET /api/atelier/extension/shop-sales': detail({ unreviewed: true, unreviewed_since: now - 600, pending: { draft: 'd_next', at: now - 300, change: 'update', origin: origin('codex', 'Next', 'More', now - 300) } }),
      'POST /api/atelier/extension/shop-sales/accept': () => ((accepted = true), { ok: true, item: item(), version: 5 }),
    })
    expect(await screen.findByText('A new version waits for your approval.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Review' }).getAttribute('href')).toBe('/atelier/drafts/d_next')
    expect(screen.getByText('Its files changed outside the Studio since v4.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Accept the changes' }))
    await confirmWith('Accept the changes')
    await waitFor(() => expect(accepted).toBe(true))
  })

  test('next to what it declares: keys granted before permissions existed, reads refused, and Allow', async () => {
    let consent: unknown = null
    const access = {
      state: 'declared',
      secrets: [{ name: 'SHOP_TOKEN', status: 'pending', how: null, at: null }],
      legacy: { secrets: [{ name: 'OLD_KEY', at: now - DAY }] },
      pending: true,
      refused: false,
      denied: [{ kind: 'secret', name: 'SHOP_TOKEN', reason: 'not_allowed', at: now - 120, count: 3 }],
    }
    open({
      'GET /api/atelier/extension/shop-sales': detail(),
      'GET /api/extensions': [{ id: 'shop-sales', name: 'Shop sales', type: 'widget', icon: 'shopping-cart', version: '1.3', enabled: true, error: null, has_api: true, permissions: { network: [], secrets: ['SHOP_TOKEN'], read: [] }, access, runtime_errors: [], origin: null }],
      'POST /api/extensions/shop-sales/consent': (b: unknown) => ((consent = b), { ok: true }),
    })
    const block = await screen.findByTestId('atelier-access')
    expect(within(block).getByTestId('atelier-legacy').textContent).toContain('OLD_KEY')
    expect(within(block).getByText('Refused while it ran')).toBeTruthy()
    expect(within(block).getByText('waits for your permission')).toBeTruthy()
    expect(within(block).getByText(/3 times/)).toBeTruthy()
    fireEvent.click(within(block).getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(consent).toEqual({ decision: 'always' }))
  })

  test('a read-only kind says where it is managed, without versions nor rollback', async () => {
    open(
      {
        'GET /api/atelier/theme/th_1': {
          item: item({ kind: 'theme', id: 'th_1', type: 'theme', name: 'Harbour night', version: null, versions: 0, actions: [], href: '/settings/appearance' }),
          versions: [],
          history: [],
          drafts: [],
          files: [],
          permissions: null,
          health: { state: 'active', error: null, errors: [], checked_at: now },
        },
      },
      '/atelier/theme/th_1',
    )
    expect(await screen.findByText(/Themes are not versioned here/)).toBeTruthy()
    expect(screen.getByText('Applied')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy()
  })

  test('an unknown creation says so', async () => {
    open({}, '/atelier/extension/nope')
    expect(await screen.findByText('Nothing here')).toBeTruthy()
  })
})

describe('Atelier history', () => {
  test('lists the proposals of the last 30 days with their outcome', async () => {
    const d = (id: string, name: string, status: string, extra: object = {}) => ({
      id, kind: 'extension', target: id, name, type: 'widget', icon: null, status, change: 'new', base: null, created: now - 3600, origin: origin('claude', 'S', null, now - 3600),
      summary: null, permissions: { network: [], secrets: [], read: [], declared: true }, check: { status: 'ok', steps: [] }, files: { count: 1, size: 1, added: 1, changed: 0, removed: 0 },
      decided: null, superseded_by: null, change_requests: [], auto: false, ...extra,
    })
    const calls = mockApi({
      'GET /api/atelier/drafts': {
        drafts: [
          d('d_a', 'Weather', 'pending'),
          d('d_b', 'Shop sales', 'approved', { change: 'update', decided: { at: now - 60, by: 'user', version: 5 } }),
          d('d_c', 'Old map', 'rejected', { decided: { at: now - 120, by: 'user', reason: 'Not needed' } }),
        ],
      },
    })
    renderApp(<HistorySheet open onOpenChange={() => {}} />, { path: '/atelier', route: '/atelier' })
    const list = await screen.findByRole('list', { name: 'History' })
    const rows = within(list).getAllByRole('link')
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['pending', 'approved', 'rejected'])
    expect(within(rows[1]).getByText('Approved · v5')).toBeTruthy()
    expect(within(rows[2]).getByText('Not needed')).toBeTruthy()
    expect(rows[0].getAttribute('href')).toBe('/atelier/drafts/d_a')
    expect(calls.find((c) => c.path === '/api/atelier/drafts')!.query.get('status')).toBe('all')
  })
})
