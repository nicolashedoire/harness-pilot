import { describe, expect, test, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { PageFrame } from '@/features/extensions/PageFrame'
import { pageApiPath, pageAppRoute } from '@/features/extensions/pageBridge'
import { mockApi, renderApp } from './render'
import type { Extension } from '@/lib/types'

const ext = { id: 'notes', name: 'Notes', type: 'page', enabled: true, icon:'puzzle', version:'1', error:null, has_api:true, runtime: { page:'frame' } } as Extension

describe('isolated page bridge', () => {
  test.each(['../settings', '%2e%2e/settings', '%252e%252e/settings', 'x/%2f..%2fsettings', 'x/%5c..', 'x\\..\\settings', 'https://outside.test', '//outside.test', 'x/./y', 'x/%2525252fapi'])('rejects ambiguous path %s', (path) => {
    expect(() => pageApiPath(path)).toThrow()
  })
  test('keeps legitimate handler paths and query values separate', () => {
    expect(pageApiPath('/notes/hello world')).toBe('notes/hello%20world')
    expect(pageApiPath('')).toBe('')
  })
  test.each(['https://outside.test', '//outside.test', '/\\outside.test', '/api/settings', '/ext/x/page.js'])('rejects host navigation %s', (path) => {
    expect(() => pageAppRoute(path)).toThrow()
  })
  test('only its own opaque frame and current channel can call its own API', async () => {
    const calls = mockApi({ 'POST /api/ext/notes/notes': { ok: true } })
    renderApp(<PageFrame ext={ext} />, { path:'/x/notes' })
    const frame = screen.getByTitle('Notes') as HTMLIFrameElement
    const win = { postMessage: vi.fn() } as unknown as Window
    Object.defineProperty(frame, 'contentWindow', { value: win, configurable:true })
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
    const channel = JSON.parse(decodeURIComponent(new URL(frame.src).hash.slice(1))).channel
    const send = (data: object, source: MessageEventSource | null = frame.contentWindow, origin = 'null') => {
      window.dispatchEvent(new MessageEvent('message', { data: { mx:'page-api', seq:1, channel, path:'notes', method:'POST', body:{text:'hello'}, ...data }, source, origin }))
    }
    send({}, window)
    send({}, frame.contentWindow, 'https://other.test')
    send({ channel:'old-load' })
    send({ path:'../settings' })
    send({ method:'TRACE' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.length).toBe(0)
    send({ seq:2 })
    await waitFor(() => expect(calls.length).toBe(1))
    expect(calls[0].path).toBe('/api/ext/notes/notes')
    expect(calls[0].body).toEqual({ text:'hello' })
  })
  test('fatal mount errors offer retry and the normal correction workflow', async () => {
    mockApi({ 'POST /api/extensions/notes/errors': {ok:true}, 'GET /api/extensions': [ext] })
    renderApp(<PageFrame ext={ext} />, {path:'/x/notes'})
    const frame = screen.getByTitle('Notes') as HTMLIFrameElement
    const win = { postMessage: vi.fn() } as unknown as Window
    Object.defineProperty(frame, 'contentWindow', { value: win, configurable:true })
    const channel = JSON.parse(decodeURIComponent(new URL(frame.src).hash.slice(1))).channel
    window.dispatchEvent(new MessageEvent('message', {source:frame.contentWindow,origin:'null',data:{mx:'page-error',channel,message:'Mount failed',fatal:true}}))
    expect(await screen.findByRole('alert')).toBeTruthy()
    const before = frame.src
    fireEvent.click(screen.getByRole('button',{name:'Retry'}))
    await waitFor(() => expect((screen.getByTitle('Notes') as HTMLIFrameElement).src).not.toBe(before))
  })
  test('permission revocation recreates the document and its browser policy', async () => {
    function Revocation() {
      const [refused, setRefused] = useState(false)
      const current = { ...ext, access: { network: [{host:'api.example.com',status:refused?'refused':'allowed'}],refused } } as Extension
      return <><button onClick={() => setRefused(true)}>Withdraw access</button><PageFrame ext={current} /></>
    }
    renderApp(<Revocation />, {path:'/x/notes'})
    const before = (screen.getByTitle('Notes') as HTMLIFrameElement).src
    fireEvent.click(screen.getByRole('button',{name:'Withdraw access'}))
    await waitFor(() => expect((screen.getByTitle('Notes') as HTMLIFrameElement).src).not.toBe(before))
  })
})
