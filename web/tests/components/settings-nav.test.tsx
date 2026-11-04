// Settings menu (pages/settings/index.tsx): grouped headings, the active section, the search (filter, Enter, Escape).
import { describe, expect, test } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import SettingsPage from '@/pages/settings'
import { renderApp } from './render'

const menu = () => screen.getAllByRole('navigation', { name: 'Settings' }).find((n) => within(n).queryByRole('textbox'))!
const open = (section: string) => renderApp(<SettingsPage />, { path: `/settings/${section}`, route: '/settings/:section' })

describe('Settings menu', () => {
  test('groups the sections under headings and marks the open one', () => {
    open('trash')
    const nav = menu()
    const groups = within(nav).getAllByRole('group')
    expect(groups.length).toBeGreaterThan(3)
    expect(within(nav).getByRole('link', { name: 'Trash' }).getAttribute('aria-current')).toBe('page')
    expect(within(nav).getByRole('link', { name: 'General' }).getAttribute('aria-current')).toBeNull()
  })

  test('the search keeps the matching sections only, and Escape brings the whole menu back', () => {
    open('general')
    const nav = menu()
    const all = within(nav).getAllByRole('link').length
    const search = within(nav).getByRole('textbox', { name: 'Search settings' })
    fireEvent.change(search, { target: { value: 'telegram' } })
    const left = within(nav).getAllByRole('link').map((a) => a.textContent)
    expect(left).toContain('Telegram')
    expect(left.length).toBeLessThan(all)
    fireEvent.keyDown(search, { key: 'Escape' })
    expect((search as HTMLInputElement).value).toBe('')
    expect(within(nav).getAllByRole('link')).toHaveLength(all)
  })

  test('a search without any match says so', () => {
    open('general')
    const nav = menu()
    fireEvent.change(within(nav).getByRole('textbox', { name: 'Search settings' }), { target: { value: 'zzzz-nothing' } })
    expect(within(nav).queryAllByRole('link')).toHaveLength(0)
    expect(within(nav).getByText('No setting matches.')).toBeTruthy()
  })

  test('Enter opens the first match', () => {
    open('general')
    const nav = menu()
    const search = within(nav).getByRole('textbox', { name: 'Search settings' })
    fireEvent.change(search, { target: { value: 'trash' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(within(menu()).getByRole('link', { name: 'Trash' }).getAttribute('aria-current')).toBe('page')
  })
})
