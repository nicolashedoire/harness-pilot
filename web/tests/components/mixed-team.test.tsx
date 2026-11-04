// Mixed agent team panel (pages/sessions/MixedTeam.tsx): the steps, each worker at work, stop one or all, the panel
// folded once the team is over, open a worker's session.
import { describe, expect, test } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { MixedTeam } from '@/pages/sessions/MixedTeam'
import { useSessionsUI } from '@/pages/sessions/store'
import { mockApi, renderApp } from './render'

const t0 = Date.now() / 1000 - 95
const team = (phase: string, claude: object, codex: object) => ({
  id: 'lead', phase, created: t0, agents: [
    { id: 'w-claude', provider: 'claude', role: 'Develop a practical approach.', state: 'running', started_at: t0, finished_at: null, ...claude },
    { id: 'w-codex', provider: 'codex', role: 'Examine risks.', state: 'running', started_at: t0, finished_at: null, ...codex },
  ],
})
const working = () => team('working',
  { state: 'idle', finished_at: t0 + 75, report: '## Plan\n\n**Flag** the change, then migrate.' },
  { activity: [{ kind: 'read', target: 'src/checkout.tsx' }, { kind: 'run', target: 'npm test' }] })
const panel = () => screen.findByRole('region', { name: 'Mixed agent team' })
const card = (name: string) => screen.getByText(name, { selector: 'strong' }).parentElement!.parentElement as HTMLElement

describe('Mixed agent team', () => {
  test('while the agents work: the current step, each worker with its time, its last actions or its report', async () => {
    mockApi({ 'GET /api/teams/lead': working() })
    renderApp(<MixedTeam sid="lead" />)
    const p = await panel()
    const steps = within(p).getByRole('list', { name: 'Team progress' })
    expect(within(steps).getByText('Agents working').closest('li')!.getAttribute('aria-current')).toBe('step')
    const claude = card('Claude Code'), codex = card('Codex')
    expect(within(claude).getByText('Approach and main steps')).toBeTruthy()
    expect(within(claude).getByText(/Finished/).textContent).toContain('1:15') // started_at -> finished_at
    expect(within(claude).getByText(/Flag the change, then migrate/).textContent).not.toContain('**') // report without Markdown marks
    expect(within(codex).getByText('Risks, alternatives and verification')).toBeTruthy()
    expect(within(codex).getByText('src/checkout.tsx')).toBeTruthy()
    expect(within(codex).getByText('npm test')).toBeTruthy()
    expect(within(p).getByText('1 of 2 ready')).toBeTruthy()
  })

  test('only a running worker can be stopped alone', async () => {
    const calls = mockApi({ 'GET /api/teams/lead': working(), 'POST /api/teams/lead/agents/w-codex/stop': {} })
    renderApp(<MixedTeam sid="lead" />)
    await panel()
    expect(within(card('Claude Code')).queryByRole('button', { name: 'Stop agent' })).toBeNull()
    fireEvent.click(within(card('Codex')).getByRole('button', { name: 'Stop agent' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/teams/lead/agents/w-codex/stop')).toBe(true))
  })

  test('the whole team can be stopped while it is active', async () => {
    const calls = mockApi({ 'GET /api/teams/lead': team('synthesizing', { state: 'idle' }, { state: 'idle' }), 'POST /api/teams/lead/stop': {} })
    renderApp(<MixedTeam sid="lead" />)
    expect(within(await panel()).getByText('Claude is writing the synthesis…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop team' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/teams/lead/stop')).toBe(true))
  })

  test('once done, the panel is one folded line without stop buttons; it opens on demand', async () => {
    mockApi({ 'GET /api/teams/lead': team('completed', { state: 'idle' }, { state: 'idle' }) })
    renderApp(<MixedTeam sid="lead" />)
    const p = await panel()
    const toggle = within(p).getByRole('button', { name: 'Mixed agent team' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(within(p).queryByText('Claude Code')).toBeNull()
    expect(within(p).queryByRole('button', { name: /Stop/ })).toBeNull()
    fireEvent.click(toggle)
    expect(within(p).getByText('Claude wrote the synthesis from both reports.')).toBeTruthy()
    expect(within(p).queryByRole('button', { name: 'Stop agent' })).toBeNull()
  })

  test('a stopped team shows a badge instead of the steps', async () => {
    mockApi({ 'GET /api/teams/lead': team('stopped', { state: 'stopped' }, { state: 'idle' }) })
    renderApp(<MixedTeam sid="lead" />)
    const p = await panel()
    expect(within(p).getByText('Stopped')).toBeTruthy()
    expect(within(p).queryByRole('list', { name: 'Team progress' })).toBeNull()
  })

  test('Open session opens the worker in a column', async () => {
    mockApi({ 'GET /api/teams/lead': working() })
    renderApp(<MixedTeam sid="lead" />)
    await panel()
    fireEvent.click(within(card('Codex')).getByRole('button', { name: 'Open session' }))
    expect(useSessionsUI.getState().cols.some((c) => c.kind === 'session' && c.id === 'w-codex')).toBe(true)
  })
})
