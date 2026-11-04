// Built-in block renderers of conversation answers (features/blocks/builtins): table (filter, sort, pages), chart
// (chart and table views), form (required fields, confirmation, sent, later).
import * as React from 'react'
import { describe, expect, test, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { ChartBlock, TableBlock } from '@/features/blocks/builtins/data'
import { FormBlock } from '@/features/blocks/builtins/interactive'
import { BlockHostProvider } from '@/features/blocks/host'
import type { BlockPlugin } from '@/features/blocks/types'
import { ConfirmHost } from '@/components/ui/alert-dialog'
import { renderApp } from './render'

const plugin = (id: string): BlockPlugin => ({ id, kind: 'builtin', name: id, names: {}, renders: [id], icon: id, category: 'data', hint: '', fields: '', schema: {},
  raw: null, version: '1', description: '', enabled: true, error: null, network: [], consent: null, pin: false, entry_v: null, height: null })
const block = (type: string, data: Record<string, unknown>) => ({ type, data, plugin: plugin(type), raw: JSON.stringify(data) })

describe('Table block', () => {
  const rows = Array.from({ length: 12 }, (_, i) => [`Product ${String.fromCharCode(65 + i)}`, (i * 7) % 12 + 1, i % 2 ? 'EU' : 'US'])
  const table = () => renderApp(<TableBlock block={block('table', { title: 'Orders by product', columns: ['Product', 'Orders', 'Region'], rows })} size="inline" memoKey="t1" />)
  const bodyRows = () => screen.getAllByRole('row').slice(1) // after the header row

  test('shows the first page, then every row on demand', () => {
    table()
    expect(screen.getByText('Orders by product')).toBeTruthy()
    expect(bodyRows()).toHaveLength(10)
    expect(screen.getByText('10 of 12 rows')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(bodyRows()).toHaveLength(12)
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy()
  })

  test('the filter keeps the matching rows and says when none matches', () => {
    table()
    const [filter] = screen.getAllByRole('textbox', { name: 'Filter' })
    fireEvent.change(filter, { target: { value: 'product c' } })
    expect(bodyRows().map((r) => r.textContent)).toEqual([expect.stringContaining('Product C')])
    fireEvent.change(filter, { target: { value: 'nothing like it' } })
    expect(screen.getByText('No row matches')).toBeTruthy()
  })

  test('a number column sorts from the largest first, then the smallest, then back to the original order', () => {
    table()
    const header = () => screen.getByRole('button', { name: 'Orders' }).closest('th')!
    const orders = () => bodyRows().map((r) => Number(r.children[1].textContent))
    const before = orders()
    fireEvent.click(screen.getByRole('button', { name: 'Orders' }))
    expect(header().getAttribute('aria-sort')).toBe('descending')
    expect(orders()).toEqual([...orders()].sort((a, b) => b - a))
    fireEvent.click(screen.getByRole('button', { name: 'Orders' }))
    expect(header().getAttribute('aria-sort')).toBe('ascending')
    expect(orders()).toEqual([...orders()].sort((a, b) => a - b))
    fireEvent.click(screen.getByRole('button', { name: 'Orders' }))
    expect(header().getAttribute('aria-sort')).toBe('none')
    expect(orders()).toEqual(before)
  })
})

describe('Chart block', () => {
  test('draws the series and shows them as a table on demand', () => {
    renderApp(<ChartBlock block={block('chart', { title: 'Visits', kind: 'line', series: [{ name: 'Visits', points: [['Mon', 120], ['Tue', 180], ['Wed', 150]] }, { name: 'Signups', points: [['Mon', 4], ['Tue', 9]] }] })} size="inline" memoKey="c1" />)
    expect(document.querySelector('svg.recharts-surface, svg[role="img"], svg')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }))
    const rows = screen.getAllByRole('row').map((r) => r.textContent)
    expect(rows[0]).toContain('Visits')
    expect(rows[0]).toContain('Signups')
    expect(rows.find((r) => r?.startsWith('Tue'))).toContain('180')
    expect(rows.find((r) => r?.startsWith('Wed'))).toContain('150')
  })
})

describe('Form block', () => {
  const data = { title: 'Launch details', fields: [
    { id: 'name', label: 'Product name', type: 'text', required: true },
    { id: 'day', label: 'Launch day', type: 'select', options: ['Monday', 'Friday'], default: 'Friday' },
    { id: 'promo', label: 'Promo code', type: 'checkbox' },
  ] }
  const form = (send: (text: string) => Promise<boolean>, memoKey: string) => renderApp(
    <BlockHostProvider value={{ sessionId: 's1', send, agent: 'Claude Code' }}>
      <FormBlock block={block('form', data)} size="inline" memoKey={memoKey} />
      <ConfirmHost />
    </BlockHostProvider>,
  )

  test('a required field must be filled; the answers go to the agent once confirmed, then the form is sent', async () => {
    const send = vi.fn(async () => true)
    form(send, 'f1')
    expect(screen.getByText('Your answers are sent to Claude Code as your reply.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Required')).toBeTruthy()
    expect(send).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: /Product name/ }), { target: { value: 'Pilot Pro' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/Pilot Pro/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const text = send.mock.calls[0][0] as string
    expect(text).toContain('Product name')
    expect(text).toContain('Pilot Pro')
    expect(text).toContain('Friday')
    expect(await screen.findByText('Your answers were sent in this conversation.')).toBeTruthy()
    expect((screen.getByRole('textbox', { name: /Product name/ }) as HTMLInputElement).disabled).toBe(true)
  })

  test('Later puts the form aside until it is opened again', () => {
    form(vi.fn(async () => true), 'f2')
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByRole('textbox', { name: /Product name/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open the form' }))
    expect(screen.getByRole('textbox', { name: /Product name/ })).toBeTruthy()
  })
})
