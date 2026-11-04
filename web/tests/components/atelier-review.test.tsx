// The validation screen of a draft (pages/atelier/Review.tsx, GET /api/atelier/drafts/{id}): who proposed it, the
// preview run once with the real data, the check, what it asks for, the files and their diff, and the decisions:
// approve against the reviewed version (stale -> read it again), refuse with a reason, ask for a change.
import { describe, expect, test } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { DraftReview } from '@/pages/atelier/Review'
import { mockApi, renderApp } from './render'

const now = Date.now() / 1000
const draft = (extra: object = {}) => ({
  id: 'd_weather',
  kind: 'extension',
  target: 'weather',
  name: 'Weather',
  type: 'widget',
  icon: 'cloud-sun',
  status: 'pending',
  change: 'new',
  base: null,
  created: now - 720,
  origin: { agent: 'codex', session: 's_1', session_title: 'Morning card', session_path: 'projects/acme/topics/blog', at: now - 720, summary: 'Today and the next three days.' },
  summary: 'Today and the next three days for the office.',
  permissions: { network: ['api.open-meteo.com'], secrets: [], read: [], declared: true },
  check: { status: 'ok', steps: [{ step: 'manifest', status: 'ok', detail: '' }, { step: 'api.py', status: 'ok', detail: '' }] },
  files: { count: 3, size: 2048, added: 2, changed: 1, removed: 0 },
  decided: null,
  superseded_by: null,
  change_requests: [],
  auto: false,
  ...extra,
})
const FILES = [
  { path: 'manifest.json', status: 'added', size: 120, old_size: null, binary: false, diff: '--- /dev/null\n+++ b/manifest.json\n@@ -0,0 +1,2 @@\n+{"id": "weather",\n+ "name": "Weather"}\n', truncated: false },
  { path: 'api.py', status: 'changed', size: 900, old_size: 800, binary: false, diff: '--- a/api.py\n+++ b/api.py\n@@ -1,2 +1,2 @@\n def card(ctx):\n-    return {}\n+    return {"title": "Weather"}\n', truncated: false },
  { path: 'icon.png', status: 'added', size: 1028, old_size: null, binary: true, diff: null, truncated: false },
  { path: 'README.md', status: 'same', size: 40, old_size: 40, binary: false, diff: null, truncated: false },
]
const detail = (d: object = {}, extra: object = {}) => ({ draft: draft(d), files: FILES, active_version: null, stale: false, preview: 'card', ...extra })
const CARD = { kind: 'card', card: { title: 'Weather', blocks: [{ type: 'list', items: [{ title: 'Monday', value: '18°' }] }] }, error: null, trace: [] }

const open = (routes: Record<string, unknown>) => {
  const calls = mockApi({ 'GET /api/atelier': { items: [], counts: {} }, ...routes })
  renderApp(<DraftReview />, { path: '/atelier/drafts/d_weather', route: '/atelier/drafts/:id' })
  return calls
}

describe('Atelier validation screen', () => {
  test('says who proposed it, runs the preview once, and shows the check, the request and the files', async () => {
    const calls = open({ 'GET /api/atelier/drafts/d_weather': detail(), 'POST /api/atelier/drafts/d_weather/preview': CARD })
    expect(await screen.findByRole('heading', { name: 'Weather', level: 2 })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Where you are' }).textContent).toContain('To approve')
    expect(screen.getByText((_, el) => el?.tagName === 'P' && /^Proposed by Codex in “Morning card” · 12 min\. ago$/.test(el.textContent ?? ''))).toBeTruthy()
    expect(screen.getByRole('link', { name: '“Morning card”' }).getAttribute('href')).toBe('/sessions?path=projects%2Facme%2Ftopics%2Fblog&session=s_1')
    // the card as the dashboard draws it
    const preview = screen.getByTestId('atelier-preview')
    expect(await within(preview).findByText('Monday')).toBeTruthy()
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/preview'))).toHaveLength(1)
    expect(screen.getByTestId('atelier-check').getAttribute('data-status')).toBe('ok')
    expect(screen.getByText('Today and the next three days for the office.')).toBeTruthy()
    // what it asks for
    expect(within(screen.getByTestId('atelier-perm-network')).getByText('api.open-meteo.com')).toBeTruthy()
    expect(within(screen.getByTestId('atelier-perm-secrets')).getByText('None')).toBeTruthy()
    expect(screen.queryByTestId('atelier-undeclared')).toBeNull()
    // files: summary, the unchanged one folded, the first diff open, another one on click
    expect(screen.getByText('2 added, 1 changed')).toBeTruthy()
    const list = screen.getByRole('list', { name: 'Files' })
    expect(within(list).queryByText('README.md')).toBeNull()
    expect(within(screen.getByTestId('atelier-diff')).getByText('"name": "Weather"}')).toBeTruthy()
    fireEvent.click(within(list).getByRole('button', { name: /api\.py/ }))
    expect(within(screen.getByTestId('atelier-diff')).getByText('return {"title": "Weather"}')).toBeTruthy()
    fireEvent.click(within(list).getByRole('button', { name: /icon\.png/ }))
    expect(within(screen.getByTestId('atelier-diff')).getByText('Binary file: no preview of its content.')).toBeTruthy()
    fireEvent.click(within(list).getByRole('button', { name: '1 unchanged file' }))
    expect(within(list).getByText('README.md')).toBeTruthy()
  })

  test('approving sends the version the diff was read against, then goes on', async () => {
    let body: unknown = null
    const calls = open({
      'GET /api/atelier/drafts/d_weather': detail({ change: 'update', base: 3, type: 'widget' }, { active_version: 3 }),
      'POST /api/atelier/drafts/d_weather/preview': CARD,
      'POST /api/atelier/drafts/d_weather/approve': (b: unknown) => ((body = b), { ok: true, item: {}, version: 4 }),
    })
    expect(await screen.findByText('new version of v3')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Turn the new version on' })[0])
    await waitFor(() => expect(body).toEqual({ base: 3 }))
    expect(await screen.findByTestId('elsewhere')).toBeTruthy()
    expect(calls.some((c) => c.path === '/api/atelier/drafts/d_weather/approve')).toBe(true)
  })

  test('a stale approval is refused by the server: the draft is read again', async () => {
    let gets = 0
    open({
      'GET /api/atelier/drafts/d_weather': () => (gets++, detail({ change: 'update', base: 2 }, { active_version: 2 })),
      'POST /api/atelier/drafts/d_weather/preview': CARD,
    })
    await screen.findByText('new version of v2')
    // a 409 stale from the server
    const real = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/approve')
        ? new Response(JSON.stringify({ error: 'stale', message: 'Another version is active', active: 3, base: 2 }), { status: 409, headers: { 'Content-Type': 'application/json' } })
        : real(input, init)) as typeof fetch
    fireEvent.click(screen.getAllByRole('button', { name: 'Turn the new version on' })[0])
    await waitFor(() => expect(gets).toBe(2))
    expect(screen.queryByTestId('elsewhere')).toBeNull()
  })

  test('refusing asks first and sends the optional reason', async () => {
    let body: unknown = null
    open({
      'GET /api/atelier/drafts/d_weather': detail(),
      'POST /api/atelier/drafts/d_weather/preview': CARD,
      'POST /api/atelier/drafts/d_weather/reject': (b: unknown) => ((body = b), { ok: true, draft: draft({ status: 'rejected' }), trash_id: 't1' }),
    })
    await screen.findByRole('heading', { name: 'Weather', level: 2 })
    fireEvent.click(screen.getAllByRole('button', { name: 'Refuse' })[0])
    const dialog = await screen.findByRole('dialog', { name: 'Refuse this proposal?' })
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Not needed' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Refuse' }))
    await waitFor(() => expect(body).toEqual({ reason: 'Not needed' }))
    expect(await screen.findByTestId('elsewhere')).toBeTruthy()
  })

  test('asking for a change sends the message to the draft', async () => {
    let body: unknown = null
    open({
      'GET /api/atelier/drafts/d_weather': detail(),
      'POST /api/atelier/drafts/d_weather/preview': CARD,
      'POST /api/atelier/drafts/d_weather/request-change': (b: unknown) => ((body = b), { ok: true, session: { id: 's_1', path: 'projects/acme/topics/blog' }, created: false, queued: false }),
    })
    await screen.findByRole('heading', { name: 'Weather', level: 2 })
    fireEvent.click(screen.getAllByRole('button', { name: 'Ask for a change' })[0])
    const dialog = await screen.findByRole('dialog', { name: 'Ask for a change' })
    expect(within(dialog).getByText(/goes to the session “Morning card”/)).toBeTruthy()
    const send = within(dialog).getByRole('button', { name: 'Send to the agent' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Bigger numbers' } })
    fireEvent.click(send)
    await waitFor(() => expect(body).toEqual({ message: 'Bigger numbers' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('a failed check cannot be approved; undeclared permissions say so', async () => {
    open({
      'GET /api/atelier/drafts/d_weather': detail({
        check: { status: 'error', steps: [{ step: 'api.py', status: 'error', detail: 'SyntaxError: invalid syntax (line 4)' }] },
        permissions: { network: [], secrets: [], read: [], declared: false },
      }),
      'POST /api/atelier/drafts/d_weather/preview': CARD,
    })
    await screen.findByRole('heading', { name: 'Weather', level: 2 })
    expect(screen.getByTestId('atelier-check').getAttribute('data-status')).toBe('error')
    expect(screen.getByText('The check found an error')).toBeTruthy()
    for (const b of screen.getAllByRole('button', { name: 'Add to the dashboard' })) expect((b as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('atelier-undeclared').textContent).toContain('Not declared.')
  })

  test('a page is never run: it says why; a decided draft shows its outcome, without actions or preview', async () => {
    const calls = open({ 'GET /api/atelier/drafts/d_weather': detail({ type: 'page' }), 'POST /api/atelier/drafts/d_weather/preview': { kind: 'none', reason: 'page' } })
    expect(await screen.findByText(/A page only opens once approved/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Turn the page on' }).length).toBeGreaterThan(0)
    expect(calls.filter((c) => c.path.endsWith('/preview'))).toHaveLength(1)
  })

  test('an approved draft shows its version and a link to the creation', async () => {
    const calls = open({ 'GET /api/atelier/drafts/d_weather': detail({ status: 'approved', decided: { at: now - 60, by: 'user', version: 1 } }) })
    expect(await screen.findByText(/it is version 1/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'See the creation' }).getAttribute('href')).toBe('/atelier/extension/weather')
    expect(screen.queryByRole('button', { name: 'Add to the dashboard' })).toBeNull()
    expect(calls.some((c) => c.path.endsWith('/preview'))).toBe(false)
  })

  test('an unknown draft says so', async () => {
    open({}) // the fake API answers 404 not_found
    expect(await screen.findByText('This proposal does not exist')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to the Studio' }).getAttribute('href')).toBe('/atelier')
  })
})
