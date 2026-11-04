// Mock of the conversation blocks API (docs/dev/API.md#conversation-blocks) for web/mock/server.mjs: the plugin
// list, enable / disable, network consent, dashboard pins, the sandboxed frames (same bridge and policy as
// server/maxxing/api/blocks.py, read from that file) and showcase sessions with every block type and fallback state.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '../..')
const BUILTINS = JSON.parse(fs.readFileSync(path.join(__dirname, 'blocks-builtins.json'), 'utf8'))
const API_PY = fs.readFileSync(path.join(REPO, 'server/maxxing/api/blocks.py'), 'utf8')
const pyString = (name) => {
  const m = new RegExp(`${name} = r"""([\\s\\S]*?)"""`).exec(API_PY)
  return m ? m[1] : ''
}
const BRIDGE = pyString('BRIDGE')
const APP_LOADER = pyString('APP_LOADER')
const BASE_CSS = '*,*::before,*::after{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--foreground);font:13px/1.45 Inter,system-ui,sans-serif}'
const UI_KIT = (() => {
  try {
    return fs.readFileSync(path.join(REPO, 'server/maxxing/assets/ui-kit.css'), 'utf8')
  } catch {
    return ''
  }
})()
const KANBAN_DIR = path.join(REPO, 'examples/extensions/kanban-block')
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

const MAP_HTML = `<style>
  .map{position:relative;height:240px;border-radius:10px;border:1px solid var(--border);overflow:hidden;
    background:repeating-linear-gradient(0deg,transparent 0 39px,color-mix(in oklab,var(--border) 70%,transparent) 39px 40px),repeating-linear-gradient(90deg,transparent 0 39px,color-mix(in oklab,var(--border) 70%,transparent) 39px 40px),var(--muted)}
  .pin{position:absolute;transform:translate(-50%,-100%);display:grid;justify-items:center;gap:2px;font-size:12px}
  .pin i{width:12px;height:12px;border-radius:50%;background:var(--primary);box-shadow:0 0 0 4px color-mix(in oklab,var(--primary) 25%,transparent)}
  .pin b{background:var(--card);border:1px solid var(--border);border-radius:6px;padding:1px 6px;font-weight:500}
</style><div class="map" id="m"></div>
<script>maxxing.onData(function(d){var m=document.getElementById('m');m.textContent='';var pts=d.points||[];
var la=pts.map(function(p){return p.lat}),lo=pts.map(function(p){return p.lon});var a=Math.min.apply(0,la),b=Math.max.apply(0,la),c=Math.min.apply(0,lo),e=Math.max.apply(0,lo);
pts.forEach(function(p){var el=document.createElement('div');el.className='pin';el.style.left=(10+80*((p.lon-c)/((e-c)||1)))+'%';el.style.top=(85-70*((p.lat-a)/((b-a)||1)))+'%';
var i=document.createElement('i'),t=document.createElement('b');t.textContent=p.label||'';el.appendChild(i);el.appendChild(t);m.appendChild(el)})})</script>`

function mockPlugins(st) {
  const kb = readJson(path.join(KANBAN_DIR, 'block.json'))
  const ext = (id, m, extra) => ({
    id, kind: 'extension', name: typeof m.name === 'object' ? m.name.en : m.name, names: typeof m.name === 'object' ? m.name : {},
    renders: m.renders, icon: m.icon || 'puzzle', category: m.category || 'other', hint: m.hint || '', fields: '',
    schema: m.schema, raw: null, version: m.version || '', description: m.description || '',
    enabled: !st.blocks.disabledExt.includes(id), error: null, network: (m.permissions && m.permissions.network) || [],
    consent: null, pin: false, entry_v: 1, height: m.height || 320, ...extra,
  })
  const list = BUILTINS.map((b) => ({
    id: b.type, kind: 'builtin', name: b.type, names: {}, renders: [b.type], icon: b.icon, category: b.category, hint: b.hint,
    fields: b.fields, schema: b.schema, raw: b.raw || null, version: '', description: '', enabled: !st.blocks.disabled.includes(b.type),
    error: null, network: [], consent: null, pin: !!b.pin, entry_v: null, height: null,
  }))
  list.push(ext('kanban-block', { ...kb, schema: readJson(path.join(KANBAN_DIR, 'schema.json')) }))
  const map = ext('map', {
    name: { en: 'Map', fr: 'Carte' }, version: '1.2.0', renders: ['map'], icon: 'map', category: 'data', permissions: { network: ['tiles.example.com'] },
    hint: 'Places, addresses and routes.', description: 'Points and areas on a map, from addresses or coordinates.', height: 250,
    schema: { type: 'object', required: ['points'], properties: { title: { type: 'string' }, points: { type: 'array', items: { type: 'object', required: ['lat', 'lon'], properties: { label: { type: 'string' }, lat: { type: 'number' }, lon: { type: 'number' } } } } } },
  })
  const c = st.blocks.consent.map
  map.consent = c === 'granted' ? 'granted' : c === 'denied' ? 'denied' : 'ask'
  list.push(map)
  list.push(ext('roadmap', { name: { en: 'Roadmap', fr: 'Frise chronologique' }, version: '0.4.0', renders: ['roadmap'], icon: 'calendar-range', category: 'organisation', hint: 'Dated steps of a project.', description: 'Dated steps of a project, a history or a plan.', schema: { type: 'object', required: ['steps'] } }))
  return list
}

export function blocksState() {
  return { disabled: [], disabledExt: ['roadmap'], consent: {}, grants: new Set() }
}

export function installBlocks({ R, state, fail, bus }) {
  const catalog = () => {
    const S = state()
    const plugins = mockPlugins(S)
    const types = plugins.filter((p) => p.enabled && !p.error).flatMap((p) => p.renders)
    return { plugins, agents: { types, count: types.length, skill: '/root/.claude/skills/pilot-blocks/SKILL.md', codex: '/var/lib/claude-maxxing/blocks/agents.md', reference: '/var/lib/claude-maxxing/blocks/reference.md', synced_at: Date.now() / 1000 } }
  }
  R('GET', '/api/blocks', () => catalog())
  R('PATCH', '/api/blocks/:id', ({ params, body }) => {
    const S = state()
    const p = mockPlugins(S).find((x) => x.id === params.id) || fail(404, 'not_found', `no block plugin ${params.id}`)
    const list = p.kind === 'builtin' ? S.blocks.disabled : S.blocks.disabledExt
    const i = list.indexOf(p.id)
    if (body.enabled && i >= 0) list.splice(i, 1)
    if (!body.enabled && i < 0) list.push(p.id)
    bus('extensions')
    return { ok: true, plugin: mockPlugins(S).find((x) => x.id === params.id) }
  })
  R('POST', '/api/blocks/:id/consent', ({ params, body }) => {
    const S = state()
    const p = mockPlugins(S).find((x) => x.id === params.id && x.kind === 'extension') || fail(404, 'not_found', `no block extension ${params.id}`)
    if (!p.network.length) fail(400, 'no_network', 'this block asks for no network access')
    if (body.decision === 'once') {
      const grant = crypto.randomBytes(12).toString('base64url')
      S.blocks.grants.add(grant)
      return { ok: true, consent: p.consent, grant }
    }
    if (body.decision === 'reset') delete S.blocks.consent[p.id]
    else S.blocks.consent[p.id] = body.decision === 'always' ? 'granted' : 'denied'
    bus('extensions')
    return { ok: true, consent: mockPlugins(S).find((x) => x.id === p.id).consent }
  })
  R('POST', '/api/blocks/pin', ({ body }) => {
    const b = BUILTINS.find((x) => x.type === body.type)
    if (!b || !b.pin) fail(400, 'not_pinnable', `${body.type} blocks cannot be pinned to the dashboard`)
    bus('extensions')
    return { ok: true, id: `pin-${String(body.title || body.type).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}-${crypto.randomBytes(3).toString('hex')}` }
  })
}

const csp = (hosts) => {
  const src = hosts.map((h) => `https://${h}`).join(' ')
  const media = `data: blob:${src ? ' ' + src : ''}`
  return `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${media}; media-src ${media}; font-src data:${src ? ' ' + src : ''}; connect-src ${src || "'none'"}; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`
}
const esc = (s) => s.replace(/<\//g, '<\\/')

export function serveBlockFrame(req, res, url, authed, state) {
  const send = (status, body, hosts = []) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': csp(hosts), 'Referrer-Policy': 'no-referrer' })
    res.end(body)
  }
  if (!authed) return send(401, 'auth required')
  const S = state()
  if (url.pathname === '/ext/_blocks/app-frame') {
    return send(200, `<!doctype html><meta charset="utf-8"><script type="text/plain" id="mxb">${esc(BRIDGE)}</script><script type="text/plain" id="mxk">${esc(BASE_CSS + UI_KIT)}</script><script>${esc(APP_LOADER)}</script>`)
  }
  const m = /^\/ext\/_blocks\/([^/]+)\/frame$/.exec(url.pathname)
  const p = m && mockPlugins(S).find((x) => x.id === m[1] && x.kind === 'extension' && x.enabled)
  if (!p) return send(404, 'no such block extension')
  const html = p.id === 'kanban-block' ? fs.readFileSync(path.join(KANBAN_DIR, 'block.html'), 'utf8') : p.id === 'map' ? MAP_HTML : '<p>Roadmap</p>'
  const grant = url.searchParams.get('grant')
  const hosts = p.consent === 'granted' || (p.consent !== 'denied' && grant && S.blocks.grants.has(grant)) ? p.network : []
  return send(200, `<!doctype html><meta charset="utf-8"><script>${esc(BRIDGE)}</script><style>${BASE_CSS}${UI_KIT}</style>\n${html}`, hosts)
}

/* ------------------------------------------------------------------ showcase sessions */
const j = (type, data) => '```' + type + '\n' + JSON.stringify(data, null, 1) + '\n```'

const DATA_ANSWER = (root) => [
  'October beats September on every indicator, carried by the second half of the month. Here is the detail.',
  j('stats', { items: [{ label: 'Revenue', value: '12 480 €', delta: '+18 % vs Sept' }, { label: 'Orders', value: 312, delta: '+11 %' }, { label: 'Average basket', value: '40.00 €', delta: '+6 %' }, { label: 'Refunds', value: 7, delta: '+2', tone: 'warn' }] }),
  j('chart', {
    title: 'Revenue per day', kind: 'line', unit: '€', source: 'sales-october.csv, sales-september.csv',
    series: [
      { name: 'October', points: [['1 Oct', 330], ['4 Oct', 318], ['8 Oct', 395], ['11 Oct', 362], ['15 Oct', 410], ['18 Oct', 396], ['22 Oct', 468], ['25 Oct', 512], ['28 Oct', 530], ['31 Oct', 652]] },
      { name: 'September', points: [['1 Oct', 320], ['4 Oct', 300], ['8 Oct', 360], ['11 Oct', 320], ['15 Oct', 345], ['18 Oct', 322], ['22 Oct', 362], ['25 Oct', 371], ['28 Oct', 380], ['31 Oct', 398]] },
    ],
  }),
  j('table', {
    title: 'Best products', source: 'sales-october.csv', page_size: 4,
    columns: ['Product', { label: 'Revenue', type: 'number' }, { label: 'Sales', type: 'number' }, { label: 'Share of total', type: 'bar' }, { label: 'vs Sept', type: 'delta' }],
    rows: [['Ceramic mug', 3120, 104, 25, '+32 %'], ['A5 notebook', 2460, 164, 20, '+9 %'], ['Canvas bag', 1980, 66, 16, '-4 %'], ['Poster 30 × 40', 1450, 58, 12, '+21 %'], ['Tea towel', 980, 49, 8, '+3 %'], ['Gift card', 760, 19, 6, '+40 %']],
  }),
  'The canvas bag dips slightly: it was out of stock from 12 to 16 October.',
  j('list', { title: 'Stock to watch', items: [{ title: 'Canvas bag', subtitle: 'Back in stock on 17 Oct', status: 'warn', icon: 'shopping-bag', value: 12 }, { title: 'Ceramic mug', subtitle: 'Best seller', status: 'ok', icon: 'store', value: 86 }, { title: 'Gift card', subtitle: 'Digital', status: 'ok', icon: 'credit-card', value: '∞', href: '/tasks' }] }),
  j('progress', { title: 'Monthly goals', items: [{ label: 'Revenue goal', value: 12480, max: 15000, unit: '€' }, { label: 'New customers', value: 64, max: 100, format: 'percent' }] }),
  j('timeline', {
    title: 'Shop jobs this week', start: '2026-11-02T00:00:00Z', end: '2026-11-09T00:00:00Z', now: '2026-11-04T15:00:00Z',
    lanes: [
      { name: 'Stock sync', sub: 'every day 06:00', events: ['02', '03', '04'].map((d) => ({ at: `2026-11-${d}T06:00:00Z`, state: 'ok' })).concat([{ at: '2026-11-05T06:00:00Z', state: 'planned' }]) },
      { name: 'Sales report', sub: 'Mondays 08:30', events: [{ at: '2026-11-02T08:30:00Z', state: 'ok' }] },
      { name: 'Price watch', sub: 'every 6 h', events: [{ at: '2026-11-03T00:00:00Z', state: 'ok' }, { at: '2026-11-03T12:00:00Z', state: 'error', label: 'Timeout' }, { at: '2026-11-04T12:00:00Z', state: 'running' }] },
    ],
  }),
].join('\n\n')

const CODE_ANSWER = (root) => [
  'The test checks that the Apple Pay button comes first in the form, but the new free-shipping banner is now shown before it.',
  j('terminal', { command: 'npm test -- steps', exit_code: 1, duration_ms: 4200, output: 'FAIL src/checkout/steps.test.tsx\n  ✕ keeps Apple Pay on top (12 ms)\n\n  Expected: "apple-pay"\n  Received: "free-shipping-banner"\n\nTests: 1 failed, 23 passed, 24 total' }),
  'I move the banner under the Apple Pay button, which keeps the rule we set last week.',
  j('diff', { path: `${root}/projects/acme/topics/website/src/checkout/steps.tsx`, diff: '@@ -40,8 +40,8 @@ export function CheckoutForm() {\n export function CheckoutForm() {\n   return (\n     <form className="checkout">\n-      <FreeShippingBanner />\n       <ApplePayButton />\n+      <FreeShippingBanner />\n       <ShippingAndPayment />\n     </form>\n   )\n' }),
  '```terminal\n$ npm test\n\n Test Files  6 passed (6)\n      Tests  24 passed (24)\n   Duration  6.80s\n```',
  'The hero image and the latest report:',
  j('file', { items: [{ path: `${root}/projects/acme/topics/website/attachments/2026-10/hero-mobile.png`, caption: 'Hero on a phone' }, { path: `${root}/projects/acme/topics/blog/images/cover-checkout.png`, caption: 'Blog cover' }, { path: `${root}/projects/acme/topics/seo/reports/2026-W40.md`, caption: 'SEO report, week 40' }] }),
  j('link', { url: 'https://ui.example.com/checkout', title: 'Checkout - Acme', description: 'Preview deployed with the fix: Apple Pay stays on top, the banner moved under it.', site: 'ui.example.com' }),
].join('\n\n')

const INTERACTIVE_ANSWER = [
  'A few settings before I prepare everything:',
  j('form', {
    title: 'Campaign settings', submit: 'Send',
    fields: [
      { id: 'audience', label: 'Audience', type: 'choice', options: ['Existing customers', 'New customers', 'Both'], default: 'Both' },
      { id: 'budget', label: 'Ad budget', type: 'range', min: 0, max: 1000, step: 50, unit: '€', default: 200 },
      { id: 'start', label: 'Start', type: 'date', default: '2026-11-10' },
      { id: 'channels', label: 'Channels', type: 'multi', options: ['E-mail', 'Instagram', 'Telegram'], default: ['E-mail', 'Instagram'] },
      { id: 'note', label: 'Anything else?', type: 'textarea', placeholder: 'Optional' },
    ],
  }),
  'To set the launch price, here is a small simulator:',
  j('app', { title: 'Price simulator', height: 200, html: '<div style="display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:14px;align-items:end"><div class="ui-field"><span class="ui-label">Selling price (€)</span><input id="p" class="ui-input" type="number" value="29" step="0.5"></div><div class="ui-card" style="padding:10px 14px"><span class="ui-muted ui-small">Shown price</span><div id="o" class="ui-h2" style="margin:2px 0 0"></div></div><div class="ui-card" style="padding:10px 14px"><span class="ui-muted ui-small">Margin</span><div id="g" class="ui-h2" style="margin:2px 0 0"></div></div></div><div class="ui-field" style="margin-top:12px"><span class="ui-label">Launch discount: <b id="dv">12</b> %</span><input id="d" type="range" min="0" max="40" value="12" style="accent-color:var(--primary);width:60%"></div><p style="margin:12px 0 0"><button class="ui-btn ui-sm" id="use">Use this price</button></p><script>const p=document.getElementById("p"),d=document.getElementById("d"),o=document.getElementById("o"),g=document.getElementById("g"),dv=document.getElementById("dv");function f(){const v=p.value*(1-d.value/100);o.textContent=v.toFixed(2)+" €";g.textContent=Math.round((v-15)/v*100)+" %";dv.textContent=d.value}p.oninput=f;d.oninput=f;f();document.getElementById("use").onclick=()=>maxxing.send("Use a launch price of "+o.textContent+" ("+d.value+" % off "+p.value+" €).")</script>' }),
  j('created', { title: 'What I created for you', items: [{ kind: 'task', title: 'Proofread the launch email', subtitle: 'Acme · before 9 Nov', id: 't_8f2a' }, { kind: 'cron', title: 'Campaign report', subtitle: 'Every Monday at 08:30', id: 'c_51bd' }, { kind: 'notification', title: 'Mug stock under 20', subtitle: 'Sound · Telegram' }] }),
  j('checklist', { title: 'Before sending on 10 Nov', submit: 'Send the checklist', items: [{ label: 'Pick the main visual', checked: true }, 'Proofread the email subject', 'Test the product page link'] }),
].join('\n\n')

const STATES_ANSWER = [
  'A block drawn by an extension (kanban-block), in its isolated frame:',
  j('kanban', { title: 'Mug launch', columns: [{ name: 'To do', cards: ['Proofread the email', { title: 'Test the product link', tag: 'web' }] }, { name: 'Doing', cards: [{ title: 'Teaser video', note: '15 s, light background', tag: 'video' }] }, { name: 'Done', cards: ['Pick the main visual'] }] }),
  'A block extension that asks for the network first:',
  j('map', { title: 'Pick-up points', points: [{ label: 'Workshop', lat: 48.85, lon: 2.35 }, { label: 'Shop', lat: 48.87, lon: 2.33 }, { label: 'Market', lat: 48.83, lon: 2.39 }] }),
  'A block whose plugin is turned off:',
  j('roadmap', { title: 'Launch plan', steps: [{ date: '2026-11-10', label: 'E-mail' }] }),
  'A block no plugin draws:',
  j('block:calendar', { title: 'Launch week', events: [{ date: '2026-11-10', title: 'E-mail' }] }),
  'A block with invalid data:',
  j('chart', { title: 'Visits', kind: 'pie', series: [{ name: 'Visits', points: [['Mon', 'many']] }] }),
].join('\n\n')

export function seedBlocksSessions(st, t, { uuid, topicPath, ROOT, MIN, HOUR }) {
  const shows = [
    { title: 'October sales report', path: topicPath('acme', 'website'), ago: 8 * MIN, prompt: 'Analyse October sales against September: the key figures, the daily trend and the best products.', answer: DATA_ANSWER(ROOT) },
    { title: 'Checkout test failing', path: topicPath('acme', 'website'), ago: 12 * MIN, prompt: 'The checkout test fails since this morning. Find out why and fix it.', answer: CODE_ANSWER(ROOT) },
    { title: 'Mug launch campaign', path: topicPath('acme', 'website'), ago: 16 * MIN, prompt: 'Prepare the mug launch campaign. I want to choose the audience and the budget.', answer: INTERACTIVE_ANSWER },
    { title: 'Block plugins and states', path: topicPath('acme', 'website'), ago: 20 * MIN, prompt: 'Show me the launch plan, the pick-up points and the week.', answer: STATES_ANSWER },
  ]
  for (const d of shows) {
    const id = uuid()
    const created = t - d.ago - 2 * MIN
    st.sessions.push({
      id, title: d.title, path: d.path, state: 'idle', queue: 0, created, updated: t - d.ago, turns: 1, cost_usd: 0.62,
      model: '', real_model: 'claude-opus-5-5', context_tokens: 41200, context_window: 1000000, archived: false, notify: false,
      source: 'web', unread: false, last_text: d.answer.slice(0, 200), error: null,
    })
    st.events[id] = [
      { type: 'user', text: d.prompt, attachments: [], at: created, source: 'web' },
      { type: 'init', model: 'claude-opus-5-5', cwd: `${ROOT}/${d.path}`, at: created + 1 },
      { type: 'assistant', text: d.answer, at: created + 30 },
      { type: 'result', ok: true, cost_usd: 0.62, duration_ms: 38000, model: 'claude-opus-5-5', usage: { input: 1840, output: 2265, cache_read: 21430, cache_write: 4120 }, at: created + 38 },
    ]
  }
}
