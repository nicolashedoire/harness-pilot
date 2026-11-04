// Mock of the Atelier API (docs/dev/API.md#atelier) for web/mock/server.mjs: the list of creations, drafts waiting for
// approval (approve / reject / request a change / preview), versions with their provenance, settings, and the
// draft preview frame (/ext/_drafts/<id>/widget-frame). In memory: S.atelier = {items, drafts, settings}.
import crypto from 'node:crypto'

const MIN = 60
const HOUR = 3600
const DAY = 86400

const unknownOrigin = { agent: 'unknown', session: null, session_title: null, session_path: null, at: null, summary: null }
const origin = (agent, session, title, path, at, summary = null) => ({ agent, session, session_title: title, session_path: path, at, summary })
const files = (list) => Object.fromEntries(list.map(([p, size, text]) => [p, { size, text: text ?? '' }]))
const hash = (fl) => crypto.createHash('sha256').update(JSON.stringify(Object.entries(fl).map(([p, f]) => [p, f.text]))).digest('hex')
const sum = (fl) => Object.values(fl).reduce((a, f) => a + f.size, 0)

const CARD_V3 = "def card(ctx):\n    orders = fetch_orders(ctx)\n    return {'title': 'Shop sales', 'blocks': [{'type': 'stat', 'label': 'Orders today', 'value': len(orders)}]}\n"
const CARD_V4 = "def card(ctx):\n    orders = fetch_orders(ctx)\n    revenue = sum(o['total'] for o in orders)\n    return {'title': 'Shop sales', 'blocks': [{'type': 'stats', 'items': [\n        {'label': 'Orders today', 'value': len(orders)},\n        {'label': 'Revenue', 'value': revenue, 'unit': '€'}]}]}\n"
const CARD_DRAFT = CARD_V4.replace("'unit': '€'}]}]}", "'unit': '€'},\n        {'label': 'Unfulfilled', 'value': unfulfilled(orders), 'tone': 'warn'}]}]}")
const WEATHER_HTML = '<div class="ui-card"><h3>Weather</h3><p id="t">Loading…</p></div>\n<script>maxxing.api("now").then(function(d){document.getElementById("t").textContent=d.temp+" °C, "+d.sky})</script>\n'

export function atelierState(t, { sessions = [] } = {}) {
  const sid = (i) => sessions[i]?.id || null
  const stitle = (i) => sessions[i]?.title || null
  const spath = (i) => sessions[i]?.path ?? null
  const shopV = (n, at, fl, o, approval, extra = {}) => ({ n, at, files: fl, hash: hash(fl), base: n > 1 ? n - 1 : null, origin: o, approval, restorable: true, health: 'unknown', error: null, note: null, ...extra })
  const v1 = files([['manifest.json', 142, '{"id": "shop-sales", "name": "Shop sales", "type": "widget", "version": "1.0"}\n'], ['api.py', 610, CARD_V3.replace('len(orders)', '0')]])
  const v2 = files([['manifest.json', 142, '{"id": "shop-sales", "name": "Shop sales", "type": "widget", "version": "1.1"}\n'], ['api.py', 820, CARD_V3]])
  const v3 = files([['manifest.json', 142, '{"id": "shop-sales", "name": "Shop sales", "type": "widget", "version": "1.2"}\n'], ['api.py', 905, CARD_V3]])
  const v4 = files([['manifest.json', 142, '{"id": "shop-sales", "name": "Shop sales", "type": "widget", "version": "1.3"}\n'], ['api.py', 1210, CARD_V4]])
  const items = {
    'extension:shop-sales': {
      kind: 'extension', id: 'shop-sales', type: 'widget', name: 'Shop sales', icon: 'shopping-cart', version_label: '1.3', active: 4, enabled: true,
      versions: [
        shopV(1, t - 30 * DAY, v1, unknownOrigin, { by: 'migration', at: t - 30 * DAY }, { health: 'ok', note: 'existed before the Atelier' }),
        shopV(2, t - 12 * DAY, v2, origin('claude', sid(0), stitle(0), spath(0), t - 12 * DAY, 'Counts the orders of the day.'), { by: 'user', at: t - 12 * DAY }, { health: 'error', error: { message: "KeyError: 'orders'", where: 'card', at: t - 11 * DAY, count: 3 } }),
        shopV(3, t - 5 * DAY, v3, origin('codex', sid(1), stitle(1), spath(1), t - 5 * DAY, 'Fixed the empty-shop case.'), { by: 'user', at: t - 5 * DAY }, { health: 'ok' }),
        shopV(4, t - 2 * HOUR, v4, origin('claude', sid(0), stitle(0), spath(0), t - 2 * HOUR - 5 * MIN, 'Adds the revenue next to the orders.'), { by: 'user', at: t - 2 * HOUR }),
      ],
      history: [
        { at: t - 2 * HOUR, action: 'approve', version: 4, draft: 'd_0f1e2d3c4b5a', by: 'user', note: null },
        { at: t - 5 * DAY, action: 'approve', version: 3, draft: 'd_9a8b7c6d5e4f', by: 'user', note: null },
        { at: t - 12 * DAY, action: 'approve', version: 2, draft: 'd_7c6d5e4f3a2b', by: 'user', note: null },
        { at: t - 30 * DAY, action: 'migrate', version: 1, draft: null, by: 'system', note: null },
      ],
      unreviewed_since: null, runtime_error: null,
    },
    'extension:notes': {
      kind: 'extension', id: 'notes', type: 'page', name: 'Notes', icon: 'notebook-pen', version_label: '0.3.0', active: 1, enabled: true,
      versions: [shopV(1, t - 20 * DAY, files([['manifest.json', 120, '{"id": "notes", "type": "page"}\n'], ['page.js', 2400, 'export function mount(el, ctx) {}\n'], ['api.py', 900, 'def handle(ctx, method, path, query, body):\n    return {}\n']]), unknownOrigin, { by: 'migration', at: t - 20 * DAY }, { note: 'existed before the Atelier' })],
      history: [{ at: t - 20 * DAY, action: 'migrate', version: 1, draft: null, by: 'system', note: null }],
      unreviewed_since: t - 40 * MIN,
      runtime_error: { message: "TypeError: Cannot read properties of undefined (reading 'map')", where: 'page', at: t - 6 * MIN, count: 1 },
    },
    'extension:broken-widget': {
      kind: 'extension', id: 'broken-widget', type: 'widget', name: 'Broken widget', icon: 'triangle-alert', version_label: '0.1.0', active: 1, enabled: false,
      versions: [shopV(1, t - 9 * DAY, files([['manifest.json', 90, '{}\n'], ['api.py', 300, 'def card(ctx)\n']]), unknownOrigin, { by: 'migration', at: t - 9 * DAY })],
      history: [{ at: t - 9 * DAY, action: 'migrate', version: 1, draft: null, by: 'system', note: null }],
      unreviewed_since: null, load_error: 'SyntaxError in api.py line 12',
    },
    'extension:pin-revenue-3f9a1c': {
      kind: 'extension', id: 'pin-revenue-3f9a1c', type: 'pin', name: 'Revenue', icon: 'chart-line', version_label: '1', active: 1, enabled: true,
      versions: [shopV(1, t - 3 * DAY, files([['manifest.json', 150, '{"id": "pin-revenue-3f9a1c", "type": "widget"}\n'], ['card.json', 900, '{}\n'], ['api.py', 200, 'def card(ctx): ...\n']]), origin('user', null, null, null, t - 3 * DAY), { by: 'user', at: t - 3 * DAY }, { note: 'pinned from a conversation' })],
      history: [{ at: t - 3 * DAY, action: 'approve', version: 1, draft: null, by: 'user', note: 'pinned from a conversation' }],
      unreviewed_since: null, runtime_error: null,
    },
  }
  // read-only kinds (themes, skills, customizations, cron jobs): listed as they are, no versions
  const ro = (kind, id, name, icon, st, extra = {}) => ({ kind, id, type: kind, name, icon, state: st, version: null, version_label: null, versions: 0, pending: null, unreviewed: false, unreviewed_since: null, origin: null, approval: null, error: null, updated: null, href: null, actions: [], ...extra })
  const others = [
    ro('theme', 'th_2f8c1a', 'Harbour night', 'palette', 'active', { origin: origin('claude', sid(0), stitle(0), spath(0), t - 4 * DAY, 'Dark blue palette from the logo.'), updated: t - 4 * DAY, href: '/settings/appearance' }),
    ro('theme', 'th_77b0e4', 'Paper', 'palette', 'disabled', { updated: t - 15 * DAY, href: '/settings/appearance' }),
    ro('skill', 'invoice-reminders', 'invoice-reminders', 'sparkles', 'active', { updated: t - 6 * DAY, agents: ['claude', 'codex'] }),
    ro('skill', 'seo-notes', 'seo-notes', 'sparkles', 'active', { updated: t - 9 * DAY, agents: ['claude'] }),
    ro('customization', 'c-20261020-7f3a', 'Telegram: 80 threads at most', 'wrench', 'review', { updated: t - 1 * DAY, href: '/settings/updates', error: { message: 'Conflicts with the update to 2.0.0a109: server/maxxing/telegram/gateway.py', where: 'check', at: t - 1 * DAY, count: 1 } }),
    ro('cron', 'c_nightly', 'Nightly sales report', 'clock', 'active', { origin: origin('claude', sid(0), stitle(0), spath(0), t - 8 * DAY), updated: t - 8 * DAY, href: '/crons?job=c_nightly' }),
    ro('cron', 'c_backup_db', 'Database dump', 'clock', 'error', { updated: t - 3 * HOUR, href: '/crons?job=c_backup_db', error: { message: 'exit code 2', where: 'run', at: t - 3 * HOUR, count: 1 } }),
  ]
  const draft = (id, target, extra) => ({
    id, kind: 'extension', target, status: 'pending', created: t, summary: null, decided: null, superseded_by: null, change_requests: [], auto: false,
    check: { status: 'ok', steps: [{ step: 'load', status: 'ok', detail: 'manifest.json is valid' }, { step: 'python', status: 'ok', detail: 'api.py compiles (not run: a proposal runs only once approved)' }] },
    ...extra,
  })
  const drafts = {
    d_1a2b3c4d5e6f: draft('d_1a2b3c4d5e6f', 'weather-board', {
      name: 'Weather board', type: 'html_widget', icon: 'cloud-sun', change: 'new', base: null, created: t - 25 * MIN,
      origin: origin('codex', sid(1), stitle(1), spath(1), t - 25 * MIN, 'A small widget with the weather of the day for the office.'),
      summary: 'A small widget with the weather of the day for the office.',
      permissions: { network: ['api.open-meteo.com'], secrets: [], read: [], declared: true },
      files: files([['manifest.json', 160, '{"id": "weather-board", "name": "Weather board", "type": "widget", "permissions": {"network": ["api.open-meteo.com"]}}\n'], ['widget.html', 230, WEATHER_HTML], ['api.py', 420, "def handle(ctx, method, path, query, body):\n    return {'temp': 14, 'sky': 'cloudy'}\n"]]),
      check: { status: 'warn', steps: [{ step: 'load', status: 'ok', detail: 'manifest.json is valid' }, { step: 'document', status: 'ok', detail: 'widget.html: 3 element(s), 1 script(s)' }, { step: 'scripts', status: 'warn', detail: 'Node.js is not installed: the inline scripts were not checked' }] },
    }),
    d_a1b2c3d4e5f6: draft('d_a1b2c3d4e5f6', 'shop-sales', {
      name: 'Shop sales', type: 'widget', icon: 'shopping-cart', change: 'update', base: 4, created: t - 8 * MIN,
      origin: origin('claude', sid(0), stitle(0), spath(0), t - 8 * MIN, 'Adds the orders still to ship, in orange when there are some.'),
      summary: 'Adds the orders still to ship, in orange when there are some.',
      permissions: { network: ['acme.myshopify.com'], secrets: ['SHOP_TOKEN'], read: [], declared: true },
      files: files([['manifest.json', 142, '{"id": "shop-sales", "name": "Shop sales", "type": "widget", "version": "1.4",\n "permissions": {"network": ["acme.myshopify.com"], "secrets": ["SHOP_TOKEN"]}}\n'], ['api.py', 1390, CARD_DRAFT]]),
    }),
  }
  return { items, others, drafts, settings: { auto_activate_safe: false, keep_days: 90, keep_versions: 10 } }
}

// ---- unified diff (enough for the mock: whole-file hunks) ------------------------------------------------------------
function udiff(path, a, b) {
  if (a === b) return null
  const al = a ? a.replace(/\n$/, '').split('\n') : []
  const bl = b ? b.replace(/\n$/, '').split('\n') : []
  let i = 0
  while (i < al.length && i < bl.length && al[i] === bl[i]) i++
  let j = 0
  while (j < al.length - i && j < bl.length - i && al[al.length - 1 - j] === bl[bl.length - 1 - j]) j++
  const s = Math.max(0, i - 3)
  const ae = al.length - Math.max(0, j - 3)
  const be = bl.length - Math.max(0, j - 3)
  const lines = [`--- ${a == null ? '/dev/null' : 'a/' + path}`, `+++ ${b == null ? '/dev/null' : 'b/' + path}`, `@@ -${s + 1},${ae - s} +${s + 1},${be - s} @@`]
  for (let k = s; k < i; k++) lines.push(' ' + al[k])
  for (let k = i; k < al.length - j; k++) lines.push('-' + al[k])
  for (let k = i; k < bl.length - j; k++) lines.push('+' + bl[k])
  for (let k = al.length - j; k < ae; k++) lines.push(' ' + al[k])
  return lines.join('\n') + '\n'
}

function diffRows(nw, old) {
  return [...new Set([...Object.keys(nw), ...Object.keys(old)])].sort().map((p) => {
    const n = nw[p], o = old[p]
    const status = !o ? 'added' : !n ? 'removed' : n.text === o.text ? 'same' : 'changed'
    return { path: p, status, size: n ? n.size : null, old_size: o ? o.size : null, binary: false, diff: status === 'same' ? null : udiff(p, o ? o.text : null, n ? n.text : null), truncated: false }
  })
}

const counts = (rows) => ({
  count: rows.filter((r) => r.status !== 'removed').length,
  size: rows.filter((r) => r.status !== 'removed').reduce((a, r) => a + (r.size || 0), 0),
  added: rows.filter((r) => r.status === 'added').length,
  changed: rows.filter((r) => r.status === 'changed').length,
  removed: rows.filter((r) => r.status === 'removed').length,
})

export function installAtelier({ R, state, fail, bus, now, sendMessage }) {
  const A = () => (state().atelier ||= atelierState(now()))
  const activeOf = (it) => it && it.versions.find((v) => v.n === it.active)
  const pendingFor = (id) => Object.values(A().drafts).filter((d) => d.target === id && d.status === 'pending').sort((a, b) => b.created - a.created)
  const publicVersion = (v, active) => ({ n: v.n, at: v.at, active: v.n === active, origin: v.origin, approval: v.approval, base: v.base, files: Object.keys(v.files).length, size: sum(v.files), hash: v.hash, restorable: v.restorable, health: v.health, error: v.error, note: v.note })
  const publicDraft = (d, rows) => {
    const it = A().items[`extension:${d.target}`]
    const r = rows || (d.status === 'pending' ? diffRows(d.files, activeOf(it)?.files || {}) : null)
    const { files: fl, ...rest } = d
    return { ...rest, files: r ? counts(r) : { count: Object.keys(fl).length, size: sum(fl), added: 0, changed: 0, removed: 0 } }
  }
  // the declaration of the installed extension, as GET /api/extensions has it (one source for both pages)
  const permissionsOf = (id) => {
    const p = (state().extensions || []).find((x) => x.id === id)?.permissions ?? null
    return { network: p?.network || [], secrets: p?.secrets || [], read: p?.read || [], declared: p != null }
  }
  const errorOf = (it) => it.load_error ? { message: it.load_error, where: 'load', at: null, count: 1 } : it.runtime_error || null
  // on / off: the extension's own flag (GET /api/extensions, PATCH /api/extensions/{id}) when it is listed there
  const enabledOf = (it) => (state().extensions || []).find((x) => x.id === it.id)?.enabled ?? it.enabled
  const stateOf = (it) => !enabledOf(it) ? 'disabled' : errorOf(it) ? 'error' : 'active'
  const href = (it) => it.type === 'page' ? `/x/${it.id}` : ['widget', 'html_widget', 'pin'].includes(it.type) ? `/?widget=${it.id}` : null
  const view = (it) => {
    const act = activeOf(it)
    const pend = pendingFor(it.id)
    const o = {
      kind: 'extension', id: it.id, type: it.type, name: it.name, icon: it.icon, state: stateOf(it), version: act ? act.n : null, version_label: it.version_label,
      versions: it.versions.length,
      pending: pend[0] ? { draft: pend[0].id, at: pend[0].created, change: pend[0].change, origin: pend[0].origin } : null,
      unreviewed: !!it.unreviewed_since, unreviewed_since: it.unreviewed_since,
      origin: act && (act.origin.agent !== 'unknown' || act.origin.at) ? act.origin : null, approval: act ? act.approval : null,
      error: errorOf(it), updated: Math.max(it.history[0]?.at || 0, pend[0]?.created || 0, it.unreviewed_since || 0) || null, href: href(it),
    }
    o.actions = [...(o.pending ? ['approve', 'reject', 'request_change'] : []), ...(o.versions > 1 ? ['rollback'] : []), ...(o.unreviewed ? ['accept'] : []), o.state === 'disabled' ? 'enable' : 'disable']
    return o
  }
  const newItemView = (d) => ({
    kind: 'extension', id: d.target, type: d.type, name: d.name, icon: d.icon, state: 'pending', version: null, version_label: null, versions: 0,
    pending: { draft: d.id, at: d.created, change: 'new', origin: d.origin }, unreviewed: false, unreviewed_since: null, origin: d.origin, approval: null,
    error: null, updated: d.created, href: null, actions: ['approve', 'reject', 'request_change'],
  })
  const rank = (it) => it.state === 'pending' || it.pending ? 0 : ({ error: 1, review: 2 }[it.state] ?? (it.unreviewed ? 3 : 4))
  const allItems = () => {
    const out = Object.values(A().items).map(view)
    const known = new Set(out.map((i) => i.id))
    for (const d of Object.values(A().drafts)) if (d.status === 'pending' && !known.has(d.target)) { known.add(d.target); out.push(newItemView(pendingFor(d.target)[0])) }
    return [...out, ...A().others]
  }
  const getDraft = (id) => A().drafts[id] || fail(404, 'not_found', `no proposal ${id}`)
  const pending = (id) => {
    const d = getDraft(id)
    if (d.status !== 'pending') fail(409, 'not_pending', `this proposal is already ${d.status}`)
    return d
  }

  R('GET', '/api/atelier', ({ q }) => {
    const every = allItems()
    const c = { pending: 0, error: 0, unreviewed: 0, review: 0, disabled: 0, total: every.length }
    for (const it of every) {
      if (it.state in c) c[it.state]++
      if (it.pending && it.state !== 'pending') c.pending++
      if (it.unreviewed) c.unreviewed++
    }
    const kind = q.get('kind'), st = q.get('state')
    const items = every.filter((i) => (!kind || i.kind === kind) && (!st || i.state === st)).sort((a, b) => rank(a) - rank(b) || (b.updated || 0) - (a.updated || 0))
    return { items, counts: c }
  })
  R('GET', '/api/atelier/settings', () => A().settings)
  R('PUT', '/api/atelier/settings', ({ body }) => {
    const s = A().settings
    if (body.auto_activate_safe != null) {
      if (typeof body.auto_activate_safe !== 'boolean') fail(400, 'bad_settings', 'auto_activate_safe must be true or false')
      s.auto_activate_safe = body.auto_activate_safe
    }
    for (const [k, hi] of [['keep_days', 3650], ['keep_versions', 100]]) {
      if (body[k] == null) continue
      if (!Number.isInteger(body[k]) || body[k] < 1 || body[k] > hi) fail(400, 'bad_settings', `${k} must be a whole number from 1 to ${hi}`)
      s[k] = body[k]
    }
    bus('atelier')
    return s
  })
  R('GET', '/api/atelier/drafts', ({ q }) => {
    const all = q.get('status') === 'all'
    return { drafts: Object.values(A().drafts).filter((d) => all || d.status === 'pending').sort((a, b) => b.created - a.created).map((d) => publicDraft(d)) }
  })
  R('GET', '/api/atelier/drafts/:id', ({ params }) => {
    const d = getDraft(params.id)
    const it = A().items[`extension:${d.target}`]
    const act = activeOf(it)
    const rows = diffRows(d.files, act?.files || {})
    return { draft: publicDraft(d, rows), files: rows, active_version: act ? act.n : null, stale: d.status === 'pending' && (act ? act.n : null) !== d.base, preview: ['widget', 'pin'].includes(d.type) ? 'card' : d.type === 'html_widget' ? 'html' : 'none' }
  })
  R('GET', '/api/atelier/drafts/:id/file', ({ params, q }) => {
    const d = getDraft(params.id)
    const f = d.files[q.get('path')] || fail(404, 'not_found', `no file ${q.get('path')} in proposal ${d.id}`)
    return { path: q.get('path'), size: f.size, binary: false, content: f.text }
  })
  R('POST', '/api/atelier/drafts/:id/preview', ({ params }) => {
    const d = pending(params.id)
    if (d.type === 'html_widget') return { kind: 'html', url: `/ext/_drafts/${d.id}/widget-frame`, height: 260 }
    if (d.type === 'widget' || d.type === 'pin') {
      return { kind: 'card', error: null, trace: [], card: { title: 'Shop sales', updated: now(), blocks: [{ type: 'stats', items: [{ label: 'Orders today', value: 37 }, { label: 'Revenue', value: 2184.5, unit: '€' }, { label: 'Unfulfilled', value: 4, tone: 'warn' }] }] } }
    }
    return { kind: 'none', reason: d.type === 'block' || d.type === 'agent' ? d.type : 'page' }
  })
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) for (const pattern of ['/api/atelier/drafts/:id/api', '/api/atelier/drafts/:id/api/*']) R(method, pattern, ({ params }) => {
    const d = A().drafts[params.id]
    if (!d || d.status !== 'pending' || d.type !== 'html_widget') fail(404, 'not_found', 'this proposal has no handle(ctx, method, path, query, body)')
    return { temp: 14, sky: 'cloudy' }
  })
  R('POST', '/api/atelier/drafts/:id/approve', ({ params, body }) => {
    const d = pending(params.id)
    const key = `extension:${d.target}`
    const it = A().items[key] || (A().items[key] = { kind: 'extension', id: d.target, type: d.type, name: d.name, icon: d.icon, version_label: null, active: null, enabled: true, versions: [], history: [], unreviewed_since: null, runtime_error: null })
    if (body && 'base' in body && body.base !== (it.active ?? null)) fail(409, 'stale', `version ${it.active} became active since you reviewed this proposal (against ${body.base})`)
    const t = now()
    const prev = activeOf(it)
    if (prev) prev.health = prev.error ? 'error' : 'ok'
    const n = Math.max(0, ...it.versions.map((v) => v.n)) + 1
    it.versions.push({ n, at: t, files: d.files, hash: hash(d.files), base: d.base, origin: d.origin, approval: { by: 'user', at: t }, restorable: true, health: 'unknown', error: null, note: null })
    it.active = n
    it.unreviewed_since = null
    it.runtime_error = null
    it.history.unshift({ at: t, action: 'approve', version: n, draft: d.id, by: 'user', note: null })
    d.status = 'approved'
    d.decided = { at: t, by: 'user', version: n }
    bus('atelier', 'extensions')
    return { ok: true, item: view(it), version: n }
  })
  R('POST', '/api/atelier/drafts/:id/reject', ({ params, body }) => {
    const d = pending(params.id)
    const reason = body?.reason ? String(body.reason) : null
    if (reason && reason.length > 500) fail(400, 'bad_reason', 'the reason is 500 characters at most')
    d.status = 'rejected'
    d.decided = { at: now(), by: 'user', reason }
    bus('atelier', 'trash')
    return { ok: true, draft: publicDraft(d), trash_id: `20261104-120000-${d.target}-draft-${d.id}` }
  })
  R('POST', '/api/atelier/drafts/:id/request-change', ({ params, body }) => {
    const d = pending(params.id)
    const msg = String(body?.message || '').trim()
    if (!msg || String(body.message).length > 4000) fail(400, 'bad_message', 'the message is 1 to 4000 characters')
    const prompt = `[Atelier] The user asked for a change to "${d.name}" (proposal ${d.id}, extension ${d.target}):\n\n${msg}\n\nMake the change in the draft folder, check it with \`pilot ext check ${d.target} --dir <folder>\`, then run \`pilot ext propose ${d.target}\`. Nothing is active until the user approves it.`
    const res = sendMessage(d.origin.session, d.origin.session_path || '', prompt, `Change: ${d.name}`)
    d.change_requests.push({ at: now(), message: msg, session: res.session?.id || null })
    bus('atelier', 'sessions', 'workspace')
    return { ok: true, ...res }
  })
  R('GET', '/api/atelier/:kind/:id', ({ params }) => {
    if (!['extension', 'theme', 'skill', 'customization', 'cron'].includes(params.kind)) fail(404, 'not_found', `no kind ${params.kind}`)
    const other = A().others.find((o) => o.kind === params.kind && o.id === params.id)
    if (other) return { item: other, versions: [], history: [], drafts: [], files: [], permissions: null, health: { state: other.state, error: other.error, errors: other.error ? [other.error] : [], checked_at: now() } }
    const it = params.kind === 'extension' ? A().items[`extension:${params.id}`] : null
    const pend = params.kind === 'extension' ? pendingFor(params.id) : []
    if (!it && !pend.length) fail(404, 'not_found', `no ${params.kind} ${params.id}`)
    const decided = Object.values(A().drafts).filter((d) => d.target === params.id && d.status !== 'pending')
    const v = it ? view(it) : newItemView(pend[0])
    const act = activeOf(it)
    return {
      item: v,
      versions: it ? [...it.versions].sort((a, b) => b.n - a.n).map((x) => publicVersion(x, it.active)) : [],
      history: it ? it.history : [],
      drafts: [...pend, ...decided].map((d) => publicDraft(d, [])),
      files: act ? Object.entries(act.files).map(([path, f]) => ({ path, size: f.size })).sort((a, b) => a.path.localeCompare(b.path)) : [],
      permissions: it ? permissionsOf(it.id) : null,
      health: { state: v.state, error: v.error, errors: v.error ? [v.error] : [], checked_at: now() },
    }
  })
  R('GET', '/api/atelier/:kind/:id/versions/:n', ({ params, q }) => {
    if (params.kind !== 'extension') fail(422, 'not_versioned', `${params.kind} creations are not versioned`)
    const it = A().items[`extension:${params.id}`] || fail(404, 'not_found', `no extension ${params.id}`)
    const n = Number(params.n)
    const v = it.versions.find((x) => x.n === n) || fail(404, 'not_found', `version ${n} of ${params.id} is not kept`)
    const against = q.get('against')
    const base = !against ? [...it.versions].filter((x) => x.n < n).sort((a, b) => b.n - a.n)[0] : against === 'active' ? activeOf(it) : it.versions.find((x) => x.n === Number(against)) || fail(404, 'not_found', `version ${against} is not kept`)
    return { version: publicVersion(v, it.active), against: base ? base.n : null, files: diffRows(v.files, base ? base.files : {}) }
  })
  R('POST', '/api/atelier/:kind/:id/rollback', ({ params, body }) => {
    if (!['extension', 'theme', 'skill', 'customization', 'cron'].includes(params.kind)) fail(404, 'not_found', `no kind ${params.kind}`)
    if (params.kind !== 'extension') fail(422, 'not_versioned', `${params.kind} creations are not versioned`)
    const it = A().items[`extension:${params.id}`] || fail(404, 'not_found', `no extension ${params.id}`)
    if (!Number.isInteger(body?.version)) fail(400, 'bad_version', 'version must be a version number')
    const v = it.versions.find((x) => x.n === body.version) || fail(404, 'not_found', `version ${body.version} of ${it.id} is not kept`)
    if (!v.restorable) fail(409, 'not_restorable', `the files of version ${v.n} are not kept`)
    if (it.active === v.n && !it.unreviewed_since) return { ok: true, item: view(it), version: v.n }
    const prev = activeOf(it)
    if (prev) prev.health = prev.error ? 'error' : 'ok'
    it.active = v.n
    it.unreviewed_since = null
    it.runtime_error = null
    it.history.unshift({ at: now(), action: 'rollback', version: v.n, draft: null, by: 'user', note: prev ? `from v${prev.n}` : null })
    bus('atelier', 'extensions')
    return { ok: true, item: view(it), version: v.n }
  })
  R('POST', '/api/atelier/:kind/:id/accept', ({ params }) => {
    if (params.kind !== 'extension') fail(422, 'not_versioned', `${params.kind} creations are not versioned`)
    const it = A().items[`extension:${params.id}`] || fail(404, 'not_found', `no extension ${params.id}`)
    if (!it.unreviewed_since) fail(409, 'nothing_to_accept', 'its files are those of the active version')
    const t = now()
    const act = activeOf(it)
    const n = Math.max(...it.versions.map((v) => v.n)) + 1
    it.versions.push({ ...act, n, at: t, base: act.n, origin: { ...unknownOrigin, at: it.unreviewed_since }, approval: { by: 'user', at: t }, health: 'unknown', error: null, note: 'changed outside the Atelier, accepted' })
    act.health = 'ok'
    it.active = n
    it.unreviewed_since = null
    it.history.unshift({ at: t, action: 'accept', version: n, draft: null, by: 'user', note: null })
    bus('atelier')
    return { ok: true, item: view(it), version: n }
  })
}

// The draft HTML widget's frame (/ext/_drafts/<id>/widget-frame): the draft's widget.html after a minimal bridge.
export function serveDraftFrame(req, res, url, authed, state) {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox allow-scripts allow-pointer-lock; frame-ancestors 'self'", 'Referrer-Policy': 'no-referrer' })
    res.end(body)
  }
  if (!authed) return send(401, 'auth required')
  const m = /^\/ext\/_drafts\/([^/]+)\/widget-frame$/.exec(url.pathname)
  const d = m && state().atelier.drafts[m[1]]
  if (!d || d.status !== 'pending' || d.type !== 'html_widget' || !d.files['widget.html']) return send(404, 'no HTML widget in this proposal')
  const bridge = `<!doctype html><meta charset="utf-8"><script>(function(){var s=0,p={};window.maxxing={theme:'dark',api:function(path,o){o=o||{};return new Promise(function(r,j){var n=++s;p[n]=[r,j];parent.postMessage({mx:'api',seq:n,path:String(path||''),method:o.method||'GET',body:o.body},'*')})},resize:function(h){parent.postMessage({mx:'resize',height:Number(h)||0},'*')},onTheme:function(){}};addEventListener('message',function(e){var m=e.data||{};if(m.mx==='reply'&&p[m.seq]){var x=p[m.seq];delete p[m.seq];m.ok?x[0](m.data):x[1](new Error(m.error||'request failed'))}})})()</script>`
  return send(200, bridge + '\n' + d.files['widget.html'].text)
}

// PATCH /api/extensions/{id} of the mock server: an Atelier extension not listed by GET /api/extensions (a pin)
export function atelierHasExtension(S, id) {
  return !!(S.atelier || {}).items?.[`extension:${id}`]
}

export function atelierSetEnabled(S, id, enabled) {
  const it = (S.atelier || {}).items?.[`extension:${id}`]
  if (it) it.enabled = enabled
}
