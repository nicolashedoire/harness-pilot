// Sorting a text column of a table block (features/blocks/builtins/data.tsx): text without a digit used to read as the
// number 0, so every cell compared equal and the order never changed.
import { expect, test } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { TableBlock } from '@/features/blocks/builtins/data'
import type { BlockPlugin } from '@/features/blocks/types'
import { renderApp } from './render'

const plugin = { id: 'table', kind: 'builtin', name: 'table', names: {}, renders: ['table'], icon: 'table', category: 'data', hint: '', fields: '', schema: {},
  raw: null, version: '1', description: '', enabled: true, error: null, network: [], consent: null, pin: false, entry_v: null, height: null } as BlockPlugin
const data = { columns: ['City', 'Region', 'Visits'], rows: [['Lyon', 'South', 40], ['Brest', 'West', 12], ['Nantes', 'West', 31], ['Arles', 'South', 8]] }

test('a text column sorts from A to Z, then from Z to A', () => {
  renderApp(<TableBlock block={{ type: 'table', data, plugin, raw: JSON.stringify(data) }} size="inline" memoKey="sort" />)
  const cities = () => screen.getAllByRole('row').slice(1).map((r) => r.children[0].textContent)
  fireEvent.click(screen.getByRole('button', { name: 'City' }))
  expect(cities()).toEqual(['Arles', 'Brest', 'Lyon', 'Nantes'])
  fireEvent.click(screen.getByRole('button', { name: 'City' }))
  expect(cities()).toEqual(['Nantes', 'Lyon', 'Brest', 'Arles'])
})

test('text with a number still sorts as a number (€9 before €45 before €120)', () => {
  const d = { columns: ['Plan', 'Price'], rows: [['Pro', '€120'], ['Basic', '€9'], ['Team', '€45']] }
  renderApp(<TableBlock block={{ type: 'table', data: d, plugin, raw: JSON.stringify(d) }} size="inline" memoKey="price" />)
  fireEvent.click(screen.getByRole('button', { name: 'Price' }))
  expect(screen.getAllByRole('row').slice(1).map((r) => r.children[0].textContent)).toEqual(['Basic', 'Team', 'Pro'])
})
