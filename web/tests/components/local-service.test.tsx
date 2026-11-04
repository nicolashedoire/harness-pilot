// Settings -> System in a local installation (pages/settings/sections/System.tsx): the background service card of a
// Mac (state, files, commands to copy, no action button) and the Git update, hidden on a server.
import { describe, expect, test } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { SystemSection } from '@/pages/settings/sections/System'
import { mockApi, renderApp } from './render'

const version = (local: boolean) => ({ version: '2.0.0', commit: 'a1b2c3d', latest_commit: 'e4f5a6b', behind: 3, local_mode: local, auto_update: { enabled: false } })
const REPO = '/Users/me/harness-pilot'
const service = (over: object = {}) => ({
  supported: true, installed: true, running: true, since: Date.now() / 1000 - 2 * 3600 - 14 * 60, label: 'local.harness-pilot',
  plist: '/Users/me/Library/LaunchAgents/local.harness-pilot.plist', logs: `${REPO}/.harness-pilot-local/logs`, url: 'http://127.0.0.1:8787',
  commands: { install: `bash ${REPO}/scripts/dev-local.sh service install`, status: `bash ${REPO}/scripts/dev-local.sh service status`,
    restart: `bash ${REPO}/scripts/dev-local.sh service restart`, uninstall: `bash ${REPO}/scripts/dev-local.sh service uninstall`, update: `git -C ${REPO} pull` },
  ...over,
})
const card = () => screen.findByTestId('local-service')

describe('Local installation: background service', () => {
  test('running as the service: its state, files and commands, no action button', async () => {
    mockApi({ 'GET /api/system/version': version(true), 'GET /api/system/local-service': service() })
    renderApp(<SystemSection />)
    const c = await card()
    const section = c.closest('[data-slot="card"]') as HTMLElement || c.parentElement!.parentElement!
    expect(within(section).getByRole('heading', { name: 'Background service' })).toBeTruthy()
    expect(within(section).getByText(/^Running · started/)).toBeTruthy()
    expect(within(c).getByText('/Users/me/Library/LaunchAgents/local.harness-pilot.plist')).toBeTruthy()
    expect(within(c).getByText(`${REPO}/.harness-pilot-local/logs`)).toBeTruthy()
    expect(within(c).getByText(`bash ${REPO}/scripts/dev-local.sh service restart`)).toBeTruthy()
    expect(within(c).getByText(`bash ${REPO}/scripts/dev-local.sh service uninstall`)).toBeTruthy()
    expect(within(c).queryByText(/service install/)).toBeNull()
    // commands to copy only: no button that would restart, stop or remove the service from here
    expect(within(c).queryByRole('button', { name: /Restart|Stop|Uninstall/ })).toBeNull()
    expect(within(c).getAllByRole('button', { name: 'Copy' })).toHaveLength(3)
    // the update goes through Git, then the service restarts the app
    const update = screen.getByTestId('local-update')
    expect(within(update).getByText(`git -C ${REPO} pull`)).toBeTruthy()
    expect(within(update).getByText(`bash ${REPO}/scripts/dev-local.sh service restart`)).toBeTruthy()
    expect(screen.queryByText('Services')).toBeNull() // the systemd cards of a server
  })

  test('not installed: the install command and what it needs; the update restarts in the terminal', async () => {
    mockApi({ 'GET /api/system/version': version(true), 'GET /api/system/local-service': service({ installed: false, running: false, since: null }) })
    renderApp(<SystemSection />)
    const c = await card()
    expect(screen.getByText('Not installed')).toBeTruthy()
    expect(within(c).getByText(`bash ${REPO}/scripts/dev-local.sh service install`)).toBeTruthy()
    expect(within(c).getByText(/the service keeps that PATH/)).toBeTruthy()
    expect(within(c).queryByText(/LaunchAgents/)).toBeNull()
    expect(within(screen.getByTestId('local-update')).getByText(/Ctrl\+C/)).toBeTruthy()
  })

  test('installed while the app runs from a terminal: says so', async () => {
    mockApi({ 'GET /api/system/version': version(true), 'GET /api/system/local-service': service({ running: false, since: null }) })
    renderApp(<SystemSection />)
    const c = await card()
    expect(screen.getByText('Installed')).toBeTruthy()
    expect(within(c).getByText(/started another way/)).toBeTruthy()
  })

  test('local installation elsewhere than on a Mac: no card, the Git update text alone', async () => {
    mockApi({ 'GET /api/system/version': version(true), 'GET /api/system/local-service': { supported: false } })
    renderApp(<SystemSection />)
    const update = await screen.findByTestId('local-update')
    await waitFor(() => expect(within(update).getByText(/you update it with Git/)).toBeTruthy())
    expect(within(update).queryByText(/git -C/)).toBeNull()
    expect(screen.queryByTestId('local-service')).toBeNull()
  })

  test('on a server: nothing of it, and the service is never asked', async () => {
    const calls = mockApi({ 'GET /api/system/version': version(false), 'GET /api/system/services': [] })
    renderApp(<SystemSection />)
    await screen.findByText('v2.0.0')
    expect(screen.queryByTestId('local-service')).toBeNull()
    expect(screen.queryByTestId('local-update')).toBeNull()
    expect(calls.some((c) => c.path === '/api/system/local-service')).toBe(false)
  })
})
