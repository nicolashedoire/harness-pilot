// "Ask for a fix" on a broken extension (features/extensions/AskFix.tsx): the line says where the fix goes, the button
// shows the message the server wrote (dry run), sends it once confirmed and opens the session; Cancel sends nothing.
import { describe, expect, test } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { ConfirmHost } from '@/components/ui'
import { AskFixButton, FixTarget } from '@/features/extensions/AskFix'
import { mockApi, renderApp } from './render'

const PROMPT = 'My page extension `notes` ("Notes", folder /root/maxxing/extensions/notes) is broken. Fix it.'
const origin = { id: 's-1', title: 'Build the notes page', path: 'projects/acme/topics/blog' }

function setup(withOrigin: boolean) {
  const calls = mockApi({
    'POST /api/extensions/notes/fix': (body: { dry_run?: boolean }) =>
      body.dry_run
        ? { prompt: PROMPT, target: withOrigin ? { session: origin } : { topic: 'projects/system/topics/harness' } }
        : { session: { id: withOrigin ? 's-1' : 's-new', path: withOrigin ? origin.path : 'projects/system/topics/harness' }, reused: withOrigin },
  })
  const ext = { id: 'notes', origin: withOrigin ? origin : null }
  renderApp(
    <>
      <AskFixButton ext={ext} error={{ message: "TypeError: rows is undefined" }} />
      <FixTarget ext={ext} />
      <ConfirmHost />
    </>,
    { path: '/', route: '/' },
  )
  return calls
}

describe('Ask for a fix', () => {
  test('to the session that created it: shown, confirmed, sent, opened', async () => {
    const calls = setup(true)
    expect(screen.getByTestId('ext-fix-target').textContent).toBe('The fix opens in the session that created it: Build the notes page')
    fireEvent.click(screen.getByRole('button', { name: 'Ask for a fix' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Ask harness-pilot to fix it?')).toBeTruthy()
    expect(within(dialog).getByTestId('ext-fix-prompt').textContent).toBe(PROMPT)
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toEqual({ error: { message: 'TypeError: rows is undefined' }, dry_run: true })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByTestId('elsewhere')).toBeTruthy()) // the app moved to the session
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/api/extensions/notes/fix', body: { error: { message: 'TypeError: rows is undefined' } } })
  })

  test('without one: a new session in system › harness; Cancel sends nothing', async () => {
    const calls = setup(false)
    expect(screen.getByTestId('ext-fix-target').textContent).toBe('The fix opens in a new session in system › harness')
    fireEvent.click(screen.getByRole('button', { name: 'Ask for a fix' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('The fix opens in a new session in system › harness')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(calls.filter((c) => !(c.body as { dry_run?: boolean }).dry_run)).toHaveLength(0)
    expect(screen.queryByTestId('elsewhere')).toBeNull()
  })
})
