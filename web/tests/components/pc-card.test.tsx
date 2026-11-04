// Settings -> MCP -> Browser of my PC (features/pc/PcBrowserCard.tsx): with no harness-pilot PC to download (the
// server's pc_agent.json lists no file), the card says so instead of disappearing or offering a dead download.
import { describe, expect, test } from 'vitest'
import { screen } from '@testing-library/react'
import { PcBrowserCard } from '@/features/pc/PcBrowserCard'
import { mockApi, renderApp } from './render'

const status = (over: object = {}) => ({
  available: false, device: null, online: false, browser_running: false, mcp_running: false, last_use: null,
  pairing: null, candidate: null, mcp_registered: false, settings: { idle_min: 10 },
  browsers: ['brave', 'chrome', 'edge', 'vivaldi', 'opera', 'chromium'],
  targets: ['windows-amd64', 'windows-arm64', 'darwin-arm64', 'darwin-amd64', 'linux-amd64', 'linux-arm64'], actions: [],
  ...over,
})

describe('Browser of my PC card', () => {
  test('nothing published: says it is not available yet, offers no download', async () => {
    const calls = mockApi({ 'GET /api/pc': status() })
    renderApp(<PcBrowserCard />)
    expect(await screen.findByText('Not available yet')).toBeTruthy()
    expect(screen.getByTestId('pc-unavailable').textContent).toMatch(/not published for download yet/)
    expect(screen.queryByRole('button', { name: /Get harness-pilot PC/ })).toBeNull()
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })

  test('an agent to download: the setup, no notice', async () => {
    mockApi({ 'GET /api/pc': status({ available: true }) })
    renderApp(<PcBrowserCard />)
    expect(await screen.findByRole('button', { name: /Get harness-pilot PC/ })).toBeTruthy()
    expect(screen.queryByTestId('pc-unavailable')).toBeNull()
  })
})
