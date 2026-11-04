// The `proposal` conversation block (features/blocks/builtins/proposal.tsx -> features/atelier/ProposalCard.tsx): drawn
// from GET /api/atelier/drafts/{draft}, never run on render (Preview on demand), approve with the reviewed version,
// ask for a change inline, waiting on a 404 (registered at the end of the agent's turn), the outcome once decided.
import { describe, expect, test } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { ProposalBlock } from '@/features/blocks/builtins/proposal'
import BlockFence from '@/features/blocks/BlockFence'
import { fenceBlock } from '@/features/blocks/fence'
import type { BlockPlugin } from '@/features/blocks/types'
import { mockApi, renderApp } from './render'

const now = Date.now() / 1000
const plugin: BlockPlugin = { id: 'proposal', kind: 'builtin', name: 'proposal', names: {}, renders: ['proposal'], icon: 'package-check', category: 'organisation', hint: '', fields: '',
  schema: {}, raw: null, version: '1', description: '', enabled: true, error: null, network: [], consent: null, pin: false, entry_v: null, height: null }
const block = (data: Record<string, unknown>) => ({ type: 'proposal', data, plugin, raw: JSON.stringify(data) })
const draft = (extra: object = {}) => ({
  id: 'd_5f2c8a91b3e4', kind: 'extension', target: 'weather', name: 'Weather', type: 'html_widget', icon: 'cloud-sun', status: 'pending', change: 'new', base: null, created: now - 60,
  origin: { agent: 'codex', session: 's_1', session_title: 'Morning card', session_path: 'projects/acme/topics/blog', at: now - 60, summary: 'Today and the next three days.' },
  summary: 'Today and the next three days for the office.',
  permissions: { network: ['api.open-meteo.com'], secrets: [], read: [], declared: true },
  check: { status: 'ok', steps: [{ step: 'load', status: 'ok', detail: '' }] },
  files: { count: 3, size: 900, added: 3, changed: 0, removed: 0 },
  decided: null, superseded_by: null, change_requests: [], auto: false, ...extra,
})
const detail = (d: object = {}, extra: object = {}) => ({ draft: draft(d), files: [], active_version: null, stale: false, preview: 'html', ...extra })

const show = (routes: Record<string, unknown>, data: Record<string, unknown> = { draft: 'd_5f2c8a91b3e4' }) => {
  const calls = mockApi(routes)
  renderApp(<ProposalBlock block={block(data)} size="inline" memoKey="p1" />)
  return calls
}

describe('Proposal block', () => {
  test('shows what was proposed, what it asks for and its files, without running it', async () => {
    const calls = show({ 'GET /api/atelier/drafts/d_5f2c8a91b3e4': detail() })
    const card = await screen.findByRole('region', { name: 'Proposal: Weather' })
    expect(card.getAttribute('data-state')).toBe('pending')
    expect(within(card).getByText('Proposed to the Studio · waits for you')).toBeTruthy()
    expect(within(card).getByText('HTML widget')).toBeTruthy()
    expect(within(card).getByText('new')).toBeTruthy()
    expect(within(card).getByText('3 added')).toBeTruthy()
    expect(within(card).getByText('Today and the next three days for the office.')).toBeTruthy()
    expect(within(card).getByText('api.open-meteo.com')).toBeTruthy()
    expect(within(card).getByRole('link', { name: 'Open in the Studio' }).getAttribute('href')).toBe('/atelier/drafts/d_5f2c8a91b3e4')
    // nothing ran: the preview waits for the user
    expect(calls.some((c) => c.path.endsWith('/preview'))).toBe(false)
    expect(within(card).getByRole('button', { name: 'Preview with your data' })).toBeTruthy()
  })

  test('Preview runs it once, on demand', async () => {
    const calls = show({
      'GET /api/atelier/drafts/d_5f2c8a91b3e4': detail({ type: 'widget' }, { preview: 'card' }),
      'POST /api/atelier/drafts/d_5f2c8a91b3e4/preview': { kind: 'card', card: { title: 'Weather', blocks: [{ type: 'list', items: [{ title: 'Monday', value: '18°' }] }] }, error: null, trace: [] },
    })
    const card = await screen.findByRole('region', { name: 'Proposal: Weather' })
    fireEvent.click(within(card).getByRole('button', { name: 'Preview with your data' }))
    expect(await within(card).findByText('Monday')).toBeTruthy()
    expect(calls.filter((c) => c.path.endsWith('/preview'))).toHaveLength(1)
  })

  test('Add to the dashboard approves against the active version', async () => {
    let body: unknown = null
    show({
      'GET /api/atelier/drafts/d_5f2c8a91b3e4': detail({ type: 'widget' }),
      'POST /api/atelier/drafts/d_5f2c8a91b3e4/approve': (b: unknown) => ((body = b), { ok: true, item: {}, version: 1 }),
    })
    const card = await screen.findByRole('region', { name: 'Proposal: Weather' })
    fireEvent.click(within(card).getByRole('button', { name: 'Add to the dashboard' }))
    await waitFor(() => expect(body).toEqual({ base: null }))
  })

  test('Ask for a change opens a field in the card and sends it', async () => {
    let body: unknown = null
    show({
      'GET /api/atelier/drafts/d_5f2c8a91b3e4': detail(),
      'POST /api/atelier/drafts/d_5f2c8a91b3e4/request-change': (b: unknown) => ((body = b), { ok: true, session: { id: 's_1', path: 'p' }, created: false, queued: true }),
    })
    const card = await screen.findByRole('region', { name: 'Proposal: Weather' })
    fireEvent.click(within(card).getByRole('button', { name: 'Ask for a change' }))
    fireEvent.change(within(card).getByRole('textbox', { name: 'What should change' }), { target: { value: 'Only two days' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Send to the agent' }))
    await waitFor(() => expect(body).toEqual({ message: 'Only two days' }))
    await waitFor(() => expect(within(card).queryByRole('textbox')).toBeNull())
  })

  test('not registered yet (404): waits with the title the agent gave', async () => {
    show({}, { draft: 'd_000000000000', title: 'Weather board' })
    const card = await screen.findByTestId('proposal-card')
    await waitFor(() => expect(card.getAttribute('data-state')).toBe('waiting'))
    expect(within(card).getByText('Weather board')).toBeTruthy()
    expect(within(card).getByText(/once the agent's turn ends/)).toBeTruthy()
  })

  test('once decided, says what became of it, without the actions', async () => {
    show({ 'GET /api/atelier/drafts/d_5f2c8a91b3e4': detail({ status: 'approved', decided: { at: now, by: 'user', version: 4 } }) })
    const card = await screen.findByRole('region', { name: 'Proposal: Weather' })
    expect(within(card).getByText('Approved · v4')).toBeTruthy()
    expect(within(card).getByText('3 files')).toBeTruthy()
    expect(within(card).getByRole('link', { name: 'See the creation' }).getAttribute('href')).toBe('/atelier/extension/weather')
    expect(within(card).queryByRole('button', { name: 'Add to the dashboard' })).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Preview with your data' })).toBeNull()
  })

  test('a failed check cannot be approved from the card', async () => {
    show({ 'GET /api/atelier/drafts/d_5f2c8a91b3e4': detail({ type: 'page', check: { status: 'error', steps: [{ step: 'page.js', status: 'error', detail: 'SyntaxError' }] } }) })
    const card = await screen.findByRole('region', { name: 'Proposal: Weather' })
    expect((within(card).getByRole('button', { name: 'Turn the page on' }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('a ```proposal fence of an answer is a block, drawn by this card', async () => {
    const code = '{"draft": "d_5f2c8a91b3e4", "title": "Weather"}'
    const fb = fenceBlock('language-proposal', code)
    expect(fb).toEqual({ type: 'proposal', explicit: false, candidate: false })
    mockApi({
      'GET /api/blocks': { plugins: [{ ...plugin, schema: { type: 'object', required: ['draft'], properties: { draft: { type: 'string', minLength: 14, maxLength: 14 }, title: { type: 'string', maxLength: 120 } } } }], agents: {} },
      'GET /api/atelier/drafts/d_5f2c8a91b3e4': detail(),
    })
    renderApp(<BlockFence block={fb!} code={code} fallback={<pre>{code}</pre>} />)
    expect(await screen.findByRole('region', { name: 'Proposal: Weather' })).toBeTruthy()
  })
})
