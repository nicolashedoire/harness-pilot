// Message composer (pages/sessions/Composer.tsx): Enter sends and Shift+Enter does not, the send button and its
// label (send / queue / intervene), a reason that blocks sending, a refused message coming back, the stop button.
import * as React from 'react'
import { describe, expect, test, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Composer } from '@/pages/sessions/Composer'
import { renderApp } from './render'

let n = 0
const compose = (props: Partial<React.ComponentProps<typeof Composer>> = {}) => {
  const onSend = vi.fn(async () => true)
  const key = `test-${++n}` // a fresh draft per test
  renderApp(<Composer colKey={key} draftKey={key} topicPath="projects/acme/topics/blog" onSend={onSend} {...props} />)
  return { onSend: (props.onSend as typeof onSend) || onSend, box: screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement }
}
const type = (box: HTMLTextAreaElement, text: string) => fireEvent.change(box, { target: { value: text } })

describe('Composer', () => {
  test('Enter sends the message and empties the box; Shift+Enter does not send', async () => {
    const { onSend, box } = compose()
    type(box, 'Draft the release notes')
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(box.value).toBe('Draft the release notes') // a send empties the box at once
    await new Promise((r) => setTimeout(r, 0))
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Draft the release notes', []))
    expect(box.value).toBe('')
  })

  test('the send button is off while the box is empty and names what it will do', () => {
    const { box } = compose()
    const send = screen.getByRole('button', { name: 'Send (Enter)' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    type(box, 'Hello')
    expect(send.disabled).toBe(false)
  })

  test('while a turn runs, a message is queued after it, and Stop stops the turn', () => {
    const onStop = vi.fn()
    compose({ running: true, onStop })
    expect(screen.getByRole('button', { name: 'Queue after the current turn' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  test('in a mode that takes interventions, a message goes in at once', () => {
    compose({ running: true, immediateIntervention: true })
    expect(screen.getByRole('button', { name: 'Intervene immediately' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull() // no onStop given
  })

  test('a reason that blocks sending is shown and Enter does nothing', async () => {
    const { onSend, box } = compose({ disabledReason: 'Wait for the team to finish' })
    type(box, 'One more thing')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box.value).toBe('One more thing')
    await new Promise((r) => setTimeout(r, 0))
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getAllByText('Wait for the team to finish').length).toBeGreaterThan(0)
    expect((screen.getByRole('button', { name: 'Send (Enter)' }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('a message the server refuses comes back in the box', async () => {
    const onSend = vi.fn(async () => false)
    const { box } = compose({ onSend })
    type(box, 'Publish the article')
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(box.value).toBe('Publish the article'))
  })
})
