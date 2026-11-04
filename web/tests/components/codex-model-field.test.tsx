// The Codex model picker (features/codex/CodexModelField.tsx) shared by the new-session form (Codex, discussion, mixed
// team) and the cron editor: the CLI's models, Default (empty) and Other… for any id; a saved id outside the list is
// kept as it is.
import * as React from 'react'
import { describe, expect, test } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { CodexModelField } from '@/features/codex/CodexModelField'
import { mockApi, renderApp } from './render'

const LIST = { source: 'cli', models: [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', description: 'Latest frontier agentic coding model.' },
  { id: 'gpt-5.5', label: 'GPT-5.5', description: 'Frontier model.' },
  { id: 'gpt-x-preview', label: 'X Preview', description: '' },
] }

function Harness({ initial, seen }: { initial: string; seen: string[] }) {
  const [value, setValue] = React.useState(initial)
  return (
    <>
      <CodexModelField id="m" value={value} onChange={(v) => { seen.push(v); setValue(v) }} />
      <output data-testid="value">{value}</output>
    </>
  )
}

const trigger = () => screen.getByRole('combobox')
async function pick(name: string | RegExp) {
  fireEvent.keyDown(trigger(), { key: 'Enter' })
  fireEvent.click(await screen.findByRole('option', { name }))
}

describe('Codex model picker', () => {
  test('the CLI models, then back to the default; nothing is typed', async () => {
    mockApi({ 'GET /api/system/codex/models': LIST })
    const seen: string[] = []
    renderApp(<Harness initial="" seen={seen} />)
    await waitFor(() => expect(trigger().textContent).toBe('Default'))
    fireEvent.keyDown(trigger(), { key: 'Enter' })
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Default', 'GPT-5.6-Sol', 'GPT-5.5', 'X Preview · gpt-x-preview', 'Other…']))
    fireEvent.click(screen.getByRole('option', { name: 'GPT-5.5' }))
    expect(screen.getByTestId('value').textContent).toBe('gpt-5.5')
    expect(screen.queryByRole('textbox')).toBeNull()
    await pick('Default')
    expect(seen).toEqual(['gpt-5.5', ''])
  })

  test('Other… takes any id; a saved id outside the list shows there unchanged', async () => {
    mockApi({ 'GET /api/system/codex/models': LIST })
    const seen: string[] = []
    renderApp(<Harness initial="gpt-5.5-codex" seen={seen} />)
    const box = (await screen.findByRole('textbox', { name: 'Model identifier' })) as HTMLInputElement
    await waitFor(() => expect(trigger().textContent).toBe('Other…'))
    expect(box.value).toBe('gpt-5.5-codex')
    expect(seen).toEqual([])                                        // opening the form changes nothing
    await pick('GPT-5.6-Sol')
    expect(screen.queryByRole('textbox')).toBeNull()
    await pick('Other…')                                            // from a listed model: an empty field to fill
    const field = (await screen.findByRole('textbox', { name: 'Model identifier' })) as HTMLInputElement
    expect(field.value).toBe('')
    fireEvent.change(field, { target: { value: ' my-model ' } })
    expect(screen.getByTestId('value').textContent).toBe('my-model')
  })

  test('the list cannot be read: Default and Other… still work', async () => {
    mockApi({})
    renderApp(<Harness initial="" seen={[]} />)
    fireEvent.keyDown(trigger(), { key: 'Enter' })
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Default', 'Other…'])
  })
})
