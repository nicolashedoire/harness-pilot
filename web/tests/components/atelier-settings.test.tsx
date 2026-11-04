// The Atelier's settings sheet (pages/atelier/Settings.tsx, GET / PUT /api/atelier/settings): auto-activation of the
// creations that declare no network and no secret (a switch, saved at once), and the retention fields (checked here,
// saved together, a refusal shown under them).
import { describe, expect, test } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { SettingsSheet } from '@/pages/atelier/Settings'
import { mockApi, renderApp } from './render'

const SETTINGS = { auto_activate_safe: false, keep_days: 90, keep_versions: 10 }

const open = (put: (b: unknown) => unknown = (b) => ({ ...SETTINGS, ...(b as object) })) => {
  const calls = mockApi({ 'GET /api/atelier/settings': SETTINGS, 'PUT /api/atelier/settings': put })
  renderApp(<SettingsSheet open onOpenChange={() => {}} />)
  return calls
}

describe('Atelier settings', () => {
  test('auto-activation is off by default, says what it covers, and saves at once', async () => {
    const calls = open()
    const dialog = await screen.findByRole('dialog', { name: 'Studio settings' })
    const sw = await within(dialog).findByRole('switch', { name: 'Turn on safe creations by themselves' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(within(dialog).getByText(/declare no network and no secret/)).toBeTruthy()
    fireEvent.click(sw)
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ auto_activate_safe: true }))
    expect(sw.getAttribute('aria-checked')).toBe('true')
  })

  test('the retention fields are checked before saving, then saved together', async () => {
    const calls = open()
    const dialog = await screen.findByRole('dialog', { name: 'Studio settings' })
    const days = await within(dialog).findByRole('textbox', { name: 'Keep for (days)' })
    const versions = within(dialog).getByRole('textbox', { name: 'Always keep the newest (versions)' })
    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect((days as HTMLInputElement).value).toBe('90')
    expect(save.disabled).toBe(true) // nothing changed
    fireEvent.change(days, { target: { value: '0' } })
    expect(within(dialog).getByText('A whole number from 1 to 3650')).toBeTruthy()
    expect(save.disabled).toBe(true)
    fireEvent.change(days, { target: { value: '30' } })
    fireEvent.change(versions, { target: { value: '5' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ keep_days: 30, keep_versions: 5 }))
  })

  test('a refusal of the server shows under the fields and keeps what was typed', async () => {
    mockApi({ 'GET /api/atelier/settings': SETTINGS })
    renderApp(<SettingsSheet open onOpenChange={() => {}} />)
    const dialog = await screen.findByRole('dialog', { name: 'Studio settings' })
    const days = await within(dialog).findByRole('textbox', { name: 'Keep for (days)' })
    const real = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      (init?.method || 'GET').toUpperCase() === 'PUT'
        ? new Response(JSON.stringify({ error: 'bad_settings', message: 'keep_days must be a whole number from 1 to 3650' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
        : real(input, init)) as typeof fetch
    fireEvent.change(days, { target: { value: '120' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByText('keep_days must be a whole number from 1 to 3650')).toBeTruthy()
    expect((days as HTMLInputElement).value).toBe('120')
  })
})
