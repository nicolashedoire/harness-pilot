// Render a component as the app does (App.tsx): a router at `path` (matching `route`), a fresh React Query client, the
// tooltip provider, and an
// optional fake API (`mockApi({ 'GET /api/x': body })`; a function receives the parsed JSON body).
import * as React from 'react'
import { render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { vi } from 'vitest'
import { TooltipProvider } from '@/components/ui'

export function renderApp(ui: React.ReactElement, { path = '/', route = '*' }: { path?: string; route?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={route} element={ui} />
            <Route path="*" element={<div data-testid="elsewhere" />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

type Handler = unknown | ((body: unknown, url: URL) => unknown)
/** Fake API: keys are `METHOD /path` (no query string). Unlisted requests answer 404. Returns the calls made. */
export function mockApi(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; query: URLSearchParams; body: unknown }[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost')
    const method = (init?.method || 'GET').toUpperCase()
    let body: unknown = undefined
    if (typeof init?.body === 'string') try { body = JSON.parse(init.body) } catch { body = init.body }
    calls.push({ method, path: url.pathname, query: url.searchParams, body })
    const h = routes[`${method} ${url.pathname}`]
    if (h === undefined) return new Response(JSON.stringify({ error: 'not_found', message: 'No route in this test' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
    const out = typeof h === 'function' ? await (h as (b: unknown, u: URL) => unknown)(body, url) : h
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  return calls
}
