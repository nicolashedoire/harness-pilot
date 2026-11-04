// Unit tests of the theme engine (src/lib/theme). Run: npm test (plain Node, no dependency).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCENTS, BASES, DEFAULT_THEME, MODES, PRESETS, TOKENS, checkContrast, compactTheme, contrastOf, deriveTokens, emptyTokens,
  expandTheme, isColor, legacyTheme, matchPreset, nearestAccent, normalizeHex, normalizeTheme, parseThemeFile, sameColor, themeCss,
  type Theme,
} from '../src/lib/theme/index'

const theme = (p: Partial<Theme>): Theme => ({ ...DEFAULT_THEME, tokens: emptyTokens(), ...p })

test('colour syntax: hex, rgb, hsl, oklch only', () => {
  for (const ok of ['#fff', '#FFFFFF', '#11223344', 'rgb(1, 2, 3)', 'rgb(1 2 3 / 50%)', 'rgba(1,2,3,0.5)', 'hsl(210 50% 40%)', 'hsl(210deg, 50%, 40%)', 'oklch(0.5 0.1 250)', 'oklch(50% 0.1 250 / 0.4)'])
    assert.ok(isColor(ok), ok)
  for (const bad of ['red', 'transparent', 'url(x)', 'var(--a)', '#fff;', 'rgb(1,2,3);color:red', 'expression(1)', 'rgb(1,2)', 'oklch(0.5 0.1 250) }', '#ggg', 'rgb(1,2,3)) x', '', 'a'.repeat(80)])
    assert.ok(!isColor(bad), bad)
  assert.equal(normalizeHex('rgb(255, 0, 0)'), '#ff0000')
  assert.equal(normalizeHex('hsl(120 100% 25%)'), '#008000')
  assert.equal(normalizeHex('oklch(1 0 0)'), '#ffffff')
})

test('every preset combination keeps text >= 4.5:1 and UI parts >= 3:1 in light and dark', () => {
  const failures: string[] = []
  for (const base of BASES)
    for (const accent of [...ACCENTS, '#2d6efd'])
      for (const buttons of ['accent', 'neutral'] as const)
        for (const tint of ['neutral', 'tinted'] as const)
          for (const mode of MODES)
            for (const c of checkContrast(deriveTokens(theme({ base, accent, buttons, tint }), mode), mode))
              if (c.ratio < c.min) failures.push(`${base}/${accent}/${buttons}/${tint}/${mode}: ${c.fg} on ${c.bg} ${c.ratio}`)
  assert.deepEqual(failures, [])
})

test('derived tokens: every token, colours only; neutral buttons are monochrome', () => {
  for (const mode of MODES) {
    const t = deriveTokens(DEFAULT_THEME, mode)
    assert.deepEqual(Object.keys(t).sort(), [...TOKENS].sort())
    for (const v of Object.values(t)) assert.ok(isColor(v), v)
    const n = deriveTokens(theme({ buttons: 'neutral' }), mode)
    assert.equal(n.action, n.foreground)
    assert.equal(n['action-foreground'], n.background)
    assert.equal(n.ring, n.primary)
  }
})

test('custom accent: readable primary in both modes, label by contrast', () => {
  for (const hex of ['#ffe600', '#0a1a3a', '#ff5ad1', '#808080', '#2d6efd']) {
    for (const mode of MODES) {
      const t = deriveTokens(theme({ accent: hex }), mode)
      assert.ok(contrastOf(t.primary, t.background) >= 4.5, `${hex} ${mode} primary`)
      assert.ok(contrastOf(t['primary-foreground'], t.primary) >= 4.5, `${hex} ${mode} label`)
      assert.ok(contrastOf(t['action-foreground'], t.action) >= 4.5, `${hex} ${mode} action`)
    }
  }
  // the logo blue keeps white labels (Marine), a light orange gets black ones
  for (const mode of MODES) {
    assert.equal(normalizeHex(deriveTokens(theme({ accent: '#2d6efd' }), mode)['action-foreground']), '#fcfcfc')
    assert.notEqual(normalizeHex(deriveTokens(theme({ accent: '#ffa94d' }), mode)['action-foreground']), '#fcfcfc')
  }
  assert.equal(nearestAccent('#ff7a00'), 'clay')
  assert.equal(nearestAccent('#1e6cff'), 'blue')
})

test('normalise: unknown keys dropped, unsafe values refused, schema checked', () => {
  const { theme: t, report } = normalizeTheme({
    schema: 1, id: 'My Theme!', name: '  Night <b>owl</b>  ', extra: 1, base: 'marine', accent: 'rgb(255, 0, 0)', buttons: 'neutral', tint: 'weird',
    tokens: { light: { background: '#fafafa', nope: '#000', primary: 'url(evil)' }, dark: { card: 'var(--x)' }, other: { background: '#000' } },
  })
  assert.equal(t.id, 'custom')
  assert.equal(t.name, 'Night bowl/b')
  assert.equal((t as Record<string, unknown>).extra, undefined)
  assert.equal(t.base, 'marine')
  assert.equal(t.accent, '#ff0000')
  assert.equal(t.buttons, 'neutral')
  assert.equal(t.tint, 'neutral')
  assert.deepEqual(Object.keys(t.tokens.light), ['background'])
  assert.deepEqual(t.tokens.dark, {})
  assert.ok(report.errors.some((e) => e.includes('primary')))
  assert.ok(report.errors.some((e) => e.includes('card')))
  assert.ok(report.errors.some((e) => e.startsWith('id')))
  assert.ok(normalizeTheme({ schema: 2 }).report.errors[0].includes('schema'))
  assert.equal(parseThemeFile('not json').theme, null)
  assert.equal(parseThemeFile('x'.repeat(20000)).theme, null)
})

test('normalise: failing foregrounds are fixed to black / white, other failures flagged', () => {
  const { theme: t, report } = normalizeTheme(theme({ tokens: { light: { primary: '#ffee00', 'primary-foreground': '#ffffff', 'muted-foreground': '#dddddd' }, dark: {} } }))
  assert.ok(report.fixed.some((f) => f.fg === 'primary-foreground' && f.mode === 'light'))
  assert.ok(contrastOf(deriveTokens(t, 'light')['primary-foreground'], '#ffee00') >= 4.5)
  assert.ok(report.issues.some((i) => i.fg === 'muted-foreground' && i.mode === 'light'))
  assert.ok(report.issues.some((i) => i.fg === 'primary' && i.bg === 'background'))
})

test('presets: export / import round trip, compaction, legacy mapping', () => {
  for (const p of PRESETS) {
    const file = JSON.stringify(expandTheme(p))
    const back = parseThemeFile(file).theme!
    assert.equal(matchPreset(back)?.id, p.id, p.id)
    assert.deepEqual(back.tokens, emptyTokens())
  }
  const custom = compactTheme(theme({ tokens: { light: { background: 'oklch(1 0 0)', card: '#f0f0f0' }, dark: {} } }))
  assert.deepEqual(Object.keys(custom.tokens.light), ['card'])
  assert.equal(legacyTheme('blue', 'neutral').id, 'zinc')
  const old = legacyTheme('violet', 'tinted')
  assert.equal(old.id, 'custom')
  assert.deepEqual([old.base, old.accent, old.buttons, old.tint], ['zinc', 'violet', 'accent', 'tinted'])
  assert.equal(legacyTheme('teal', undefined).accent, 'blue')
})

test('css: every token in both blocks, nothing but colours', () => {
  const css = themeCss(PRESETS[2])
  assert.match(css, /^html:root\{--background:[^;{}]+(;--[a-z-]+:[^;{}]+)+\}\nhtml:root\.dark\{/)
  for (const k of TOKENS) assert.equal(css.split(`--${k}:`).length, 3, k)
})

test('styles/globals.css fallback = the default palette', async () => {
  const { readFileSync } = await import('node:fs')
  const css = readFileSync(new URL('../src/styles/globals.css', import.meta.url), 'utf8')
  const blockOf = (sel: string) => css.slice(css.indexOf(`\n${sel} {`) + 1).split('\n}')[0]
  for (const [sel, mode] of [[':root', 'light'], ['.dark', 'dark']] as const) {
    const block = blockOf(sel)
    const want = deriveTokens(DEFAULT_THEME, mode)
    for (const k of TOKENS) {
      const m = block.match(new RegExp(`\\n\\s*--${k}:\\s*([^;]+);`))
      assert.ok(m, `${sel} --${k} missing`)
      assert.ok(sameColor(m![1], want[k]), `${sel} --${k}: ${m![1]} != ${want[k]}`)
    }
  }
})

test('theme code: round trip, pasted JSON, refusals', async () => {
  const { THEME_CODE_PREFIX, parseThemeText, sameLook, themeCode } = await import('../src/lib/theme/index')
  const t = theme({ id: 'ember', name: 'Ember « braise »', base: 'custom', accent: '#e8915a', tokens: { light: {}, dark: { background: '#14100d', card: '#1c1612' } } })
  const code = themeCode(t)
  assert.ok(code.startsWith(THEME_CODE_PREFIX) && /^theme1:[A-Za-z0-9_-]+$/.test(code))
  const back = parseThemeText(`  ${code.slice(0, 20)}\n${code.slice(20)}  `)
  assert.ok(back.theme && sameLook(back.theme, t) && back.theme.name === t.name && back.report.errors.length === 0)
  assert.ok(sameLook(parseThemeText(JSON.stringify(t)).theme!, t))
  assert.ok(!sameLook(t, { ...t, accent: '#14b8a6' }))
  // never trusted: unsafe values dropped and reported, junk and oversize refused
  const evil = parseThemeText(themeCode(t).slice(0, 7) + Buffer.from(JSON.stringify({ ...t, tokens: { light: {}, dark: { card: 'url(https://x.example/a)' } } })).toString('base64url'))
  assert.ok(evil.theme && !('card' in evil.theme.tokens.dark) && evil.report.errors.some((e) => e.includes('card')))
  for (const bad of ['hello', 'theme1:%%%', 'theme1:' + 'A'.repeat(30000), 'theme1:' + Buffer.from('[1,2]').toString('base64url'), 'theme1:' + Buffer.from([0xff, 0xfe]).toString('base64url'), '{nope'])
    assert.equal(parseThemeText(bad).theme, null, bad.slice(0, 20))
})
