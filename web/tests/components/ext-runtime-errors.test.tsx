// Runtime errors of extensions: the Settings -> Extensions row lists them (features/extensions/RuntimeErrors.tsx), and
// the reports sent to the server (features/extensions/report.ts) are deduplicated per extension and capped.
import { beforeEach, describe, expect, test } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { RuntimeErrors } from '@/features/extensions/RuntimeErrors'
import { __resetReported, reportExtensionError } from '@/features/extensions/report'
import type { Extension, ExtRuntimeError } from '@/lib/types'
import { mockApi, renderApp } from './render'

const now = Date.now() / 1000
const err = (over: Partial<ExtRuntimeError> = {}): ExtRuntimeError => ({ where: 'page', message: 'TypeError: rows is undefined', stack: 'at draw (lib/table.js:7:11)', at: now - 60, count: 1, ...over })
const ext = (errors: ExtRuntimeError[]): Extension => ({
  id: 'notes', name: 'Notes', type: 'page', icon: 'notebook-pen', version: '1.0.0', enabled: true, error: null, has_api: true, runtime_errors: errors,
})

describe('runtime errors on the Settings row', () => {
  test('nothing recorded: nothing shown', () => {
    renderApp(<RuntimeErrors ext={ext([])} />)
    expect(screen.queryByTestId('ext-runtime-errors')).toBeNull()
  })

  test('the newest three with their place, count and stack; Clear forgets them', async () => {
    const calls = mockApi({ 'DELETE /api/extensions/notes/errors': { ok: true } })
    const errors = [err(), err({ where: 'api', message: "KeyError: 'notes'", stack: 'api.py:9 in handle', count: 4 }), err({ where: 'card', message: 'c' }), err({ message: 'oldest' })]
    renderApp(<RuntimeErrors ext={ext(errors)} />)
    const box = screen.getByTestId('ext-runtime-errors')
    expect(box.textContent).toContain('4 errors while it ran')
    expect(box.textContent).toContain('TypeError: rows is undefined')
    expect(box.textContent).toContain('at draw (lib/table.js:7:11)')
    expect(box.textContent).toContain('4 times')
    expect(screen.getByText('API')).toBeTruthy()
    expect(box.textContent).not.toContain('oldest')
    expect(box.textContent).toContain('1 older error not shown')
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/extensions/notes/errors')).toBe(true))
  })
})

describe('reports to the server', () => {
  beforeEach(() => __resetReported())

  test('the same message once per extension, at most ten', async () => {
    const calls = mockApi({ 'POST /api/extensions/game/errors': { ok: true }, 'POST /api/extensions/notes/errors': { ok: true } })
    reportExtensionError('game', 'widget', 'ReferenceError: boom is not defined', 'at /ext/game/widget-frame:58:3')
    reportExtensionError('game', 'widget', 'ReferenceError: boom is not defined')
    reportExtensionError('notes', 'page', 'ReferenceError: boom is not defined')
    for (let i = 0; i < 15; i++) reportExtensionError('game', 'widget', `e${i}`)
    await waitFor(() => expect(calls.length).toBe(11))
    const game = calls.filter((c) => c.path === '/api/extensions/game/errors')
    expect(game).toHaveLength(10)
    expect(game[0].body).toEqual({ where: 'widget', message: 'ReferenceError: boom is not defined', stack: 'at /ext/game/widget-frame:58:3' })
  })
})
