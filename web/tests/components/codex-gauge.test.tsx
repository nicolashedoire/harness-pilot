// Context gauge of a Codex session (pages/sessions/Column.tsx, Widgets.tsx ContextGauge): shown like Claude's, measured
// against the window Codex recorded (or Codex's default), never against Claude's models.
import * as React from 'react'
import { describe, expect, test } from 'vitest'
import { screen } from '@testing-library/react'
import { SessionColumn } from '@/pages/sessions/Column'
import { mockApi, renderApp } from './render'

const session = (over: Record<string, unknown>) => ({
  id: 's1', title: 'Refactor the router', path: 'projects/acme/topics/blog', state: 'idle', queue: 0, created: 1, updated: 1,
  turns: 2, cost_usd: 0, model: '', real_model: null, context_tokens: 103000, context_window: 258400, archived: false,
  notify: false, source: 'web', unread: false, last_text: '', error: null, provider: 'codex', ...over,
})
// Claude's default model has a 1M window here: it must not be used for Codex
const claude = { installed: true, auth: { ok: true }, default_model: 'claude-opus-5-5', models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', context_window: 1000000 }] }
const log = { events: [], start: 0, next: 0, more_before: false, state: 'idle' }

async function gauge(s: Record<string, unknown>) {
  mockApi({ 'GET /api/sessions/s1': s, 'GET /api/sessions/s1/events': log, 'GET /api/claude/status': claude })
  renderApp(<SessionColumn col={{ key: 'c-s1', kind: 'session', id: 's1' }} sid="s1" variant="solo" index={0} count={1} />)
  await screen.findByText('Refactor the router')
  return screen.findByTestId('context-gauge')
}

describe('Codex context gauge', () => {
  test('a Codex session shows its context against the window Codex recorded', async () => {
    const el = await gauge(session({}))
    expect(el.getAttribute('aria-label')).toBe('Context: 103k / 258k tokens (40 %)')
    expect(el.textContent).toContain('40 %')
  })

  test('without a recorded window: Codex\'s default, not Claude\'s', async () => {
    const el = await gauge(session({ context_window: null }))
    expect(el.getAttribute('aria-label')).toBe('Context: 103k / 258k tokens (40 %)')
  })

  test('a Claude session is unchanged', async () => {
    const el = await gauge(session({ provider: 'claude', context_window: null }))
    expect(el.getAttribute('aria-label')).toBe('Context: 103k / 1.0M tokens (10 %)')
  })

  test('no context recorded: no gauge', async () => {
    mockApi({ 'GET /api/sessions/s1': session({ context_tokens: null, context_window: null }), 'GET /api/sessions/s1/events': log, 'GET /api/claude/status': claude })
    renderApp(<SessionColumn col={{ key: 'c-s1', kind: 'session', id: 's1' }} sid="s1" variant="solo" index={0} count={1} />)
    await screen.findByText('Refactor the router')
    expect(screen.queryByTestId('context-gauge')).toBeNull()
  })
})
