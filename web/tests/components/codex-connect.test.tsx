// Settings -> Codex and the wizard's Codex step (features/codex/CodexConnect.tsx): signing the server's Codex in with a
// ChatGPT account (a one-time code shown here, entered on OpenAI's page) or an API key, and signing it out.
import { describe, expect, test } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { ConfirmHost } from '@/components/ui'
import { CodexConnect } from '@/features/codex/CodexConnect'
import { mockApi, renderApp } from './render'

const signedOut = { installed: true, authenticated: false, reason: 'not_authenticated', method: null }
const signedIn = (method: 'chatgpt' | 'api_key') => ({ installed: true, authenticated: true, reason: null, method })
const none = { state: 'none', url: null, code: null, expires_at: null, started_at: null, error: null }
const waiting = () => ({ state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'WXYZ-12345', expires_at: Date.now() / 1000 + 14 * 60 + 30, started_at: Date.now() / 1000, error: null })

describe('Codex sign-in from the web app', () => {
  test('ChatGPT account: the page and the code are shown, then the status turns signed in by itself', async () => {
    let status: object = signedOut
    let flow: object = none
    const calls = mockApi({
      'GET /api/system/codex': () => status,
      'GET /api/system/codex/login': () => flow,
      'POST /api/system/codex/login': () => (flow = waiting()),
    })
    renderApp(<CodexConnect />)
    expect(await screen.findByText('Codex is installed but not signed in.')).toBeTruthy()
    fireEvent.click(await screen.findByTestId('codex-get-code'))
    const device = await screen.findByTestId('codex-device')
    const link = within(device).getByRole('link', { name: /auth\.openai\.com\/codex\/device/ })
    expect(link.getAttribute('href')).toBe('https://auth.openai.com/codex/device')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(within(device).getByTestId('codex-code').textContent).toBe('WXYZ-12345')
    expect(within(device).getByText(/^expires in 1[45]:\d\d$/)).toBeTruthy()
    expect(within(device).getByText(/Never give it to anyone/)).toBeTruthy()
    // the user signs in on the other device: the next poll ends the flow and the status is read again
    status = signedIn('chatgpt')
    flow = { ...none, state: 'succeeded', started_at: 1 }
    expect(await screen.findByText('Codex is signed in.', {}, { timeout: 4000 })).toBeTruthy()
    expect(screen.getByText('ChatGPT account')).toBeTruthy()
    expect(screen.queryByTestId('codex-device')).toBeNull()
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/system/codex/login')).toHaveLength(1)
  })

  test('a failed or expired code is said, with a way to get a new one; cancel stops a waiting one', async () => {
    let flow: object = { ...waiting() }
    const calls = mockApi({
      'GET /api/system/codex': signedOut,
      'GET /api/system/codex/login': () => flow,
      'DELETE /api/system/codex/login': () => (flow = { ...none, state: 'cancelled', started_at: 1 }),
    })
    renderApp(<CodexConnect />)
    // a flow already waiting when the page opens (another tab, a reload) is shown as it is
    const device = await screen.findByTestId('codex-device')
    fireEvent.click(within(device).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByTestId('codex-device')).toBeNull())
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/system/codex/login')).toBe(true)
    expect(screen.getByRole('button', { name: /Get a sign-in code/ })).toBeTruthy()
  })

  test('a flow that failed while watched shows the CLI error and offers a new code', async () => {
    let flow: object = waiting()
    mockApi({ 'GET /api/system/codex': signedOut, 'GET /api/system/codex/login': () => flow })
    renderApp(<CodexConnect />)
    await screen.findByTestId('codex-device')
    flow = { ...none, state: 'failed', started_at: 1, error: 'Error: device code ••• was rejected' }
    expect(await screen.findByText(/Error: device code ••• was rejected/, {}, { timeout: 4000 })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Get a new code/ })).toBeTruthy()
  })

  test('API key: sent once to the server, the field is emptied and the status says how Codex is signed in', async () => {
    let status: object = signedOut
    const calls = mockApi({
      'GET /api/system/codex': () => status,
      'GET /api/system/codex/login': none,
      'POST /api/system/codex/auth': () => (status = { ok: true, ...signedIn('api_key') }),
    })
    renderApp(<CodexConnect />)
    const tab = await screen.findByRole('tab', { name: /API key/ })
    fireEvent.mouseDown(tab)
    fireEvent.click(tab)
    const field = await screen.findByTestId('codex-key')
    fireEvent.click(screen.getByRole('button', { name: /Sign in with this key/ }))
    expect(await screen.findByText('Paste a key first.')).toBeTruthy()
    fireEvent.change(field, { target: { value: '  sk-proj-abcdefghijklmnopqrstuvwxyz  ' } })
    fireEvent.click(screen.getByRole('button', { name: /Sign in with this key/ }))
    expect(await screen.findByText('Codex is signed in.')).toBeTruthy()
    expect(screen.getByText('API key')).toBeTruthy()
    const sent = calls.filter((c) => c.method === 'POST' && c.path === '/api/system/codex/auth')
    expect(sent.map((c) => c.body)).toEqual([{ value: 'sk-proj-abcdefghijklmnopqrstuvwxyz' }])
  })

  test('signed in: sign out asks first, then signs out', async () => {
    let status: object = signedIn('chatgpt')
    const calls = mockApi({
      'GET /api/system/codex': () => status,
      'DELETE /api/system/codex/auth': () => (status = { ok: true, ...signedOut }),
    })
    renderApp(
      <>
        <CodexConnect />
        <ConfirmHost />
      </>,
    )
    expect(await screen.findByText('Codex is signed in.')).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/A terminal on this computer uses the same sign-in/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByText('Codex is installed but not signed in.')).toBeTruthy()
    expect(calls.filter((c) => c.method === 'DELETE' && c.path === '/api/system/codex/auth')).toHaveLength(1)
  })

  test('not installed: the install command, no sign-in form', async () => {
    mockApi({ 'GET /api/system/codex': { installed: false, authenticated: false, reason: 'not_installed', method: null } })
    renderApp(<CodexConnect />)
    expect(await screen.findByText('The Codex command was not found by this server.')).toBeTruthy()
    expect(screen.getByText('npm install -g @openai/codex')).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
  })
})
