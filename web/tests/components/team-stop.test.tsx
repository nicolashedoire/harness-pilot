// "Stop team" of a mixed team (pages/sessions/MixedTeam.tsx, Column.tsx, Composer.tsx): while the team works, the
// session header and the locked composer offer it next to the team panel's own button; one request stops the team,
// then the composer opens again.
import * as React from 'react'
import { describe, expect, test } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { SessionColumn } from '@/pages/sessions/Column'
import { Composer } from '@/pages/sessions/Composer'
import { mockApi, renderApp } from './render'

const lead = (phase: string) => ({
  id: 'lead', title: 'Checkout in one page?', path: 'projects/acme/topics/website', state: 'idle', queue: 0, created: 1, updated: 1, turns: 0,
  cost_usd: 0, model: '', real_model: null, context_tokens: null, context_window: null, archived: false, notify: false, source: 'web',
  unread: false, last_text: '', error: null, provider: 'claude', team_phase: phase, team_parent: null, team_turn: false,
})
const team = (phase: string) => ({
  id: 'lead', phase, created: Date.now() / 1000 - 60, coordinator: 'claude', agents: [
    { id: 'w-claude', provider: 'claude', role: 'Approach', state: phase === 'working' ? 'running' : 'stopped', started_at: Date.now() / 1000 - 60, finished_at: null, activity: [] },
    { id: 'w-codex', provider: 'codex', role: 'Risks', state: phase === 'working' ? 'running' : 'stopped', started_at: Date.now() / 1000 - 60, finished_at: null, activity: [] },
  ],
})

const log = { events: [], start: 0, next: 0, more_before: false, state: 'idle' }

describe('Stop team', () => {
  test('while the team works: in the header, in the locked composer and in the panel; one request stops it', async () => {
    let phase = 'working'
    const calls = mockApi({
      'GET /api/sessions/lead': () => lead(phase),
      'GET /api/sessions/lead/events': log,
      'GET /api/teams/lead': () => team(phase),
      'POST /api/teams/lead/stop': () => { phase = 'stopped'; return team(phase) },
    })
    renderApp(<SessionColumn col={{ key: 'c-team', kind: 'session', id: 'lead' }} sid="lead" variant="solo" index={0} count={1} />)
    const header = (await screen.findByText('Checkout in one page?')).closest('header') as HTMLElement
    const locked = await screen.findByTestId('composer-locked')
    expect(within(locked).getByText('The team is working. Wait for the synthesis or stop the team to write.')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull() // nothing can be written while it works
    const panel = await screen.findByRole('region', { name: 'Mixed agent team' })
    expect(within(header).getByRole('button', { name: 'Stop team' })).toBeTruthy()
    expect(within(panel).getByRole('button', { name: 'Stop team' })).toBeTruthy()

    fireEvent.click(within(locked).getByRole('button', { name: 'Stop team' }))
    fireEvent.click(within(header).getByRole('button', { name: 'Stop team' })) // a second click while it stops: no second request
    await waitFor(() => expect(screen.queryByTestId('composer-locked')).toBeNull())
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/teams/lead/stop')).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy()
    expect(within(header).queryByRole('button', { name: 'Stop team' })).toBeNull()
    expect(within(await screen.findByRole('region', { name: 'Mixed agent team' })).getByText('Stopped')).toBeTruthy()
  })

  test('a finished team leaves the header and the composer as usual', async () => {
    mockApi({ 'GET /api/sessions/lead': lead('completed'), 'GET /api/sessions/lead/events': log, 'GET /api/teams/lead': team('completed') })
    renderApp(<SessionColumn col={{ key: 'c-done', kind: 'session', id: 'lead' }} sid="lead" variant="solo" index={0} count={1} />)
    await screen.findByRole('region', { name: 'Mixed agent team' })
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy()
    expect(screen.queryByTestId('composer-locked')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop team' })).toBeNull()
  })

  test('a locked composer keeps the draft and gives it back once unlocked', () => {
    function Box() {
      const [locked, setLocked] = React.useState(false)
      return <>
        <button type="button" onClick={() => setLocked(!locked)}>toggle</button>
        <Composer colKey="team-draft" draftKey="team-draft" topicPath="projects/acme/topics/blog" onSend={async () => true} locked={locked ? { text: 'Locked', action: <button type="button">Stop</button> } : null} />
      </>
    }
    renderApp(<Box />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Then publish it' } })
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull()
    expect(within(screen.getByTestId('composer-locked')).getByRole('button', { name: 'Stop' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('Then publish it')
  })
})
