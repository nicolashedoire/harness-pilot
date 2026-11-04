// New session form, agent modes (pages/sessions/NewSessionModes.tsx): the cards, one or several agents, and the
// "What will happen" panel of each mode.
import * as React from 'react'
import { describe, expect, test } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { ModePanel, ModePicker } from '@/pages/sessions/NewSessionModes'
import type { AgentProvider } from '@/lib/types'
import { mockApi, renderApp } from './render'

const notes: AgentProvider = { id: 'plugin:notes-agent', name: 'Notes agent', builtin: false, capabilities: ['text'] }

function Picker({ plugins = [] as AgentProvider[] }) {
  const [mode, setMode] = React.useState('claude')
  return <>
    <ModePicker name="mode" value={mode} onChange={setMode} plugins={plugins} swarmAgents="3" />
    <output data-testid="mode">{mode}</output>
  </>
}
const panel = () => screen.getByRole('complementary', { name: 'What will happen' })
const facts = () => Object.fromEntries([...panel().querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]))

describe('Agent modes', () => {
  test('one agent or several: every mode is a radio card, the chosen one is checked', () => {
    renderApp(<Picker plugins={[notes]} />)
    const one = screen.getByRole('group', { name: 'One agent' }), several = screen.getByRole('group', { name: 'Several agents' })
    expect(within(one).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['claude', 'codex', 'plugin:notes-agent'])
    expect(within(several).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['swarm', 'both', 'team'])
    expect((screen.getByRole('radio', { name: /Claude Code/ }) as HTMLInputElement).checked).toBe(true)
    expect(within(several).getByText('×3')).toBeTruthy()
    expect(within(several).getByText('New')).toBeTruthy() // the mixed team
    fireEvent.click(screen.getByRole('radio', { name: /Mixed team/ }))
    expect(screen.getByTestId('mode').textContent).toBe('team')
    expect((screen.getByRole('radio', { name: /Mixed team/ }) as HTMLInputElement).checked).toBe(true)
  })

  test('each single agent names the subscription it uses', () => {
    const view = renderApp(<ModePanel mode="claude" swarmAgents="3" />)
    expect(within(panel()).getByRole('heading', { name: 'Claude Code' })).toBeTruthy()
    expect(facts()).toEqual({ 'Subscription used': 'Claude' })
    view.unmount()
    renderApp(<ModePanel mode="codex" swarmAgents="3" />)
    expect(within(panel()).getByRole('heading', { name: 'Codex' })).toBeTruthy()
    expect(facts()).toEqual({ 'Subscription used': 'ChatGPT' })
  })

  test('the swarm says how many subagents are requested, and that one cannot be stopped alone', () => {
    renderApp(<ModePanel mode="swarm" swarmAgents="4" />)
    expect(facts()['Subagents requested']).toBe('4')
    expect(within(panel()).getByText(/one agent cannot/i)).toBeTruthy()
  })

  test('the debate uses both subscriptions', () => {
    renderApp(<ModePanel mode="both" swarmAgents="3" />)
    expect(within(panel()).getByRole('heading', { name: 'Debate' })).toBeTruthy()
    expect(facts()).toEqual({ 'Subscriptions used': 'Claude + ChatGPT' })
  })

  test('the mixed team shows its flow and the coordinator model from the Claude status', async () => {
    mockApi({ 'GET /api/claude/status': { installed: true, version: '2.4.1', auth: { ok: true }, default_model: 'claude-opus-5-5', models: [] } })
    renderApp(<ModePanel mode="team" swarmAgents="3" />)
    expect(within(panel()).getByText('Your mission')).toBeTruthy()
    expect(within(panel()).getByText('Claude coordinates and writes the synthesis')).toBeTruthy()
    expect(within(panel()).getByText('Neither analysis changes any file.')).toBeTruthy()
    expect(await within(panel()).findByText('Opus 5.5')).toBeTruthy()
    expect(facts()).toEqual({ 'Subscriptions used': 'Claude + ChatGPT', Coordinator: 'Opus 5.5', Sessions: '2 analyses + this one' })
  })

  test('an extension engine warns when it takes text only, or when it is unavailable', () => {
    const view = renderApp(<ModePanel mode="plugin:notes-agent" adapter={notes} swarmAgents="3" />)
    expect(within(panel()).getByRole('heading', { name: 'Notes agent' })).toBeTruthy()
    expect(within(panel()).getByText(/accepts text only/)).toBeTruthy()
    view.unmount()
    renderApp(<ModePanel mode="plugin:gone" swarmAgents="3" />)
    expect(within(panel()).getByRole('heading', { name: 'gone' })).toBeTruthy()
    expect(within(panel()).getByText(/unavailable or disabled/)).toBeTruthy()
  })
})
