#!/usr/bin/env node
// Harness Maxxing v2 — dev MOCK backend (zero dependencies, Node 22, ESM).
//
//   node mock/server.mjs                       # port 8809, scenario "ready"
//   MOCK_PORT=8899 MOCK_SCENARIO=setup node mock/server.mjs
//   curl -X POST localhost:8809/__mock/scenario -d '{"name":"login"}'   # reset state at runtime
//   curl -X POST localhost:8809/__mock/bus -d '{"topics":["sessions","workspace"]}'   # emit a bus event
//
// Implements the endpoints of docs/dev/API.md with in-memory state and fake, product-neutral data (the routes left out
// are listed in docs/dev/DESIGN.md, "Mock & visual checks").
// Serves the built SPA from ../dist (web/dist). Scenarios: setup | login | onboarding | ready | maxxing.
// maxxing: 30 more sessions that keep finishing at random (Maxxing mode); MOCK_PASSWORD=... asks for that password.
// MOCK_LOCAL=mac|mac-terminal|mac-none|linux: a local installation (Settings -> System: background service, Git update).
// MOCK_MEDIA=none|no-webp|no-pdf: ffmpeg and pdftoppm missing, ffmpeg without WebP, pdftoppm missing (Settings -> System).
// MOCK_CODEX=signed-in|signed-out|missing|device-fails: Codex's sign-in (Settings -> Codex, the wizard's Codex step).
// MOCK_EXT_BROKEN=1: the Shop sales widget fails on the dashboard and the Notes page does not load (Ask for a fix).

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { blocksState, installBlocks, seedBlocksSessions, serveBlockFrame } from './blocks.mjs'
import { atelierHasExtension, atelierSetEnabled, atelierState, installAtelier, serveDraftFrame } from './atelier.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = process.env.MOCK_DIST || path.resolve(__dirname, '../dist')
const PORT = Number(process.env.MOCK_PORT || 8809)
const HOST = '127.0.0.1'
const ROOT = '/root/harness-pilot'
const VERSION = '2.0.0'
const SETUP_TOKEN = 'dev-token'
const DEFAULT_PASSWORD = 'password123'
const SCENARIOS = ['setup', 'login', 'onboarding', 'ready', 'maxxing']
const MOCK_PASSWORD = process.env.MOCK_PASSWORD || ''
// MOCK_LOCAL=mac | mac-terminal | mac-none | linux: a local installation (scripts/dev-local.sh): no Update button,
// services or logs; on a Mac, the background service runs the app / is installed but the app runs in a terminal / is
// not installed (Settings -> System)
const LOCAL = ['mac', 'mac-terminal', 'mac-none', 'linux'].includes(process.env.MOCK_LOCAL) ? process.env.MOCK_LOCAL : ''
// MOCK_MEDIA=none | no-webp | no-pdf: the thumbnail tools missing (default: all found)
const MEDIA = ['none', 'no-webp', 'no-pdf'].includes(process.env.MOCK_MEDIA) ? process.env.MOCK_MEDIA : ''

/* =================================================================== helpers */
const now = () => Date.now() / 1000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const uuid = () => crypto.randomUUID()
const rid = (p) => `${p}_${crypto.randomBytes(4).toString('hex')}`
const sha = () => crypto.randomBytes(20).toString('hex')
const clone = (o) => JSON.parse(JSON.stringify(o))
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/
const MIN = 60, HOUR = 3600, DAY = 86400

function rng(seed) { // mulberry32, deterministic fake data
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class HttpError extends Error {
  constructor(status, error, message) { super(message || error); this.status = status; this.error = error }
}
const fail = (status, error, message) => { throw new HttpError(status, error, message || error.replace(/_/g, ' ')) }
const RAW = Symbol('raw') // handler wrote the response itself

const MIME = {
  '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.ts': 'text/x-typescript', '.tsx': 'text/x-typescript', '.css': 'text/css', '.html': 'text/html', '.py': 'text/x-python',
  '.sh': 'text/x-shellscript', '.csv': 'text/csv', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
}
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || (path.basename(p) === 'Caddyfile' ? 'text/plain' : 'application/octet-stream')
const isText = (m) => m.startsWith('text/') || m === 'application/json' || m === 'image/svg+xml'

/* =================================================================== static data */
const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
]

const WORKSPACE = [
  { name: 'acme', description: 'Acme Inc. — company website, blog and SEO', topics: [
    ['blog', 'Weekly articles for the Acme blog'], ['website', 'Marketing site (Astro + Tailwind)'], ['seo', 'Keywords, audits and monthly reports']] },
  { name: 'personal', description: 'Personal notes and finances', topics: [
    ['notes', 'Ideas, reading notes and journal'], ['finance', 'Budget and expense tracking']] },
  { name: 'ops', description: 'Server and infrastructure', topics: [['server', 'VPS maintenance, Caddy, backups']] },
]
const projPath = (p) => `projects/${p}`
const topicPath = (p, t) => `projects/${p}/topics/${t}`

const SECRET_SEED = [
  ['OPENAI_API_KEY', 'Image generation for blog covers', true, 'sk-proj-4f9a1c7e2b8d6a3f0e5c9b1d7a2e8f4c'],
  ['GITHUB_TOKEN', 'Fine-grained PAT — acme/website contents RW', true, 'ghp_9Xk2LmQ7vR4tY8wZ1aB3cD5eF6gH0jK2'],
  ['STRIPE_SECRET_KEY', 'Shop sales widget (read-only restricted key)', false, 'rk_live_51Hx9aKd8fJ2mQ0pL7vN3sT6wY'],
  ['CLOUDFLARE_API_TOKEN', 'DNS edit on example.com zone', true, 'cf_7Hq2Zm9Kx4Lp1Vb8Nc3Rt6Ws0Yd5'],
  ['SMTP_PASSWORD', 'Transactional mail (newsletter@example.com)', false, 'smtp-Pz8qW3eR5tY7uI9oP1aS'],
]

const SERVICES = [
  ['claude-maxxing', 'harness-pilot'], ['caddy', 'Caddy web server'], ['tailscaled', 'Tailscale'], ['cron', 'Cron daemon'],
]

/* =================================================================== state */
let S = null
let GEN = 0 // bumped on reset; async timers check it

function buildState(scenario) {
  const t = now()
  const ready = scenario === 'ready' || scenario === 'login' || scenario === 'maxxing'
  const st = {
    scenario,
    bootAt: t - 12 * DAY - 3 * HOUR,
    setup_required: scenario === 'setup',
    password: scenario === 'setup' ? null : scenario === 'maxxing' && MOCK_PASSWORD ? MOCK_PASSWORD : DEFAULT_PASSWORD,
    autoAuth: scenario === 'onboarding' || scenario === 'ready' || (scenario === 'maxxing' && !MOCK_PASSWORD),
    tokens: new Set(),
    loginFails: [], // timestamps
    lockUntil: 0,
    onboarding_completed: ready,
    settings: { timezone: 'Europe/Paris', language: 'en', public_url: 'https://ui.example.com', files_root: ROOT, presentation_default: false, usage_widget: false, maxxing_mode: false, memory_max_lines: 200, donation_hidden: false, team_page: ready },
    claude: {
      installed: true, version: '2.4.1',
      auth: ready ? { ok: true, method: 'oauth_token', detail: 'Long-lived OAuth token (claude setup-token), Max plan' } : { ok: false, method: null, detail: 'Not connected' },
      default_model: 'claude-opus-5-5', permission_mode: 'bypass',
    },
    projects: [],
    sessions: [],
    events: {}, // id -> [Event]
    queues: {}, // id -> [text]
    timers: {}, // id -> [timeout]
    tasks: { projects: [], tasks: [] },
    crons: [], cronRuns: [], external: [],
    // saved themes and a Team contact who sent one (Settings -> Appearance -> My themes, Team theme card)
    myThemes: ready ? [{ id: 'th_5a63e0b1c2', source: 'received', from: 'Acme team', saved: t - 2 * DAY,
      theme: { schema: 1, id: 'sauge', name: 'Sauge', description: 'Sage green on softly tinted greys.', base: 'zinc', accent: '#5f8f6b', buttons: 'accent', tint: 'tinted', tokens: { light: {}, dark: {} } } }] : [],
    team: {
      people: { p_acme: { name: 'Acme team', emoji: '', color: 'green', server: 'https://acme.example.com', status: 'online', address: 'https://acme.example.com', peer: true, contact: true, last_seen: t - 60 },
        p_sam: { name: 'Sam', emoji: '🦊', color: 'violet', server: 'https://sam.example.net', status: 'away', address: 'https://sam.example.net', peer: true, contact: true, last_seen: t - 40 * MIN },
        // asked to connect (Settings -> Team: accept or decline); not a contact yet
        p_north: { name: 'North studio', emoji: '', color: 'amber', server: 'https://north.example.org', status: 'offline', address: 'https://north.example.org', peer: true, contact: false, request: true, last_seen: null } },
      chats: ready ? [{ id: 'd_acme', kind: 'dm', name: '', emoji: '', members: ['p_acme'], created: t - 3 * DAY, read_at: t - 2 * DAY, remote: true, admin: null, messages: [
        { id: 'm_00000001', author: 'p_acme', at: t - 2 * DAY - 300, text: 'Here is the palette we use for the client dashboards.', kind: 'text' },
        { id: 'm_00000002', author: 'p_acme', at: t - 2 * DAY - 240, text: 'Sauge', kind: 'theme',
          theme: { schema: 1, id: 'sauge', name: 'Sauge', description: 'Sage green on softly tinted greys.', author: 'Acme', base: 'zinc', accent: '#5f8f6b', buttons: 'accent', tint: 'tinted', tokens: { light: {}, dark: {} } } },
      ] }] : [],
    },
    telegram: {
      token: null, bot: null, chat: null, topics_enabled: false, threads: [],
      settings: { notify_crons: true, login_alerts: true, reply_mode: 'final' }, last_error: null, link: null,
    },
    backup: { configured: false, repo: null, private: null, schedule: '40 4 * * *', include: ['tasks.json', 'extensions/**', '.claude/skills/**'], always: ['**/CLAUDE.md', '**/memory.md'], history: [] },
    secrets: [],
    services: SERVICES.map(([name, label], i) => ({ name, label, active: true, enabled: true, since: t - 12 * DAY - i * 40, state: 'running' })),
    layout: { order: ['activity', 'tasks-today', 'crons', 'server', 'shop-sales', 'uptime', 'backup', 'telegram', 'claude-usage'], hidden: ['claude-usage'] },
    widgetUpdated: {},
    uptimeFixed: false,
    extensions: [
      // permissions: what the manifest declares (null = no "permissions" key: an extension older than permissions)
      { id: 'shop-sales', name: 'Shop sales', type: 'widget', icon: 'shopping-cart', version: '1.2.0', enabled: true, error: null, has_api: true, permissions: null,
        runtime_errors: [{ where: 'card', message: 'URLError: <urlopen error timed out>', stack: 'api.py:14 in card: orders = fetch_orders(token)\napi.py:6 in fetch_orders: with urllib.request.urlopen(req, timeout=10) as r:', at: t - 25 * MIN, count: 3 }] },
      { id: 'notes', name: 'Notes', type: 'page', icon: 'notebook-pen', version: '0.3.0', enabled: true, error: null, has_api: true,
        permissions: { network: [], secrets: [], read: ['projects'] },
        runtime_errors: [
          { where: 'page', message: "TypeError: Cannot read properties of undefined (reading 'map')", stack: "TypeError: Cannot read properties of undefined (reading 'map')\nat render (lib/list.js:12:24)\nat mount (page.js:31:5)", at: t - 6 * MIN, count: 1 },
          { where: 'api', message: "KeyError: 'notes'", stack: "api.py:9 in handle: return {\"notes\": data[\"notes\"]}", at: t - 2 * HOUR, count: 2 },
        ] },
      { id: 'broken-widget', name: 'Broken widget', type: 'widget', icon: 'triangle-alert', version: '0.1.0', enabled: false, error: 'SyntaxError in api.py line 12', has_api: true, permissions: null },
      // created after permissions came in: declares a key that waits for the user (the dashboard card asks)
      { id: 'stock-levels', name: 'Stock levels', type: 'widget', icon: 'package', version: '1.0.0', enabled: true, error: null, has_api: true,
        permissions: { network: [], secrets: ['STOCK_API_KEY'], read: [] } },
    ],
    fs: new Map(),
    blocks: blocksState(),
    // what the user allowed (server: <state>/extension-permissions.json); legacy = existed before permissions
    extPerms: { since: t - 2 * DAY, legacy: ['shop-sales', 'notes', 'broken-widget'],
      grants: { 'shop-sales': { secrets: { SHOP_TOKEN: { at: t - 2 * DAY + 600, how: 'legacy' } }, refused: null, denied: [] } } },
  }

  if (scenario !== 'setup' && scenario !== 'onboarding') {
    // full workspace
    st.projects = WORKSPACE.map((p) => ({ name: p.name, description: p.description, topics: p.topics.map(([name, description]) => ({ name, description })) }))
  }
  if (ready) {
    seedSessions(st, t)
    seedBlocksSessions(st, t, { uuid, topicPath, ROOT, MIN, HOUR })
    seedDebate(st, t)
    st.atelier = atelierState(t, { sessions: st.sessions.filter((x) => !x.archived).slice(0, 2) })
    if (scenario === 'maxxing') {
      seedMaxxing(st, t)
      st.settings.maxxing_mode = true
    }
    seedTasks(st, t)
    seedCrons(st, t)
    seedFeed(st, t)
    // telegram
    st.telegram.token = '7412369850:AAH3kx9-Qw2Er4Ty6Ui8Op0As1Df3Gh5Jk7'
    st.telegram.bot = { id: 7412369850, username: 'acme_pilot_bot', name: 'Acme Pilot' }
    st.telegram.chat = { id: 123456789, title: 'Alex', type: 'private' }
    st.telegram.topics_enabled = true
    st.telegram.threads = makeThreads(st)
    // backup
    Object.assign(st.backup, { configured: true, repo: 'alex-dev/pilot-memory', private: true })
    const r = rng(42)
    for (let i = 7; i >= 0; i--) {
      const failed = i === 3
      st.backup.history.push({ at: t - i * DAY - 5 * HOUR + Math.floor(r() * 300), ok: !failed, commit: failed ? null : sha().slice(0, 7),
        files: failed ? 0 : 38 + Math.floor(r() * 6), error: failed ? 'remote: Repository not found. fatal: unable to access (HTTP 404) — token expired?' : null })
    }
    st.secrets = SECRET_SEED.map(([name, note, expose, value], i) => ({ name, note, expose, value, updated: t - (i * 9 + 2) * DAY }))
  } else if (scenario === 'onboarding' || scenario === 'setup') {
    st.layout.hidden = ['claude-usage']
  }
  if (!st.feed) { st.feed = { events: [], nextId: 1, settings: { telegram: true, rules: {}, kind_rules: {} }, hooks: [] }; st.push = { subs: [] } }
  seedFiles(st, t)
  // the session that made the Notes page (recorded by `pilot ext check` run from its turn): where "Ask for a fix" goes
  const maker = st.sessions.find((s) => !s.archived && s.path.startsWith('projects/'))
  if (maker) st.extensions.find((e) => e.id === 'notes').origin_session = maker.id
  return st
}

function makeThreads(st) {
  const th = [{ path: '', thread_id: 1, name: 'General' }, { path: '__crons__', thread_id: 2, name: 'Crons' }]
  let id = 101
  for (const p of st.projects) for (const tp of p.topics) th.push({ path: topicPath(p.name, tp.name), thread_id: id++, name: `${p.name.toUpperCase().slice(0, 2)}-${tp.name}` })
  return th
}

/* ------------------------------------------------------------------ sessions seed */
const SESSION_SEED = [
  { p: 'acme', t: 'blog', title: 'Draft: 5 ways to speed up checkout', ago: 2 * MIN, turns: 3, cost: 0.84, model: '', real: 'claude-opus-5-5', src: 'web', state: 'running', unread: false,
    last: 'I read the outline and the style guide. Now checking the existing articles so the new one links to them…' },
  { p: 'acme', t: 'blog', title: 'Editorial calendar for November', ago: 25 * MIN, turns: 4, cost: 1.12, model: 'claude-sonnet-5-5', real: 'claude-sonnet-5-5', src: 'web', unread: true,
    last: 'Here is the November calendar: 8 articles, two per week, alternating tutorials and case studies. I saved it to `calendar/2026-11.md`.' },
  { p: 'acme', t: 'blog', title: 'Daily article — Oct 11', ago: 4 * HOUR, turns: 1, cost: 0.47, model: 'claude-sonnet-5-5', real: 'claude-sonnet-5-5', src: 'cron', unread: false,
    last: 'Published “How to write a great product changelog” (1,240 words) and updated the internal links of 3 older posts.' },
  { p: 'acme', t: 'website', title: 'Fix hero image on mobile', ago: 62 * MIN, turns: 2, cost: 0.31, model: '', real: 'claude-opus-5-5', src: 'web', unread: true,
    last: 'Fixed: the hero now uses `object-cover` with an explicit aspect ratio, so it no longer overflows below 400 px. Build passes.' },
  { p: 'acme', t: 'website', title: 'Add pricing page', ago: 26 * HOUR, turns: 6, cost: 2.37, model: '', real: 'claude-opus-5-5', src: 'web', unread: false,
    last: 'The pricing page is live on the preview URL with three tiers and an FAQ. The toggle monthly / yearly is keyboard accessible.' },
  { p: 'acme', t: 'seo', title: 'Keyword research: project management tools', ago: 3 * HOUR, turns: 3, cost: 0.92, model: 'claude-opus-5-5', real: 'claude-opus-5-5', src: 'web', unread: false,
    last: 'I grouped 64 keywords into 9 clusters. The best opportunity is “kanban for small teams” (low difficulty, steady volume).' },
  { p: 'acme', t: 'seo', title: 'Weekly SEO report', ago: 2 * DAY, turns: 1, cost: 0.36, model: 'claude-sonnet-5-5', real: 'claude-sonnet-5-5', src: 'cron', unread: false, archived: true,
    last: 'Clicks +12 % week over week. Two pages lost rankings after the redesign; details in `reports/2026-W40.md`.' },
  { p: 'personal', t: 'notes', title: 'Summarise “Deep Work” highlights', ago: 5 * HOUR, turns: 2, cost: 0.22, model: 'claude-haiku-4-5-20251001', real: 'claude-haiku-4-5-20251001', src: 'telegram', unread: true,
    last: 'Summary saved to `reading/deep-work.md`: 4 rules, 12 highlights, and 3 ideas you could try this week.' },
  { p: 'personal', t: 'finance', title: 'Categorise September expenses', ago: 28 * HOUR, turns: 2, cost: 0.41, model: '', real: 'claude-opus-5-5', src: 'web', unread: false, state: 'error',
    error: 'Claude exited with code 1: API rate limit reached, retry later', last: 'I categorised 112 of 143 transactions so far.' },
  { p: 'ops', t: 'server', title: 'Caddy: add security headers', ago: 30 * MIN, turns: 3, cost: 0.58, model: '', real: 'claude-opus-5-5', src: 'web', unread: false,
    last: 'Added HSTS, `X-Content-Type-Options` and a strict `Referrer-Policy` to the Caddyfile, validated the config and reloaded Caddy.' },
  { p: 'ops', t: 'server', title: 'Investigate high disk usage', ago: 6 * HOUR, turns: 4, cost: 0.77, model: '', real: 'claude-opus-5-5', src: 'telegram', unread: false,
    last: 'Disk is at 82 %. The biggest offenders are old journal logs (6.1 GB) and Docker build cache (4.3 GB). Want me to prune both?' },
  { p: 'ops', t: 'server', title: 'Upgrade Node to 22 LTS', ago: 3 * DAY, turns: 5, cost: 1.04, model: '', real: 'claude-sonnet-5-5', src: 'web', unread: false, archived: true,
    last: 'Node 22.11.0 is installed via the official repository; all three services restarted cleanly.' },
]

function seedSessions(st, t) {
  for (const d of SESSION_SEED) {
    const id = uuid()
    const s = {
      id, title: d.title, path: topicPath(d.p, d.t), state: d.state || 'idle', queue: 0,
      created: t - d.ago - d.turns * 7 * MIN - 3 * HOUR, updated: t - d.ago, turns: d.turns, cost_usd: d.cost,
      model: d.model, real_model: d.real, context_tokens: 18000 + Math.round(d.cost * 41000), context_window: 1000000,
      archived: !!d.archived, notify: d.src !== 'web', source: d.src, unread: !!d.unread,
      last_text: d.last.slice(0, 200), error: d.error || null,
    }
    st.sessions.push(s)
    st.events[id] = conversation(s, d)
  }
}

/* A Claude Code + Codex debate in progress (conversation view: lanes, reply numbers, progress against the limits). The
 * runner writes the name of the agent that answers next as an info note before its turn. */
function seedDebate(st, t) {
  const id = uuid()
  const path = topicPath('acme', 'website')
  const s = { id, title: 'One-page checkout?', path, state: 'running', queue: 0, created: t - 15 * MIN, updated: t - 20, turns: 5, cost_usd: 0.64,
    model: '', real_model: 'claude-opus-5-5', context_tokens: 31000, context_window: 1000000, archived: false, notify: false, source: 'web', unread: false,
    last_text: 'Noted. Revised version: Apple Pay first, then the two blocks Codex proposed, and a single pay button at the bottom.', error: null,
    provider: 'debate', debate_paused: false, discussion_pause_reason: null, discussion_turns: 5, discussion_turn_limit: 20, discussion_duration_seconds: 1800, discussion_elapsed: 14 * MIN }
  const cwd = `${ROOT}/${path}`
  let k = 0
  const at = () => s.created + (k += 30)
  const turn = (agent, text, cost, extra = []) => [
    { type: 'note', text: agent, level: 'info', at: at() },
    { type: 'init', model: agent === 'Codex' ? 'gpt-5.5-codex' : 'claude-opus-5-5', cwd, at: at() },
    ...extra,
    { type: 'assistant', text, at: at() },
    { type: 'result', ok: true, cost_usd: cost, duration_ms: 38000, model: agent === 'Codex' ? 'gpt-5.5-codex' : 'claude-opus-5-5', usage: { input: 900, output: 420, cache_read: 18000, cache_write: 600 }, at: at() },
  ]
  const read = `toolu_${crypto.randomBytes(6).toString('hex')}`
  st.events[id] = [
    { type: 'user', text: 'Should the shop checkout move to a single page? Debate the benefits and the risks, then end with a recommendation.', attachments: [], at: at(), source: 'web' },
    ...turn('Claude Code', 'I suggest putting delivery and payment on one page. Today the cart reloads at every step and the address has to be typed again after going back.', 0.18),
    ...turn('Codex', 'Agreed on the diagnosis, not on the whole cure. On mobile a single page makes the first render heavier: I would keep two collapsible blocks, validated one after the other.', 0),
    { type: 'user', text: 'Keep Apple Pay at the top of the page, that is a constraint.', attachments: [], at: at(), source: 'web' },
    ...turn('Claude Code', 'Noted. Revised version: **Apple Pay first**, then the two blocks Codex proposed, and a single pay button at the bottom.', 0.21, [
      { type: 'tool_use', id: read, name: 'Read', input: { file_path: `${cwd}/src/checkout/steps.tsx` }, summary: 'Read src/checkout/steps.tsx', at: at() },
      { type: 'tool_result', tool_use_id: read, text: 'export const steps = [delivery, payment]', is_error: false, at: at() },
    ]),
    { type: 'note', text: 'Codex', level: 'info', at: at() },
    { type: 'init', model: 'gpt-5.5-codex', cwd, at: at() },
    { type: 'assistant', text: 'That works for me. One point to check before concluding: the Apple Pay button must stay visible without scrolling on a small screen.', at: now() - 25 },
  ]
  st.sessions.push(s)
}

/* Maxxing scenario: 30 sessions spread over the topics, most of them running; each finishes after 5 to 40 s
 * (startMaxxing), one of them on an error, a few with a plan waiting. A prompt sent starts a turn of 8 to 35 s. */
const MAXXING_TASKS = ['Refactor the checkout flow', 'Write the FAQ page', 'Audit the sitemap', 'Translate the landing page', 'Fix flaky login test',
  'Draft the newsletter', 'Compare hosting offers', 'Clean the CSV export', 'Add dark mode to the docs', 'Optimise hero images', 'Write release notes',
  'Map the internal links', 'Review the privacy policy', 'Profile the slow API route', 'Plan the Q1 content', 'Migrate the cron jobs', 'Design the pricing table',
  'Summarise user feedback', 'Set up uptime alerts', 'Rewrite the onboarding emails', 'Check broken links', 'Tag the photo library', 'Benchmark the search',
  'Prepare the board slides', 'Draft a job post', 'Split the big component', 'Write the API docs', 'Tidy the backlog', 'Archive old invoices', 'Estimate the redesign']
function seedMaxxing(st, t) {
  const topics = st.projects.flatMap((p) => p.topics.map((tp) => topicPath(p.name, tp.name)))
  MAXXING_TASKS.forEach((title, i) => {
    const id = uuid()
    const s = {
      id, title, path: topics[i % topics.length], state: 'running', queue: 0,
      created: t - (i + 2) * 7 * MIN, updated: t - i * 5, turns: 1 + (i % 4), cost_usd: +(0.1 + (i % 7) * 0.13).toFixed(2),
      model: '', real_model: i % 3 ? 'claude-opus-5-5' : 'claude-sonnet-5-5', context_tokens: 22000 + i * 1700, context_window: 1000000,
      archived: false, notify: false, source: 'web', unread: false, last_text: `Working on: ${title.toLowerCase()}…`, error: null,
      plan_mode: i % 9 === 4, plan_ready: false, maxxing: true,
    }
    st.sessions.push(s)
    st.events[id] = [
      { type: 'user', text: `${title}. Keep it short and tell me when it is done.`, attachments: [], at: s.created, source: 'web' },
      { type: 'init', model: s.real_model, cwd: `${ROOT}/${s.path}`, at: s.created + 2 },
      { type: 'thinking', text: `Starting: ${title}. First I read the topic memory, then the files involved.`, at: s.created + 4 },
    ]
  })
}
function maxxingFinish(s, i) {
  const model = s.real_model || 'claude-opus-5-5'
  const failed = i === 7 && s.turns < 3
  const cost = +(0.03 + Math.random() * 0.2).toFixed(4)
  s.turns += 1; s.cost_usd = +(s.cost_usd + cost).toFixed(4); s.updated = now(); s.unread = true; s.state = failed ? 'error' : 'idle'
  if (failed) {
    s.error = 'Claude exited with code 1: overloaded, retry later'
    addEvents(s, { type: 'result', ok: false, error: s.error, cost_usd: cost, duration_ms: 20000, model, at: now() })
  } else {
    const answer = s.plan_mode
      ? `**Plan for “${s.title}”**\n\n1. Read the files involved.\n2. Make the change in small steps.\n3. Check the result and report.\n\nValidate the plan and I start.`
      : `Done: **${s.title}**. I changed 3 files and checked the result. What next?`
    if (s.plan_mode) s.plan_ready = true
    s.last_text = answer.replace(/[*`#\n]/g, ' ').slice(0, 200)
    addEvents(s, { type: 'assistant', text: answer, at: now() },
      { type: 'result', ok: true, cost_usd: cost, duration_ms: 20000, model, usage: { input: 900, output: 210, cache_read: 21000, cache_write: 400 }, at: now() })
  }
  bus('sessions', 'workspace')
}
function startMaxxing() {
  if (S.scenario !== 'maxxing') return
  S.sessions.filter((s) => s.maxxing).forEach((s, i) => later(s, 5000 + Math.random() * 35000, () => maxxingFinish(s, i)))
}

function conversation(s, d) {
  const cwd = `${ROOT}/${s.path}`
  const t0 = s.created
  const model = s.real_model || 'claude-opus-5-5'
  const ev = []
  let k = 0
  const at = () => t0 + (k += 4)
  const tid = () => `toolu_${crypto.randomBytes(6).toString('hex')}`
  const isOps = s.path.startsWith('projects/ops')
  const isSite = s.path.includes('/website')

  // turn 1
  ev.push({ type: 'user', text: firstPrompt(s), attachments: s.path.endsWith('/website') ? [`${cwd}/attachments/2026-10/hero-mobile.png`] : [], at: at(), source: s.source })
  ev.push({ type: 'init', model, cwd, at: at() })
  ev.push({ type: 'thinking', text: 'The user wants me to work in this topic. I should first read the topic memory to understand the conventions, then look at the existing files before changing anything.', at: at() })
  const r1 = tid()
  ev.push({ type: 'tool_use', id: r1, name: 'Read', input: { file_path: `${cwd}/memory.md` }, summary: `Read ${s.path}/memory.md`, at: at() })
  ev.push({ type: 'tool_result', tool_use_id: r1, text: `# ${s.path.split('/').pop()} — memory\n\n## Conventions\n- Write in plain English, short paragraphs.\n- Keep a changelog of decisions below.\n\n## Decisions\n- 2026-09-30: use the shared style guide in ../../CLAUDE.md`, is_error: false, at: at() })
  const b1 = tid()
  const cmd = isOps ? 'df -h / && du -sh /var/log/journal /var/lib/docker 2>/dev/null' : isSite ? 'npm run build 2>&1 | tail -5' : 'ls -la'
  const out = isOps
    ? 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        80G   66G   15G  82% /\n6.1G\t/var/log/journal\n4.3G\t/var/lib/docker'
    : isSite
      ? '> acme-website@1.4.0 build\n> astro build\n\n 12 page(s) built in 3.41s\n Complete!'
      : 'total 48\ndrwxr-xr-x 6 root root 4096 Oct 11 08:12 .\ndrwxr-xr-x 5 root root 4096 Sep 02 10:40 ..\n-rw-r--r-- 1 root root  412 Sep 02 10:40 CLAUDE.md\n-rw-r--r-- 1 root root 1893 Oct 10 18:02 memory.md\ndrwxr-xr-x 2 root root 4096 Oct 11 08:12 drafts\ndrwxr-xr-x 2 root root 4096 Oct 09 14:55 images'
  ev.push({ type: 'tool_use', id: b1, name: 'Bash', input: { command: cmd, description: 'Inspect the current state' }, summary: `Bash: ${cmd}`, at: at() })
  ev.push({ type: 'tool_result', tool_use_id: b1, text: out, is_error: false, at: at() })

  if (s.state === 'running') {
    ev.push({ type: 'assistant', text: d.last, at: at() })
    const td = tid()
    ev.push({ type: 'tool_use', id: td, name: 'TodoWrite', input: { todos: [
      { content: 'Read the topic memory', status: 'completed', activeForm: 'Reading the topic memory' },
      { content: 'List the existing articles', status: 'completed', activeForm: 'Listing the existing articles' },
      { content: 'Write the draft', status: 'in_progress', activeForm: 'Writing the draft' },
      { content: 'Update the memory', status: 'pending', activeForm: 'Updating the memory' },
    ] }, summary: 'TodoWrite', at: at() })
    ev.push({ type: 'tool_result', tool_use_id: td, text: 'Todos have been modified successfully.', is_error: false, at: at() })
    const g = tid()
    ev.push({ type: 'tool_use', id: g, name: 'Grep', input: { pattern: 'checkout', path: `${cwd}/drafts` }, summary: 'Grep "checkout" in drafts/', at: at() })
    ev.push({ type: 'tool_result', tool_use_id: g, text: 'drafts/2026-09-cart-abandonment.md:14: …a slow checkout is the first reason…\ndrafts/2026-10-payment-methods.md:3: …one-page checkout…', is_error: false, at: at() })
    const w = tid()
    ev.push({ type: 'tool_use', id: w, name: 'Write', input: { file_path: `${cwd}/drafts/2026-10-speed-up-checkout.md`, content: '# 5 ways to speed up checkout\n…' }, summary: 'Write drafts/2026-10-speed-up-checkout.md', at: at() })
    return ev
  }

  ev.push({ type: 'assistant', text: answerMarkdown(s, d), at: at() })
  ev.push({ type: 'result', ok: true, cost_usd: +(s.cost_usd / Math.max(1, s.turns) * 1.3).toFixed(4), duration_ms: 41250, model,
    usage: { input: 1840, output: 1265, cache_read: 21430, cache_write: 4120 }, at: at() })

  if (s.turns > 1) {
    ev.push({ type: 'user', text: 'Great, thanks. Can you also update the topic memory with what we decided?', attachments: [], at: at(), source: s.source })
    ev.push({ type: 'init', model, cwd, at: at() })
    const e1 = tid()
    ev.push({ type: 'tool_use', id: e1, name: 'Edit', input: { file_path: `${cwd}/memory.md`, old_string: '## Decisions', new_string: `## Decisions\n- 2026-10-11: ${s.title}` }, summary: `Edit ${s.path}/memory.md`, at: at() })
    ev.push({ type: 'tool_result', tool_use_id: e1, text: 'The file has been updated successfully.', is_error: false, at: at() })
    if (s.state === 'error') {
      const t1 = tid()
      ev.push({ type: 'tool_use', id: t1, name: 'Bash', input: { command: 'python3 scripts/categorise.py --month 2026-09', description: 'Categorise the rest' }, summary: 'Bash: python3 scripts/categorise.py --month 2026-09', at: at() })
      ev.push({ type: 'tool_result', tool_use_id: t1, text: 'Traceback (most recent call last):\n  File "scripts/categorise.py", line 42\nKeyError: \'merchant\'\nExit code 1', is_error: true, at: at() })
      ev.push({ type: 'note', text: 'Turn failed: ' + s.error, level: 'error', at: at() })
      return ev
    }
    ev.push({ type: 'assistant', text: `Done — I added a line under **Decisions** in \`memory.md\`.\n\n${d.last}`, at: at() })
    ev.push({ type: 'result', ok: true, cost_usd: +(s.cost_usd / s.turns * 0.7).toFixed(4), duration_ms: 12890, model,
      usage: { input: 640, output: 212, cache_read: 25110, cache_write: 380 }, at: at() })
  }
  if (s.archived) ev.push({ type: 'note', text: 'Session archived.', level: 'info', at: at() })
  return ev
}

function firstPrompt(s) {
  if (s.source === 'cron') return `[cron] ${s.title}. Follow the editorial plan and the memory of this topic, then report what you did in 3 lines.`
  return `${s.title}. Please look at what we already have in this topic first, then propose and apply the changes.`
}

function answerMarkdown(s, d) {
  const isOps = s.path.startsWith('projects/ops')
  const code = isOps
    ? '```caddyfile\nui.example.com {\n\theader {\n\t\tStrict-Transport-Security "max-age=31536000; includeSubDomains"\n\t\tX-Content-Type-Options nosniff\n\t\tReferrer-Policy strict-origin-when-cross-origin\n\t}\n\treverse_proxy 127.0.0.1:8787\n}\n```'
    : s.path.includes('/website')
      ? '```astro\n<img\n  src={hero}\n  alt="Acme dashboard"\n  class="w-full aspect-[4/3] object-cover sm:aspect-[16/9]"\n  loading="eager"\n/>\n```'
      : '```markdown\n## Outline\n1. Why speed matters (data)\n2. Remove optional fields\n3. Offer express wallets\n4. Show progress clearly\n5. Measure and iterate\n```'
  return [
    `## Summary`, '', d.last, '',
    `### What I changed`, '',
    `- Read the topic memory and the existing files`,
    `- Applied the change and checked the result`,
    `- Kept the conventions from \`CLAUDE.md\``, '',
    code, '',
    `| Item | Before | After |`, `|---|---|---|`, `| Files touched | 0 | 2 |`, `| Checks | — | passing |`, '',
    `> Tip: ask me to **commit** when you are happy with it.`,
  ].join('\n')
}

/* ------------------------------------------------------------------ tasks seed */
function seedTasks(st, t) {
  const today = new Date().toISOString().slice(0, 10)
  const day = (n) => new Date(Date.now() + n * DAY * 1000).toISOString().slice(0, 10)
  st.tasks.projects = [
    { id: 'tp_acme', name: 'Acme', color: '#6366f1' },
    { id: 'tp_personal', name: 'Personal', color: '#10b981' },
    { id: 'tp_ops', name: 'Ops', color: '#f59e0b' },
  ]
  const T = (title, status, priority, due, project_id, topic_path, labels, notes = '', ageDays = 3) => ({
    id: rid('t'), title, notes, status, priority, due, project_id, topic_path, labels,
    created: t - ageDays * DAY, updated: t - Math.min(ageDays, 1) * DAY / 2, done_at: status === 'done' ? t - DAY / 3 : null, order: 0,
  })
  st.tasks.tasks = [
    T('Review the checkout article draft', 'doing', 2, today, 'tp_acme', topicPath('acme', 'blog'), ['writing'], 'Check the numbers in section 2.'),
    T('Renew the ui.example.com certificate alert', 'todo', 1, today, 'tp_ops', topicPath('ops', 'server'), ['infra']),
    T('Call the accountant about Q3', 'todo', 3, today, 'tp_personal', topicPath('personal', 'finance'), ['admin'], 'Bring the categorised expenses export.'),
    T('Publish pricing page', 'todo', 2, day(2), 'tp_acme', topicPath('acme', 'website'), ['launch']),
    T('Prune Docker build cache', 'todo', 1, day(1), 'tp_ops', topicPath('ops', 'server'), ['infra', 'disk']),
    T('Fix 404s found by the SEO audit', 'doing', 2, day(3), 'tp_acme', topicPath('acme', 'seo'), ['seo'], '', 6),
    T('Read “Shape Up” chapters 4–6', 'todo', 0, null, 'tp_personal', topicPath('personal', 'notes'), ['reading'], '', 10),
    T('Set up a monthly budget review cron', 'todo', 1, day(7), 'tp_personal', null, ['idea'], '', 12),
    T('Migrate blog images to WebP', 'done', 1, day(-2), 'tp_acme', topicPath('acme', 'blog'), ['performance'], '', 9),
    T('Rotate the Cloudflare API token', 'done', 2, day(-4), 'tp_ops', null, ['security'], '', 14),
    T('Write the November newsletter', 'todo', 1, day(-1), 'tp_acme', null, ['writing'], 'Overdue — reuse the calendar.', 5),
  ]
  st.tasks.tasks.forEach((x, i) => { x.order = (i + 1) * 1000 })
}

/* ------------------------------------------------------------------ crons */
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const LIM = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

function cronValid(expr) {
  const f = String(expr || '').trim().split(/\s+/)
  if (f.length !== 5) return false
  return f.every((x, i) => x.split(',').every((part) => {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/)
    if (!m) return false
    const a = m[2] !== undefined ? +m[2] : null, b = m[3] !== undefined ? +m[3] : null
    if (a !== null && (a < LIM[i][0] || a > LIM[i][1])) return false
    if (b !== null && (b < LIM[i][0] || b > LIM[i][1] || b < a)) return false
    if (m[4] !== undefined && +m[4] < 1) return false
    return true
  }))
}
function fieldMatch(field, v, i) {
  return field.split(',').some((part) => {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/)
    let lo = LIM[i][0], hi = LIM[i][1]
    if (m[1] !== '*') { lo = +m[2]; hi = m[3] !== undefined ? +m[3] : (m[4] ? LIM[i][1] : lo) }
    const step = m[4] ? +m[4] : 1
    const val = i === 4 && v === 0 && hi === 7 && lo > 0 ? 7 : v
    return val >= lo && val <= hi && (val - lo) % step === 0
  })
}
// Minutes east of UTC of `zone` at instant `ms` (an unknown zone counts as UTC).
const zoneFormats = new Map()
function zoneOffset(ms, zone) {
  let f = zoneFormats.get(zone)
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    } catch {
      f = null
    }
    zoneFormats.set(zone, f)
  }
  if (!f) return 0
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, +x.value]))
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60000) * 60000) / 60000
}
// Like the server (crons.iter_runs), schedules are evaluated in the configured timezone.
function cronNext(expr, n = 5, from = Date.now()) {
  if (!cronValid(expr)) return []
  const f = expr.trim().split(/\s+/)
  const zone = S?.settings?.timezone || 'UTC'
  const out = []
  let bucket = -1, offset = 0
  for (let i = 0, t = Math.floor(from / 60000) * 60000 + 60000; i < 366 * 24 * 60 && out.length < n; i++, t += 60000) {
    if (Math.floor(t / 900000) !== bucket) {
      bucket = Math.floor(t / 900000)
      offset = zoneOffset(t, zone)
    }
    const d = new Date(t + offset * 60000) // wall clock of the zone, read with the UTC getters
    const dowF = f[4], domF = f[2]
    const domOk = fieldMatch(domF, d.getUTCDate(), 2), dowOk = fieldMatch(dowF, d.getUTCDay(), 4)
    const dayOk = domF !== '*' && dowF !== '*' ? domOk || dowOk : domOk && dowOk
    if (fieldMatch(f[0], d.getUTCMinutes(), 0) && fieldMatch(f[1], d.getUTCHours(), 1) && fieldMatch(f[3], d.getUTCMonth() + 1, 3) && dayOk) out.push(t / 1000)
  }
  return out
}
// Like the server (crons.humanize): in the UI language (settings.language), times HH:MM
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
function cronHuman(expr) {
  const fr = S?.settings?.language === 'fr'
  if (expr === '@reboot') return fr ? 'Au démarrage' : 'At boot'
  if (!cronValid(expr)) return fr ? 'Expression invalide' : 'Invalid expression'
  const [mi, h, dom, mon, dow] = expr.trim().split(/\s+/)
  const pad = (x) => String(x).padStart(2, '0')
  const num = (v) => /^\d+$/.test(v)
  const rest = dom === '*' && mon === '*' && dow === '*'
  if (mi === '*' && h === '*' && rest) return fr ? 'Toutes les minutes' : 'Every minute'
  if (/^\*\/\d+$/.test(mi) && h === '*' && rest) return fr ? `Toutes les ${mi.slice(2)} minutes` : `Every ${mi.slice(2)} minutes`
  if (num(mi) && h === '*' && rest) return fr ? `Toutes les heures à la minute ${+mi}` : `Every hour at :${pad(mi)}`
  if (num(mi) && /^\*\/\d+$/.test(h) && rest) return fr ? `Toutes les ${h.slice(2)} heures à la minute ${+mi}` : `Every ${h.slice(2)} hours at :${pad(mi)}`
  if (num(mi) && num(h)) {
    const at = `${pad(h)}:${pad(mi)}`
    if (rest) return fr ? `Tous les jours à ${at}` : `Every day at ${at}`
    if (dom === '*' && mon === '*' && num(dow)) return fr ? `À ${at} le ${JOURS[+dow % 7]}` : `Every ${DOW[+dow % 7]} at ${at}`
    if (dom === '*' && mon === '*' && dow === '1-5') return fr ? `À ${at} en semaine` : `Weekdays at ${at}`
    if (num(dom) && mon === '*' && dow === '*') return fr ? `À ${at} le ${dom === '1' ? '1er' : dom} du mois` : `On day ${dom} of every month at ${at}`
  }
  return fr ? `Planification personnalisée (${expr})` : `Custom schedule (${expr})`
}
const cronOut = (c) => ({ ...c, next_run: c.enabled ? cronNext(c.schedule, 1)[0] ?? null : null, human: cronHuman(c.schedule), running: c.id === 'c_blog' })

function seedCrons(st, t) {
  const base = { command: '', topic_path: '', prompt: '', model: '', reuse_session: false, enabled: true, notify: 'failure', timeout_s: 600 }
  st.crons = [
    { ...base, id: 'c_backup', name: 'Memory backup', schedule: '40 4 * * *', kind: 'shell', command: 'maxxing backup run', last_run: { at: t - 5 * HOUR, ok: true, code: 0, duration_s: 6.2 } },
    { ...base, id: 'c_blog', name: 'Daily blog article', schedule: '0 7 * * *', kind: 'claude', topic_path: topicPath('acme', 'blog'),
      prompt: 'Write the next article from the editorial plan, publish it, and update internal links.', model: 'claude-sonnet-5-5', notify: 'always', timeout_s: 1800,
      last_run: { at: t - 4 * HOUR, ok: true, code: 0, duration_s: 412.8 } },
    { ...base, id: 'c_seo', name: 'Weekly SEO report', schedule: '30 8 * * 1', kind: 'claude', topic_path: topicPath('acme', 'seo'),
      prompt: 'Produce the weekly SEO report from Search Console data and save it under reports/.', model: 'claude-sonnet-5-5', reuse_session: true,
      last_run: { at: t - 2 * DAY, ok: true, code: 0, duration_s: 233.1 } },
    { ...base, id: 'c_uptime', name: 'Uptime check', schedule: '*/15 * * * *', kind: 'shell', command: 'curl -fsS --max-time 10 https://www.example.com/healthz', timeout_s: 30,
      last_run: { at: t - 9 * MIN, ok: false, code: 22, duration_s: 10.0 } },
    { ...base, id: 'c_cleanup', name: 'Clean old attachments', schedule: '0 3 1 * *', kind: 'shell', command: 'find /root/harness-pilot -path "*/attachments/*" -mtime +90 -delete', enabled: false, notify: 'never',
      last_run: { at: t - 40 * DAY, ok: true, code: 0, duration_s: 1.4 } },
  ]
  st.external = [
    { schedule: '0 0 * * 0', command: '/usr/sbin/logrotate /etc/logrotate.conf', human: cronHuman('0 0 * * 0') },
    { schedule: '@reboot', command: '/usr/local/bin/mount-backups.sh', human: 'At boot' },
  ]
  const r = rng(7)
  const blogIds = st.sessions.filter((s) => s.source === 'cron').map((s) => s.id)
  for (let i = 0; i < 36; i++) {
    const c = st.crons[Math.floor(r() * 4)]
    const ok = c.id === 'c_uptime' ? r() > 0.25 : r() > 0.06
    const at = t - i * 3.3 * HOUR - Math.floor(r() * 900)
    st.cronRuns.push({ id: rid('r'), cron_id: c.id, name: c.name, at, ok, code: ok ? 0 : (c.id === 'c_uptime' ? 22 : 1),
      duration_s: +(c.kind === 'claude' ? 120 + r() * 400 : r() * 10).toFixed(1),
      output_tail: ok ? (c.kind === 'claude' ? 'Turn finished: article published, 3 links updated.' : 'OK') : (c.id === 'c_uptime' ? 'curl: (22) The requested URL returned error: 503' : 'Error: process exited with code 1'),
      session_id: c.kind === 'claude' && c.id === 'c_blog' && blogIds.length ? blogIds[0] : null })
  }
  st.cronRuns.sort((a, b) => b.at - a.at)
}

/* ------------------------------------------------------------------ files */
function fsAdd(st, rel, content, mtime, mime) {
  const abs = rel.startsWith('/') ? rel : `${ROOT}/${rel}`
  fsMkdirp(st, path.dirname(abs), mtime)
  const m = mime || mimeOf(abs)
  const body = content ?? ''
  st.fs.set(abs, { type: 'file', content: body, mtime, mime: m, size: typeof body === 'string' ? Buffer.byteLength(body) : body.length })
}
function fsMkdirp(st, abs, mtime = now()) {
  let cur = abs
  const chain = []
  while (cur.startsWith(ROOT) && !st.fs.has(cur)) { chain.push(cur); if (cur === ROOT) break; cur = path.dirname(cur) }
  for (const d of chain) st.fs.set(d, { type: 'dir', mtime, mime: 'inode/directory', size: 4096 })
}

function seedFiles(st, t) {
  st.fs.set(ROOT, { type: 'dir', mtime: t - 40 * DAY, mime: 'inode/directory', size: 4096 })
  fsAdd(st, 'CLAUDE.md', '# Workspace\n\n@memory.md\n\nYou are working in the harness-pilot workspace. Projects live in `projects/<name>/`, topics in `projects/<name>/topics/<topic>/`.\n\n## Rules\n- Write durable facts in the closest `memory.md`.\n- Never print secrets.\n', t - 30 * DAY)
  fsAdd(st, 'memory.md', '# Global memory\n\n## Preferences\n- Answers in English, concise.\n- Timezone Europe/Paris.\n\n## Facts\n- Server: Ubuntu 24.04, 4 vCPU, 8 GB RAM.\n- Public URL: https://ui.example.com\n', t - 2 * DAY)
  fsAdd(st, 'tasks.json', JSON.stringify(st.tasks, null, 2), t - HOUR)
  for (const p of st.projects) {
    fsAdd(st, `${projPath(p.name)}/CLAUDE.md`, `# Project ${p.name}\n\n> ${p.description}\n\n@memory.md\n`, t - 20 * DAY)
    fsAdd(st, `${projPath(p.name)}/memory.md`, `# ${p.name} — memory\n\n- Created for: ${p.description}\n`, t - 3 * DAY)
    for (const tp of p.topics) {
      const base = topicPath(p.name, tp.name)
      fsAdd(st, `${base}/CLAUDE.md`, `# Topic ${p.name}/${tp.name}\n\n> ${tp.description}\n\n@memory.md\n`, t - 20 * DAY)
      fsAdd(st, `${base}/memory.md`, `# ${tp.name} — memory\n\n## Conventions\n- Write in plain English, short paragraphs.\n\n## Decisions\n- 2026-09-30: use the shared style guide\n`, t - DAY)
    }
  }
  if (st.projects.length) {
    const blog = topicPath('acme', 'blog')
    fsAdd(st, `${blog}/drafts/2026-10-speed-up-checkout.md`, '# 5 ways to speed up checkout\n\nA slow checkout costs sales. Here are five changes that make a measurable difference.\n\n## 1. Remove optional fields\n\nEvery field is friction…\n', t - 3 * MIN)
    fsAdd(st, `${blog}/drafts/2026-09-cart-abandonment.md`, '# Why carts get abandoned\n\nA slow checkout is the first reason…\n', t - 20 * DAY)
    fsAdd(st, `${blog}/calendar/2026-11.md`, '# November 2026\n\n| Week | Tuesday | Friday |\n|---|---|---|\n| 45 | Changelog tips | Case study: Globex |\n| 46 | Kanban basics | Pricing pages |\n', t - 25 * MIN)
    fsAdd(st, `${blog}/images/cover-checkout.png`, PLACEHOLDER_SVG('cover-checkout.png'), t - 2 * HOUR, 'image/png')
    fsAdd(st, `${blog}/images/hero.jpg`, PLACEHOLDER_SVG('hero.jpg'), t - 5 * DAY, 'image/jpeg')
    const site = topicPath('acme', 'website')
    fsAdd(st, `${site}/src/pages/index.astro`, '---\nimport Layout from "../layouts/Layout.astro"\nimport hero from "../assets/hero.webp"\n---\n<Layout title="Acme — Ship faster">\n  <h1>Ship faster</h1>\n</Layout>\n', t - 62 * MIN)
    fsAdd(st, `${site}/src/styles/global.css`, ':root { --brand: #6366f1; }\nbody { font-family: Inter, sans-serif; }\n', t - 9 * DAY)
    fsAdd(st, `${site}/package.json`, '{\n  "name": "acme-website",\n  "version": "1.4.0",\n  "scripts": { "build": "astro build" }\n}\n', t - 9 * DAY)
    fsAdd(st, `${site}/attachments/2026-10/hero-mobile.png`, PLACEHOLDER_SVG('hero-mobile.png'), t - 70 * MIN, 'image/png')
    fsAdd(st, `${topicPath('acme', 'seo')}/keywords.csv`, 'keyword,volume,difficulty,cluster\nkanban for small teams,2400,18,kanban\nproject management tool,40500,72,generic\ntask board free,5400,31,kanban\n', t - 3 * HOUR)
    fsAdd(st, `${topicPath('acme', 'seo')}/reports/2026-W40.md`, '# SEO report — week 40\n\n- Clicks: 3,412 (+12 %)\n- Impressions: 88,903 (+4 %)\n', t - 2 * DAY)
    fsAdd(st, `${topicPath('personal', 'notes')}/ideas.md`, '# Ideas\n\n- A weekly digest of my sessions\n- Track reading time\n', t - 6 * DAY)
    fsAdd(st, `${topicPath('personal', 'notes')}/reading/deep-work.md`, '# Deep Work — highlights\n\n1. Work deeply\n2. Embrace boredom\n3. Quit social media\n4. Drain the shallows\n', t - 5 * HOUR)
    fsAdd(st, `${topicPath('personal', 'finance')}/budget-2026.csv`, 'month,income,expenses\n2026-07,5200,3890\n2026-08,5200,4120\n2026-09,5350,3975\n', t - 28 * HOUR)
    fsAdd(st, `${topicPath('ops', 'server')}/deploy.sh`, '#!/usr/bin/env bash\nset -euo pipefail\ncd /srv/acme-website\ngit pull --ff-only\nnpm ci && npm run build\nsystemctl reload caddy\n', t - 8 * DAY)
    fsAdd(st, `${topicPath('ops', 'server')}/caddy/Caddyfile`, 'ui.example.com {\n\treverse_proxy 127.0.0.1:8787\n}\n', t - 30 * MIN)
    fsAdd(st, `${topicPath('ops', 'server')}/demo.mp4`, Buffer.alloc(2048), t - 12 * DAY, 'video/mp4')
  }
  fsAdd(st, 'extensions/shop-sales/manifest.json', JSON.stringify({ id: 'shop-sales', name: 'Shop sales', type: 'widget', icon: 'shopping-cart', version: '1.2.0', span: 1, ttl: 1800 }, null, 2), t - 15 * DAY)
  fsAdd(st, 'extensions/shop-sales/api.py', 'def card(ctx):\n    orders = ctx.http.get("https://api.example-shop.com/orders?days=7").json()\n    return {"blocks": [{"type": "stat", "label": "Today", "value": len(orders)}]}\n', t - 15 * DAY)
  fsAdd(st, 'extensions/notes/manifest.json', JSON.stringify({ id: 'notes', name: 'Notes', type: 'page', icon: 'notebook-pen', version: '0.3.0', permissions: { read: ['projects'] } }, null, 2), t - 10 * DAY)
  fsAdd(st, 'extensions/notes/api.py', 'import time\n\ndef handle(ctx, method, path, query, body):\n    if path == "hello":\n        return {"hello": "world", "at": time.time()}\n    return {"error": "not_found"}\n', t - 10 * DAY)
  fsAdd(st, 'extensions/notes/page.js', NOTES_PAGE_JS, t - 10 * DAY)
  fsAdd(st, 'extensions/broken-widget/manifest.json', JSON.stringify({ id: 'broken-widget', name: 'Broken widget', type: 'widget', icon: 'triangle-alert', version: '0.1.0' }, null, 2), t - 4 * DAY)
  fsAdd(st, 'extensions/broken-widget/api.py', 'def card(ctx)\n    return {"blocks": []}\n', t - 4 * DAY)
  fsAdd(st, 'extensions/stock-levels/manifest.json', JSON.stringify({ id: 'stock-levels', name: 'Stock levels', type: 'widget', icon: 'package', version: '1.0.0', api: 1, permissions: { secrets: ['STOCK_API_KEY'] } }, null, 2), t - 3 * HOUR)
  fsAdd(st, 'extensions/stock-levels/api.py', 'import json\nimport urllib.request\n\n\ndef card(ctx):\n    key = ctx["secret"]("STOCK_API_KEY")\n    return {"blocks": [{"type": "list", "items": []}]}\n', t - 3 * HOUR)
}

function PLACEHOLDER_SVG(label = 'image', w = 640, h = 400) {
  const hue = [...label].reduce((a, c) => a + c.charCodeAt(0), 0) % 360
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},55%,35%)"/></linearGradient></defs>` +
    `<rect width="100%" height="100%" fill="url(#g)"/>` +
    `<text x="50%" y="50%" fill="#fff" font-family="sans-serif" font-size="${Math.round(w / 18)}" text-anchor="middle" dominant-baseline="middle">${label.replace(/[<&>]/g, '')}</text></svg>`
}

const NOTES_PAGE_JS = `// Example page extension (mock). ctx = { api(path, opts), navigate, theme, t }
export function mount(el, ctx) {
  el.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.style.cssText = 'padding:24px;max-width:640px'
  const h = document.createElement('h2')
  h.textContent = 'Notes'
  h.style.cssText = 'font-size:20px;font-weight:600;margin:0 0 6px'
  const p = document.createElement('p')
  p.textContent = 'Example page extension. Current theme: ' + (ctx && ctx.theme)
  p.style.cssText = 'opacity:.7;margin:0'
  const btn = document.createElement('button')
  btn.textContent = 'Call api("hello")'
  btn.style.cssText = 'margin-top:16px;padding:8px 14px;border:1px solid currentColor;border-radius:8px;background:transparent;color:inherit;cursor:pointer;font:inherit'
  const out = document.createElement('pre')
  out.style.cssText = 'margin-top:12px;padding:12px;border-radius:8px;background:rgba(127,127,127,.12);font-size:13px;white-space:pre-wrap'
  out.textContent = '(no call yet)'
  btn.onclick = async () => {
    out.textContent = 'Loading…'
    try {
      let r = await ctx.api('hello')
      if (r && typeof r.json === 'function') r = await r.json()
      out.textContent = JSON.stringify(r, null, 2)
    } catch (e) {
      out.textContent = 'Error: ' + ((e && e.message) || e)
    }
  }
  wrap.append(h, p, btn, out)
  el.append(wrap)
  return () => { el.innerHTML = '' }
}
`

/* =================================================================== derived objects */
function topicObj(p, tp) {
  const pth = topicPath(p.name, tp.name)
  const ss = S.sessions.filter((s) => s.path === pth && !s.archived)
  const th = S.telegram.threads.find((x) => x.path === pth)
  return { name: tp.name, project: p.name, path: pth, description: tp.description || '', session_count: ss.length, archived_count: S.sessions.filter((s) => s.path === pth && s.archived).length,
    running: ss.filter((s) => s.state === 'running').length, unread: ss.filter((s) => s.unread).length, telegram_thread: th ? th.thread_id : null }
}
function projectObj(p) {
  const pp = projPath(p.name)
  return { name: p.name, path: pp, description: p.description || '', topics: p.topics.map((tp) => topicObj(p, tp)),
    session_count: S.sessions.filter((s) => (s.path === pp || s.path.startsWith(pp + '/')) && !s.archived).length }
}
const findProject = (name) => S.projects.find((p) => p.name === name) || fail(404, 'not_found', `Project “${name}” not found`)
const findSession = (id) => S.sessions.find((s) => s.id === id) || fail(404, 'not_found', 'Session not found')

function onboardingObj() {
  return { completed: S.onboarding_completed, steps: { password: !S.setup_required && !!S.password, claude: S.claude.auth.ok,
    workspace: S.projects.length > 0, telegram: !!S.telegram.chat, backup: S.backup.configured } }
}

/* =================================================================== SSE buses */
const busClients = new Set()
const sessionSubs = new Map() // id -> Set(res)

function sseOpen(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.write('retry: 3000\n\n')
}
const sseSend = (res, event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch {} }

function bus(...topics) {
  const data = { topics: [...new Set(topics)] }
  for (const c of busClients) sseSend(c, 'invalidate', data)
  // Like the server's session streams: a `state` frame whenever the Session changed (any write announces `sessions`).
  if (topics.includes('sessions')) for (const [id, subs] of sessionSubs) {
    const s = S.sessions.find((x) => x.id === id)
    if (!s) { for (const r of subs) sseSend(r, 'state', null); sessionSubs.delete(id); continue }
    const sig = JSON.stringify(s)
    for (const r of subs) if (r.mxState !== sig) { r.mxState = sig; sseSend(r, 'state', s) }
  }
}
function pushEvents(id, newEvents) {
  const subs = sessionSubs.get(id)
  if (!subs) return
  const s = S.sessions.find((x) => x.id === id)
  const next = (S.events[id] || []).length
  for (const r of subs) {
    if (newEvents.length) sseSend(r, 'events', { events: newEvents, next })
    if (s) sseSend(r, 'state', s)
  }
}
function addEvents(s, ...evs) {
  (S.events[s.id] ||= []).push(...evs)
  pushEvents(s.id, evs)
}

setInterval(() => {
  for (const c of busClients) c.write(': ping\n\n')
  for (const set of sessionSubs.values()) for (const c of set) c.write(': ping\n\n')
}, 15000).unref()
setInterval(() => bus('health'), 20000).unref()

/* =================================================================== simulated turns */
function later(s, ms, fn) {
  const g = GEN
  const h = setTimeout(() => { if (g === GEN) fn() }, ms)
  ;(S.timers[s.id] ||= []).push(h)
}
function clearTimers(s) { for (const h of S.timers[s.id] || []) clearTimeout(h); S.timers[s.id] = [] }

/* The theme generator's topic (Settings -> Appearance -> Create): the turn writes a `<name>.theme.json` like the
   skill pilot-theme would (a canned "Ember" theme, adjusted by the refinement words). */
const THEME_TOPIC = 'projects/system/topics/themes'
function emberTheme(text, prev) {
  const t = prev ? JSON.parse(JSON.stringify(prev)) : {
    schema: 1, id: 'ember', name: 'Ember', description: 'Warm dark surfaces, orange buttons, calm text.', base: 'custom', accent: '#e8915a', buttons: 'accent', tint: 'neutral',
    tokens: { light: {}, dark: { background: '#14100d', foreground: '#f6efe8', card: '#1c1612', 'card-foreground': '#f6efe8', popover: '#211a15', 'popover-foreground': '#f6efe8',
      secondary: '#2b221b', 'secondary-foreground': '#f6efe8', muted: '#241c16', 'muted-foreground': '#b8a99a', accent: '#2b221b', 'accent-foreground': '#f6efe8',
      border: '#2e241c', input: '#3a2e24', sidebar: '#181310', 'sidebar-border': '#2e241c', primary: '#f2b48a', action: '#e8915a', 'action-foreground': '#ffffff' } },
  }
  const low = text.toLowerCase()
  if (/contrast/.test(low)) Object.assign(t.tokens.dark, { foreground: '#fffaf5', 'muted-foreground': '#d2c3b4', border: '#4a3a2c', card: '#211a15' })
  if (/neutral|neutre/.test(low)) { t.buttons = 'neutral'; delete t.tokens.dark.action; delete t.tokens.dark['action-foreground'] }
  if (/cool|froid/.test(low)) { t.accent = '#5a9ae8'; t.tokens.dark.primary = '#8ab8f2'; if (t.tokens.dark.action) t.tokens.dark.action = '#5a9ae8'; t.name = 'Ember - cool' }
  if (/light|clair/.test(low)) Object.assign(t.tokens.light, { background: '#fbf7f3', card: '#ffffff', sidebar: '#f5eee7', muted: '#f1e9e1', border: '#e6d9cc', 'muted-foreground': '#6b5a4b' })
  return t
}
function themeTurn(s, text, attachments) {
  s.state = 'running'; s.error = null; s.updated = now()
  addEvents(s, { type: 'user', text, attachments, at: now(), source: 'web' }, { type: 'init', model: S.claude.default_model, cwd: `${ROOT}/${s.path}`, at: now() })
  bus('sessions', 'workspace')
  const tu = `toolu_${crypto.randomBytes(6).toString('hex')}`
  later(s, 900, () => addEvents(s, { type: 'tool_use', id: tu, name: 'Write', input: { file_path: `${ROOT}/${s.path}/ember.theme.json` }, summary: 'Write ember.theme.json', at: now() }))
  later(s, 2600, () => {
    const file = `${ROOT}/${s.path}/ember.theme.json`
    const prevNode = S.fs.get(file)
    const theme = emberTheme(text, prevNode && s.turns > 0 ? JSON.parse(prevNode.content) : null)
    fsAdd(S, file, JSON.stringify(theme, null, 2) + '\n', now(), 'application/json')
    const answer = s.turns ? `Done: **${theme.name}** adjusted as asked, contrast checked in light and dark.` : `**Ember**: warm dark surfaces taken from your logo, calmer orange for the buttons, links in a lighter orange. Every text passes 4.5:1 in dark and light.`
    s.turns += 1; s.cost_usd = +(s.cost_usd + 0.03).toFixed(4); s.last_text = answer.replace(/[*`#]/g, ''); s.updated = now(); s.unread = true; s.state = 'idle'
    addEvents(s, { type: 'tool_result', tool_use_id: tu, text: 'File written', is_error: false, at: now() }, { type: 'assistant', text: answer, at: now() },
      { type: 'result', ok: true, cost_usd: 0.03, duration_ms: 2600, model: S.claude.default_model, usage: { input: 900, output: 420, cache_read: 12000, cache_write: 300 }, at: now() })
    bus('sessions', 'workspace')
  })
}

function startTurn(s, text, attachments = []) {
  if (s.path === THEME_TOPIC) return themeTurn(s, text, attachments)
  const cwd = `${ROOT}/${s.path}`
  const model = s.model || S.claude.default_model
  s.state = 'running'; s.error = null; s.updated = now()
  if (s.plan_ready) s.plan_ready = false
  // Maxxing scenario: turns of 8 to 35 s, so several sessions finish while the user types
  const k = S.scenario === 'maxxing' ? (8000 + Math.random() * 27000) / 3400 : 1
  addEvents(s, { type: 'user', text, attachments, at: now(), source: 'web' }, { type: 'init', model, cwd, at: now() })
  bus('sessions', 'workspace')
  const tu = `toolu_${crypto.randomBytes(6).toString('hex')}`
  later(s, 700 * k, () => addEvents(s, { type: 'thinking', text: `Let me look at the files in this topic before answering: "${text.slice(0, 80)}"`, at: now() }))
  later(s, 1500 * k, () => addEvents(s, { type: 'tool_use', id: tu, name: 'Bash', input: { command: 'ls -la', description: 'List topic files' }, summary: 'Bash: ls -la', at: now() }))
  later(s, 2200 * k, () => addEvents(s, { type: 'tool_result', tool_use_id: tu, text: 'total 24\n-rw-r--r-- 1 root root  412 CLAUDE.md\n-rw-r--r-- 1 root root 1893 memory.md\ndrwxr-xr-x 2 root root 4096 drafts', is_error: false, at: now() }))
  later(s, 3400 * k, () => {
    const answer = `Sure. Here is what I found for **“${text.slice(0, 60)}”**:\n\n- The topic contains a \`CLAUDE.md\`, a \`memory.md\` and a \`drafts/\` folder.\n- Nothing needed to change yet.\n\n\`\`\`bash\nls -la ${s.path}\n\`\`\`\n\nTell me if you want me to go further.`
    const cost = +(0.02 + Math.random() * 0.12).toFixed(4)
    s.turns += 1; s.cost_usd = +(s.cost_usd + cost).toFixed(4); s.real_model = model; s.context_tokens = 20000 + Math.floor(Math.random() * 30000)
    s.last_text = answer.replace(/[*`#]/g, '').slice(0, 200); s.updated = now(); s.unread = true; s.state = 'idle'
    if (s.plan_mode) s.plan_ready = true // a plan-mode turn ends with a plan to approve (as the server does)
    addEvents(s, { type: 'assistant', text: answer, at: now() },
      { type: 'result', ok: true, cost_usd: cost, duration_ms: 3400, model, usage: { input: 820, output: 164, cache_read: 19870, cache_write: 512 }, at: now() })
    bus('sessions', 'workspace')
    const q = S.queues[s.id] || []
    if (q.length) { const nxt = q.shift(); s.queue = q.length; startTurn(s, nxt.text, nxt.attachments) }
  })
}

/* =================================================================== dashboard */
function widgetDefs() {
  const ext = S.extensions.find((e) => e.id === 'shop-sales')
  const defs = [
    { id: 'activity', title: 'Activity', icon: 'activity', span: 2, source: 'builtin', card: cardActivity },
    { id: 'tasks-today', title: 'Today', icon: 'list-checks', span: 1, source: 'builtin', card: cardTasks },
    { id: 'crons', title: 'Crons', icon: 'clock', span: 1, source: 'builtin', card: cardCrons },
    { id: 'server', title: 'Server', icon: 'server', span: 1, source: 'builtin', card: cardServer },
    { id: 'backup', title: 'Backup', icon: 'database-backup', span: 1, source: 'builtin', card: cardBackup },
    { id: 'telegram', title: 'Telegram', icon: 'send', span: 1, source: 'builtin', card: cardTelegram },
    { id: 'claude-usage', title: 'Claude usage', icon: 'gauge', span: 1, source: 'builtin', card: cardUsage },
    { id: 'uptime', title: 'Website uptime', icon: 'radar', span: 2, source: 'builtin', card: cardUptime },
  ]
  if (ext && ext.enabled) defs.push({ id: 'shop-sales', title: 'Shop sales', icon: 'shopping-cart', span: 1, source: 'extension', card: cardShop })
  if (S.extensions.find((e) => e.id === 'stock-levels')?.enabled) defs.push({ id: 'stock-levels', title: 'Stock levels', icon: 'package', span: 1, source: 'extension', card: cardStock })
  return defs
}
function renderWidget(d) {
  const hidden = S.layout.hidden.includes(d.id)
  const base = { id: d.id, title: d.title, icon: d.icon, span: d.span, source: d.source, hidden }
  if (hidden) return { ...base, card: null, error: null }
  if (d.id === 'uptime' && !S.uptimeFixed) return { ...base, card: null, error: 'Timeout after 10 s' }
  // MOCK_EXT_BROKEN=1: the Shop sales extension's card() fails (its runtime error is the seeded `card` one)
  if (d.id === 'shop-sales' && process.env.MOCK_EXT_BROKEN) return { ...base, card: null, error: 'URLError: <urlopen error timed out>' }
  try {
    const card = d.card()
    card.updated = S.widgetUpdated[d.id] || now() - 120
    return { ...base, card, error: null }
  } catch (e) { return { ...base, card: null, error: String(e.message || e), ...(e.permission ? { permission: e.permission } : {}) } }
}
function dashboard() {
  const defs = widgetDefs()
  const idx = (id) => { const i = S.layout.order.indexOf(id); return i === -1 ? 1e6 : i }
  defs.sort((a, b) => idx(a.id) - idx(b.id))
  return { widgets: defs.map(renderWidget) }
}

const fmtDay = (ts) => new Date(ts * 1000).toISOString().slice(5, 10)
function cardActivity() {
  const r = rng(11), t = now()
  const pts = [], cost = []
  for (let i = 13; i >= 0; i--) { const v = S.sessions.length ? 3 + Math.floor(r() * 9) + (i < 3 ? 4 : 0) : 0; pts.push([fmtDay(t - i * DAY), v]); cost.push([fmtDay(t - i * DAY), +(v * (0.25 + r() * 0.2)).toFixed(2)]) }
  const week = pts.slice(-7).reduce((a, p) => a + p[1], 0)
  const prev = pts.slice(0, 7).reduce((a, p) => a + p[1], 0)
  const spend = S.sessions.reduce((a, s) => a + s.cost_usd, 0)
  return { title: 'Activity', link: '/sessions', blocks: [
    { type: 'stats', items: [
      { label: 'Turns this week', value: week, delta: prev ? `${week >= prev ? '+' : ''}${Math.round((week - prev) / prev * 100)} %` : undefined, tone: week >= prev ? 'ok' : 'warn' },
      { label: 'Sessions', value: S.sessions.filter((s) => !s.archived).length, hint: `${S.sessions.filter((s) => s.state === 'running').length} running` },
      { label: 'Spend (API equiv.)', value: `$${spend.toFixed(2)}`, hint: 'last 14 days' },
    ] },
    { type: 'chart', kind: 'line', unit: 'turns', series: [{ name: 'Turns', points: pts }, { name: 'Cost ($)', points: cost }] },
  ] }
}
function cardTasks() {
  const today = new Date().toISOString().slice(0, 10)
  const items = S.tasks.tasks.filter((x) => x.status !== 'done' && (x.status === 'doing' || (x.due && x.due <= today)))
    .sort((a, b) => b.priority - a.priority)
    .map((x) => ({ title: x.title, subtitle: x.due && x.due < today ? `Overdue · ${x.due}` : x.status === 'doing' ? 'In progress' : 'Due today',
      value: ['', 'P1', 'P2', 'P3'][x.priority] || undefined, href: '/tasks', status: x.due && x.due < today ? 'error' : x.priority >= 2 ? 'warn' : 'ok' }))
  return { title: 'Today', link: '/tasks', blocks: [{ type: 'list', items, empty: 'Nothing due today' }] }
}
function cardCrons() {
  const items = S.crons.map((c) => ({ title: c.name, subtitle: cronHuman(c.schedule) + (c.enabled ? '' : ' · disabled'),
    value: c.last_run ? (c.last_run.ok ? 'ok' : `exit ${c.last_run.code}`) : '—', href: '/crons',
    status: !c.enabled ? undefined : c.last_run && !c.last_run.ok ? 'error' : 'ok' }))
  const failing = S.crons.filter((c) => c.enabled && c.last_run && !c.last_run.ok).length
  return { title: 'Crons', link: '/crons', status: failing ? 'warn' : 'ok', blocks: [{ type: 'list', items, empty: 'No cron jobs yet' }] }
}
function cardServer() {
  const h = healthObj()
  return { title: 'Server', link: '/settings/system', status: h.issues.some((i) => i.level === 'error') ? 'error' : h.issues.length ? 'warn' : 'ok', blocks: [
    { type: 'stats', items: [{ label: 'CPU', value: `${h.cpu_pct} %` }, { label: 'Load', value: h.load[0].toFixed(2) }, { label: 'Uptime', value: `${Math.floor(h.uptime_s / DAY)} d` }] },
    { type: 'progress', label: 'Disk', value: h.disk.pct, max: 100, hint: `${(h.disk.free / 1e9).toFixed(1)} GB free` },
    { type: 'progress', label: 'Memory', value: +((h.mem.total - h.mem.avail) / 1e9).toFixed(1), max: +(h.mem.total / 1e9).toFixed(1), hint: 'GB used' },
    { type: 'table', columns: ['Service', 'State'], rows: S.services.map((s) => [s.label, s.active ? 'active' : 'inactive']) },
  ] }
}
function cardBackup() {
  const last = S.backup.history.at(-1) || null
  if (!S.backup.configured) return { title: 'Backup', link: '/settings/backup', status: 'warn', blocks: [{ type: 'stat', label: 'Status', value: 'Not configured', tone: 'warn' }, { type: 'markdown', text: 'Back up your memory files to a **private** GitHub repository. [Set it up](/settings/backup).' }] }
  const age = last ? (now() - last.at) / HOUR : null
  return { title: 'Backup', link: '/settings/backup', status: last && last.ok ? 'ok' : 'error', blocks: [
    { type: 'stat', label: 'Last backup', value: age == null ? 'never' : `${Math.round(age)} h ago`, hint: last && last.commit ? `commit ${last.commit}` : undefined, tone: last && last.ok ? 'ok' : 'error' },
    { type: 'markdown', text: `Repository **${S.backup.repo}** (private) · ${last ? last.files : 0} files · schedule \`${S.backup.schedule}\`` },
  ] }
}
function cardTelegram() {
  const tg = S.telegram
  return { title: 'Telegram', link: '/settings/telegram', status: tg.chat ? 'ok' : 'warn', blocks: [
    { type: 'stat', label: tg.bot ? `@${tg.bot.username}` : 'Bot', value: tg.chat ? 'Linked' : tg.bot ? 'Waiting for /start' : 'Not configured',
      hint: tg.chat ? `${tg.threads.length} threads` : undefined, tone: tg.chat ? 'ok' : 'warn' },
  ] }
}
function cardUsage() {
  return { title: 'Claude usage', blocks: [{ type: 'stat', label: 'Plan usage', value: 'Unavailable', hint: 'Experimental endpoint disabled', tone: 'warn' }] }
}
function cardUptime() {
  return { title: 'Website uptime', status: 'warn', blocks: [{ type: 'table', columns: ['Site', 'Status', 'Response', 'Uptime 30 d'], rows: [
    ['www.example.com', '503', '10.0 s', '99.12 %'], ['ui.example.com', '200', '182 ms', '100 %'], ['shop.example.com', '200', '341 ms', '99.98 %']] }] }
}
// A key read through ctx["secret"], as permissions.secret_reader answers it (API.md, Permissions).
function extSecret(id, name) {
  const e = S.extensions.find((x) => x.id === id)
  const a = extAccess(e)
  const deny = (reason, message) => { const err = new Error(message); err.permission = { kind: 'secret', name, reason }; throw err }
  if (a.refused) deny('refused', `reading the key ${name} was refused for this extension (Settings -> Extensions)`)
  const s = a.secrets.find((x) => x.name === name)
  if (a.state === 'legacy') return 'value'
  if (!s) deny('undeclared', `the key ${name} is not in manifest.json "permissions.secrets": add it there to read it, then allow it (Settings -> Extensions)`)
  if (s.status !== 'allowed') deny('not_allowed', `reading the key ${name} waits for your permission: Settings -> Extensions -> ${e.name} -> Allow`)
  return 'value'
}
function cardStock() {
  extSecret('stock-levels', 'STOCK_API_KEY')
  return { title: 'Stock levels', blocks: [{ type: 'list', items: [
    { title: 'Mug "Morning"', value: '14 left', status: 'warn', icon: 'package' },
    { title: 'Tote bag', value: '86 left', status: 'ok', icon: 'package' },
  ] }] }
}
function cardShop() {
  const r = rng(99), t = now()
  const pts = []
  for (let i = 13; i >= 0; i--) pts.push([fmtDay(t - i * DAY), Math.round(180 + r() * 420)])
  return { title: 'Shop sales', link: 'https://shop.example.com/admin', blocks: [
    { type: 'stats', items: [
      { label: 'Today', value: '€412', delta: '+18 %', tone: 'ok' },
      { label: 'This month', value: '€6,930', delta: '-4 %', tone: 'warn' },
      { label: 'Orders', value: 23, delta: 3, tone: 'ok' },
    ] },
    { type: 'chart', kind: 'bar', unit: '€', series: [{ name: 'Revenue', points: pts }] },
  ] }
}

/* =================================================================== system */
function healthObj() {
  const issues = []
  if (S.scenario === 'ready' || S.scenario === 'login') issues.push({ level: 'warn', code: 'disk_high', text: 'Disk usage is above 80 % (82 %)' })
  if (!S.claude.auth.ok) issues.push({ level: 'warn', code: 'claude_auth', text: 'Claude is not connected' })
  for (const s of S.services) if (s.enabled && !s.active) issues.push({ level: 'error', code: 'service_down', text: `Service ${s.name} is not running` })
  const last = S.backup.history.at(-1)
  const fails = S.loginFails.filter((x) => x > now() - HOUR).length
  if (fails >= 8) issues.push({ level: 'warn', code: 'failed_logins', text: `${fails} failed logins in the last hour` })
  const jitter = Math.sin(Date.now() / 20000)
  const disk = { total: 80e9, free: Math.round(80e9 * 0.18), pct: 82 }
  if (!(S.scenario === 'ready' || S.scenario === 'login')) { disk.free = 52e9; disk.pct = 35 }
  const seen = S.healthSeen || {} // POST /api/system/health/seen: an issue stops counting for 24 h
  for (const i of issues) { i.id = i.code; i.seen = now() - (seen[i.id] || 0) < DAY }
  return { ok: !issues.some((i) => i.level === 'error'), issues, cpu_pct: +(23 + jitter * 8).toFixed(1), load: [+(0.42 + jitter * 0.1).toFixed(2), 0.38, 0.31],
    mem: { total: 8e9, avail: Math.round(3.1e9 + jitter * 2e8) }, disk, uptime_s: Math.round(now() - S.bootAt),
    claude_auth: S.claude.auth.ok, backup_age_h: last ? +((now() - last.at) / HOUR).toFixed(1) : null, failed_logins_1h: fails, at: now() }
}

function journal(unit, n) {
  const r = rng([...unit].reduce((a, c) => a + c.charCodeAt(0), 0))
  const msgs = {
    'claude-maxxing': ['INFO  GET /api/sessions 200 4ms', 'INFO  GET /api/dashboard 200 38ms', 'INFO  session %s turn finished in 41.2s', 'INFO  cron c_blog started (unit mx-cron-c_blog)', 'WARN  telegram: getUpdates timed out, retrying', 'INFO  POST /api/sessions/%s/messages 200 6ms', 'INFO  backup: pushed 41 files', 'INFO  SSE client connected (2 active)'],
    caddy: ['{"level":"info","logger":"http.log.access","msg":"handled request","status":200,"uri":"/api/stream"}', '{"level":"info","logger":"tls","msg":"certificate is valid","identifiers":["ui.example.com"]}', '{"level":"warn","logger":"http","msg":"HTTP/2 stream reset"}'],
    tailscaled: ['magicsock: derp-4 connected', 'wgengine: Reconfig: configuring router', 'netcheck: report: udp=true v6=false', 'health: state is healthy'],
    cron: ['(root) CMD (maxxing cron-run c_uptime)', 'pam_unix(cron:session): session opened for user root', 'pam_unix(cron:session): session closed for user root'],
  }[unit] || ['started', 'running', 'heartbeat ok']
  const lines = []
  const t = Date.now() - n * 37000
  for (let i = 0; i < n; i++) {
    const d = new Date(t + i * 37000)
    const ts = d.toUTCString().slice(5, 25).replace(/(\d{2}) (\w{3}) \d{4}/, '$2 $1')
    lines.push(`${ts} vps-1 ${unit}[${1200 + Math.floor(r() * 50)}]: ${msgs[Math.floor(r() * msgs.length)].replace('%s', crypto.randomUUID().slice(0, 8))}`)
  }
  return lines
}

/* =================================================================== docs */
const B = '`'
const md = (s) => s.replace(/§/g, B)
const DOCS = [
  { slug: 'getting-started', title: 'Getting started', section: 'Basics', order: 1, markdown: md(`# Getting started

harness-pilot runs **Claude Code** on your server and gives you a web UI, a Telegram gateway and scheduled jobs around it.

## Concepts

| Concept | What it is | Where it lives |
|---|---|---|
| Project | A group of related work | §projects/<name>/§ |
| Topic | One workflow inside a project — it is the working directory of its sessions | §projects/<name>/topics/<topic>/§ |
| Session | One Claude conversation | listed under its topic |
| Memory | Markdown files loaded automatically | §CLAUDE.md§ + §memory.md§ at each level |

## First steps

1. Connect Claude (Settings → Claude). A long-lived token from §claude setup-token§ is the easiest.
2. Create a project and a first topic.
3. Open the topic and start a [session](sessions).
4. Optionally link [Telegram](telegram) to talk to the same sessions from your phone.

## How memory is loaded

Claude Code loads every §CLAUDE.md§ from the working directory up to the workspace root, so a session in a topic receives:

- the workspace §CLAUDE.md§ (global rules),
- the project §CLAUDE.md§,
- the topic §CLAUDE.md§, which imports its §memory.md§.

§§§markdown
# Topic acme/blog

> Weekly articles for the Acme blog

@memory.md
§§§

> Keep durable facts in the **closest** §memory.md§. Short, factual, dated.

## Where next

- [Sessions](sessions) — the core of the app
- [Files](files) — browse and edit the workspace
- [Crons](crons) — run Claude on a schedule
`) },
  { slug: 'sessions', title: 'Sessions', section: 'Features', order: 2, markdown: md(`# Sessions

A session is one Claude Code conversation attached to a topic. It keeps running on the server when you close the tab.

## Starting a session

- Open a topic and click **New session**, or press §N§.
- Type a message; attach files by dropping them on the composer.
- Pick a model per session from the model menu. The badge shows the model that **actually answered** the last turn.

## While a turn runs

| Action | Effect |
|---|---|
| Send another message | It is **queued** and starts when the current turn ends |
| Stop | Interrupts the turn; the conversation stays intact |
| Clear queue | Drops waiting messages |

## Compact vs hand-off

- **Compact** summarises the conversation and continues in the *same* session with a fresh context.
- **Hand-off** creates a *new* session seeded with a summary and archives the old one.

## Notifications

Turn on **Notify** to receive a short Telegram message when a turn finishes. It is skipped if you looked at the session in the last 3 minutes.

## Search

The search box looks in titles and the last answers:

§§§text
GET /api/sessions/search?q=caddy
§§§

See also [Telegram](telegram) and [Crons](crons).
`) },
  { slug: 'files', title: 'Files', section: 'Features', order: 3, markdown: md(`# Files

The Files page shows everything under the files root (here §/root/harness-pilot§).

## Features

- Browse folders, preview images and videos, download any file.
- Edit text files in place. Markdown has a live preview.
- Upload by drag and drop, create folders, move and rename.
- Deleted files go to the **trash**, never straight to oblivion.

## Conflicts

If a file changed on disk since you opened it (for example Claude edited it), saving returns a conflict and you can reload or overwrite.

## Keyboard

| Key | Action |
|---|---|
| §Ctrl+S§ | Save |
| §Ctrl+P§ | Quick open |
| §Esc§ | Close the editor |

## Linking

Any absolute path printed by Claude in a [session](sessions), like §/root/harness-pilot/memory.md§, becomes a link to this page.
`) },
  { slug: 'crons', title: 'Crons', section: 'Features', order: 4, markdown: md(`# Crons

Crons run on a schedule, either as a **shell command** or as a **Claude prompt** in a topic.

## Schedule syntax

Standard 5-field cron, evaluated in your timezone:

§§§text
┌ minute (0-59)
│ ┌ hour (0-23)
│ │ ┌ day of month (1-31)
│ │ │ ┌ month (1-12)
│ │ │ │ ┌ day of week (0-7, Sunday = 0 or 7)
0 7 * * *     → every day at 07:00
*/15 * * * *  → every 15 minutes
30 8 * * 1    → every Monday at 08:30
§§§

## Claude jobs

- **Topic**: working directory and memory of the run.
- **Reuse session**: append to the same session every time instead of a new one.
- **Model**: leave empty for the default.

## Notifications

| Setting | Telegram message |
|---|---|
| never | none |
| failure | only when the exit code is not 0 |
| always | every run |

Messages go to the **Crons** thread when [Telegram](telegram) topics are enabled.

## External lines

Lines of your crontab outside the managed block are listed read-only, so you can see everything that runs.
`) },
  { slug: 'telegram', title: 'Telegram', section: 'Features', order: 5, markdown: md(`# Telegram

Talk to your sessions from your phone through your own bot.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Paste it in Settings → Telegram.
3. Click **Link**, open the link and press **Start**.
4. Optional: enable **topics** to get one thread per topic, plus *General* and *Crons*.

## Threads

| Thread | Purpose |
|---|---|
| General | Sessions at the workspace root |
| Crons | Cron notifications |
| One per topic | Messages go to the latest session of that topic |

## Reply mode

- **final** — only the final answer is sent.
- **progress** — a status bubble is updated while tools run.

## Commands

§§§text
/new       start a new session in this thread's topic
/stop      stop the running turn
/sessions  list recent sessions
§§§

Sessions started from Telegram appear in the web UI with a Telegram badge — see [Sessions](sessions).
`) },
  { slug: 'extensions', title: 'Writing an extension', section: 'Extending', order: 6, markdown: md(`# Writing an extension

Extensions add **widgets** to the dashboard or full **pages** to the app. They live in §<workspace>/extensions/<id>/§.

## Manifest

§§§json
{
  "id": "shop-sales",
  "name": "Shop sales",
  "type": "widget",
  "icon": "shopping-cart",
  "version": "1.0.0",
  "span": 1,
  "ttl": 1800
}
§§§

## Widget: §api.py§

§§§python
def card(ctx):
    orders = fetch_orders()
    return {
        "title": "Shop sales",
        "blocks": [
            {"type": "stat", "label": "Today", "value": len(orders)},
        ],
    }
§§§

### Block types

| Type | Use it for |
|---|---|
| §stat§ / §stats§ | Key numbers, with optional delta and tone |
| §list§ | Short lists with status dots |
| §chart§ | §bar§ or §line§ series |
| §table§ | Small tables |
| §progress§ | A value out of a max |
| §markdown§ | Free text |

## Page: §page.js§

§§§js
export function mount(el, ctx) {
  el.textContent = 'Hello from ' + ctx.theme
  return () => { el.textContent = '' }
}
§§§

Call your §api.py§ §handle()§ with §ctx.api('path')§; it is served under §/api/ext/<id>/<path>§.

## Tips

- Keep §card()§ fast; slow widgets time out after 10 s.
- Use **Reload** in Settings → Extensions after editing files.
- Back to [Getting started](getting-started).
`) },
]

/* =================================================================== routes */
const routes = []
function R(method, pattern, handler, opts = {}) {
  const keys = []
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)' }).replace(/\*$/, '(.*)') + '$')
  if (pattern.endsWith('*')) keys.push('rest')
  routes.push({ method, re, keys, handler, public: !!opts.public, csrf: opts.csrf !== false })
}

/* ---- auth */
R('GET', '/api/auth/state', ({ authed }) => ({ setup_required: S.setup_required, authenticated: authed, version: VERSION, onboarding_completed: S.onboarding_completed, language: S.settings.language, look: S.look || null }), { public: true })

R('POST', '/api/auth/setup', ({ body, res }) => {
  if (!S.setup_required) fail(409, 'already_setup', 'Setup has already been completed')
  if (body.token !== SETUP_TOKEN) fail(403, 'bad_token', 'Invalid setup token')
  if (!body.password || String(body.password).length < 8) fail(422, 'invalid', 'Password must be at least 8 characters')
  S.password = body.password; S.setup_required = false
  setCookie(res, newToken())
  return { ok: true }
}, { public: true })

R('POST', '/api/auth/login', async ({ req, body, res }) => {
  if (S.setup_required) fail(409, 'setup_required', 'Run the setup first')
  const t = now()
  if (S.lockUntil > t) fail(429, 'throttled', `Too many attempts, retry in ${Math.ceil(S.lockUntil - t)} s`)
  if (body.password !== S.password) {
    await sleep(400)
    S.loginFails.push(t)
    S.failStreak = (S.failStreak || 0) + 1
    if (S.failStreak >= 5) { S.lockUntil = now() + 30; S.failStreak = 0 }
    bus('health')
    fail(401, 'bad_password', 'Wrong password')
  }
  S.failStreak = 0
  const app = !!totpState().enabled
  if ((S.telegram.settings.two_factor || app) && !tfTrusted(req))
    return { ok: false, two_factor: tfChallenge('login', app ? ['totp', ...(S.telegram.settings.two_factor ? ['telegram'] : [])] : ['telegram']) }
  setCookie(res, newToken())
  return { ok: true }
}, { public: true })

R('POST', '/api/auth/logout', ({ req, res }) => {
  S.tokens.delete(cookieToken(req)); S.autoAuth = false
  res.setHeader('Set-Cookie', 'mx_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
  return { ok: true }
}, { public: true })

R('POST', '/api/auth/password', ({ body }) => {
  if (body.current !== S.password) fail(400, 'bad_password', 'Current password is wrong')
  if (!body.new || String(body.new).length < 8) fail(422, 'invalid', 'Password must be at least 8 characters')
  S.password = body.new
  return { ok: true }
})

/* ---- two-step sign-in (server/maxxing/twofactor.py): with Telegram setting `two_factor` on, a password sign-in from an
   untrusted browser waits for Allow in Telegram or the code it shows. Mock: Allow is "pressed" 4 s after the challenge
   is created, and the code is 246810 (5 wrong codes expire the challenge). With the authenticator app on (below), the
   challenge lists `methods` and also takes a code of the app or a recovery code; an app-only one is never auto-approved. */
const TF_CODE = '246810'
const tfState = () => (S.twoFactor ||= { deviceKey: crypto.randomBytes(12).toString('hex'), challenges: {} })
function tfChallenge(kind, methods = ['telegram']) { // kind: login | enable
  const c = { id: crypto.randomBytes(16).toString('hex'), kind, at: now(), tries: 0, status: 'pending', methods }
  tfState().challenges[c.id] = c
  const g = GEN
  if (methods.includes('telegram')) setTimeout(() => { if (g === GEN && c.status === 'pending') c.status = 'approved' }, 4000).unref()
  return { challenge: c.id, expires_in: methods.includes('telegram') ? 120 : 300, methods }
}
const tfTrusted = (req) => (req.headers.cookie || '').split(/;\s*/).includes(`mx_device=${tfState().deviceKey}`)
const tfDeviceCookie = () => `mx_device=${tfState().deviceKey}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=2592000`
R('POST', '/api/auth/two-factor', ({ req, res, body, authed }) => {
  const c = tfState().challenges[body.challenge]
  if (!c || c.status === 'expired' || now() - c.at > 360) fail(410, 'expired', 'This sign-in request expired: sign in again')
  if (c.kind === 'enable' && !authed) fail(401, 'auth_required', 'Please log in')
  if (body.code !== undefined && body.code !== null && c.status === 'pending') {
    const viaApp = (c.methods || []).includes('totp') && totpVerify(String(body.code))
    if (!viaApp && (body.code !== TF_CODE || !(c.methods || ['telegram']).includes('telegram'))) {
      c.tries += 1
      if (c.tries >= 5) { c.status = 'expired'; fail(410, 'expired', 'Too many wrong codes: sign in again') }
      sendJson(res, 400, { error: 'bad_code', message: 'Wrong code', tries_left: 5 - c.tries })
      return RAW
    }
    c.status = 'approved'
  }
  if (c.status === 'pending') return { ok: false, status: 'pending', expires_in: Math.max(0, Math.round(300 - (now() - c.at))) }
  delete tfState().challenges[c.id] // once only
  const trust = body.trust !== false || c.kind === 'enable'
  if (c.kind === 'enable') { S.telegram.settings.two_factor = true; bus('telegram') }
  res.setHeader('Set-Cookie', [...(c.kind === 'login' ? [`mx_session=${newToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`] : []), ...(trust ? [tfDeviceCookie()] : [])])
  return { ok: true, status: 'approved' }
}, { public: true })
R('PUT', '/api/auth/two-factor', ({ body }) => {
  if (!body.enabled) { S.telegram.settings.two_factor = false; tfState().deviceKey = crypto.randomBytes(12).toString('hex'); bus('telegram'); return { ok: true, enabled: false } }
  if (!S.telegram.chat) fail(409, 'not_linked', 'Link a Telegram chat first')
  if (S.telegram.settings.two_factor) return { ok: true, enabled: true }
  return { ok: false, two_factor: tfChallenge('enable') }
})
R('POST', '/api/auth/two-factor/forget-browsers', ({ res }) => {
  tfState().deviceKey = crypto.randomBytes(12).toString('hex')
  res.setHeader('Set-Cookie', tfDeviceCookie()) // this browser stays trusted
  return { ok: true }
})

/* ---- authenticator app (server/maxxing/totp.py): real RFC 6238 codes (SHA-1, 6 digits, 30 s, one step either way, a
   step never accepted twice), so a phone app scanning the mock's QR code works; 135790 also passes, for clicking through
   without an app. Ten recovery codes, single use. Re-authentication = the mock password + a code. */
const TOTP_CODE = '135790'
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const totpState = () => (S.totp ||= { enabled: false, secret: '', lastStep: 0, recovery: [], enabledAt: null, pending: null })
const b32encode = (buf) => { let bits = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); let out = ''; for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out }
const b32decode = (txt) => { let bits = ''; for (const ch of txt.toUpperCase()) { const v = B32.indexOf(ch); if (v >= 0) bits += v.toString(2).padStart(5, '0') } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out) }
function hotp(secret, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter))
  const mac = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest()
  return String((mac.readUInt32BE(mac[19] & 15) & 0x7fffffff) % 1e6).padStart(6, '0')
}
const totpStepOf = (secret, code) => { const s = Math.floor(now() / 30); return [s - 1, s, s + 1].find((x) => hotp(secret, x) === code) ?? null }
const recoveryNorm = (code) => code.replace(/[\s-]/g, '').toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B')
const newRecovery = () => Array.from({ length: 10 }, () => Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => B32[crypto.randomInt(32)]).join('')).join('-'))
/** 'totp' | 'recovery' (spent) | null, like totp.verify */
function totpVerify(code) {
  const t = totpState(); const given = code.trim().replace(/\s/g, '')
  if (!t.enabled) return null
  if (/^\d{6}$/.test(given)) {
    if (given === TOTP_CODE) return 'totp'
    const step = totpStepOf(t.secret, given)
    if (step === null || step <= t.lastStep) return null
    t.lastStep = step
    return 'totp'
  }
  const i = t.recovery.findIndex((r) => recoveryNorm(r) === recoveryNorm(code))
  if (i < 0) return null
  t.recovery.splice(i, 1)
  return 'recovery'
}
const totpStatus = () => { const t = totpState(); return { enabled: t.enabled, recovery_left: t.enabled ? t.recovery.length : 0, pending: !t.enabled && !!t.pending && now() - t.pending.created < 600, enabled_at: t.enabled ? t.enabledAt : null } }
const reauth = (body) => { if (body.password !== S.password) fail(401, 'bad_password', 'Current password is wrong') }
R('GET', '/api/auth/totp', () => totpStatus())
R('POST', '/api/auth/totp/setup', () => {
  const t = totpState()
  if (t.enabled) fail(409, 'already_on', 'The authenticator app is already on - turn it off first')
  t.pending = { secret: b32encode(crypto.randomBytes(20)), created: now() }
  const label = encodeURIComponent(S.profile?.name || '')
  return { secret: t.pending.secret, uri: `otpauth://totp/harness-pilot${label ? ':' + label : ''}?secret=${t.pending.secret}&issuer=harness-pilot&algorithm=SHA1&digits=6&period=30`, expires_in: 600 }
})
R('POST', '/api/auth/totp/enable', ({ body, res }) => {
  reauth(body)
  const t = totpState()
  if (t.enabled) fail(409, 'already_on', 'The authenticator app is already on')
  if (!t.pending || now() - t.pending.created >= 600) fail(410, 'expired', 'The setup expired - start it again')
  const code = String(body.code || '').replace(/\s/g, '')
  const step = code === TOTP_CODE ? Math.floor(now() / 30) : totpStepOf(t.pending.secret, code)
  if (step === null) fail(400, 'bad_code', 'Wrong code')
  Object.assign(t, { enabled: true, secret: t.pending.secret, lastStep: step, recovery: newRecovery(), enabledAt: now(), pending: null })
  res.setHeader('Set-Cookie', tfDeviceCookie()) // this browser stays trusted
  return { ok: true, recovery_codes: [...t.recovery] }
})
R('POST', '/api/auth/totp/disable', ({ body }) => {
  reauth(body)
  if (!totpVerify(String(body.code || ''))) fail(400, 'bad_code', 'Wrong code')
  S.totp = null
  tfState().deviceKey = crypto.randomBytes(12).toString('hex') // every trusted browser asks again
  return { ok: true }
})
R('POST', '/api/auth/totp/recovery-codes', ({ body }) => {
  reauth(body)
  const t = totpState()
  if (!t.enabled) fail(409, 'not_on', 'The authenticator app is off')
  if (!totpVerify(String(body.code || ''))) fail(400, 'bad_code', 'Wrong code')
  t.recovery = newRecovery()
  return { ok: true, recovery_codes: [...t.recovery] }
})

/* ---- onboarding */
R('GET', '/api/onboarding', () => onboardingObj())
R('POST', '/api/onboarding/complete', () => { S.onboarding_completed = true; return { ok: true } })

/* ---- codex models (the Codex model pickers: new session, discussion, mixed team, scheduled prompt) */
R('GET', '/api/system/codex/models', () => ({ source: 'cli', models: [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', description: 'Latest frontier agentic coding model.' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', description: 'Balanced agentic coding model for everyday work.' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', description: 'Fast and affordable agentic coding model.' },
  { id: 'gpt-5.5', label: 'GPT-5.5', description: 'Frontier model for complex coding, research, and real-world work.' },
  { id: 'gpt-5.2', label: 'GPT-5.2', description: 'Optimized for professional work and long-running agents.' },
] }))

/* ---- claude */
R('GET', '/api/claude/status', () => ({ ...clone(S.claude), models: MODELS }))
R('POST', '/api/claude/auth', async ({ body }) => {
  await sleep(1200)
  const v = String(body.value || '').trim()
  const kind = v.startsWith('sk-ant-oat') ? 'oauth_token' : v.startsWith('sk-ant-api') ? 'api_key' : null
  if (!kind) return { ok: false, error: 'Authentication failed: invalid token' }
  S.claude.auth = { ok: true, method: kind, detail: kind === 'oauth_token' ? 'Long-lived OAuth token (claude setup-token)' : `API key ${v.slice(0, 14)}…` }
  bus('health')
  return { ok: true }
})
R('DELETE', '/api/claude/auth', () => { S.claude.auth = { ok: false, method: null, detail: 'Not connected' }; bus('health'); return { ok: true } })
R('POST', '/api/claude/test', async () => {
  const t0 = Date.now()
  await sleep(850 + Math.floor(Math.random() * 120))
  if (!S.claude.auth.ok) return { ok: false, model: S.claude.default_model, ms: Date.now() - t0, error: 'Not authenticated — run setup-token or add an API key' }
  return { ok: true, model: S.claude.default_model, ms: Date.now() - t0 }
})
R('PUT', '/api/claude/settings', ({ body }) => {
  if (body.permission_mode !== undefined && !['bypass', 'acceptEdits', 'default'].includes(body.permission_mode)) fail(422, 'invalid', 'Unknown permission mode')
  if (body.default_model !== undefined) S.claude.default_model = String(body.default_model)
  if (body.permission_mode !== undefined) S.claude.permission_mode = body.permission_mode
  return { ok: true }
})

/* ---- workspace */
R('GET', '/api/workspace/tree', () => ({ root: ROOT, projects: S.projects.map(projectObj) }))
R('POST', '/api/workspace/projects', ({ body }) => {
  const name = String(body.name || '')
  if (!SLUG.test(name)) fail(422, 'invalid', 'Name must be lowercase letters, digits and dashes (max 48)')
  if (S.projects.some((p) => p.name === name)) fail(409, 'exists', `Project “${name}” already exists`)
  const p = { name, description: body.description || '', topics: [] }
  S.projects.push(p)
  fsAdd(S, `${projPath(name)}/CLAUDE.md`, `# Project ${name}\n\n> ${p.description}\n\n@memory.md\n`, now())
  fsAdd(S, `${projPath(name)}/memory.md`, `# ${name} — memory\n`, now())
  bus('workspace')
  return projectObj(p)
})
function renamePath(oldP, newP) {
  const remap = (x) => (x === oldP ? newP : x.startsWith(oldP + '/') ? newP + x.slice(oldP.length) : x)
  for (const s of S.sessions) s.path = remap(s.path)
  for (const th of S.telegram.threads) th.path = remap(th.path)
  for (const tk of S.tasks.tasks) if (tk.topic_path) tk.topic_path = remap(tk.topic_path)
  for (const c of S.crons) if (c.topic_path) c.topic_path = remap(c.topic_path)
  const moved = []
  for (const [k, v] of S.fs) { const nk = remap(k.slice(ROOT.length + 1)); if (k.startsWith(`${ROOT}/${oldP}`)) moved.push([k, `${ROOT}/${nk}`, v]) }
  for (const [k, nk, v] of moved) { S.fs.delete(k); S.fs.set(nk, v) }
}
function trashPath(rel) { for (const k of [...S.fs.keys()]) if (k === `${ROOT}/${rel}` || k.startsWith(`${ROOT}/${rel}/`)) S.fs.delete(k) }
R('PATCH', '/api/workspace/projects/:project', ({ params, body }) => {
  const p = findProject(params.project)
  if (body.name !== undefined && body.name !== p.name) {
    if (!SLUG.test(body.name)) fail(422, 'invalid', 'Invalid name')
    if (S.projects.some((x) => x.name === body.name)) fail(409, 'exists', 'A project with this name already exists')
    renamePath(projPath(p.name), projPath(body.name)); p.name = body.name
  }
  if (body.description !== undefined) p.description = body.description
  bus('workspace', 'sessions')
  return projectObj(p)
})
R('DELETE', '/api/workspace/projects/:project', ({ params }) => {
  const p = findProject(params.project)
  const pp = projPath(p.name)
  if (S.sessions.some((s) => s.state === 'running' && s.path.startsWith(pp + '/'))) fail(409, 'has_running_sessions', 'Stop the running sessions first')
  S.projects = S.projects.filter((x) => x !== p)
  trashPath(pp)
  bus('workspace', 'sessions')
  return { ok: true }
})
R('POST', '/api/workspace/projects/:project/topics', ({ params, body }) => {
  const p = findProject(params.project)
  const name = String(body.name || '')
  if (!SLUG.test(name)) fail(422, 'invalid', 'Name must be lowercase letters, digits and dashes (max 48)')
  if (p.topics.some((x) => x.name === name)) fail(409, 'exists', `Topic “${name}” already exists`)
  const tp = { name, description: body.description || '' }
  p.topics.push(tp)
  const base = topicPath(p.name, name)
  fsAdd(S, `${base}/CLAUDE.md`, `# Topic ${p.name}/${name}\n\n> ${tp.description}\n\n@memory.md\n`, now())
  fsAdd(S, `${base}/memory.md`, `# ${name} — memory\n`, now())
  bus('workspace')
  return topicObj(p, tp)
})
R('PATCH', '/api/workspace/projects/:project/topics/:topic', ({ params, body }) => {
  const p = findProject(params.project)
  const tp = p.topics.find((x) => x.name === params.topic) || fail(404, 'not_found', 'Topic not found')
  if (body.name !== undefined && body.name !== tp.name) {
    if (!SLUG.test(body.name)) fail(422, 'invalid', 'Invalid name')
    if (p.topics.some((x) => x.name === body.name)) fail(409, 'exists', 'A topic with this name already exists')
    renamePath(topicPath(p.name, tp.name), topicPath(p.name, body.name)); tp.name = body.name
  }
  if (body.description !== undefined) tp.description = body.description
  bus('workspace', 'sessions')
  return topicObj(p, tp)
})
R('DELETE', '/api/workspace/projects/:project/topics/:topic', ({ params }) => {
  const p = findProject(params.project)
  const tp = p.topics.find((x) => x.name === params.topic) || fail(404, 'not_found', 'Topic not found')
  const tpp = topicPath(p.name, tp.name)
  if (S.sessions.some((s) => s.state === 'running' && s.path === tpp)) fail(409, 'has_running_sessions', 'Stop the running sessions first')
  p.topics = p.topics.filter((x) => x !== tp)
  trashPath(tpp)
  bus('workspace', 'sessions')
  return { ok: true }
})

/* ---- sessions */
R('POST', '/api/sessions/:id/queue/take', ({ params }) => {
  const s = S.sessions.find((x) => x.id === params.id) || fail(404, 'not_found', 'Session not found')
  const n = s.queue; s.queue = 0; bus('sessions')
  return { messages: Array.from({ length: n }, (_, i) => ({ text: `Queued message ${i + 1}`, attachments: [] })), session: s }
})
R('POST', '/api/sessions/:id/steer', ({ params }) => {
  const s = S.sessions.find((x) => x.id === params.id) || fail(404, 'not_found', 'Session not found')
  const steered = s.state === 'running' && s.queue > 0
  if (steered) { s.queue = 1; bus('sessions') }
  return { steered, interrupted: steered, session: s }
})
R('GET', '/api/search', ({ q }) => {
  const term = (q.get('q') || '').trim().toLowerCase()
  if (term.length < 2) return { results: [], took_ms: 0 }
  const mark = (txt) => { const i = txt.toLowerCase().indexOf(term); return i < 0 ? txt.slice(0, 120) : txt.slice(Math.max(0, i - 40), i) + '\u0002' + txt.slice(i, i + term.length) + '\u0003' + txt.slice(i + term.length, i + term.length + 60) }
  const results = []
  for (const s of S.sessions) {
    const e = (S.events[s.id] || []).find((x) => (x.type === 'assistant' || x.type === 'user') && x.text.toLowerCase().includes(term))
    if (e || s.title.toLowerCase().includes(term)) results.push({ kind: 'session', id: s.id, path: s.path, title: s.title, snippet: e ? mark(e.text.replace(/\n/g, ' ')) : s.title, at: s.updated, score: 1 })
  }
  for (const tk of S.tasks.tasks) if ((tk.title + ' ' + tk.notes).toLowerCase().includes(term)) results.push({ kind: 'task', id: tk.id, path: '', title: tk.title, snippet: mark(tk.title + ' ' + tk.notes), at: tk.updated, score: 1 })
  return { results: results.slice(0, 30), took_ms: 1.2 }
})
R('GET', '/api/sessions/search', ({ q }) => {
  const term = (q.get('q') || '').trim().toLowerCase()
  if (!term) return []
  const hits = []
  for (const s of S.sessions) {
    const inTitle = s.title.toLowerCase().includes(term)
    let snippet = null
    const lt = s.last_text, i = lt.toLowerCase().indexOf(term)
    if (i !== -1) snippet = (i > 40 ? '…' : '') + lt.slice(Math.max(0, i - 40), i + term.length + 60) + (i + term.length + 60 < lt.length ? '…' : '')
    else {
      const e = (S.events[s.id] || []).find((x) => (x.type === 'assistant' || x.type === 'user') && x.text.toLowerCase().includes(term))
      if (e) { const j = e.text.toLowerCase().indexOf(term); snippet = '…' + e.text.slice(Math.max(0, j - 40), j + term.length + 60).replace(/\n/g, ' ') + '…' }
    }
    if (inTitle || snippet) hits.push({ id: s.id, title: s.title, path: s.path, snippet: snippet || lt.slice(0, 100), at: s.updated })
  }
  return hits.sort((a, b) => b.at - a.at).slice(0, 50)
})
R('GET', '/api/sessions', ({ q }) => {
  const pth = q.get('path')
  const arch = q.get('archived') === '1'
  return S.sessions.filter((s) => (pth === null || s.path === pth) && s.archived === arch).sort((a, b) => b.updated - a.updated)
})
R('POST', '/api/sessions', ({ body }) => {
  if (typeof body.path !== 'string') fail(422, 'invalid', 'path is required')
  const t = now()
  const msg = (body.message || '').trim()
  const s = { id: uuid(), title: body.title || (msg ? msg.slice(0, 60) : 'New session'), path: body.path, state: 'idle', queue: 0, created: t, updated: t, turns: 0, cost_usd: 0,
    model: body.model || '', real_model: null, context_tokens: null, context_window: null, archived: false, notify: false, source: 'web', unread: false, last_text: '', error: null }
  S.sessions.push(s); S.events[s.id] = []
  if (msg) startTurn(s, msg, body.attachments || [])
  bus('sessions', 'workspace')
  return s
})
R('GET', '/api/sessions/:id', ({ params }) => findSession(params.id))
R('PATCH', '/api/sessions/:id', ({ params, body }) => {
  const s = findSession(params.id)
  for (const k of ['title', 'model', 'archived', 'notify', 'plan_mode']) if (body[k] !== undefined) s[k] = body[k]
  if (body.plan_mode === false) s.plan_ready = false
  if (body.archived === true) addEvents(s, { type: 'note', text: 'Session archived.', level: 'info', at: now() })
  bus('sessions', 'workspace')
  pushEvents(s.id, [])
  return s
})
R('DELETE', '/api/sessions/:id', ({ params }) => {
  const s = findSession(params.id)
  clearTimers(s)
  S.sessions = S.sessions.filter((x) => x !== s); delete S.events[s.id]; delete S.queues[s.id]
  bus('sessions', 'workspace')
  return { ok: true }
})
R('POST', '/api/sessions/:id/messages', ({ params, body }) => {
  const s = findSession(params.id)
  const text = String(body.text || '').trim()
  if (!text) fail(422, 'invalid', 'Message is empty')
  if (s.archived) s.archived = false
  if (s.state === 'running') {
    (S.queues[s.id] ||= []).push({ text, attachments: body.attachments || [] })
    s.queue = S.queues[s.id].length
    bus('sessions')
    pushEvents(s.id, [])
    return { queued: true, session: s }
  }
  startTurn(s, text, body.attachments || [])
  return { queued: false, session: s }
})
R('POST', '/api/sessions/:id/plan/approve', ({ params, body }) => {
  const s = findSession(params.id)
  if (s.state === 'running') fail(409, 'running', 'A turn is running')
  s.plan_mode = false; s.plan_ready = false
  startTurn(s, String(body.text || '').trim() || 'The plan is validated: carry it out.', [])
  return { queued: false, session: s }
})
R('DELETE', '/api/sessions/:id/queue', ({ params }) => {
  const s = findSession(params.id)
  S.queues[s.id] = []; s.queue = 0
  bus('sessions'); pushEvents(s.id, [])
  return { ok: true }
})
R('POST', '/api/sessions/:id/stop', ({ params }) => {
  const s = findSession(params.id)
  if (s.state === 'running') {
    clearTimers(s)
    s.state = 'idle'; s.updated = now()
    addEvents(s, { type: 'note', text: 'Turn stopped by user.', level: 'warn', at: now() })
    bus('sessions', 'workspace')
  }
  return { ok: true }
})
R('POST', '/api/sessions/:id/compact', async ({ params }) => {
  const s = findSession(params.id)
  if (s.state === 'running') fail(409, 'busy', 'Wait for the turn to finish')
  await sleep(1500)
  s.context_tokens = 4200; s.updated = now()
  addEvents(s, { type: 'note', text: 'Context compacted — the next turn starts from a summary of this conversation.', level: 'info', at: now() })
  bus('sessions')
  return { ok: true }
})
R('POST', '/api/sessions/:id/handoff', async ({ params }) => {
  const s = findSession(params.id)
  await sleep(1200)
  const t = now()
  const n = { ...s, id: uuid(), title: `${s.title} (continued)`, state: 'idle', queue: 0, created: t, updated: t, turns: 0, cost_usd: 0, real_model: null, context_tokens: 3800, archived: false, unread: false, error: null }
  S.sessions.push(n)
  S.events[n.id] = [
    { type: 'note', text: `Handed off from “${s.title}”.`, level: 'info', at: t },
    { type: 'user', text: `Summary of the previous session:\n\n- Goal: ${s.title}\n- Status: ${s.last_text}\n\nContinue from here.`, attachments: [], at: t, source: 'web' },
  ]
  s.archived = true
  addEvents(s, { type: 'note', text: 'Handed off to a new session; this one is archived.', level: 'info', at: t })
  bus('sessions', 'workspace')
  return n
})
R('POST', '/api/sessions/:id/seen', ({ params }) => {
  const s = findSession(params.id)
  if (s.unread) { s.unread = false; bus('sessions', 'workspace') }
  return { ok: true }
})
R('GET', '/api/sessions/:id/events', ({ params, q }) => {
  const s = findSession(params.id)
  const ev = S.events[s.id] || []
  const from = Math.max(0, Math.min(ev.length, parseInt(q.get('from') || '0', 10) || 0))
  return { events: ev.slice(from), next: ev.length, state: s.state }
})
R('GET', '/api/sessions/:id/stream', ({ params, q, req, res }) => {
  const s = findSession(params.id)
  const ev = S.events[s.id] || []
  const from = Math.max(0, Math.min(ev.length, parseInt(q.get('from') || '0', 10) || 0))
  sseOpen(req, res)
  sseSend(res, 'events', { events: ev.slice(from), next: ev.length })
  sseSend(res, 'state', s)
  let set = sessionSubs.get(s.id)
  if (!set) sessionSubs.set(s.id, (set = new Set()))
  set.add(res)
  req.on('close', () => set.delete(res))
  return RAW
})
R('POST', '/api/uploads', ({ q, req, rawBody }) => {
  const topic = q.get('path') || ''
  const files = parseMultipart(rawBody, req.headers['content-type'] || '')
  if (!files.length) fail(422, 'invalid', 'No file in the request')
  const d = new Date()
  const dir = `${ROOT}/${topic ? topic + '/' : ''}attachments/${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  const out = files.map((f) => {
    const p = uniquePath(`${dir}/${f.name}`)
    fsAdd(S, p, isText(f.mime) ? f.data.toString('utf8') : f.data, now(), f.mime)
    return { path: p, name: path.basename(p), size: f.data.length, mime: f.mime }
  })
  return { files: out }
})

/* ---- side question, hidden messages, summary to memory (api/sessions.py): canned answers, real checks */
const sideBusy = new Set()
R('POST', '/api/sessions/:id/ask', async ({ params, body }) => {
  const s = findSession(params.id), question = String(body.question || '').trim()
  if (!question) fail(422, 'invalid', 'question is required')
  if (!s.turns) fail(409, 'no_thread', 'This session has no answer yet')
  if (sideBusy.has(s.id)) fail(409, 'busy', 'A side question is already running for this session')
  if (sideBusy.size >= 2) fail(429, 'busy', 'Two side questions are already running')
  sideBusy.add(s.id)
  try { await sleep(1500) } finally { sideBusy.delete(s.id) }
  return { answer: `From this conversation (“${s.title}”): ${s.last_text ? s.last_text.slice(0, 160) : 'nothing has been decided yet.'}\n\nNothing was changed and this answer is not saved in the thread.`, cost_usd: 0.012, duration_ms: 1500 }
})
R('POST', '/api/sessions/:id/hide', ({ params, body }) => {
  const s = findSession(params.id), hidden = body.hidden !== false
  const evs = S.events[s.id] || []
  if (!evs.some((e) => e.type === 'user' && e.at === body.at)) fail(404, 'not_found', 'No user message at this time')
  const last = evs.filter((e) => e.type === 'hide' && e.ref === body.at).at(-1)
  if ((last ? last.hidden : false) !== hidden) addEvents(s, { type: 'hide', ref: body.at, hidden, at: now() })
  return { ok: true }
})
const summaryBusy = new Set()
R('POST', '/api/sessions/:id/summary', async ({ params }) => {
  const s = findSession(params.id)
  if (!(S.events[s.id] || []).some((e) => e.type === 'assistant' || e.type === 'user')) fail(400, 'empty_session', 'Nothing to summarize yet')
  if (!s.path) fail(409, 'no_topic', 'This session is not in a topic')
  if (summaryBusy.has(s.id)) fail(409, 'summary_busy', 'A summary is already being written for this session')
  if (summaryBusy.size >= 2) fail(429, 'summary_limit', 'Two summaries are already being written')
  summaryBusy.add(s.id)
  try { await sleep(2200) } finally { summaryBusy.delete(s.id) }
  return { summary: `The conversation “${s.title}” reviewed the current state and agreed on the next steps.${s.last_text ? ` Latest answer: ${s.last_text.slice(0, 140)}` : ''}`,
    decisions: ['Keep the current structure and change one thing at a time.', 'Check the result on a phone before publishing.'],
    actions: [{ title: `Follow up: ${s.title.slice(0, 60)}`, notes: 'Review the proposed change and confirm it in this topic.' }, { title: 'Add a test for the fixed case', notes: '' }], truncated: false }
})
R('POST', '/api/sessions/:id/summary/memory', ({ params, body }) => {
  const s = findSession(params.id), text = String(body.text || '').trim()
  if (!text || text.length > 12000) fail(400, 'empty_memory', 'Nothing to add to the memory')
  if (!s.path) fail(409, 'no_topic', 'This session is not in a topic')
  const file = `${ROOT}/${s.path}/memory.md`, node = S.fs.get(file)
  if (!node) fail(409, 'memory_unavailable', 'The topic has no memory.md')
  if (node.type !== 'file') fail(409, 'invalid_memory', 'memory.md is not a regular file')
  const next = `${String(node.content || '').replace(/\n*$/, '\n')}\n## Discussion — ${new Date().toISOString().slice(0, 10)}\n\n${text}\n`
  if (Buffer.byteLength(next) > 32768) fail(409, 'memory_full', 'memory.md would pass 32 KiB')
  fsAdd(S, file, next, now(), 'text/markdown')
  bus('workspace')
  return { ok: true }
})

/* ---- mixed teams (server/maxxing/sessions/teams.py): a Claude Code and a Codex worker analyse the mission in their own
   sessions, then the coordinator session synthesises their reports. The team lives on the coordinator (team_phase). */
const TEAM_ROLES = [['claude', 'Develop a practical approach and identify the main steps.'],
  ['codex', 'Independently examine risks, alternatives and how to verify the result.']]
const TEAM_REPORTS = {
  claude: 'Approach in four steps: list what the change touches, make it behind a flag, migrate the existing data, then remove the old path. The first two steps fit in one afternoon.',
  codex: 'Main risk: the data migration cannot be undone once the old path is removed. Keep a backup and a dry run that counts the rows to change; verify with the existing tests plus one end-to-end check.',
}
const teamsState = () => (S.teams ||= {}) // coordinator id -> { phase, goal, agents: [{ id, provider, role, stopped }] }
const teamOf = (sid) => { findSession(sid); return teamsState()[sid] || fail(404, 'not_found', 'Team not found') }
function teamSetPhase(sid, phase) {
  teamsState()[sid].phase = phase
  const s = S.sessions.find((x) => x.id === sid)
  if (s) s.team_phase = phase
  bus('sessions', 'workspace')
}
// One turn with a fixed answer (startTurn's generic answer would ignore the assignment); `done` runs when it ends.
function teamTurn(s, text, answer, ms, done) {
  const model = s.provider === 'codex' ? 'gpt-5.5-codex' : S.claude.default_model
  s.state = 'running'; s.error = null; s.updated = now()
  addEvents(s, { type: 'user', text, attachments: [], at: now(), source: 'team' }, { type: 'init', model, cwd: `${ROOT}/${s.path}`, at: now() })
  if (s.team_parent) { // a worker looks around first (the team panel shows its last actions)
    const id = `toolu_${crypto.randomBytes(6).toString('hex')}`
    addEvents(s, { type: 'assistant', text: 'Reading the files the mission touches.', at: now() },
      { type: 'tool_use', id, name: 'Read', input: { file_path: `${ROOT}/${s.path}/CLAUDE.md` }, summary: 'Read CLAUDE.md', at: now() },
      { type: 'tool_result', tool_use_id: id, text: '# Topic notes', is_error: false, at: now() })
  }
  later(s, ms, () => {
    Object.assign(s, { state: 'idle', turns: s.turns + 1, real_model: model, updated: now(), unread: true, last_text: answer.slice(0, 200) })
    addEvents(s, { type: 'assistant', text: answer, at: now() },
      { type: 'result', ok: true, cost_usd: s.provider === 'codex' ? 0 : 0.06, duration_ms: ms, model, usage: { input: 2400, output: 380, cache_read: 16000, cache_write: 400 }, at: now() })
    bus('sessions', 'workspace')
    done()
  })
  bus('sessions', 'workspace')
}
function teamAdvance(sid) { // like teams.advance: once no worker runs, the coordinator synthesises
  const team = teamsState()[sid]
  if (!team || team.phase !== 'working') return
  const workers = team.agents.map((a) => [a, S.sessions.find((x) => x.id === a.id)])
  if (workers.some(([, w]) => w && w.state === 'running')) return
  const reports = workers.map(([a, w]) => `${a.provider.toUpperCase()} — ${a.role}\n${a.stopped ? '[Stopped by the user; no final report.]' : w ? w.last_text || '[No final report.]' : '[Agent failed or its session is missing.]'}`)
  const coordinator = findSession(sid)
  teamSetPhase(sid, 'synthesizing')
  const name = (a) => (a.provider === 'codex' ? 'Codex' : 'Claude Code')
  const points = { claude: '- **Plan** (Claude Code): flag the change, migrate the data, then remove the old path.', codex: '- **Risks** (Codex): the migration is one-way; keep a backup and a dry run first.' }
  const stopped = team.agents.filter((a) => a.stopped)
  const answer = `**Synthesis of the team's analyses**\n\n${team.agents.filter((a) => !a.stopped).map((a) => points[a.provider]).join('\n')}\n\n${stopped.length ? `Note: ${stopped.map(name).join(' and ')} was stopped before reporting, so its part is missing.\n\n` : ''}Recommendation: start with a dry run, then the flagged change.`
  teamTurn(coordinator, 'The two independent team members have finished. Synthesize their findings for the user.\n\nReports:\n' + reports.join('\n\n---\n\n'), answer, 2600,
    () => { if (team.phase === 'synthesizing') teamSetPhase(sid, 'completed') })
}
const teamSession = (path, title, provider) => {
  const t = now()
  const s = { id: uuid(), title, path, state: 'idle', queue: 0, created: t, updated: t, turns: 0, cost_usd: 0, model: '', real_model: null, context_tokens: null,
    context_window: null, archived: false, notify: false, source: 'web', unread: false, last_text: '', error: null, provider, team_phase: null, team_parent: null, team_turn: false }
  S.sessions.push(s); S.events[s.id] = []
  return s
}
// a worker's last actions and the start of its report, from its events (teams._live_view)
const TEAM_KINDS = { Read: 'read', Grep: 'search', Glob: 'search', Bash: 'run', Write: 'edit', Edit: 'edit', WebFetch: 'web', WebSearch: 'web' }
const teamLive = (session) => {
  const evs = S.events[session.id] || []
  const turn = evs.slice(evs.map((e) => e.type).lastIndexOf('user') + 1)
  const activity = turn.flatMap((e) => e.type === 'tool_use' ? [{ kind: TEAM_KINDS[e.name] || 'other', target: String(e.input?.file_path || e.input?.pattern || e.input?.command || e.summary || e.name).replace(`${ROOT}/${session.path}/`, '') }]
    : e.type === 'assistant' ? [{ kind: 'say', target: e.text.split('\n')[0].slice(0, 120) }] : []).slice(-3)
  const last = [...turn].reverse().find((e) => e.type === 'assistant')
  return { activity, report: session.state !== 'running' && last ? last.text.slice(0, 600) : null }
}
const teamOut = (sid) => {
  const team = teamOf(sid)
  return { id: sid, phase: team.phase, created: team.created, coordinator: findSession(sid).provider === 'codex' ? 'codex' : 'claude', agents: team.agents.map((a) => {
    const session = S.sessions.find((x) => x.id === a.id) || null
    const state = a.stopped ? 'stopped' : session ? session.state : 'missing'
    return { ...a, state, session, started_at: team.created, custom_role: !TEAM_ROLES.some(([p, r]) => p === a.provider && r === a.role), finished_at: session && state !== 'running' ? session.updated : null,
      ...(session ? teamLive(session) : { activity: [], report: null }) }
  }) }
}
R('POST', '/api/teams', ({ body }) => {
  if (typeof body.path !== 'string') fail(422, 'invalid', 'path is required')
  const goal = String(body.message || '').trim()
  if (!goal || goal.length > 24000) fail(400, 'bad_mission', 'A mission of up to 24000 characters is required.')
  const parent = teamSession(body.path, body.title || goal.slice(0, 100), body.coordinator === 'codex' ? 'codex' : 'claude')
  addEvents(parent, { type: 'user', text: goal, attachments: [], at: now(), source: 'web' })
  const team = { phase: 'launching', goal, agents: [], created: now() }
  teamsState()[parent.id] = team
  for (const [provider, fallback] of TEAM_ROLES) {
    const role = String(body[`${provider}_role`] || '').trim() || fallback
    const child = teamSession(body.path, `Team: ${provider === 'codex' ? 'Codex' : 'Claude'}`, provider)
    Object.assign(child, { team_parent: parent.id, team_turn: true })
    team.agents.push({ id: child.id, provider, role, stopped: false })
    teamTurn(child, `You are an independent member of a mixed Claude and Codex team. Analyze the mission from your assigned perspective and report your findings to the coordinator.\n\nYour assignment: ${role}\n\nMission:\n${goal}`,
      TEAM_REPORTS[provider], provider === 'codex' ? 5200 : 3800, () => teamAdvance(parent.id))
  }
  teamSetPhase(parent.id, 'working')
  return parent
})
R('GET', '/api/teams/:sid', ({ params }) => teamOut(params.sid))
R('POST', '/api/teams/:sid/agents/:agent/stop', ({ params }) => {
  const team = teamOf(params.sid)
  const agent = team.agents.find((a) => a.id === params.agent) || fail(404, 'not_found', 'Team agent not found')
  if (team.phase !== 'working') fail(409, 'not_running', 'The team is not working.')
  const child = S.sessions.find((x) => x.id === agent.id)
  if (!child || child.state !== 'running') fail(409, 'not_running', 'The agent is not running.')
  agent.stopped = true
  clearTimers(child); child.state = 'idle'; child.updated = now()
  addEvents(child, { type: 'note', text: 'Turn stopped by user.', level: 'warn', at: now() })
  teamAdvance(params.sid) // the other worker may already be done
  bus('sessions', 'workspace')
  return teamOut(params.sid)
})
R('POST', '/api/teams/:sid/stop', ({ params }) => {
  const team = teamOf(params.sid)
  teamSetPhase(params.sid, 'stopped')
  for (const s of [...team.agents.map((a) => S.sessions.find((x) => x.id === a.id)), S.sessions.find((x) => x.id === params.sid)]) {
    if (!s || s.state !== 'running') continue
    const agent = team.agents.find((a) => a.id === s.id)
    if (agent) agent.stopped = true
    clearTimers(s); s.state = 'idle'; s.updated = now()
    addEvents(s, { type: 'note', text: 'Turn stopped by user.', level: 'warn', at: now() })
  }
  bus('sessions', 'workspace')
  return teamOut(params.sid)
})

/* ---- discussion presets (server/maxxing/sessions/presets.py): saved roles of Claude Code + Codex conversations */
const presetsState = () => (S.discussionPresets ||= S.scenario === 'ready' || S.scenario === 'maxxing' ? [
  { id: uuid(), name: 'Builder and reviewer', claude_role: 'Propose the change and write it step by step.', codex_role: 'Review each step: risks, missing tests, simpler options.' },
  { id: uuid(), name: 'Two copywriters', claude_role: 'Write the first draft in a warm, plain tone.', codex_role: 'Tighten the draft: shorter sentences, no jargon, keep the facts.' },
] : [])
R('GET', '/api/discussion-presets', () => presetsState())
R('POST', '/api/discussion-presets', ({ body }) => {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || body.name.length > 80 || String(body.claude_role || '').length > 2000 || String(body.codex_role || '').length > 2000) fail(422, 'invalid', 'name: 1-80 characters, roles: 2000 at most')
  if (presetsState().length >= 100) fail(400, 'bad_request', 'A maximum of 100 configurations can be saved.')
  const preset = { id: uuid(), name, claude_role: String(body.claude_role || '').trim(), codex_role: String(body.codex_role || '').trim() }
  S.discussionPresets.push(preset)
  return preset
})
R('DELETE', '/api/discussion-presets/:id', ({ params }) => {
  if (!presetsState().some((p) => p.id === params.id)) fail(404, 'not_found', 'Configuration not found')
  S.discussionPresets = S.discussionPresets.filter((p) => p.id !== params.id)
  return { ok: true }
})

/* ---- global bus */
R('GET', '/api/stream', ({ req, res }) => {
  sseOpen(req, res)
  busClients.add(res)
  req.on('close', () => busClients.delete(res))
  return RAW
})

/* ---- space labels (server/maxxing/api/space_labels.py): the owner's personal / agents / shared marks on folders and
   files, keyed by absolute path; `unclassified` removes the mark */
const labelsState = () => (S.spaceLabels ||= S.scenario === 'ready' || S.scenario === 'maxxing'
  ? { [`${ROOT}/projects/personal`]: 'personal', [`${ROOT}/projects/ops`]: 'agents' } : {})
R('GET', '/api/space-labels', () => Object.fromEntries(Object.entries(labelsState()).filter(([p]) => S.fs.has(p))))
R('PUT', '/api/space-labels', ({ body }) => {
  if (!['personal', 'agents', 'shared', 'unclassified'].includes(body.label)) fail(422, 'invalid', 'label must be personal, agents, shared or unclassified')
  const p = typeof body.path === 'string' && body.path.startsWith('/') ? path.posix.normalize(body.path).replace(/(.)\/$/, '$1') : fail(400, 'bad_path', 'An absolute path is required.')
  const files = S.settings.files_root || ROOT
  if (![ROOT, files].some((r) => p === r || p.startsWith(r + '/'))) fail(403, 'forbidden', 'Path is outside the workspace and files root.')
  if (!S.fs.has(p)) fail(404, 'not_found', 'Item not found.')
  if (body.label === 'unclassified') delete labelsState()[p]; else labelsState()[p] = body.label
  bus('space-labels')
  return { path: p, label: body.label }
})

/* ---- files */
function absPath(p, { must = true } = {}) {
  const raw = p == null || p === '' ? ROOT : String(p)
  const abs = path.posix.normalize(raw.startsWith('/') ? raw : `${ROOT}/${raw}`).replace(/\/$/, '') || '/'
  if (abs !== ROOT && !abs.startsWith(ROOT + '/')) fail(403, 'outside_root', `Path must be inside ${ROOT}`)
  if (must && !S.fs.has(abs)) fail(404, 'not_found', 'No such file or directory')
  return abs
}
function uniquePath(p) {
  if (!S.fs.has(p)) return p
  const ext = path.extname(p), base = p.slice(0, p.length - ext.length)
  for (let i = 1; ; i++) if (!S.fs.has(`${base}-${i}${ext}`)) return `${base}-${i}${ext}`
}
const entryOf = (abs, n) => ({ name: path.basename(abs), path: abs, type: n.type, size: n.size, mtime: n.mtime, mime: n.type === 'dir' ? 'inode/directory' : n.mime })

R('GET', '/api/files/list', ({ q }) => {
  const abs = absPath(q.get('path'))
  const node = S.fs.get(abs)
  if (node.type !== 'dir') fail(400, 'not_a_directory', 'Not a directory')
  const entries = []
  for (const [k, n] of S.fs) if (k !== abs && path.posix.dirname(k) === abs) entries.push(entryOf(k, n))
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  return { path: abs, parent: abs === ROOT ? null : path.posix.dirname(abs), root: ROOT, entries }
})
R('GET', '/api/files/read', ({ q }) => {
  const abs = absPath(q.get('path'))
  const n = S.fs.get(abs)
  if (n.type === 'dir') fail(400, 'is_a_directory', 'This is a directory')
  if (n.size > 2 * 1024 * 1024) fail(413, 'too_large', 'File is larger than 2 MB')
  const text = isText(n.mime) && typeof n.content === 'string' && !n.mime.startsWith('image/')
  if (!text) fail(415, 'binary', 'Binary file — use /api/files/raw')
  return { path: abs, content: n.content, mtime: n.mtime, size: n.size, mime: n.mime, editable: true }
})
R('GET', '/api/files/raw', ({ q, req, res }) => {
  const abs = absPath(q.get('path'))
  const n = S.fs.get(abs)
  if (n.type === 'dir') fail(400, 'is_a_directory', 'This is a directory')
  let mime = n.mime, body = n.content
  if (mime.startsWith('image/') && typeof body === 'string' && body.startsWith('<svg')) mime = 'image/svg+xml'
  if (typeof body === 'string') body = Buffer.from(body)
  const headers = { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' }
  if (q.get('download') === '1') headers['Content-Disposition'] = `attachment; filename="${path.basename(abs)}"`
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
  if (range) {
    const start = range[1] ? +range[1] : 0, end = range[2] ? Math.min(+range[2], body.length - 1) : body.length - 1
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 })
    res.end(body.subarray(start, end + 1))
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': body.length })
    res.end(body)
  }
  return RAW
})
R('GET', '/api/files/thumb', ({ q, res }) => {
  const abs = absPath(q.get('path'))
  const w = Math.min(1024, Math.max(32, parseInt(q.get('w') || '320', 10) || 320))
  const svg = PLACEHOLDER_SVG(path.basename(abs), w, Math.round(w * 0.625))
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=3600' })
  res.end(svg)
  return RAW
})
R('PUT', '/api/files/write', ({ body }) => {
  const abs = absPath(body.path, { must: false })
  const n = S.fs.get(abs)
  if (n && n.type === 'dir') fail(400, 'is_a_directory', 'This is a directory')
  if (n && body.expected_mtime != null && Math.abs(n.mtime - body.expected_mtime) > 0.001) fail(409, 'conflict', 'The file changed on disk since you opened it')
  const mtime = now()
  fsAdd(S, abs, String(body.content ?? ''), mtime, n ? n.mime : undefined)
  return { ok: true, mtime }
})
R('POST', '/api/files/mkdir', ({ body }) => {
  const abs = absPath(body.path, { must: false })
  if (S.fs.has(abs)) fail(409, 'exists', 'Already exists')
  fsMkdirp(S, abs)
  return { ok: true }
})
R('POST', '/api/files/move', ({ body }) => {
  const from = absPath(body.from), to = absPath(body.to, { must: false })
  if (from === ROOT) fail(403, 'forbidden', 'Cannot move the root')
  if (S.fs.has(to)) fail(409, 'exists', 'Destination already exists')
  fsMkdirp(S, path.posix.dirname(to))
  for (const [k, v] of [...S.fs]) if (k === from || k.startsWith(from + '/')) { S.fs.delete(k); S.fs.set(to + k.slice(from.length), v) }
  return { ok: true }
})
R('POST', '/api/files/delete', ({ body }) => {
  const abs = absPath(body.path)
  if (abs === ROOT) fail(403, 'forbidden', 'Cannot delete the root')
  for (const k of [...S.fs.keys()]) if (k === abs || k.startsWith(abs + '/')) S.fs.delete(k)
  return { ok: true }
})
R('POST', '/api/files/upload', ({ q, req, rawBody }) => {
  const dir = absPath(q.get('dir'))
  const files = parseMultipart(rawBody, req.headers['content-type'] || '')
  if (!files.length) fail(422, 'invalid', 'No file in the request')
  return { files: files.map((f) => {
    const p = uniquePath(`${dir}/${f.name}`)
    fsAdd(S, p, isText(f.mime) ? f.data.toString('utf8') : f.data, now(), f.mime)
    return { path: p, name: path.basename(p), size: f.data.length, mime: f.mime }
  }) }
})
R('GET', '/api/files/search', ({ q }) => {
  const term = (q.get('q') || '').trim().toLowerCase()
  if (!term) return []
  const out = []
  for (const [k, n] of S.fs) if (k !== ROOT && k.slice(ROOT.length).toLowerCase().includes(term)) out.push({ path: k, name: path.basename(k), type: n.type })
  return out.sort((a, b) => a.path.length - b.path.length).slice(0, 50)
})

/* ---- trash (server/maxxing/trash.py): deleted files, folders, topics, projects and sessions, kept 30 days. The mock's
   own delete routes still remove at once; the ready scenarios seed a few items that restore into the mock state. */
function trashState() {
  if (S.trash) return S.trash
  const t = now(), ready = S.scenario === 'ready' || S.scenario === 'maxxing'
  const item = (kind, name, original, ago, size, extra = {}) => ({ id: crypto.randomBytes(8).toString('hex'), kind, name, original, at: t - ago, size, sessions: 0, restorable: true, ...extra })
  S.trash = ready ? [
    item('file', 'old-draft.md', 'projects/acme/topics/blog/drafts/old-draft.md', 2 * HOUR, 2140),
    item('session', 'Try a dark hero image', topicPath('acme', 'website'), 26 * HOUR, 48200),
    item('topic', 'newsletter', 'projects/acme/topics/newsletter', 3 * DAY, 18400, { sessions: 2 }),
    item('previous_versions', 'Backup: previous versions', '.backup/previous', 9 * DAY, 3200000, { restorable: false }),
  ] : []
  return S.trash
}
const trashFind = (id) => trashState().find((x) => x.id === id) || fail(404, 'not_found', 'Not in the trash')
R('GET', '/api/trash', () => ({ items: [...trashState()].sort((a, b) => b.at - a.at), keep_days: 30 }))
R('POST', '/api/trash/:id/restore', ({ params }) => {
  const it = trashFind(params.id)
  if (!it.restorable) fail(409, 'not_restorable', 'Previous versions are restored from the backup, not from the trash')
  let to = it.original, sessions = 0
  if (it.kind === 'file' || it.kind === 'folder') {
    if (S.fs.has(`${ROOT}/${to}`)) to = to.replace(/(\.[^./]+)?$/, ' (restored)$1')
    if (it.kind === 'file') fsAdd(S, to, '# Old draft\n\nRestored from the trash.\n', now(), 'text/markdown'); else fsMkdirp(S, `${ROOT}/${to}`)
  } else if (it.kind === 'topic' || it.kind === 'project') {
    const [, project, , topic] = to.split('/')
    const p = S.projects.find((x) => x.name === project)
    if (it.kind === 'topic' && p) {
      let name = topic, n = 0
      while (p.topics.some((x) => x.name === name)) name = `${topic}-restored${++n > 1 ? '-' + n : ''}` // -restored, -restored-2…
      p.topics.push({ name, description: '' }); to = topicPath(project, name); fsMkdirp(S, `${ROOT}/${to}`)
      sessions = it.sessions
    }
  } else if (it.kind === 'session') {
    const s = { id: uuid(), title: it.name, path: S.projects.some((p) => p.topics.some((tp) => topicPath(p.name, tp.name) === to)) ? to : '', state: 'idle', queue: 0,
      created: it.at - HOUR, updated: it.at, turns: 2, cost_usd: 0.18, model: '', real_model: S.claude.default_model, context_tokens: 24000, context_window: 1000000,
      archived: false, notify: false, source: 'web', unread: false, last_text: 'The dark hero reads well on desktop; on mobile the text needs a stronger shadow.', error: null }
    S.sessions.push(s); S.events[s.id] = []; to = s.path; sessions = 1
  }
  S.trash = S.trash.filter((x) => x !== it)
  bus('workspace', 'sessions')
  return { ok: true, kind: it.kind, restored_to: to, sessions }
})
R('DELETE', '/api/trash/:id', ({ params }) => { const it = trashFind(params.id); S.trash = S.trash.filter((x) => x !== it); return { ok: true } })
R('DELETE', '/api/trash', () => { const deleted = trashState().length; S.trash = []; return { ok: true, deleted } })

/* ---- Files page extras (api/files.py, filesite.py, videos.py): image previews, archive listings, HTML pages with
   their assets (sandboxed, token in the URL), file mtimes, video copies, zip downloads. The zips are real (stored,
   not compressed); archive listings read zip files only (415 for tar / gzip in the mock). */
function zipStore(entries) { // [{name, data, mtime}] -> a ZIP buffer, method 0 (stored), UTF-8 names
  const parts = [], central = []
  let off = 0
  for (const { name, data, mtime } of entries) {
    const n = Buffer.from(name), d = new Date((mtime || now()) * 1000), crc = zlib.crc32(data)
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12)
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14)
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42)
    parts.push(h, n, data); central.push(c, n); off += 30 + n.length + data.length
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16)
  return Buffer.concat([...parts, cd, end])
}
function zipList(buf) { // the central directory of a ZIP file
  const e = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (e < 0) return null
  const out = []
  let p = buf.readUInt32LE(e + 16)
  for (let i = 0; i < buf.readUInt16LE(e + 10) && buf.readUInt32LE(p) === 0x02014b50; i++) {
    const nl = buf.readUInt16LE(p + 28), name = buf.subarray(p + 46, p + 46 + nl).toString('utf8')
    out.push({ name, size: buf.readUInt32LE(p + 24), dir: name.endsWith('/'), mtime: null })
    p += 46 + nl + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
  }
  return out
}
const fileBytes = (n) => (Buffer.isBuffer(n.content) ? n.content : Buffer.from(String(n.content ?? '')))
const filesUnder = (abs) => [...S.fs.entries()].filter(([k, n]) => n.type === 'file' && (k === abs || k.startsWith(abs + '/')) && !k.slice(abs.length + 1).split('/').some((x) => x.startsWith('.')))
const sendZip = (res, name, entries) => {
  const buf = zipStore(entries)
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${name}"` })
  res.end(buf)
  return RAW
}
R('GET', '/api/files/preview', ({ q, res }) => {
  const abs = absPath(q.get('path')), n = S.fs.get(abs)
  if (n.type !== 'file' || !String(n.mime).startsWith('image/')) fail(415, 'unsupported', 'Not an image')
  const body = fileBytes(n), svg = body.subarray(0, 5).toString() === '<svg '
  res.writeHead(200, { 'Content-Type': svg ? 'image/svg+xml' : n.mime, 'Content-Length': body.length, 'Cache-Control': 'private, max-age=86400' })
  res.end(body)
  return RAW
})
R('GET', '/api/files/archive', ({ q }) => {
  const abs = absPath(q.get('path')), n = S.fs.get(abs)
  if (n.type !== 'file') fail(404, 'not_found', 'Not a file')
  const entries = zipList(fileBytes(n)) || fail(415, 'unsupported', 'The mock lists ZIP archives only')
  return { path: abs, format: 'zip', entries: entries.slice(0, 5000), count: entries.length, total_size: entries.reduce((a, x) => a + x.size, 0), truncated: entries.length > 5000, size: fileBytes(n).length }
})
const siteTokens = new Map() // token -> { dir, file, until }
R('GET', '/api/files/site-url', ({ q }) => {
  const abs = absPath(q.get('path'))
  if (!/\.html?$/i.test(abs)) fail(415, 'unsupported', 'Only .html and .htm pages')
  const token = crypto.randomBytes(16).toString('hex')
  siteTokens.set(token, { dir: path.posix.dirname(abs), until: now() + 2 * HOUR })
  return { url: `/api/files/site/${token}/${encodeURIComponent(path.posix.basename(abs))}`, expires_in: 7200 }
})
R('GET', '/api/files/site/:token/*', ({ params, res }) => {
  const t = siteTokens.get(params.token)
  if (!t || t.until < now()) fail(404, 'not_found', 'This page link expired')
  const rel = decodeURIComponent(params.rest || ''), abs = path.posix.normalize(`${t.dir}/${rel}`)
  if (!abs.startsWith(t.dir + '/') || rel.split('/').some((x) => x.startsWith('.')) || !/\.(html?|css|m?js|wasm|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|svg|avif|ico|mp3|ogg|wav|mp4|webm)$/i.test(abs)) fail(403, 'forbidden', 'Not a web asset of this page')
  const n = S.fs.get(abs)
  if (!n || n.type !== 'file') fail(404, 'not_found', 'No such file')
  const body = fileBytes(n)
  res.writeHead(200, { 'Content-Type': mimeOf(abs), 'Content-Length': body.length, 'Cache-Control': 'no-store',
    'Content-Security-Policy': "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads; frame-ancestors 'self'" })
  res.end(body)
  return RAW
}, { public: true })
R('POST', '/api/files/stat', ({ body }) => {
  const paths = Array.isArray(body.paths) ? body.paths.slice(0, 500) : fail(422, 'invalid', 'paths must be a list')
  return { mtimes: Object.fromEntries(paths.map((p) => { const n = typeof p === 'string' && p.startsWith('/') ? S.fs.get(p) : null; return [p, n && n.type === 'file' ? n.mtime : null] })) }
})
const videoCopies = () => (S.videoCopies ||= {}) // `${path}|${q}` -> queued at
const VIDEO_QS = [720, 480] // below the 1080p original
function videoInfo(abs) {
  const n = S.fs.get(abs)
  if (n.type !== 'file' || !String(n.mime).startsWith('video/')) fail(415, 'unsupported', 'Not a video')
  const qualities = VIDEO_QS.map((q) => {
    const at = videoCopies()[`${abs}|${q}`], age = at ? now() - at : -1
    return at === undefined ? { q, state: 'none', progress: 0 } : age < 1 ? { q, state: 'queued', progress: 0 } : age < 6 ? { q, state: 'running', progress: +((age - 1) / 5).toFixed(2) } : { q, state: 'ready', progress: 1 }
  })
  return { width: 1920, height: 1080, codec: 'avc1.640028', bitrate: 6200000, duration: 42.5, fps: 30, has_audio: true, rotation: 0, qualities, auto: 720 }
}
R('GET', '/api/files/video', ({ q }) => videoInfo(absPath(q.get('path'))))
R('POST', '/api/files/video/prepare', ({ body }) => {
  const abs = absPath(body.path), q = Number(body.q)
  videoInfo(abs)
  if (!VIDEO_QS.includes(q)) fail(422, 'invalid', 'This quality is not offered for this video')
  videoCopies()[`${abs}|${q}`] ??= now()
  return videoInfo(abs)
})
R('GET', '/api/files/video/stream', ({ q, res }) => {
  const abs = absPath(q.get('path')), info = videoInfo(abs)
  if (info.qualities.find((x) => x.q === Number(q.get('q')))?.state !== 'ready') fail(404, 'not_ready', 'This copy is not ready yet')
  const body = fileBytes(S.fs.get(abs))
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' })
  res.end(body)
  return RAW
})
const zipTokens = new Map() // token -> { paths, until }
function zipPlan(paths) {
  const seen = new Set(), entries = []
  for (const abs of paths) {
    const base = path.posix.dirname(abs)
    for (const [k, n] of filesUnder(abs)) {
      let name = k.slice(base.length + 1)
      if (seen.has(k)) continue
      seen.add(k)
      while (entries.some((e) => e.name === name)) name = name.replace(/(\.[^./]+)?$/, ' (2)$1')
      entries.push({ name, data: fileBytes(n), mtime: n.mtime })
    }
  }
  return entries
}
R('GET', '/api/files/zip', ({ q, res }) => {
  if (q.get('token')) {
    const t = zipTokens.get(q.get('token'))
    if (!t || t.until < now()) fail(404, 'not_found', 'This download expired')
    return sendZip(res, t.name, zipPlan(t.paths))
  }
  const abs = absPath(q.get('path'))
  if (S.fs.get(abs).type !== 'dir') fail(404, 'not_found', 'Not a folder')
  const entries = zipPlan([abs])
  if (q.get('check') === '1') return { count: entries.length, size: entries.reduce((a, e) => a + e.data.length, 0) }
  return sendZip(res, `${path.posix.basename(abs) || 'files'}.zip`, entries)
})
R('POST', '/api/files/zip', ({ body }) => {
  if (!Array.isArray(body.paths) || !body.paths.length || body.paths.length > 1000) fail(422, 'invalid', 'paths: 1 to 1000')
  if (body.paths.some((p) => typeof p !== 'string' || !p.startsWith('/'))) fail(400, 'bad_path', 'Absolute paths only')
  const paths = [...new Set(body.paths.map((p) => absPath(p)))].filter((p, _, all) => !all.some((o) => o !== p && p.startsWith(o + '/')))
  const entries = zipPlan(paths), dirs = new Set(paths.map((p) => path.posix.dirname(p)))
  const token = crypto.randomBytes(16).toString('hex'), name = dirs.size === 1 ? `${path.posix.basename([...dirs][0]) || 'files'}.zip` : 'files.zip'
  zipTokens.set(token, { paths, name, until: now() + 120 })
  return { count: entries.length, size: entries.reduce((a, e) => a + e.data.length, 0), name, token, expires_in: 120 }
})
R('POST', '/api/telegram/webhook/remove', ({ body }) => {
  if (!body.token && !S.telegram.token) fail(400, 'not_configured', 'No Telegram bot is configured')
  return { ok: true }
})

/* ---- tasks */
const TASK_FIELDS = ['title', 'notes', 'status', 'priority', 'due', 'project_id', 'topic_path', 'labels', 'order']
function applyTask(tk, body) {
  for (const k of TASK_FIELDS) if (body[k] !== undefined) tk[k] = body[k]
  if (body.status !== undefined && !['todo', 'doing', 'done'].includes(body.status)) fail(422, 'invalid', 'Unknown status')
  if (body.priority !== undefined && ![0, 1, 2, 3].includes(body.priority)) fail(422, 'invalid', 'Priority must be 0-3')
  if (body.due != null && body.due !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(body.due)) fail(422, 'invalid', 'due must be YYYY-MM-DD')
  if (body.status !== undefined) tk.done_at = body.status === 'done' ? tk.done_at || now() : null
  tk.updated = now()
}
R('GET', '/api/tasks', () => S.tasks)
R('POST', '/api/tasks', ({ body }) => {
  if (!body.title || !String(body.title).trim()) fail(422, 'invalid', 'title is required')
  const t = now()
  const tk = { id: rid('t'), title: '', notes: '', status: 'todo', priority: 0, due: null, project_id: null, topic_path: null, labels: [], created: t, updated: t, done_at: null,
    order: Math.max(0, ...S.tasks.tasks.map((x) => x.order)) + 1000 }
  applyTask(tk, body)
  S.tasks.tasks.push(tk)
  bus('tasks')
  return tk
})
R('POST', '/api/tasks/projects', ({ body }) => {
  if (!body.name) fail(422, 'invalid', 'name is required')
  const p = { id: rid('tp'), name: String(body.name), color: body.color || '#64748b' }
  S.tasks.projects.push(p); bus('tasks')
  return p
})
R('PATCH', '/api/tasks/projects/:id', ({ params, body }) => {
  const p = S.tasks.projects.find((x) => x.id === params.id) || fail(404, 'not_found', 'Task project not found')
  if (body.name !== undefined) p.name = body.name
  if (body.color !== undefined) p.color = body.color
  bus('tasks')
  return p
})
R('DELETE', '/api/tasks/projects/:id', ({ params }) => {
  const p = S.tasks.projects.find((x) => x.id === params.id) || fail(404, 'not_found', 'Task project not found')
  S.tasks.projects = S.tasks.projects.filter((x) => x !== p)
  for (const tk of S.tasks.tasks) if (tk.project_id === p.id) tk.project_id = null
  bus('tasks')
  return { ok: true }
})
R('POST', '/api/tasks/bulk', ({ body }) => {
  const ids = new Set(body.ids || [])
  if (!ids.size) fail(400, 'invalid_ids', 'ids must list at least one task id')
  const hit = S.tasks.tasks.filter((x) => ids.has(x.id))
  if (body.delete) {
    S.tasks.tasks = S.tasks.tasks.filter((x) => !ids.has(x.id)); bus('tasks')
    return { ok: true, updated: 0, deleted: hit.length }
  }
  for (const tk of hit) {
    applyTask(tk, body.patch || {})
    if (body.labels_remove) tk.labels = tk.labels.filter((l) => !body.labels_remove.includes(l))
    for (const l of body.labels_add || []) if (!tk.labels.includes(l)) tk.labels.push(l)
  }
  bus('tasks')
  return { ok: true, updated: hit.length, deleted: 0 }
})
R('PATCH', '/api/tasks/:id', ({ params, body }) => {
  const tk = S.tasks.tasks.find((x) => x.id === params.id) || fail(404, 'not_found', 'Task not found')
  applyTask(tk, body); bus('tasks')
  return tk
})
R('DELETE', '/api/tasks/:id', ({ params }) => {
  const tk = S.tasks.tasks.find((x) => x.id === params.id) || fail(404, 'not_found', 'Task not found')
  S.tasks.tasks = S.tasks.tasks.filter((x) => x !== tk); bus('tasks')
  return { ok: true }
})

/* ---- voice (server/maxxing/voice.py): speech-to-text on the server (local faster-whisper or Groq / OpenAI keys). The
   mock never decodes audio: every recording gives the same sentence. An install takes about 6 s. */
const VOICE_MODELS = [['tiny', 75], ['base', 142], ['small', 466], ['medium', 1530]]
function voiceState() {
  if (S.voice) return S.voice
  const ready = S.scenario === 'ready' || S.scenario === 'maxxing'
  S.voice = { settings: { engine: ready ? 'local' : 'off', model: 'small', language: 'auto', auto_send: false, direct: true }, installed: ready,
    present: new Set(ready ? ['small'] : []), install: { state: 'idle', step: null, progress: null, model: null, message: '', error: null, at: null } }
  return S.voice
}
function voiceStatus() {
  const v = voiceState(), st = v.settings, inst = v.install
  if (inst.state === 'running') { // a background job: dependencies first (when missing), then the model download
    const p = Math.min(1, (now() - inst.at) / 6)
    if (p >= 1) { v.installed = true; v.present.add(inst.model); Object.assign(inst, { state: 'done', step: null, progress: 1, message: `Model ${inst.model} ready` }) }
    else Object.assign(inst, v.installed || p > 0.4 ? { step: 'model', progress: p, message: `Downloading ${inst.model}…` } : { step: 'deps', progress: null, message: 'Installing faster-whisper…' })
  }
  const keys = { groq: S.secrets.some((s) => s.name === 'GROQ_API_KEY'), openai: S.secrets.some((s) => s.name === 'OPENAI_API_KEY') }
  const reason = st.engine === 'off' ? 'off' : st.engine === 'local' ? (v.installed && v.present.has(st.model) ? null : 'not_installed') : keys[st.engine] ? null : 'no_key'
  return { settings: { ...st }, ready: !reason, reason, ffmpeg: true,
    local: { installed: v.installed, loaded: v.installed && reason === null && st.engine === 'local' ? st.model : null, recommended: 'small', ram_gb: 7.8, cpus: 4,
      models: VOICE_MODELS.map(([id, size_mb]) => ({ id, size_mb, present: v.present.has(id) })) },
    keys, key_names: { groq: 'GROQ_API_KEY', openai: 'OPENAI_API_KEY' }, install: { ...inst }, max_seconds: 900 }
}
const formField = (raw, name) => { const m = raw.toString('latin1').match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`)); return m ? Buffer.from(m[1], 'latin1').toString('utf8') : null }
R('GET', '/api/voice', () => voiceStatus())
R('PUT', '/api/voice/settings', ({ body }) => {
  const st = voiceState().settings
  if (body.engine !== undefined && !['off', 'local', 'groq', 'openai'].includes(body.engine)) fail(422, 'invalid', 'engine')
  if (body.model !== undefined && !VOICE_MODELS.some(([id]) => id === body.model)) fail(422, 'invalid', 'model')
  if (body.language !== undefined && body.language !== 'auto' && !/^[a-z]{2,3}$/.test(body.language)) fail(400, 'invalid_language', 'Use auto or an ISO 639-1 code')
  for (const k of ['engine', 'model', 'language', 'auto_send', 'direct']) if (body[k] !== undefined) st[k] = body[k]
  return { ok: true, settings: { ...st } }
})
R('POST', '/api/voice/install', ({ body }) => {
  const v = voiceState()
  if (v.install.state === 'running') fail(409, 'busy', 'An install is already running')
  const model = body.model || v.settings.model
  if (!VOICE_MODELS.some(([id]) => id === model)) fail(422, 'invalid', 'model')
  v.install = { state: 'running', step: v.installed ? 'model' : 'deps', progress: v.installed ? 0 : null, model, message: '', error: null, at: now() }
  return voiceStatus().install
})
R('DELETE', '/api/voice/models/:model', ({ params }) => {
  if (!VOICE_MODELS.some(([id]) => id === params.model)) fail(422, 'invalid', 'model')
  voiceState().present.delete(params.model)
  return { ok: true }
})
R('POST', '/api/voice/transcribe', async ({ req, rawBody }) => {
  const status = voiceStatus()
  if (status.reason === 'off') fail(409, 'voice_off', 'Voice messages are turned off in Settings')
  if (status.reason) fail(503, status.reason, status.reason === 'no_key' ? 'No API key for this engine in Secrets' : 'The local engine is not installed')
  const [audio] = parseMultipart(rawBody, req.headers['content-type'] || '')
  if (!audio) fail(422, 'bad_audio', 'No audio file in the request')
  if (audio.data.length < 200) fail(422, 'empty_audio', 'Nothing was heard in this recording')
  if (audio.data.length > 100 * 1024 * 1024) fail(413, 'too_large', 'Recordings are limited to 100 MB')
  await sleep(900)
  const topic = formField(rawBody, 'path'), lang = formField(rawBody, 'language') || status.settings.language
  let audio_path = null
  if (topic) {
    const d = new Date(), ext = path.extname(audio.name) || '.webm'
    audio_path = `${ROOT}/${topic}/attachments/voice/${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}/voice-${Math.floor(now())}${ext}`
    fsAdd(S, audio_path, audio.data, now(), audio.mime)
  }
  return { text: 'Draft a short reply thanking the client for the feedback, and propose a call next Tuesday.', language: lang === 'auto' ? 'en' : lang,
    duration_s: Math.max(1, Math.round(audio.data.length / 4000)), engine: status.settings.engine, model: status.settings.engine === 'local' ? status.settings.model : status.settings.engine === 'groq' ? 'whisper-large-v3-turbo' : 'gpt-4o-transcribe', ms: 900, audio_path }
})

/* ---- crons */
const CRON_FIELDS = ['name', 'schedule', 'kind', 'command', 'topic_path', 'prompt', 'model', 'reuse_session', 'enabled', 'notify', 'timeout_s']
function applyCron(c, body) {
  for (const k of CRON_FIELDS) if (body[k] !== undefined) c[k] = body[k]
  if (!c.name) fail(422, 'invalid', 'name is required')
  if (!cronValid(c.schedule)) fail(422, 'invalid_schedule', `Invalid cron expression “${c.schedule}”`)
  if (!['shell', 'claude'].includes(c.kind)) fail(422, 'invalid', 'kind must be shell or claude')
  if (c.kind === 'shell' && !c.command) fail(422, 'invalid', 'command is required for shell jobs')
  if (c.kind === 'claude' && !c.prompt) fail(422, 'invalid', 'prompt is required for Claude jobs')
  if (!['never', 'failure', 'always'].includes(c.notify)) fail(422, 'invalid', 'Unknown notify mode')
}
R('GET', '/api/crons', () => ({ jobs: S.crons.map(cronOut), external: S.external.map((e) => ({ ...e, human: cronHuman(e.schedule) })) }))
R('GET', '/api/crons/runs', ({ q }) => {
  const cid = q.get('cron_id'), limit = Math.min(500, parseInt(q.get('limit') || '50', 10) || 50)
  return S.cronRuns.filter((r) => !cid || r.cron_id === cid).slice(0, limit)
})
R('GET', '/api/crons/preview', ({ q }) => {
  const sch = (q.get('schedule') || '').trim()
  const valid = cronValid(sch)
  return { valid, human: valid ? cronHuman(sch) : 'Invalid expression — expected 5 fields: minute hour day month weekday', next: valid ? cronNext(sch, 5) : [] }
})
R('POST', '/api/crons', ({ body }) => {
  const c = { id: rid('c'), name: '', schedule: '', kind: 'shell', command: '', topic_path: '', prompt: '', model: '', reuse_session: false, enabled: true, notify: 'failure', timeout_s: 600, last_run: null }
  applyCron(c, body)
  S.crons.push(c); bus('crons')
  return cronOut(c)
})
R('PATCH', '/api/crons/:id', ({ params, body }) => {
  const c = S.crons.find((x) => x.id === params.id) || fail(404, 'not_found', 'Cron not found')
  const copy = { ...c }
  applyCron(copy, body)
  Object.assign(c, copy); bus('crons')
  return cronOut(c)
})
R('DELETE', '/api/crons/:id', ({ params }) => {
  const c = S.crons.find((x) => x.id === params.id) || fail(404, 'not_found', 'Cron not found')
  S.crons = S.crons.filter((x) => x !== c); bus('crons')
  return { ok: true }
})
R('POST', '/api/crons/:id/run', ({ params }) => {
  const c = S.crons.find((x) => x.id === params.id) || fail(404, 'not_found', 'Cron not found')
  const g = GEN, started = now()
  let sid = null
  if (c.kind === 'claude') {
    const s = { id: uuid(), title: `${c.name} — manual run`, path: c.topic_path, state: 'idle', queue: 0, created: started, updated: started, turns: 0, cost_usd: 0,
      model: c.model, real_model: null, context_tokens: null, context_window: null, archived: false, notify: c.notify !== 'never', source: 'cron', unread: false, last_text: '', error: null }
    S.sessions.push(s); S.events[s.id] = []; sid = s.id
    startTurn(s, c.prompt)
  }
  setTimeout(() => {
    if (g !== GEN) return
    const ok = c.id !== 'c_uptime'
    const dur = +(now() - started).toFixed(1)
    c.last_run = { at: started, ok, code: ok ? 0 : 22, duration_s: dur }
    S.cronRuns.unshift({ id: rid('r'), cron_id: c.id, name: c.name, at: started, ok, code: c.last_run.code, duration_s: dur,
      output_tail: ok ? 'Done.' : 'curl: (22) The requested URL returned error: 503', session_id: sid })
    feedCronRun(c, S.cronRuns[0])
    bus('crons', 'health')
  }, c.kind === 'claude' ? 3600 : 1500)
  bus('crons')
  return { ok: true }
})

/* ---- MCP servers (server/maxxing/mcp.py): Claude Code's servers per folder, checked with `claude mcp list` in the
   background (here: 1.5 s), and the OAuth login of a server that needs one (here: any redirect with ?code= works). */
const mcpWhere = (rel) => {
  if (!rel) return { rel: null, project: null, topic: null, exists: true, path: null }
  const [, project, , topic] = rel.split('/')
  return { rel, project: project || null, topic: topic || null, exists: S.fs.has(`${ROOT}/${rel}`), path: `${ROOT}/${rel}` }
}
function mcpState() {
  if (S.mcp) return S.mcp
  const ready = S.scenario === 'ready' || S.scenario === 'maxxing', t = now()
  const server = (scope, rel, name, def, state, detail = '', extra = {}) => ({ id: `${scope}|${rel || ''}|${name}`, name, scope, where: mcpWhere(rel), ...def,
    literal_secret: false, keys: [...JSON.stringify(def).matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]), state, detail, checked_at: t - 300, ...extra })
  S.mcp = { auto: false, checking: false, checked_at: ready ? t - 300 : null, logins: {}, servers: ready ? [
    server('user', null, 'github', { type: 'http', url: 'https://mcp.example.com/github', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } }, 'connected'),
    server('user', null, 'linear', { type: 'sse', url: 'https://mcp.example.com/linear/sse' }, 'needs_auth', 'Needs authentication'),
    server('local', topicPath('acme', 'website'), 'playwright', { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'] }, 'connected'),
    server('project', topicPath('ops', 'server'), 'postgres', { type: 'stdio', command: 'uvx', args: ['postgres-mcp'], env: { DATABASE_URI: '•••' } }, 'failed', 'Connection closed', { literal_secret: true, approved: true }),
  ] : [] }
  return S.mcp
}
function mcpCheck() {
  const st = mcpState()
  if (st.checking) return
  st.checking = true
  const g = GEN
  setTimeout(() => { if (g !== GEN) return; st.checking = false; st.checked_at = now(); for (const x of st.servers) { x.checked_at = now(); if (x.state === 'pending') x.state = 'connected' } bus('mcp') }, 1500)
}
R('GET', '/api/mcp', () => { const st = mcpState(); if (st.checked_at === null) mcpCheck(); return { servers: st.servers, checking: st.checking, checked_at: st.checked_at, config_file: '/root/.claude.json', auto: st.auto } })
R('PUT', '/api/mcp/auto', ({ body }) => { const st = mcpState(); st.auto = !!body.enabled; if (st.auto) mcpCheck(); return { ok: true, enabled: st.auto } })
R('POST', '/api/mcp/check', () => { mcpCheck(); return { checking: true } })
R('POST', '/api/mcp', ({ body }) => {
  const st = mcpState(), name = String(body.name || ''), where = String(body.where || '')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) fail(400, 'bad_name', 'Letters, digits, dot, dash and underscore')
  if (!['http', 'sse', 'stdio'].includes(body.type)) fail(400, 'bad_type', 'type: http, sse or stdio')
  if (where && !where.startsWith('projects/')) fail(400, 'bad_where', 'where: empty (all folders) or a projects/… folder')
  if (where && !S.fs.has(`${ROOT}/${where}`)) fail(404, 'folder_missing', 'This folder does not exist')
  if (body.type === 'stdio' ? !String(body.command || '').trim() : !/^https?:\/\/\S+$/.test(String(body.url || ''))) fail(400, body.type === 'stdio' ? 'bad_command' : 'bad_url', body.type === 'stdio' ? 'A command is required' : 'An http(s) URL is required')
  if (JSON.stringify(body).length > 32768) fail(400, 'too_long', 'A value is too long')
  const scope = where ? 'local' : 'user', id = `${scope}|${where}|${name}`
  if (st.servers.some((x) => x.id === id)) fail(409, 'exists', 'A server with this name already exists here')
  const def = { type: body.type, ...(body.type === 'stdio' ? { command: body.command.trim(), args: body.args || [] } : { url: body.url }), ...(body.headers ? { headers: body.headers } : {}), ...(body.env ? { env: body.env } : {}) }
  const keys = [...JSON.stringify(def).matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1])
  st.servers.push({ id, name, scope, where: mcpWhere(where || null), ...def, literal_secret: false, keys, state: 'pending', detail: '', checked_at: null })
  mcpCheck(); bus('mcp')
  return { id, exposed: keys.filter((k) => S.secrets.some((s) => s.name === k && !s.expose)) }
})
R('DELETE', '/api/mcp', ({ q }) => { const st = mcpState(); st.servers = st.servers.filter((x) => x.id !== q.get('id')); bus('mcp'); return { ok: true } })
R('POST', '/api/mcp/login', ({ body }) => {
  const x = mcpState().servers.find((s) => s.id === body.id) || fail(404, 'folder_missing', 'Server not found')
  if (x.type === 'stdio') fail(400, 'no_login_url', 'This server does not offer a login')
  const login = crypto.randomBytes(8).toString('hex')
  S.mcp.logins[login] = { id: x.id, at: now() }
  return { login, url: `https://mcp.example.com/oauth/authorize?client_id=claude-code&state=${login}&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback` }
})
R('POST', '/api/mcp/login/:login', async ({ params, body }) => {
  const l = mcpState().logins[params.login] || fail(404, 'login_expired', 'This login expired: start it again')
  if (!/^http:\/\/localhost:\d+\/callback\?/.test(String(body.redirect || ''))) fail(400, 'bad_redirect', 'Paste the whole address of the page that failed to open (http://localhost:…/callback?code=…)')
  await sleep(800)
  if (!/[?&]code=/.test(body.redirect)) fail(400, 'login_failed', 'The address has no authorization code')
  delete S.mcp.logins[params.login]
  const x = S.mcp.servers.find((s) => s.id === l.id)
  if (x) Object.assign(x, { state: 'connected', detail: '', checked_at: now() })
  bus('mcp')
  return { ok: true, message: `${x ? x.name : 'Server'}: authenticated` }
})
R('DELETE', '/api/mcp/login/:login', ({ params }) => { delete mcpState().logins[params.login]; return { ok: true } })

/* ---- telegram */
function tgStatus() {
  const tg = S.telegram
  return { configured: !!tg.token, running: !!tg.token && !!tg.chat, bot: tg.bot, chat: tg.chat, topics_enabled: tg.topics_enabled, threads: tg.threads, settings: tg.settings, linking: !!tg.link && !tg.chat, last_error: tg.last_error }
}
R('GET', '/api/telegram', () => tgStatus())
R('POST', '/api/telegram/token', async ({ body }) => {
  await sleep(600)
  const token = String(body.token || '').trim()
  if (!/^\d+:[\w-]{30,}$/.test(token)) return { ok: false, error: 'Unauthorized: invalid bot token' }
  const bot = { id: parseInt(token.split(':')[0], 10), username: 'acme_pilot_bot', name: 'Acme Pilot' }
  Object.assign(S.telegram, { token, bot, last_error: null })
  bus('telegram')
  return { ok: true, bot }
})
R('POST', '/api/telegram/link', () => {
  if (!S.telegram.token) fail(409, 'not_configured', 'Set the bot token first')
  const code = crypto.randomBytes(5).toString('hex')
  S.telegram.link = { code, at: Date.now() }
  return { code, deep_link: `https://t.me/${S.telegram.bot.username}?start=${code}` }
})
R('GET', '/api/telegram/link', () => {
  const tg = S.telegram
  if (!tg.chat && tg.link && Date.now() - tg.link.at >= 6000) {
    tg.chat = { id: 123456789, title: 'Alex', type: 'private' }
    tg.link = null
    bus('telegram')
  }
  return { linked: !!tg.chat, chat: tg.chat }
})
R('POST', '/api/telegram/sync', async () => {
  if (!S.telegram.chat) fail(409, 'not_linked', 'Link a chat first')
  await sleep(500)
  const want = makeThreads(S)
  let created = 0
  let maxId = Math.max(100, ...S.telegram.threads.map((x) => x.thread_id))
  for (const w of want) if (!S.telegram.threads.some((x) => x.path === w.path)) { S.telegram.threads.push({ ...w, thread_id: w.thread_id < 100 ? w.thread_id : ++maxId }); created++ }
  S.telegram.topics_enabled = true
  bus('telegram', 'workspace')
  return { created, topics_enabled: S.telegram.topics_enabled, error: null }
})
R('PUT', '/api/telegram/settings', ({ body }) => {
  const st = S.telegram.settings
  if (body.reply_mode !== undefined && !['final', 'progress'].includes(body.reply_mode)) fail(422, 'invalid', 'reply_mode must be final or progress')
  for (const k of ['notify_crons', 'login_alerts', 'reply_mode']) if (body[k] !== undefined) st[k] = body[k]
  bus('telegram')
  return { ok: true }
})
R('POST', '/api/telegram/test', async () => {
  if (!S.telegram.chat) fail(409, 'not_linked', 'Link a chat first')
  await sleep(500)
  return { ok: true }
})
R('DELETE', '/api/telegram', () => {
  Object.assign(S.telegram, { token: null, bot: null, chat: null, topics_enabled: false, threads: [], last_error: null, link: null })
  bus('telegram', 'workspace')
  return { ok: true }
})

/* ---- starter packs (server/maxxing/packs.py): read from the repository's templates/packs/<id>/pack.json, so the mock
   offers the real catalog. Installing adds the project (a free name when taken), its topics and its jobs, disabled. */
const PACKS_DIR = path.resolve(__dirname, '../../templates/packs')
function packList() {
  const lang = S.settings.language === 'fr' ? 'fr' : 'en', txt = (v) => (typeof v === 'object' && v ? v[lang] || v.en : v || '')
  let ids = []
  try { ids = fs.readdirSync(PACKS_DIR).filter((d) => fs.existsSync(path.join(PACKS_DIR, d, 'pack.json'))).sort() } catch {}
  const packs = ids.map((id) => {
    const d = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, id, 'pack.json'), 'utf8'))
    const copies = S.projects.filter((p) => p.name === d.project || p.name.startsWith(d.project + '-'))
    return { id: d.id, project: d.project, emoji: d.emoji || '', icon: d.icon || 'package', title: txt(d.title), description: txt(d.description),
      topics: d.topics || [], crons: (d.crons || []).map((c) => c.name), installed: copies.length > 0, partial: false, project_exists: S.projects.some((p) => p.name === d.project), basics: false, def: d }
  })
  const missing = ['general', 'system'].filter((n) => !S.projects.some((p) => p.name === n))
  packs.unshift({ id: 'basics', project: 'general, system', emoji: '', icon: 'house', title: lang === 'fr' ? 'Projets de base' : 'Default projects',
    description: lang === 'fr' ? 'general/inbox et system (tutoriel, aide, Harness) : remet ceux que vous avez supprimés, sans rien écraser.' : 'general/inbox and system (tutorial, help, Harness): puts back the ones you deleted, never overwrites.',
    topics: ['general/inbox', 'system/help', 'system/harness', 'system/tutorial'], crons: [], installed: missing.length === 0, partial: missing.length === 1, project_exists: missing.length < 2, basics: true })
  return packs
}
const packOut = ({ def, ...p }) => p
R('GET', '/api/packs', () => ({ packs: packList().map(packOut) }))
R('POST', '/api/packs/:id/install', async ({ params }) => {
  const pack = packList().find((p) => p.id === params.id) || fail(404, 'unknown_pack', 'Unknown pack')
  await sleep(700)
  let project = '', created = 0
  const jobs = []
  if (pack.basics) {
    for (const [name, topics] of [['general', ['inbox']], ['system', ['help', 'harness', 'tutorial']]]) {
      let p = S.projects.find((x) => x.name === name)
      if (!p) { p = { name, description: '', topics: [] }; S.projects.push(p); fsAdd(S, `${projPath(name)}/CLAUDE.md`, `# Project ${name}\n\n@memory.md\n`, now()); created += 1 }
      for (const t of topics) if (!p.topics.some((x) => x.name === t)) { p.topics.push({ name: t, description: '' }); fsAdd(S, `${topicPath(name, t)}/CLAUDE.md`, `# Topic ${t}\n`, now()); created += 1 }
    }
  } else {
    project = pack.project
    for (let n = 2; S.projects.some((p) => p.name === project); n++) project = `${pack.project}-${n}`
    S.projects.push({ name: project, description: pack.description, topics: pack.topics.map((name) => ({ name, description: '' })) })
    fsAdd(S, `${projPath(project)}/CLAUDE.md`, `# Project ${project}\n\n> ${pack.description}\n\n@memory.md\n`, now())
    fsAdd(S, `${projPath(project)}/memory.md`, `# ${project} — memory\n`, now())
    for (const t of pack.topics) fsAdd(S, `${topicPath(project, t)}/CLAUDE.md`, `# Topic ${t}\n`, now())
    created = 2 + pack.topics.length
    for (const c of pack.def.crons || []) {
      const name = project === pack.project ? c.name : `${c.name} (${project})`
      S.crons.push({ id: rid('c'), name, schedule: c.schedule, kind: 'claude', command: '', topic_path: topicPath(project, c.topic), prompt: c.prompt, model: '',
        reuse_session: false, enabled: false, notify: c.notify || 'failure', timeout_s: 600, last_run: null })
      jobs.push(name)
    }
  }
  bus('workspace', 'crons')
  return { ok: true, pack: packOut(packList().find((p) => p.id === pack.id)), project, created_files: created, jobs }
})

/* ---- backup */
function backupStatus() {
  const b = S.backup
  return { configured: b.configured, repo: b.repo, private: b.private, schedule: b.schedule, include: b.include, always: b.always, last: b.history.at(-1) || null }
}
R('GET', '/api/backup', () => backupStatus())
R('POST', '/api/backup/config', async ({ body }) => {
  await sleep(900)
  const repo = String(body.repo || '').trim(), token = String(body.token || '').trim()
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, private: false, error: 'Repository must look like owner/name' }
  if (!token.startsWith('github_pat_')) return { ok: false, private: false, error: 'Bad credentials: use a fine-grained token (github_pat_…)' }
  Object.assign(S.backup, { configured: true, repo, private: true })
  bus('backup', 'health')
  return { ok: true, private: true }
})
R('PUT', '/api/backup/settings', ({ body }) => {
  if (body.schedule !== undefined) { if (!cronValid(body.schedule)) fail(422, 'invalid_schedule', 'Invalid cron expression'); S.backup.schedule = body.schedule }
  if (body.include !== undefined) { if (!Array.isArray(body.include)) fail(422, 'invalid', 'include must be a list'); S.backup.include = body.include }
  bus('backup')
  return { ok: true }
})
R('POST', '/api/backup/run', async () => {
  if (!S.backup.configured) fail(409, 'not_configured', 'Configure the backup repository first')
  await sleep(1500)
  const run = { at: now(), ok: true, commit: sha().slice(0, 7), files: 42, error: null }
  S.backup.history.push(run)
  bus('backup', 'health')
  return { ok: true, commit: run.commit, files: run.files }
})
R('GET', '/api/backup/history', () => [...S.backup.history].reverse())
R('POST', '/api/backup/restore', async ({ body }) => {
  if (!S.backup.configured) fail(409, 'not_configured', 'Configure the backup repository first')
  await sleep(1200)
  return { ok: true, ref: body.ref || 'HEAD', files: 42, trash: `${ROOT}/.trash/restore-${Math.floor(now())}` }
})
R('DELETE', '/api/backup', () => {
  Object.assign(S.backup, { configured: false, repo: null, private: null })
  bus('backup', 'health')
  return { ok: true }
})

/* ---- complete instance backup (server/maxxing/instance_backup.py): encrypted exports kept on the server, a verified
   preview of an uploaded archive, restore into a separate copy whose services and integrations start paused */
const IB_DESCRIPTION = { version: VERSION, files: 1834, bytes: 412 * 1024 * 1024, external_links: ['workspace/projects/acme/topics/website/node_modules'],
  includes: ['settings_and_credentials', 'sessions', 'attachments', 'workspace', 'files', 'space_labels'],
  excludes: ['application_and_provider_binaries', 'temporary_runtime_files', 'external_symlink_targets'], excluded_roots: {} }
const ibId = () => crypto.randomBytes(16).toString('hex')
function ibState() {
  if (S.instanceBackup) return S.instanceBackup
  const t = now(), ready = S.scenario === 'ready' || S.scenario === 'maxxing'
  S.instanceBackup = { restore_hold: false, integrations_paused: false, previews: {}, // previews: id -> { at, ...result }
    schedule: null, runs: {}, keyStored: false, copyFolder: '', // schedule: {frequency, hour, keep, since} or off; runs: {last_success, last_id, error}
    exports: ready ? [{ id: ibId(), created: t - 6 * DAY, sha256: crypto.randomBytes(32).toString('hex'), archive_bytes: 371 * 1024 * 1024, ...clone(IB_DESCRIPTION), files: 1791, bytes: 398 * 1024 * 1024, scheduled: false, copy: null }] : [] }
  return S.instanceBackup
}
const ibRoots = () => {
  const files = S.settings.files_root || ROOT
  const broad = files === '/' || files === '/root' || /^\/home\/[^/]+\/?$/.test(files) // the filesystem root or a home folder
  return { state: { source: '/var/lib/claude-maxxing', archive: 'state' }, workspace: { source: ROOT, archive: 'workspace' },
    files: broad ? { source: files, archive: null, excluded: 'broad_root' } : { source: files, archive: 'files' } }
}
const ibDescription = () => {
  const roots = ibRoots(), left = Object.entries(roots).filter(([, r]) => !r.archive)
  return { ...clone(IB_DESCRIPTION), includes: IB_DESCRIPTION.includes.filter((x) => x !== 'files' || roots.files.archive),
    excluded_roots: Object.fromEntries(left.map(([name, r]) => [name, { source: r.source, reason: r.excluded }])) }
}
const ibHeld = () => { if (ibState().restore_hold) fail(409, 'restore_hold', 'This restored instance is in review mode. Enable services in Settings → Backup before making changes.') }
const ibPassphrase = (p) => { if (typeof p !== 'string' || p.length < 12 || p.length > 1024) fail(400, 'passphrase', 'Use a backup passphrase between 12 and 1024 characters.') }
// Scheduled archives (instance_backup.schedule_status): the next run is the first `hour`:00 in the configured timezone
// after the last success plus the period (less 12 h), or after the schedule was enabled; none while paused.
const IB_PERIOD = { daily: 1, weekly: 7 }
function ibSchedule() {
  const st = ibState(), cur = st.schedule, runs = st.runs, paused = st.restore_hold || st.integrations_paused
  const earliest = cur && (runs.last_success ? runs.last_success + IB_PERIOD[cur.frequency] * DAY - 12 * HOUR : cur.since)
  return { enabled: !!cur, frequency: cur ? cur.frequency : 'off', hour: cur ? cur.hour : 3, keep: cur ? cur.keep : 7,
    next_run: cur && !paused ? cronNext(`0 ${cur.hour} * * *`, 1, earliest * 1000)[0] ?? null : null, paused,
    last_success: runs.last_success ?? null, last_id: runs.last_id ?? null, error: cur ? runs.error ?? null : null }
}
// Copy folder (instance_backup.copy_status): `last` = the copy record of the newest export that has one.
const ibCopy = () => ({ folder: ibState().copyFolder || null, last: ibState().exports.find((e) => e.copy)?.copy ?? null })
// Copy one export to the folder (instance_backup.copy_export); a folder whose path contains "full" fails, to see the
// failure. The record is kept with the export, as in its metadata file.
function ibCopyExport(e) {
  const folder = ibState().copyFolder, d = new Date(e.created * 1000 + zoneOffset(e.created * 1000, S.settings.timezone) * 60000)
  const stamp = d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  e.copy = /(^|\/)[^/]*full[^/]*(\/|$)/i.test(folder)
    ? { ok: false, at: now(), code: 'copy_no_space', error: `Not enough free space in ${folder} for this archive.` }
    : { ok: true, at: now(), path: `${folder}/pilot-${stamp}-${e.id.slice(0, 12)}.pilotbackup`, bytes: e.archive_bytes, sha256: e.sha256 }
  return e.copy
}
R('GET', '/api/backup/instance', () => {
  const st = ibState()
  return { max_bytes: 2048 * 1024 * 1024, restore_hold: st.restore_hold, integrations_paused: st.integrations_paused, roots: ibRoots(),
    export_error: null, requires_idle_sessions: true, service_resume_errors: [], schedule: ibSchedule(), copy: ibCopy() }
})
R('POST', '/api/backup/instance/export', async ({ body }) => {
  ibHeld(); ibPassphrase(body.passphrase)
  if (S.sessions.some((s) => s.state === 'running' || s.queue)) fail(409, 'sessions_active', 'Finish or stop active and queued sessions before a full snapshot.')
  await sleep(2500)
  const e = { id: ibId(), created: now(), sha256: crypto.randomBytes(32).toString('hex'), archive_bytes: 384 * 1024 * 1024, ...ibDescription(), scheduled: false, copy: null }
  ibState().exports.unshift(e)
  if (ibState().copyFolder) ibCopyExport(e)
  bus('backup')
  return { ...e, copy: ibState().copyFolder ? e.copy : null }
})
R('GET', '/api/backup/instance/exports', () => ibState().exports.map(({ id, created, archive_bytes, sha256, version, files, bytes, scheduled, copy }) => ({ id, created, archive_bytes, sha256, version, files, bytes, scheduled: !!scheduled, copy: copy || null })))
R('DELETE', '/api/backup/instance/exports/:id', ({ params }) => {
  ibHeld()
  const st = ibState()
  if (!/^[a-f0-9]{32}$/.test(params.id) || !st.exports.some((e) => e.id === params.id)) fail(404, 'not_found', 'Backup not found.')
  st.exports = st.exports.filter((e) => e.id !== params.id)
  return { ok: true, id: params.id }
})
R('POST', '/api/backup/instance/exports/:id/copy', ({ params }) => {
  ibHeld()
  if (!ibState().copyFolder) fail(409, 'copy_off', 'No copy folder is set.')
  const e = /^[a-f0-9]{32}$/.test(params.id) && ibState().exports.find((x) => x.id === params.id)
  if (!e) fail(404, 'not_found', 'Backup not found.')
  return ibCopyExport(e)
})
// The passphrase is never kept, by the server or here: only whether a key derived from it is stored.
R('PUT', '/api/backup/instance/schedule', ({ body }) => {
  ibHeld()
  const { frequency, hour, keep, passphrase, store_key } = body
  if (passphrase != null && (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024)) fail(422, 'invalid', 'passphrase: 12 to 1024 characters')
  if (!(frequency in IB_PERIOD) || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(keep) || keep < 1 || keep > 30)
    fail(400, 'schedule', 'Choose daily or weekly, an hour from 0 to 23 and 1 to 30 archives to keep.')
  const st = ibState()
  if (passphrase) {
    if (store_key !== true) fail(400, 'consent_required', 'Agree to keep a key derived from the passphrase on this server.')
    st.keyStored = true
  } else if (!st.schedule) fail(400, 'passphrase_required', 'Enter the backup passphrase to enable scheduled archives.')
  st.schedule = { frequency, hour, keep, since: st.schedule ? st.schedule.since : now() }
  return ibSchedule()
})
R('DELETE', '/api/backup/instance/schedule', () => {
  ibHeld()
  Object.assign(ibState(), { schedule: null, keyStored: false })
  return ibSchedule()
})
// The folder is checked like the server's: absolute, existing, writable, outside the archived data. Nothing exists here:
// a path with a "missing" folder does not exist, one with "readonly" cannot be written.
R('PUT', '/api/backup/instance/copy', ({ body }) => {
  ibHeld()
  if (typeof body.folder !== 'string' || body.folder.length > 4096) fail(422, 'invalid', 'folder: a string of 4096 characters at most')
  const raw = body.folder.trim(), bad = (message) => fail(400, 'copy_folder', message)
  if (!raw || raw.includes('\0')) bad('Choose a folder for the copies.')
  const folder = (raw === '~' || raw.startsWith('~/') ? '/root' + raw.slice(1) : raw).replace(/\/+/g, '/').replace(/(.)\/$/, '$1')
  if (!folder.startsWith('/')) bad('Use the full path of the folder (it starts with /).')
  if (folder.split('/').includes('missing')) bad('This folder does not exist. Connect the drive or create the folder first.')
  const sources = ['/var/lib/claude-maxxing', ...Object.values(ibRoots()).filter((r) => r.archive).map((r) => r.source)]
  if (sources.some((src) => folder === src || folder.startsWith(src.replace(/\/$/, '') + '/') || src === '/'))
    bad('Choose a folder outside the data the archive contains, ideally on another drive or in a synced folder.')
  if (folder.split('/').includes('readonly')) bad('The application cannot write in this folder.')
  ibState().copyFolder = folder
  return ibCopy()
})
R('DELETE', '/api/backup/instance/copy', () => {
  ibHeld()
  ibState().copyFolder = ''
  return ibCopy()
})
R('GET', '/api/backup/instance/download/:id', ({ params, res }) => {
  if (!/^[a-f0-9]{32}$/.test(params.id) || !ibState().exports.some((e) => e.id === params.id)) fail(404, 'not_found', 'Backup not found.')
  // A short stand-in for the real file: the format-2 header (magic, version, scrypt 2^15/8/1, salt, nonce) and random bytes.
  const header = Buffer.concat([Buffer.from('PILOTBK\n'), Buffer.from([2, 1, 15, 0, 8, 0, 1]), crypto.randomBytes(28)])
  const data = Buffer.concat([header, crypto.randomBytes(4096)])
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="pilot-${params.id.slice(0, 12)}.pilotbackup"` })
  res.end(data)
  return RAW
})
R('POST', '/api/backup/instance/preview', async ({ req, rawBody }) => {
  ibHeld()
  const [file] = parseMultipart(rawBody, req.headers['content-type'] || '')
  const m = rawBody.toString('latin1').match(/name="passphrase"\r\n\r\n([^\r]*)\r\n/)
  if (!file) fail(422, 'invalid', 'file is required')
  ibPassphrase(m ? Buffer.from(m[1], 'latin1').toString('utf8') : null)
  if (!file.data.subarray(0, 8).equals(Buffer.from('PILOTBK\n'))) fail(400, 'format', 'This is not a supported encrypted instance backup.')
  await sleep(1500)
  if (/wrong/i.test(m[1])) fail(400, 'decrypt_failed', 'The passphrase is incorrect or the backup has been modified.') // try it with a passphrase containing "wrong"
  const p = { id: ibId(), sha256: crypto.randomBytes(32).toString('hex'), created: now() - 2 * DAY, ...ibDescription() }
  ibState().previews[p.id] = { at: now(), ...p }
  return p
})
R('POST', '/api/backup/instance/restore', async ({ body }) => {
  ibHeld()
  const p = ibState().previews[body.id]
  if (!/^[a-f0-9]{32}$/.test(body.id || '') || !/^[a-f0-9]{64}$/.test(body.sha256 || '')) fail(400, 'preview_required', 'Inspect the archive before restoring it.')
  if (!p || p.sha256 !== body.sha256 || now() - p.at > HOUR) fail(409, 'changed', 'The archive changed or its preview expired. Inspect it again.')
  await sleep(2000)
  delete S.instanceBackup.previews[body.id]
  const destination = `/var/lib/pilot-restored-${crypto.randomBytes(6).toString('hex')}`, { at, ...preview } = p
  return { destination, state: `${destination}/state`, background_services_paused: true, integrations_paused: true, ...preview,
    launch_command: `MAXXING_STATE=${destination}/state MAXXING_CRONTAB_FILE=${destination}/crontab uv run --directory /opt/harness-pilot/server python -m uvicorn maxxing.app:create_app --factory --host 127.0.0.1 --port 8790` }
})
// A restored copy starts held (read-only) and with its integrations paused: the scenario has none, these only answer.
R('POST', '/api/backup/instance/activate', () => {
  const st = ibState()
  if (!st.restore_hold) return { ok: true, already_active: true }
  st.restore_hold = false; bus('backup', 'health')
  return { ok: true }
})
R('POST', '/api/backup/instance/resume-integrations', () => {
  const st = ibState()
  if (st.restore_hold) fail(409, 'restore_hold', 'Enable this instance’s services before resuming its integrations.')
  st.integrations_paused = false; bus('crons', 'backup', 'telegram')
  return { ok: true, scheduled_jobs: S.crons.filter((c) => c.enabled !== false).length, telegram: !!S.telegram.chat }
})

/* ---- Git page (server/maxxing/gitview.py): clones under the files root and the repositories of the GitHub tokens.
   Histories are generated from a seed per repository (stable across reads): a main line, a merged feature branch,
   a branch still open, a tag. */
const GIT_LOCAL = [
  { path: `${ROOT}/projects/acme/topics/website/app`, name: 'app', branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, changed: 3, untracked: 1, remote: 'git@github.com:acme/website.git', github: 'acme/website', error: null, worktrees: 1 },
  { path: `${ROOT}/projects/ops/topics/server/scripts`, name: 'scripts', branch: 'main', upstream: null, ahead: 0, behind: 0, changed: 0, untracked: 0, remote: null, github: null, error: null, worktrees: 0 },
]
const GIT_HUB = [
  ['acme/website', 'Marketing site and shop front', 'TypeScript', false, 'admin', 12, 4],
  ['acme/platform', 'Back office and APIs', 'Python', true, 'push', 3, 9],
  ['acme/blog', 'Articles and newsletter archive', 'MDX', false, 'maintain', 41, 1],
]
const GIT_SUBJECTS = ['Fix the hero image on small screens', 'Add the pricing page', 'Bump dependencies', 'Write the FAQ', 'Speed up the build', 'Refactor the checkout steps',
  'Add tests for the cart', 'Update the footer links', 'Translate the about page', 'Clean up unused styles', 'Log failed payments', 'Tidy the README']
function gitHistory(id) {
  const r = rng([...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)), t = now()
  const hex = () => Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('')
  const who = () => ['Alex Martin', 'Sam Lee', 'Codex'][Math.floor(r() * 3)]
  const main = [], out = []
  for (let i = 0; i < 40; i++) main.push({ sha: hex(), parents: [], refs: [], author: who(), date: t - (40 - i) * 9 * HOUR - Math.floor(r() * HOUR), subject: GIT_SUBJECTS[Math.floor(r() * GIT_SUBJECTS.length)] })
  for (let i = 1; i < main.length; i++) main[i].parents = [main[i - 1].sha]
  const feat = [] // merged into main at 30, branched at 24
  for (let i = 0; i < 4; i++) feat.push({ sha: hex(), parents: [i ? feat[i - 1].sha : main[24].sha], refs: [], author: 'Codex', date: main[24].date + (i + 1) * 2 * HOUR, subject: ['Checkout: one page', 'Checkout: keep Apple Pay on top', 'Checkout: tests', 'Checkout: review fixes'][i] })
  main[30].parents.push(feat[3].sha); main[30].subject = 'Merge branch feat/one-page-checkout'
  const open = [{ sha: hex(), parents: [main[37].sha], refs: [{ name: 'feat/dark-mode', kind: 'branch' }], author: 'Sam Lee', date: main[37].date + HOUR, subject: 'Dark mode: first pass' }]
  main[39].refs = [{ name: 'HEAD', kind: 'head' }, { name: 'main', kind: 'branch', current: true }, { name: 'origin/main', kind: 'remote' }]
  main[20].refs = [{ name: 'v1.2.0', kind: 'tag' }]
  out.push(...main, ...feat, ...open)
  return out.sort((a, b) => b.date - a.date)
}
function gitRepo(id) {
  if (id.startsWith('github:')) {
    const g = GIT_HUB.find(([full]) => `github:${full}` === id) || fail(404, 'not_found', 'Repository not found')
    return { kind: 'github', id, name: g[0].split('/')[1], branch: 'main', github: g[0], url: `https://github.com/${g[0]}`, private: g[3], permission: g[4], description: g[1], branches: 13, branches_shown: 13 }
  }
  const l = GIT_LOCAL.find((x) => x.path === id) || fail(404, 'not_found', 'Not a repository')
  return { kind: 'local', id, ...l }
}
R('GET', '/api/git/repos', () => ({ root: S.settings.files_root || ROOT,
  local: GIT_LOCAL.map((l) => { const h = gitHistory(l.path)[0]; return { ...l, last_commit: h.date, last_subject: h.subject } }),
  github: { connected: true, login: 'acme-dev', error: null, errors: [], accounts: [{ login: 'acme-dev', name: 'Acme', avatar: null, keys: ['GITHUB_TOKEN'], repos: GIT_HUB.length }],
    repos: GIT_HUB.map(([full, description, language, priv, permission, stars, issues]) => ({ full_name: full, owner: full.split('/')[0], name: full.split('/')[1], description, private: priv, fork: false,
      archived: false, permission, default_branch: 'main', pushed_at: new Date((now() - stars * HOUR) * 1000).toISOString(), url: `https://github.com/${full}`, language, stars, open_issues: issues,
      keys: ['GITHUB_TOKEN'], accounts: ['acme-dev'], local_paths: GIT_LOCAL.filter((l) => l.github === full).map((l) => l.path) })) } }))
R('GET', '/api/git/graph', ({ q }) => {
  const repo = gitRepo(q.get('repo') || ''), limit = Math.min(1000, Math.max(1, Number(q.get('limit')) || 200))
  const all = gitHistory(repo.id)
  return { repo, commits: all.slice(0, limit), truncated: all.length > limit }
})
R('GET', '/api/git/commit', ({ q }) => {
  const repo = gitRepo(q.get('repo') || ''), c = gitHistory(repo.id).find((x) => x.sha === q.get('sha')) || fail(404, 'no_commit', 'No such commit')
  const r = rng(parseInt(c.sha.slice(0, 8), 16)), pool = ['src/pages/checkout.tsx', 'src/styles/hero.css', 'README.md', 'tests/cart.test.ts', 'package.json', 'src/i18n/en.ts', 'src/components/Footer.tsx']
  const files = pool.filter(() => r() < 0.45).map((p) => ({ path: p, additions: Math.floor(r() * 60) + 1, deletions: Math.floor(r() * 25) }))
  if (!files.length) files.push({ path: pool[0], additions: 4, deletions: 1 })
  return { sha: c.sha, parents: c.parents, author: c.author, email: `${c.author.split(' ')[0].toLowerCase()}@example.com`, date: c.date,
    message: `${c.subject}\n\nKeeps the change small; tested on a phone and a desktop browser.`, files, files_total: files.length, ...(repo.github ? { url: `https://github.com/${repo.github}/commit/${c.sha}` } : {}) }
})
R('GET', '/api/git/pulls', ({ q }) => {
  const id = q.get('repo') || ''
  if (!id.startsWith('github:')) fail(400, 'not_github', 'Pull requests come from GitHub repositories')
  const repo = gitRepo(id)
  return [[18, 'Dark mode: first pass', 'sam-lee', 'feat/dark-mode', false], [17, 'Translate the about page', 'acme-dev', 'i18n/about', true]].map(([number, title, author, head, draft], i) => ({
    number, title, author, head, base: 'main', draft, url: `https://github.com/${repo.github}/pull/${number}`, updated: now() - (i + 1) * 5 * HOUR }))
})

/* ---- browser of my PC (server/maxxing/pcbridge.py, api/pc.py): one paired PC runs the Harness PC agent; Claude
   drives its browser through the MCP `harness-pc`. The mock has no WebSocket: after a pairing code is created, a PC
   "runs the installer" 5 s later and waits as the candidate; downloads are short placeholders. */
const PC_TARGETS = ['windows-amd64', 'windows-arm64', 'darwin-arm64', 'darwin-amd64', 'linux-amd64', 'linux-arm64']
const PC_BROWSERS = ['brave', 'chrome', 'edge', 'vivaldi', 'opera', 'chromium']
function pcState() {
  if (S.pc) return S.pc
  const t = now(), ready = S.scenario === 'ready' || S.scenario === 'maxxing'
  S.pc = { device: ready ? { id: 'pc_4f2a9c', name: 'Alex-Laptop', os: 'windows', arch: 'amd64', version: '1.4.0', browsers: ['chrome', 'edge'], browser: 'chrome', created: t - 12 * DAY, last_seen: t - 30 } : null,
    online: ready, browser_running: false, mcp_running: false, last_use: ready ? t - 3 * HOUR : null, pairing: null, candidate: null, mcp_registered: ready, settings: { idle_min: 30 },
    actions: ready ? [{ at: t - 3 * HOUR, tool: 'navigate_page', args: { url: 'https://shop.example.com/checkout' }, ok: true, ms: 1840 }, { at: t - 3 * HOUR + 4, tool: 'take_screenshot', args: {}, ok: true, ms: 420 }] : [] }
  return S.pc
}
const pcOut = () => { const p = pcState(); return { available: true, device: p.device, online: !!p.device && p.online, browser_running: p.browser_running, mcp_running: p.mcp_running, last_use: p.last_use,
  mcp_registered: p.mcp_registered, pairing: p.pairing && p.pairing.expires_at > now() ? { expires_at: p.pairing.expires_at, browser: p.pairing.browser, os: p.pairing.os } : null,
  candidate: p.candidate, settings: { ...p.settings }, browsers: PC_BROWSERS, targets: PC_TARGETS, actions: [...p.actions].reverse().slice(0, 20) } }
const pcCode = (code) => { const p = pcState().pairing; if (!p || p.code !== code) fail(403, 'bad_code', 'Unknown code'); if (p.expires_at < now()) fail(403, 'expired', 'This code expired'); return p }
R('GET', '/api/pc', () => pcOut())
R('POST', '/api/pc/pairing', ({ body }) => {
  if (!PC_BROWSERS.includes(body.browser) || !['windows', 'darwin', 'linux'].includes(body.os)) fail(422, 'invalid', 'browser and os')
  const p = pcState(), code = crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})(.{5})/, '$1-$2'), base = 'https://ui.example.com'
  p.pairing = { code, browser: body.browser, os: body.os, autostart: body.autostart !== false, expires_at: now() + 15 * MIN }
  const g = GEN
  setTimeout(() => { if (g === GEN && p.pairing?.code === code) { p.candidate = { id: 'pc_' + crypto.randomBytes(3).toString('hex'), name: body.os === 'darwin' ? 'Alex-MacBook' : 'Alex-Desktop', os: body.os, arch: body.os === 'darwin' ? 'arm64' : 'amd64', version: '1.4.0', created: now(), ip: '192.0.2.24' }; bus('pc') } }, 5000).unref()
  return { code, expires_at: p.pairing.expires_at, expires_in: 900, server: base,
    downloads: Object.fromEntries(PC_TARGETS.map((tg) => [tg, `${base}/api/pc/download/${tg}?code=${code}`])),
    commands: { windows: `irm "${base}/api/pc/install.ps1?code=${code}&target=windows-amd64" | iex`, darwin: `curl -fsSL "${base}/api/pc/install.sh?code=${code}&target=darwin-arm64" | sh`, linux: `curl -fsSL "${base}/api/pc/install.sh?code=${code}&target=linux-amd64" | sh` } }
})
R('POST', '/api/pc/confirm', ({ body }) => {
  const p = pcState(), c = p.candidate
  if (!c || c.id !== body.id || now() - c.created > 15 * MIN) return { ok: false }
  if (body.ok !== false) Object.assign(p, { device: { id: c.id, name: c.name, os: c.os, arch: c.arch, version: c.version, browsers: [p.pairing?.browser || 'chrome'], browser: p.pairing?.browser || 'chrome', created: now(), last_seen: now() }, online: true, mcp_registered: true, pairing: null })
  p.candidate = null; bus('pc')
  return { ok: true }
})
R('PUT', '/api/pc/settings', ({ body }) => {
  const m = Number(body.idle_min)
  if (!Number.isInteger(m) || m < 1 || m > 240) fail(422, 'invalid', 'idle_min: 1-240')
  pcState().settings.idle_min = m
  return { idle_min: m }
})
R('POST', '/api/pc/stop', () => { Object.assign(pcState(), { browser_running: false, mcp_running: false }); bus('pc'); return { ok: true } })
R('POST', '/api/pc/wipe', async () => { const p = pcState(); if (!p.device || !p.online) fail(409, 'offline', 'The PC is offline'); await sleep(800); p.browser_running = false; return { ok: true } })
R('POST', '/api/pc/test', async () => {
  const p = pcState()
  if (!p.device || !p.online) fail(409, 'offline', 'The PC is offline')
  await sleep(1200)
  Object.assign(p, { browser_running: true, mcp_running: true, last_use: now() })
  p.actions.push({ at: now(), tool: 'list_pages', args: {}, ok: true, ms: 1200 })
  bus('pc')
  return { ok: true, text: '1: about:blank [selected]' }
})
R('POST', '/api/pc/mcp/register', () => { const p = pcState(); if (!p.device) fail(409, 'not_paired', 'No PC is paired'); p.mcp_registered = true; return { ok: true } })
R('DELETE', '/api/pc', () => { Object.assign(pcState(), { device: null, online: false, browser_running: false, mcp_running: false, mcp_registered: false }); bus('pc'); return { ok: true } })
// Called by the agent on the PC (public: the code is the permission)
R('POST', '/api/pc/pair', ({ body }) => {
  pcCode(body.code)
  const p = pcState()
  p.candidate = { id: 'pc_' + crypto.randomBytes(3).toString('hex'), name: String(body.name || 'PC').slice(0, 64), os: String(body.os || ''), arch: String(body.arch || ''), version: String(body.version || ''), created: now(), ip: '192.0.2.24' }
  bus('pc')
  return { device_id: p.candidate.id, token: crypto.randomBytes(24).toString('base64url') }
}, { public: true, csrf: false })
R('GET', '/api/pc/download/:target', ({ params, q, res }) => {
  pcCode(q.get('code'))
  if (!PC_TARGETS.includes(params.target)) fail(404, 'not_found', 'Unknown target')
  const body = Buffer.from(`Harness PC agent ${params.target} (mock placeholder, not a program)\n`)
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, 'Content-Disposition': `attachment; filename="harness-pc${params.target.startsWith('windows') ? '.exe' : ''}"` })
  res.end(body)
  return RAW
}, { public: true })
R('GET', '/api/pc/install.:ext', ({ params, q, res }) => {
  if (!['ps1', 'sh'].includes(params.ext)) fail(404, 'not_found', 'Unknown script')
  const code = q.get('code') || '', target = q.get('target') || (params.ext === 'ps1' ? 'windows-amd64' : 'linux-amd64')
  const url = `https://ui.example.com/api/pc/download/${target}?code=${code}`
  const body = params.ext === 'ps1' ? `# Harness PC (mock): downloads the agent and starts it\n$f = "$env:LOCALAPPDATA\\HarnessPC\\harness-pc.exe"\nInvoke-WebRequest "${url}" -OutFile $f\nStart-Process $f\n`
    : `#!/bin/sh\n# Harness PC (mock): downloads the agent and starts it\nset -e\nmkdir -p "$HOME/.local/bin"\ncurl -fsSL "${url}" -o "$HOME/.local/bin/harness-pc"\nchmod +x "$HOME/.local/bin/harness-pc"\n"$HOME/.local/bin/harness-pc" &\n`
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
  return RAW
}, { public: true })

/* ---- settings & secrets */
R('GET', '/api/settings', () => S.settings)
R('PUT', '/api/settings', ({ body }) => {
  if (body.language !== undefined && !['en', 'fr'].includes(body.language)) fail(422, 'invalid', 'language must be en or fr')
  if (body.public_url !== undefined && body.public_url && !/^https?:\/\//.test(body.public_url)) fail(422, 'invalid', 'public_url must start with http(s)://')
  for (const k of ['timezone', 'language', 'public_url', 'files_root', 'presentation_default', 'usage_widget', 'memory_max_lines', 'donation_hidden']) if (body[k] !== undefined) S.settings[k] = body[k]
  return S.settings
})
/* ---- profile (api/settings.py): the pseudo shown on the user's messages and in notifications. The legacy hello /
   feedback / license routes talk to the original project's cloud: like the server by default (no MAXXING_LICENSE_PING),
   they answer 404 not_found after sign-in, whatever the method. */
const PROFILE_COLORS = ['clay', 'blue', 'violet', 'green', 'amber', 'rose', 'teal', 'zinc']
const profileState = () => (S.profile ||= S.scenario === 'ready' || S.scenario === 'maxxing' ? { name: 'Alex', color: 'blue', emoji: '' } : { name: '', color: '', emoji: '' })
R('GET', '/api/settings/profile', () => ({ ...profileState() }))
R('PUT', '/api/settings/profile', ({ body }) => {
  const name = String(body.name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').split(/\s+/).filter(Boolean).join(' ').slice(0, 32)
  const color = String(body.color || ''), emoji = String(body.emoji || '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (color && !PROFILE_COLORS.includes(color)) fail(400, 'invalid_color', `color: ${PROFILE_COLORS.join(', ')} or empty`)
  if ([...emoji].length > 8 || /\s/.test(emoji)) fail(400, 'invalid_emoji', 'emoji: one emoji or initials (8 characters at most) or empty')
  const next = { name, color, emoji }
  if (JSON.stringify(next) !== JSON.stringify(profileState())) { S.profile = next; bus('profile') }
  return { ...S.profile }
})
for (const what of ['register', 'feedback', 'license']) for (const method of ['GET', 'PUT', 'POST', 'DELETE'])
  R(method, `/api/settings/${what}`, () => fail(404, 'not_found', 'Not available in this project'))

// The look last chosen (theme + palette, `rev` grows with each palette change; real validation: server/maxxing/themes.py).
R('PUT', '/api/settings/look', ({ body }) => {
  if (!['dark', 'light', 'system'].includes(body.theme)) fail(422, 'invalid', 'theme')
  const old = S.look || { accent: 'blue', tint: 'neutral', palette: null, rev: 0 }
  const next = { ...old, theme: body.theme }
  if (body.palette) {
    if (typeof body.palette !== 'object' || JSON.stringify(body.palette).length > 16384) fail(422, 'invalid_theme', 'a theme is an object of 16 KB at most')
    next.palette = body.palette
    next.accent = body.accent || 'blue'
    next.tint = body.palette.tint === 'tinted' ? 'tinted' : 'neutral'
  }
  const changed = JSON.stringify(next.palette) !== JSON.stringify(old.palette)
  if (changed) next.rev = old.rev + 1
  S.look = next
  if (changed) bus('look')
  return { ok: true, look: S.look }
})
/* ---- Team (a minimal mock: one contact, direct chats, text and theme messages) */
const teamChatOut = (c) => {
  const msgs = c.messages
  const last = msgs[msgs.length - 1]
  return { ...Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'messages')),
    last: last ? { author: last.author, at: last.at, kind: last.kind, text: last.text, files: 0 } : null,
    unread: msgs.filter((m) => m.author !== 'me' && m.at > (c.read_at || 0)).length, updated: last ? last.at : c.created }
}
const teamChat = (id) => S.team.chats.find((c) => c.id === id) || fail(404, 'not_found', 'Chat not found')
R('GET', '/api/team', () => ({ me: 'me', people: { ...Object.fromEntries(Object.entries(S.team.people).filter(([, p]) => !p.request)), me: { name: 'Me', emoji: '', color: 'blue', server: '', status: 'online' } },
  chats: S.team.chats.map(teamChatOut).sort((a, b) => b.updated - a.updated), reactions: ['👍', '❤️', '😂', '🎉', '🤔', '👀'], typing: {} }))
R('GET', '/api/team/connections', () => ({ ok: true, address: 'https://ui.example.com', reason: '', insecure: false, open_invites: 0,
  contacts: Object.entries(S.team.people).map(([id, p]) => ({ address: p.address, id, name: p.name, emoji: p.emoji, color: p.color, status: p.request ? 'request' : p.waiting ? 'waiting' : 'accepted', fingerprint: p.fingerprint || '7F3A-91C2', since: p.since || now() - 9 * DAY, last_seen: p.last_seen })) }))
R('GET', '/api/team/chats/:id', ({ params }) => { const c = teamChat(params.id); return { chat: teamChatOut(c), messages: c.messages } })
R('POST', '/api/team/chats', ({ body }) => {
  const who = (body.members || []).filter((m) => S.team.people[m] && S.team.people[m].contact)
  if (!who.length) fail(400, 'no_members', 'Choose at least one contact')
  if (body.kind === 'group') {
    const g = { id: 'g_' + crypto.randomBytes(8).toString('hex'), kind: 'group', name: String(body.name || '').trim().slice(0, 60) || who.map((m) => S.team.people[m].name).join(', '), emoji: String(body.emoji || ''),
      members: who, created: now(), read_at: now(), remote: false, admin: 'me', messages: [] }
    S.team.chats.push(g); bus('team')
    return teamChatOut(g)
  }
  let c = S.team.chats.find((x) => x.kind === 'dm' && x.members[0] === who[0])
  if (!c) { c = { id: 'd_' + crypto.randomBytes(8).toString('hex'), kind: 'dm', name: '', emoji: '', members: [who[0]], created: now(), read_at: now(), remote: true, admin: null, messages: [] }; S.team.chats.push(c); bus('team') }
  return teamChatOut(c)
})
for (const what of ['read', 'typing']) R('POST', `/api/team/chats/:id/${what}`, ({ params }) => { const c = teamChat(params.id); if (what === 'read') c.read_at = now(); return { ok: true } })
R('POST', '/api/team/presence', () => ({ ok: true }))
R('POST', '/api/team/chats/:id/messages', ({ params, body }) => {
  const c = teamChat(params.id)
  if (c.left) fail(409, 'left', 'You left this group')
  const text = String(body.text || '').trim().slice(0, 8000)
  const files = (Array.isArray(body.files) ? body.files : []).map((f) => S.fs.get(f.path) && { path: f.path, name: path.basename(f.path), size: S.fs.get(f.path).size, mime: S.fs.get(f.path).mime }).filter(Boolean)
  if (!text && !files.length) fail(400, 'empty', 'Empty message')
  const m = { id: 'm_' + crypto.randomBytes(4).toString('hex'), author: 'me', at: now(), text, kind: 'text', ...(body.reply_to ? { reply_to: body.reply_to } : {}), ...(files.length ? { files } : {}) }
  c.messages.push(m); c.read_at = m.at; bus('team')
  return m
})
R('POST', '/api/team/chats/:id/themes', ({ params, body }) => {
  const c = teamChat(params.id)
  if (!themeOk(body.theme)) fail(422, 'invalid_theme', 'tokens: colours only, 16 KB at most')
  const m = { id: 'm_' + crypto.randomBytes(4).toString('hex'), author: 'me', at: now(), text: String(body.theme.name || '').slice(0, 60), kind: 'theme', theme: body.theme }
  c.messages.push(m); c.read_at = m.at; bus('team')
  return m
})

// Groups, edits, reactions, polls, summaries, forwarding to a session, files, connections (team.py, teampeer.py).
const teamMsg = (c, mid) => c.messages.find((m) => m.id === mid) || fail(404, 'not_found', 'Message not found')
const teamMine = (m) => { if (m.author !== 'me') fail(403, 'not_yours', 'Only your own messages'); if (m.deleted) fail(409, 'deleted', 'This message was deleted'); return m }
const teamPost = (c, m) => { c.messages.push(m); c.read_at = m.at; bus('team'); return m }
R('POST', '/api/team/chats/:id/group', ({ params, body }) => {
  const c = teamChat(params.id)
  if (c.kind !== 'group') fail(400, 'not_a_group', 'Only a group can be changed')
  if (c.admin !== 'me') fail(403, 'not_admin', 'Only the creator of the group can change it')
  if (body.name !== undefined) c.name = String(body.name).trim().slice(0, 60) || c.name
  if (body.emoji !== undefined) c.emoji = String(body.emoji).slice(0, 8)
  for (const id of body.add || []) if (S.team.people[id]?.contact && !c.members.includes(id)) c.members.push(id)
  c.members = c.members.filter((id) => !(body.remove || []).includes(id))
  bus('team')
  return teamChatOut(c)
})
R('POST', '/api/team/chats/:id/leave', ({ params }) => {
  const c = teamChat(params.id)
  if (c.kind !== 'group') fail(400, 'not_a_group', 'Only a group can be left')
  c.left = 'self'; bus('team')
  return teamChatOut(c)
})
R('POST', '/api/team/chats/:id/mute', ({ params, body }) => { const c = teamChat(params.id); c.muted = !!body.muted; bus('team'); return teamChatOut(c) })
R('POST', '/api/team/chats/:id/messages/:mid/edit', ({ params, body }) => {
  const m = teamMine(teamMsg(teamChat(params.id), params.mid))
  if (m.kind !== 'text') fail(400, 'not_editable', 'Only text messages can be edited')
  const text = String(body.text || '').trim().slice(0, 8000)
  if (!text) fail(400, 'empty', 'Empty message')
  Object.assign(m, { text, edited: now() }); bus('team')
  return m
})
R('POST', '/api/team/chats/:id/messages/:mid/delete', ({ params }) => {
  const m = teamMine(teamMsg(teamChat(params.id), params.mid))
  Object.assign(m, { text: '', deleted: now() }); delete m.files; delete m.theme; delete m.poll; bus('team')
  return m
})
R('POST', '/api/team/chats/:id/messages/:mid/react', ({ params, body }) => {
  const m = teamMsg(teamChat(params.id), params.mid), emoji = String(body.emoji || '')
  if (!emoji || [...emoji].length > 4) fail(400, 'bad_emoji', 'One emoji')
  const who = ((m.reactions ||= {})[emoji] ||= [])
  if (who.includes('me')) who.splice(who.indexOf('me'), 1); else who.push('me')
  if (!who.length) delete m.reactions[emoji]
  bus('team')
  return m
})
R('POST', '/api/team/chats/:id/polls', ({ params, body }) => {
  const c = teamChat(params.id), question = String(body.question || '').trim(), options = (body.options || []).map((o) => String(o).trim()).filter(Boolean)
  if (!question || options.length < 2 || options.length > 12) fail(400, 'bad_poll', 'A question and 2 to 12 options')
  return teamPost(c, { id: 'm_' + crypto.randomBytes(4).toString('hex'), author: 'me', at: now(), text: question, kind: 'poll',
    poll: { question, multi: !!body.multi, options: options.map((label, i) => ({ id: `o${i + 1}`, label: label.slice(0, 200), votes: [] })) } })
})
R('POST', '/api/team/chats/:id/messages/:mid/vote', ({ params, body }) => {
  const m = teamMsg(teamChat(params.id), params.mid)
  if (m.kind !== 'poll') fail(400, 'not_a_poll', 'This message is not a poll')
  const opt = m.poll.options.find((o) => o.id === body.option) || fail(400, 'bad_option', 'Unknown option')
  const had = opt.votes.includes('me')
  if (!m.poll.multi) for (const o of m.poll.options) o.votes = o.votes.filter((v) => v !== 'me')
  if (had) opt.votes = opt.votes.filter((v) => v !== 'me'); else opt.votes.push('me')
  bus('team')
  return m
})
R('POST', '/api/team/chats/:id/summarize', async ({ params, body }) => {
  const c = teamChat(params.id), lastSummary = c.messages.filter((m) => m.kind === 'summary').at(-1)
  const picked = c.messages.filter((m) => !m.deleted && m.kind !== 'summary' && (body.ids ? body.ids.includes(m.id) : m.at > (body.since ?? lastSummary?.at ?? 0)))
  if (!picked.length) fail(400, 'nothing_to_summarize', 'No message to summarize')
  await sleep(1500)
  const names = [...new Set(picked.map((m) => (m.author === 'me' ? 'You' : S.team.people[m.author]?.name || 'Someone')))]
  return teamPost(c, { id: 'm_' + crypto.randomBytes(4).toString('hex'), author: 'me', at: now(), kind: 'summary',
    text: `**Summary of ${picked.length} message${picked.length > 1 ? 's' : ''}** (${names.join(', ')})\n\n- ${picked.slice(-4).map((m) => (m.kind === 'theme' ? `[colour theme] ${m.text}` : m.text.split('\n')[0].slice(0, 120))).join('\n- ')}` })
})
R('POST', '/api/team/chats/:id/messages/:mid/forward', ({ params, body }) => {
  const c = teamChat(params.id), m = teamMsg(c, params.mid), text = String(body.text || '').trim()
  if (!text) fail(400, 'empty', 'Empty message')
  let s
  if (body.session) s = findSession(body.session)
  else {
    if (!S.projects.some((p) => p.topics.some((tp) => topicPath(p.name, tp.name) === body.path))) fail(400, 'bad_path', 'Choose a topic')
    const t = now()
    s = { id: uuid(), title: String(body.title || text).slice(0, 60), path: body.path, state: 'idle', queue: 0, created: t, updated: t, turns: 0, cost_usd: 0, model: '', real_model: null,
      context_tokens: null, context_window: null, archived: false, notify: false, source: 'web', unread: false, last_text: '', error: null }
    S.sessions.push(s); S.events[s.id] = []
  }
  const author = m.author === 'me' ? 'You' : S.team.people[m.author]?.name || 'Someone'
  startTurn(s, `${text}\n\n> ${author} wrote in Team:\n> ${m.text.split('\n').join('\n> ')}`, (m.files || []).map((f) => f.path))
  ;(m.sent ||= []).push({ session: s.id, title: s.title, at: now() })
  bus('team', 'sessions', 'workspace')
  return { session: s, message: m }
})
R('POST', '/api/team/files', ({ req, rawBody }) => {
  const files = parseMultipart(rawBody, req.headers['content-type'] || '')
  if (!files.length) fail(422, 'invalid', 'No file in the request')
  const d = new Date(), dir = `${ROOT}/team/attachments/${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  return { files: files.map((f) => { const p = uniquePath(`${dir}/${f.name}`); fsAdd(S, p, isText(f.mime) ? f.data.toString('utf8') : f.data, now(), f.mime); return { path: p, name: path.basename(p), size: f.data.length, mime: f.mime } }) }
})
R('POST', '/api/team/connections/invite', () => ({ invitation: `https://ui.example.com#${crypto.randomBytes(6).toString('base64url')}`, expires: now() + 15 * MIN }))
R('POST', '/api/team/connections/join', ({ body }) => {
  const m = /^(https:\/\/[a-z0-9.-]+(?::\d+)?)#[A-Za-z0-9_-]{6,}$/i.exec(String(body.invitation || '').trim())
  if (!m) fail(400, 'bad_invitation', 'Paste the whole invitation: https://<address>#<code>')
  const address = m[1].toLowerCase()
  if (Object.values(S.team.people).some((p) => p.address === address)) fail(409, 'exists', 'Already connected to this address')
  const id = 'p_' + crypto.createHash('sha1').update(address).digest('hex').slice(0, 8), fingerprint = crypto.randomBytes(4).toString('hex').toUpperCase().replace(/(....)(....)/, '$1-$2')
  S.team.people[id] = { name: address.replace(/^https:\/\//, '').split('.')[0], emoji: '', color: 'teal', server: address, status: 'offline', address, peer: true, contact: false, waiting: true, fingerprint, since: now(), last_seen: null }
  const g = GEN
  setTimeout(() => { if (g === GEN && S.team.people[id]?.waiting) { Object.assign(S.team.people[id], { waiting: false, contact: true, status: 'online', last_seen: now() }); bus('team') } }, 4000).unref() // the other side accepts
  bus('team')
  return { address, fingerprint }
})
R('POST', '/api/team/connections/answer', ({ body }) => {
  const [id, p] = Object.entries(S.team.people).find(([, x]) => x.address === body.address && x.request) || fail(404, 'not_found', 'No request from this address')
  if (body.accept) Object.assign(p, { request: false, contact: true, status: 'online', since: now(), last_seen: now() }); else delete S.team.people[id]
  bus('team')
  return { ok: true }
})
R('POST', '/api/team/connections/remove', ({ body }) => {
  const [id] = Object.entries(S.team.people).find(([, x]) => x.address === body.address) || fail(404, 'not_found', 'Unknown contact')
  delete S.team.people[id]
  S.team.chats = S.team.chats.filter((c) => !(c.kind === 'dm' && c.members[0] === id))
  for (const c of S.team.chats) c.members = c.members.filter((m) => m !== id)
  bus('team')
  return { ok: true }
})

// Saved themes ("My themes") and the theme a session wrote (real validation: server/maxxing/themes.py clean_theme).
const themeOk = (t) => t && typeof t === 'object' && !Array.isArray(t) && JSON.stringify(t).length <= 16384 && !/url\(|var\(|;|[{}]\s*[a-z-]+\s*:/i.test(JSON.stringify(t.tokens || {}))
const themeColours = (t) => JSON.stringify([t.base, t.accent, t.buttons, t.tint, t.tokens])
R('GET', '/api/settings/themes', () => ({ themes: S.myThemes, max: 50 }))
R('POST', '/api/settings/themes', ({ body }) => {
  if (!themeOk(body.theme)) fail(422, 'invalid_theme', 'tokens: colours only, 16 KB at most')
  const same = S.myThemes.find((e) => themeColours(e.theme) === themeColours(body.theme))
  if (same) return same
  if (S.myThemes.length >= 50) fail(409, 'too_many_themes', '50 saved themes at most: delete one first')
  const e = { id: 'th_' + crypto.randomBytes(5).toString('hex'), theme: { schema: 1, id: 'custom', name: '', base: 'zinc', accent: 'blue', buttons: 'accent', tint: 'neutral', tokens: { light: {}, dark: {} }, ...body.theme }, source: body.source || 'imported', from: String(body.from || '').slice(0, 60), saved: now() }
  S.myThemes.unshift(e)
  bus('themes')
  return e
})
R('PATCH', '/api/settings/themes/:id', ({ params, body }) => {
  const e = S.myThemes.find((x) => x.id === params.id) || fail(404, 'not_found', 'Theme not found')
  const name = String(body.name || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 60)
  if (!name) fail(422, 'invalid_theme', 'a name is needed')
  e.theme.name = name
  bus('themes')
  return e
})
R('DELETE', '/api/settings/themes/:id', ({ params }) => {
  if (!S.myThemes.some((x) => x.id === params.id)) fail(404, 'not_found', 'Theme not found')
  S.myThemes = S.myThemes.filter((x) => x.id !== params.id)
  bus('themes')
  return { ok: true }
})
R('GET', '/api/settings/themes/session/:id', ({ params, q }) => {
  const s = findSession(params.id)
  const since = Number(q.get('since')) || s.created - 2
  const dir = `${ROOT}/${s.path}`
  let best = null
  for (const [k, n] of S.fs) if (n.type === 'file' && k.endsWith('.theme.json') && (path.posix.dirname(k) === dir || path.posix.dirname(k) === `${dir}/themes`) && n.mtime >= since && (!best || n.mtime > best[1].mtime)) best = [k, n]
  if (!best) fail(404, 'no_theme', 'No theme file written by this session yet')
  let theme
  try { theme = JSON.parse(best[1].content) } catch { fail(422, 'invalid_theme', `${path.basename(best[0])}: not JSON`) }
  if (!themeOk(theme)) fail(422, 'invalid_theme', 'tokens: colours only')
  return { theme, file: path.basename(best[0]), at: best[1].mtime }
})
const secretOut = (s) => ({ name: s.name, note: s.note, expose: s.expose, updated: s.updated, preview: s.value.slice(0, 4) + '…' })
R('GET', '/api/secrets', () => S.secrets.map(secretOut))
R('PUT', '/api/secrets/:name', ({ params, body }) => {
  const name = decodeURIComponent(params.name)
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) fail(422, 'invalid', 'Name must be UPPER_SNAKE_CASE')
  let s = S.secrets.find((x) => x.name === name)
  if (!s) {
    if (!body.value) fail(422, 'invalid', 'value is required for a new secret')
    s = { name, note: '', expose: false, value: '', updated: now() }
    S.secrets.push(s)
  }
  if (body.value !== undefined) s.value = String(body.value)
  if (body.note !== undefined) s.note = String(body.note)
  if (body.expose !== undefined) s.expose = !!body.expose
  s.updated = now()
  return { ok: true }
})
R('GET', '/api/secrets/:name/reveal', ({ params }) => {
  const s = S.secrets.find((x) => x.name === params.name) || fail(404, 'not_found', 'Secret not found')
  return { value: s.value }
})
R('DELETE', '/api/secrets/:name', ({ params }) => {
  const s = S.secrets.find((x) => x.name === params.name) || fail(404, 'not_found', 'Secret not found')
  S.secrets = S.secrets.filter((x) => x !== s)
  return { ok: true }
})

/* ---- agent engines and resident companions (server/maxxing/companions.py: persistent roles, runs in a disposable
   copy of the source whose proposal the owner reviews, approves or rejects, then may publish as a draft PR) */
const AGENT_PROVIDERS = [
  { id: 'claude', name: 'Claude Code', builtin: true, capabilities: ['text', 'source-edit', 'plan', 'attachments'] },
  { id: 'codex', name: 'Codex', builtin: true, capabilities: ['text', 'source-edit', 'plan', 'attachments'] },
]
R('GET', '/api/agent-providers', () => AGENT_PROVIDERS)

const COMPANION_ROLES = [
  { id: 'observer', name: 'Platform observer', provider: 'codex', role: 'Inspect the platform, identify a small useful improvement, implement it in the isolated copy, run relevant tests and explain the change, evidence and limitations.' },
  { id: 'security', name: 'Security and dependencies', provider: 'codex', role: 'Inspect the platform for security weaknesses and outdated or vulnerable dependencies. Use available evidence, prepare a narrowly scoped fix or dependency update, and run relevant tests. Report when an advisory database, network access, or further review is needed.' },
  { id: 'architect', name: 'Application architect and router', provider: 'codex', role: 'Understand how the platform components and features connect. Use the source import map, documentation and code to identify relevant modules and guide other companions with precise file paths, dependencies and verification steps.' },
  { id: 'reverse-engineer', name: 'Reverse engineering investigator', provider: 'codex', role: 'Investigate source, application behavior and dependencies. Keep evidence and internal maps, distinguish observations from hypotheses, and guide tested improvements.' },
]
// What every mock run proposes (a real run's diff comes from git in its copy): a tracked change and one new file.
const COMPANION_PATCH = `diff --git a/server/maxxing/api/files.py b/server/maxxing/api/files.py
index 3f2a1c4..8b9d0e7 100644
--- a/server/maxxing/api/files.py
+++ b/server/maxxing/api/files.py
@@ -212,5 +212,7 @@ async def rename(body: RenameIn):
     src = _resolve(body.path)
+    if '/' in body.name or body.name in ('.', '..'):
+        raise HTTPException(400, {'error': 'bad_name', 'message': 'A name cannot contain a slash.'})
     dst = src.with_name(body.name)
     if dst.exists():
         raise HTTPException(409, {'error': 'exists', 'message': 'A file with this name already exists.'})
     src.rename(dst)
`
const COMPANION_NEW = [{ path: 'server/tests/test_rename_names.py', executable: false,
  content: "def test_a_name_with_a_slash_is_refused(client, mx):\n    r = client.post('/api/files/rename', json={'path': str(mx['files'] / 'a.txt'), 'name': 'x/y'})\n    assert r.status_code == 400 and r.json()['error'] == 'bad_name'\n" }]
const COMPANION_REPORT = 'Renaming a file to a name with a slash moved it into another folder. The rename route now refuses such names (`400 bad_name`), with a test.\n\n**Verified:** `uv run pytest tests/test_rename_names.py tests/test_files.py` (all passed).\n\n**Not verified:** the Files page message for this error.'
const companionFingerprint = () => {
  const h = crypto.createHash('sha256').update(COMPANION_PATCH)
  for (const f of COMPANION_NEW) h.update(`${f.path}\0${f.content}\0${f.executable ? 'x' : '-'}`)
  return h.digest('hex')
}
function companionsState() {
  if (S.companions) return S.companions
  S.companions = { roles: clone(COMPANION_ROLES), runs: {} } // runs: session id -> { base, decision, pull_request }
  if (S.scenario === 'ready' || S.scenario === 'maxxing') { // one finished run waiting for the owner's review
    const t = now(), path = topicPath('ops', 'server')
    const s = { id: uuid(), title: 'Platform observer — platform review', path, state: 'idle', queue: 0, created: t - 50 * MIN, updated: t - 38 * MIN,
      turns: 1, cost_usd: 0, model: '', real_model: 'gpt-5.5-codex', context_tokens: 41000, context_window: 400000, archived: false, notify: false,
      source: 'web', unread: true, last_text: COMPANION_REPORT.replace(/[*`#]/g, '').slice(0, 200), error: null, provider: 'codex',
      companion: { id: 'observer', name: 'Platform observer', decision: null } }
    S.sessions.push(s)
    S.events[s.id] = [
      { type: 'user', text: 'You are Platform observer, a resident companion. Additional mission: Find a useful, small improvement.', attachments: [], at: s.created, source: 'companion' },
      { type: 'init', model: 'gpt-5.5-codex', cwd: `${ROOT}/${path}`, at: s.created + 1 },
      { type: 'assistant', text: COMPANION_REPORT, at: s.updated },
      { type: 'result', ok: true, cost_usd: 0, duration_ms: 690000, model: 'gpt-5.5-codex', usage: { input: 38000, output: 2900, cache_read: 120000, cache_write: 0 }, at: s.updated },
    ]
    S.companions.runs[s.id] = { base: sha(), decision: null, pull_request: null }
  }
  return S.companions
}
// A run's turn: the agent edits its copy, runs the tests and reports (startTurn's generic answer would echo the role).
function companionTurn(s, text) {
  const model = s.provider === 'codex' ? 'gpt-5.5-codex' : S.claude.default_model, tu = `toolu_${crypto.randomBytes(6).toString('hex')}`
  s.state = 'running'; s.updated = now()
  addEvents(s, { type: 'user', text, attachments: [], at: now(), source: 'companion' }, { type: 'init', model, cwd: `${ROOT}/${s.path}`, at: now() })
  later(s, 1200, () => addEvents(s, { type: 'tool_use', id: tu, name: 'Bash', input: { command: 'uv run pytest tests/test_rename_names.py tests/test_files.py' }, summary: 'Bash: uv run pytest', at: now() }))
  later(s, 2600, () => addEvents(s, { type: 'tool_result', tool_use_id: tu, text: '38 passed in 4.21s', is_error: false, at: now() }))
  later(s, 3400, () => {
    Object.assign(s, { state: 'idle', turns: s.turns + 1, real_model: model, updated: now(), unread: true, last_text: COMPANION_REPORT.replace(/[*`#]/g, '').slice(0, 200) })
    addEvents(s, { type: 'assistant', text: COMPANION_REPORT, at: now() },
      { type: 'result', ok: true, cost_usd: 0, duration_ms: 3400, model, usage: { input: 38000, output: 2900, cache_read: 120000, cache_write: 0 }, at: now() })
    bus('companions', 'sessions', 'workspace')
  })
  bus('sessions', 'workspace')
}
const companionRun = (sid) => {
  const s = findSession(sid), run = companionsState().runs[sid]
  if (!run) fail(404, 'not_found', 'Companion run not found.')
  return { s, run }
}
const companionReview = (sid) => {
  const { s, run } = companionRun(sid)
  const done = s.state !== 'running' && s.turns > 0 // the copy is unchanged until the agent worked in it
  return { target: 'acme/platform', session: s, fingerprint: done ? companionFingerprint() : crypto.createHash('sha256').digest('hex'),
    patch: done ? COMPANION_PATCH : '', untracked: done ? clone(COMPANION_NEW) : [], has_changes: done, base: run.base,
    decision: run.decision, pull_request: run.pull_request }
}
function companionSave(body, ident) {
  const name = String(body.name || '').trim(), role = String(body.role || '').trim()
  if (!name || !role || name.length > 80 || role.length > 4000) fail(400, 'bad_role', 'A name and role are required.')
  const st = companionsState()
  const previous = ident ? st.roles.find((p) => p.id === ident) || fail(404, 'not_found', 'Companion not found.') : null
  if (!ident && st.roles.length >= 99 + COMPANION_ROLES.length) fail(400, 'limit', 'Maximum number of companions reached.')
  const provider = body.provider || previous?.provider || 'codex'
  if (!AGENT_PROVIDERS.some((p) => p.id === provider && p.capabilities.includes('source-edit'))) fail(400, 'bad_provider', 'Choose an available coding agent for this companion.')
  const item = { id: ident || uuid(), name, role, provider }
  if (previous) Object.assign(previous, item); else st.roles.push(item)
  bus('companions')
  return item
}
R('GET', '/api/companions', () => {
  const st = companionsState()
  return { companions: st.roles, runs: S.sessions.filter((s) => st.runs[s.id]).sort((a, b) => b.created - a.created).slice(0, 100) }
})
R('POST', '/api/companions', ({ body }) => companionSave(body, null))
R('PUT', '/api/companions/:id', ({ params, body }) => companionSave(body, params.id))
R('POST', '/api/companions/:id/runs', ({ params, body }) => {
  const p = companionsState().roles.find((x) => x.id === params.id) || fail(404, 'not_found', 'Companion not found.')
  if (!S.projects.some((pr) => pr.topics.some((tp) => topicPath(pr.name, tp.name) === body.path))) fail(400, 'bad_path', 'Choose an existing topic.')
  const mission = String(body.mission || '')
  if (mission.length > 6000) fail(400, 'bad_mission', 'Mission is too long.')
  const t = now()
  const s = { id: uuid(), title: `${p.name} — platform review`, path: body.path, state: 'idle', queue: 0, created: t, updated: t, turns: 0, cost_usd: 0,
    model: '', real_model: null, context_tokens: null, context_window: null, archived: false, notify: false, source: 'web', unread: false, last_text: '',
    error: null, provider: p.provider, companion: { id: p.id, name: p.name, decision: null } }
  S.sessions.push(s); S.events[s.id] = []
  S.companions.runs[s.id] = { base: sha(), decision: null, pull_request: null }
  companionTurn(s, `You are ${p.name}, a resident companion. Your persistent role:\n${p.role}\n\nAdditional mission: ${mission.trim() || 'Find a useful, small improvement.'}`)
  bus('companions', 'sessions', 'workspace')
  return s
})
R('GET', '/api/companions/runs/:sid/review', ({ params }) => companionReview(params.sid))
R('POST', '/api/companions/runs/:sid/decision', ({ params, body }) => {
  if (!['approved', 'rejected'].includes(body.decision)) fail(400, 'bad_decision', 'Invalid decision.')
  const { s, run } = companionRun(params.sid)
  if (s.state === 'running') fail(409, 'running', 'Wait until the experiment stops.')
  const review = companionReview(params.sid)
  if (!review.has_changes || review.fingerprint !== body.fingerprint) fail(409, 'changed', 'The proposal changed; review it again.')
  run.decision = { value: body.decision, fingerprint: body.fingerprint, at: now() }
  s.companion.decision = run.decision
  bus('companions', 'sessions')
  return companionReview(params.sid)
})
R('POST', '/api/companions/runs/:sid/pull-request', async ({ params, body }) => {
  const { run } = companionRun(params.sid)
  const title = String(body.title || '').trim()
  if (!title || title.length > 180 || String(body.body || '').length > 12000) fail(400, 'bad_request', 'Invalid pull request title or body.')
  if (run.decision?.value !== 'approved' || run.decision.fingerprint !== body.fingerprint || body.fingerprint !== companionFingerprint()) fail(409, 'not_approved', 'Approve the current finished proposal first.')
  await sleep(1200)
  run.pull_request ||= { url: `https://github.com/acme/platform/pull/${140 + Object.keys(S.companions.runs).length}`, fingerprint: body.fingerprint }
  bus('companions')
  return { url: run.pull_request.url, target: 'acme/platform' }
})

/* ---- Infra page (server/maxxing/infra): servers, sites, databases, buckets, workers and domains of this server, a
   registered one and Cloudflare / Hostinger. infra-resources.json is the output of the real builder (infra/build.py)
   on the fixture of server/tests/test_infra.py; the owner's annotations, servers and domains live in the mock state. */
const INFRA_RESOURCES = JSON.parse(fs.readFileSync(path.join(__dirname, 'infra-resources.json'), 'utf8'))
function infraState() {
  if (S.infra) return S.infra
  S.infra = { refreshing: false, generated_at: now() - 7 * MIN, registry: {}, domains: [], servers: [{ name: 'far', label: 'Far VPS', host: '198.51.100.9', user: 'root', port: 22, note: '' }] }
  return S.infra
}
function infraView() {
  const st = infraState(), t = now()
  const remote = new Set(INFRA_RESOURCES.filter((r) => r.kind === 'server' && r.location !== 'local').map((r) => r.location)) // registered servers of the fixture
  const resources = INFRA_RESOURCES.filter((r) => !remote.has(r.location) || st.servers.some((s) => s.name === r.location))
    .concat(st.domains.map((name) => ({ id: `domain:${name}`, kind: 'domain', name, location: 'other', provider: 'rdap', urls: [`https://${name}/`], status: 'ok', status_detail: '',
      details: { name, registrar: 'Example Registrar', expires: t + 200 * DAY, auto_renew: true, dns: [{ type: 'A', name, content: '203.0.113.5' }], name_servers: ['ns1.example.net', 'ns2.example.net'], sources: ['rdap', 'dns'] },
      links: [], project: null, note: '', hidden: false, declared: true, missing: false })))
    .map((r) => {
      const out = { ...clone(r), ...(st.registry[r.id] || {}) }
      if (r.id === 'domain:example.org') out.details.expires = t + 20 * DAY // expiring soon: the warn state
      if (r.kind === 'server' && r.location !== 'local') { const s = st.servers.find((x) => x.name === r.location); if (s) out.name = s.label || s.name }
      return out
    })
  return { enabled: true, refreshing: st.refreshing, error: null, refresh_min: 15, generated_at: st.generated_at, took_ms: 2840, harness_host: 'ui.example.com',
    sources: { servers: Object.fromEntries([['local', { ok: true, error: null, took_ms: 410 }], ...st.servers.map((s) => [s.name, { ok: true, error: null, took_ms: 1220 }])]),
      cloudflare: { connected: true, key: 'CLOUDFLARE_API_TOKEN', error: null, sections: { zones: 'ok', workers: 'ok', worker_domains: 'ok', pages: 'ok', r2: 'ok', d1: 'ok', registrar: 'missing_permission', dns: 'ok' } },
      hostinger: { connected: true, key: 'HOSTINGER_API_TOKEN', sections: { domains: 'ok', vps: 'ok' } },
      ...Object.fromEntries(['vercel', 'netlify', 'supabase', 'github'].map((p) => [p, { connected: p === 'github', key: p === 'github' ? 'GITHUB_TOKEN' : null, error: null, label: p[0].toUpperCase() + p.slice(1),
        beta: p !== 'github', token_url: `https://${p}.example.com/account/tokens`, keys: [`${p.toUpperCase()}_TOKEN`], sections: p === 'github' ? { sites: 'ok' } : {} }])) },
    resources, servers: clone(st.servers) }
}
R('GET', '/api/infra', () => infraView())
R('POST', '/api/infra/refresh', () => {
  const st = infraState()
  if (st.refreshing) return { started: false, refreshing: true }
  st.refreshing = true
  const g = GEN
  setTimeout(() => { if (g === GEN) { st.refreshing = false; st.generated_at = now(); bus('infra') } }, 2500).unref()
  bus('infra')
  return { started: true, refreshing: true }
})
R('POST', '/api/infra/annotate', ({ body }) => {
  const st = infraState(), cur = { ...(st.registry[body.id] || {}) }
  if (body.project !== undefined) cur.project = String(body.project || '').trim().replace(/^\/+|\/+$/g, '') || null
  if (body.note !== undefined) cur.note = String(body.note || '').trim().slice(0, 500)
  if (body.hidden !== undefined) cur.hidden = !!body.hidden
  const kept = Object.fromEntries(Object.entries(cur).filter(([, v]) => v !== null && v !== '' && v !== false))
  if (Object.keys(kept).length) st.registry[body.id] = kept; else delete st.registry[body.id]
  bus('infra')
  return kept
})
R('GET', '/api/infra/reserved', () => ({ names: ['api', 'ext', 'assets', 'icons', 'sessions', 'files', 'tasks', 'crons', 'settings', 'infra', 'git', 'team', 'x', 'login', 'sw.js', 'manifest', 'index.html', 'favicon'] }))
R('POST', '/api/infra/servers/connect', async ({ body }) => {
  const st = infraState()
  const host = String(body.host || '').trim(), user = String(body.user || 'root'), port = Number(body.port || 22)
  if (!host && !body.id) fail(422, 'not_found', 'Give a host or a Hostinger server')
  if (st.servers.some((s) => s.host === host)) fail(409, 'exists', 'This server is already connected')
  await sleep(1500)
  if (!/^192\.0\.2\.\d+$/.test(host) && !body.id) // only the documentation range 192.0.2.0/24 "accepts" the key in the mock
    return { connected: false, message: 'No key of this server works yet: add the Harness public key to the server, then try again.', public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample harness@ui.example.com',
      command: `mkdir -p ~/.ssh && echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample harness@ui.example.com' >> ~/.ssh/authorized_keys` }
  let name = (body.label || host || 'server').toLowerCase().replace(/[^a-z0-9-]+/g, '-').split('.')[0].slice(0, 36) || 'server'
  for (let n = 2; st.servers.some((s) => s.name === name); n++) name = `${name.replace(/-\d+$/, '')}-${n}`
  const s = { name, label: String(body.label || '').slice(0, 60), host: host || '203.0.113.40', user, port, note: '' }
  st.servers.push(s); bus('infra')
  return { connected: true, name: s.name, label: s.label, host: s.host, user: s.user, port: s.port, via: body.id ? 'added_key' : 'existing_key' }
})
R('POST', '/api/infra/servers/rename', ({ body }) => {
  const s = infraState().servers.find((x) => x.name === body.name) || fail(404, 'not_found', `no server named ${body.name}`)
  s.label = String(body.label || '').trim().slice(0, 60); bus('infra')
  return { name: s.name, label: s.label }
})
R('POST', '/api/infra/servers/remove', ({ body }) => {
  const st = infraState()
  if (!st.servers.some((x) => x.name === body.name)) fail(404, 'not_found', `no server named ${body.name}`)
  st.servers = st.servers.filter((x) => x.name !== body.name); bus('infra')
  return { removed: true }
})
R('POST', '/api/infra/domains', ({ body }) => {
  const name = String(body.name || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/\.$/, '')
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) fail(400, 'invalid_domain', 'not a domain name (example: example.com)')
  const st = infraState()
  if (!st.domains.includes(name) && !INFRA_RESOURCES.some((r) => r.id === `domain:${name}`)) st.domains.push(name)
  bus('infra')
  return { name }
})
R('POST', '/api/infra/domains/remove', ({ body }) => {
  const st = infraState()
  if (!st.domains.includes(body.name)) fail(404, 'not_found', 'This domain was not added by hand')
  st.domains = st.domains.filter((x) => x !== body.name); bus('infra')
  return { removed: true }
})

/* ---- system */
R('GET', '/api/system/health', () => healthObj())
R('GET', '/api/system/services', () => S.services)
R('POST', '/api/system/services/:name/:action', async ({ params }) => {
  const s = S.services.find((x) => x.name === params.name) || fail(404, 'not_found', 'Unknown service')
  if (!['start', 'stop', 'restart'].includes(params.action)) fail(404, 'not_found', 'Unknown action')
  if (s.name === 'claude-maxxing' && params.action === 'stop') fail(409, 'self', 'Stopping the UI service from the UI is not allowed')
  await sleep(500)
  if (params.action === 'stop') { s.active = false; s.since = null } else { s.active = true; s.since = now() }
  bus('health')
  return { ok: true }
})
R('GET', '/api/system/logs', ({ q }) => {
  const unit = q.get('unit') || 'claude-maxxing'
  if (!S.services.some((s) => s.name === unit)) fail(404, 'not_found', 'Unknown unit')
  const n = Math.min(2000, Math.max(1, parseInt(q.get('lines') || '200', 10) || 200))
  return { lines: journal(unit, n) }
})
R('GET', '/api/system/version', () => ({ version: VERSION, commit: 'a1b2c3d', latest_commit: 'e4f5a6b', behind: 3, local_mode: !!LOCAL,
  auto_update: { enabled: !!S.autoUpdate, tried: null, last_check: null }, report: S.updateReport ? { at: S.updateReport.at, version: S.updateReport.version, ok: S.updateReport.ok, problems: S.updateReport.problems } : null }))
R('POST', '/api/system/update', () => (LOCAL ? fail(409, 'local_update_unsupported', 'Updates from the application are unavailable in local mode.') : { ok: true }))
// the tools of thumbnails and previews (server/maxxing/mediatools.py `status`): Homebrew commands on a Mac, apt elsewhere
R('GET', '/api/system/media-tools', () => {
  const mac = LOCAL.startsWith('mac'), bin = mac ? '/opt/homebrew/bin' : '/usr/bin'
  const ffmpeg = MEDIA === 'none' ? null : `${bin}/ffmpeg`, webp = !!ffmpeg && MEDIA !== 'no-webp'
  const pdftoppm = MEDIA === 'none' || MEDIA === 'no-pdf' ? null : `${bin}/pdftoppm`
  const missing = [...(!ffmpeg ? ['ffmpeg'] : webp ? [] : ['ffmpeg_webp']), ...(pdftoppm ? [] : ['pdftoppm'])]
  const needFfmpeg = missing.some((m) => m.startsWith('ffmpeg')), needPdf = missing.includes('pdftoppm')
  const pkgs = [...(needFfmpeg ? [mac ? 'ffmpeg-full' : 'ffmpeg'] : []), ...(needPdf ? [mac ? 'poppler' : 'poppler-utils'] : [])]
  const install = !pkgs.length ? [] : mac ? pkgs.map((p) => `brew install ${p}`) : [`sudo apt-get install -y ${pkgs.join(' ')}`]
  return { ok: !missing.length, ffmpeg: { path: ffmpeg, webp }, pdftoppm: { path: pdftoppm }, missing, install }
})
// the optional launchd agent of a local installation on macOS (server/maxxing/local_service.py), read-only
const MAC_REPO = '/Users/me/harness-pilot'
const macCmd = (a) => `bash ${MAC_REPO}/scripts/dev-local.sh service ${a}`
const SERVICE_STARTED = now() - 2 * 3600 - 14 * 60
R('GET', '/api/system/local-service', () => (!LOCAL.startsWith('mac') ? { supported: false } : {
  supported: true, installed: LOCAL !== 'mac-none', label: 'local.harness-pilot', plist: '/Users/me/Library/LaunchAgents/local.harness-pilot.plist',
  running: LOCAL === 'mac', since: LOCAL === 'mac' ? SERVICE_STARTED : null, logs: `${MAC_REPO}/.harness-pilot-local/logs`, url: 'http://127.0.0.1:8787',
  commands: { ...Object.fromEntries(['install', 'status', 'restart', 'uninstall'].map((a) => [a, macCmd(a)])), update: `git -C ${MAC_REPO} pull` },
}))
R('GET', '/api/system/changelog', () => ({ version: VERSION, entries: [
  { version: VERSION, label: 'unreleased', current: true, body: '- **Bulk task actions**: select several tasks and change them at once.\n- **Notifications** when Claude finishes.' },
  { version: '1.9.0', label: '', current: false, body: '- Earlier release.' },
] }))
R('GET', '/api/memory', () => ({ max_lines: S.settings.memory_max_lines ?? 200, files: [
  { path: 'memory.md', level: 'global', lines: 42, bytes: 2100, over: false },
  { path: 'projects/acme/memory.md', level: 'project', lines: 260, bytes: 14000, over: (S.settings.memory_max_lines ?? 200) > 0 && 260 > (S.settings.memory_max_lines ?? 200) },
  { path: 'projects/acme/topics/blog/memory.md', level: 'topic', lines: 80, bytes: 4100, over: false },
] }))
R('POST', '/api/memory/compact', () => ({ session: S.sessions[0] || null }))
R('GET', '/api/stats/tokens', () => {
  const row = (total) => ({ input: Math.round(total * 0.05), output: Math.round(total * 0.05), cache_read: Math.round(total * 0.85), cache_write: Math.round(total * 0.05), total, cost_usd: total / 400000, turns: Math.round(total / 50000), sessions: 3 })
  const days = Array.from({ length: 30 }, (_, i) => ({ date: new Date(Date.now() - (29 - i) * 864e5).toISOString().slice(0, 10), tokens: 200000 + ((i * 7919) % 9) * 90000, cost_usd: 1.2 }))
  return { totals: row(12_500_000), projects: [{ name: 'acme', ...row(9_000_000) }, { name: '', ...row(3_500_000) }],
    topics: [{ path: 'projects/acme/topics/blog', ...row(6_000_000) }, { path: 'projects/acme/topics/shop', ...row(3_000_000) }],
    sessions: (S.sessions || []).slice(0, 5).map((x, i) => ({ id: x.id, title: x.title, path: x.path, archived: false, updated: x.updated, ...row(2_000_000 - i * 300_000) })),
    days, at: now() }
})
R('GET', '/api/usage', () => ({ available: false, five_hour: null, seven_day: null, reason: 'disabled' }))

/* ---- resident missions (server/maxxing/missions.py): a goal, a plan of companion steps the owner reviews, then runs
   launched one by one as companion runs (the proposal of each waits for the owner's decision in Settings -> Companions).
   The server's worker advances missions every 2 s; here each read does (the page polls). Cycles are not simulated. */
const MISSION_FIELDS = ['title', 'path', 'goal', 'max_runs', 'max_seconds', 'max_tokens', 'concurrent', 'interval_seconds', 'max_cycles']
const MISSION_PLAN = [ // what the architect proposes in the mock
  { id: 'map', title: 'Map the keyboard paths of the Files page', role: 'architect', instruction: 'List every action of the Files page and how it is reached without a mouse. Name the components and files involved.', after: [] },
  { id: 'focus', title: 'Fix the missing focus states', role: 'observer', instruction: 'Give every interactive element of the Files page a visible focus ring with the shared tokens, and add a test for the list.', after: ['map'] },
  { id: 'check', title: 'Review the change for regressions', role: 'security', instruction: 'Check that the focus changes do not expose hidden actions and that the tests cover the list and the toolbar.', after: ['focus'] },
]
const missionStep = (s) => ({ id: s.id, title: s.title, role: s.role, instruction: s.instruction, after: [...s.after], state: 'pending', session: null })
function missionFingerprint(m) {
  const roles = companionsState().roles
  const plan = Object.fromEntries(MISSION_FIELDS.map((k) => [k, m[k]]))
  plan.steps = m.steps.map(({ id, title, role, instruction, after }) => ({ id, title, role, instruction, after }))
  plan.roles = Object.fromEntries([...new Set(m.steps.map((s) => s.role))].sort().map((r) => { const p = roles.find((x) => x.id === r); return [r, p ? { role: p.role, engine: p.provider } : null] }))
  return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex')
}
function missionsState() {
  if (S.missions) return S.missions
  S.missions = []
  if (S.scenario === 'ready' || S.scenario === 'maxxing') S.missions.push({ ...missionNew('Keyboard-friendly Files page', topicPath('acme', 'website'),
    'Every action of the Files page works with the keyboard alone, with a visible focus, without changing how it looks for mouse users.', 6, 90, 2000000, 1, 0, 1),
    steps: MISSION_PLAN.map(missionStep), phase: 'plan_review', reason: 'plan_ready', created: now() - 3 * HOUR })
  return S.missions
}
function missionNew(title, path, goal, runs, minutes, tokens, concurrent, interval, cycles) {
  return { id: crypto.randomBytes(16).toString('hex'), title, path, goal, steps: [], phase: 'draft', reason: '', created: now(), origin_state: '/var/lib/claude-maxxing',
    max_runs: runs, max_seconds: minutes * 60, max_tokens: tokens, concurrent, interval_seconds: interval * 60, max_cycles: cycles,
    cycle: 1, spent_seconds: 0, active_since: null, next_cycle: null, launches: [], tokens: 0, planner: null }
}
function missionValidate(steps) {
  const roles = new Set(companionsState().roles.map((p) => p.id)), seen = new Set()
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 8) fail(400, 'bad_plan', 'A plan needs one to eight steps.')
  return steps.map((v) => {
    const id = String(v?.id || ''), title = String(v?.title || '').trim(), instruction = String(v?.instruction || '').trim(), after = v?.after || []
    if (!/^[a-z0-9-]{1,40}$/.test(id) || seen.has(id) || !title || title.length > 120 || !roles.has(v.role) || !instruction || instruction.length > 2000
      || !Array.isArray(after) || after.some((d) => !seen.has(d)) || new Set(after).size !== after.length) fail(400, 'bad_plan', 'Use existing roles and distinct steps with earlier prerequisites.')
    seen.add(id)
    return missionStep({ id, title, role: v.role, instruction, after })
  })
}
const missionOut = (m) => ({ ...clone(m), plan_fingerprint: missionFingerprint(m) })
const missionFind = (id) => missionsState().find((m) => m.id === id) || fail(404, 'not_found', 'Mission not found.')
const missionRuns = (m) => m.launches.filter((l) => !l.aborted).length
const missionBank = (m) => { if (m.active_since) { m.spent_seconds += Math.max(0, now() - m.active_since); m.active_since = null } }
// A launch is an ordinary companion run (its session carries `companion`), so its proposal is reviewed in Companions.
function missionLaunch(m, step, purpose) {
  const role = companionsState().roles.find((p) => p.id === step.role) || companionsState().roles[0]
  const t = now()
  const s = { id: uuid(), title: `${role.name} — platform review`, path: m.path, state: 'idle', queue: 0, created: t, updated: t, turns: 0, cost_usd: 0, model: '',
    real_model: null, context_tokens: null, context_window: null, archived: false, notify: false, source: 'web', unread: false, last_text: '', error: null,
    provider: role.provider, companion: { id: role.id, name: role.name, decision: null } }
  S.sessions.push(s); S.events[s.id] = []
  if (purpose === 'experiment') S.companions.runs[s.id] = { base: sha(), decision: null, pull_request: null } // a plan proposes no change
  m.launches.push({ key: uuid(), session: s.id, purpose })
  Object.assign(step, { state: 'running', session: s.id })
  if (purpose === 'experiment') return companionTurn(s, `Mission goal: ${m.goal}\nYour step: ${step.title}\n${step.instruction}`)
  const plan = JSON.stringify({ steps: MISSION_PLAN.map(({ id, title, role: r, instruction, after }) => ({ id, title, role: r, instruction, after })) }, null, 2)
  s.state = 'running'
  addEvents(s, { type: 'user', text: `Design a small actionable plan for this goal, using existing roles only.\n${m.goal}`, attachments: [], at: now(), source: 'companion' })
  later(s, 3000, () => {
    Object.assign(s, { state: 'idle', turns: 1, updated: now(), unread: true, last_text: plan.slice(0, 200) })
    addEvents(s, { type: 'assistant', text: '```json\n' + plan + '\n```', at: now() }, { type: 'result', ok: true, cost_usd: 0, duration_ms: 3000, model: 'gpt-5.5-codex', usage: { input: 9000, output: 700, cache_read: 0, cache_write: 0 }, at: now() })
    bus('missions', 'sessions')
  })
}
function missionAdvance(m) { // like missions.advance, one pass
  const runs = companionsState().runs
  for (const step of [...m.steps, ...(m.planner ? [m.planner] : [])]) {
    if (!step.session || !['running', 'review'].includes(step.state)) continue
    const s = S.sessions.find((x) => x.id === step.session)
    if (!s) { Object.assign(step, { state: 'failed', error: 'missing_session' }); continue }
    if (s.state === 'running') continue
    if (!s.turns) { Object.assign(step, { state: 'failed', error: 'agent_failed' }); continue }
    if (step === m.planner) { step.state = 'complete'; m.tokens += 9700; continue }
    const decision = runs[s.id]?.decision
    if (step.state === 'running') m.tokens += 40900
    step.state = decision?.fingerprint === companionFingerprint() ? (decision.value === 'approved' ? 'complete' : 'rejected') : 'review'
  }
  if (!['active', 'planning'].includes(m.phase)) return
  const busy = [...m.steps, ...(m.planner ? [m.planner] : [])].some((s) => s.state === 'running')
  if (busy) m.active_since ||= now(); else missionBank(m)
  if (m.spent_seconds >= m.max_seconds || m.tokens >= m.max_tokens) return Object.assign(m, { phase: 'budget', reason: m.tokens >= m.max_tokens ? 'tokens' : 'time' })
  if ([...m.steps, ...(m.phase === 'planning' && m.planner ? [m.planner] : [])].some((s) => ['failed', 'rejected', 'interrupted'].includes(s.state))) return Object.assign(m, { phase: 'paused', reason: 'step_failed' })
  if (m.phase === 'planning') {
    if (m.planner?.state === 'complete') Object.assign(m, { steps: MISSION_PLAN.map(missionStep), phase: 'plan_review', reason: 'plan_ready' })
    else if (!m.planner) {
      if (missionRuns(m) >= m.max_runs) return Object.assign(m, { phase: 'budget', reason: 'runs' })
      m.planner = { id: 'planner', title: 'Plan', role: 'architect', instruction: '', state: 'pending', after: [], session: null }
      missionLaunch(m, m.planner, 'plan')
    }
    return
  }
  if (m.steps.every((s) => ['complete', 'skipped'].includes(s.state))) return Object.assign(m, { phase: 'completed', reason: 'completed' })
  const ready = m.steps.find((s) => s.state === 'pending' && s.after.every((d) => m.steps.some((x) => x.id === d && ['complete', 'skipped'].includes(x.state))))
  if (ready && m.steps.filter((s) => s.state === 'running').length < m.concurrent) {
    if (missionRuns(m) >= m.max_runs) return Object.assign(m, { phase: 'budget', reason: 'runs' })
    missionLaunch(m, ready, 'experiment')
  }
}
const missionsRead = () => { for (const m of missionsState()) missionAdvance(m); return missionsState() }
R('GET', '/api/missions', () => [...missionsRead()].sort((a, b) => b.created - a.created).map(missionOut))
R('POST', '/api/missions', ({ body }) => {
  const title = String(body.title || '').trim(), goal = String(body.goal || '').trim()
  if (!title || title.length > 120 || !goal || goal.length > 2000) fail(400, 'bad_mission', 'A title and bounded goal are required.')
  if (!S.projects.some((p) => p.topics.some((tp) => topicPath(p.name, tp.name) === body.path))) fail(400, 'bad_path', 'Choose an existing topic.')
  const n = (k, d) => (body[k] === undefined || body[k] === null ? d : Number(body[k]))
  const [runs, minutes, tokens, concurrent, interval, cycles] = [n('max_runs', 8), n('max_minutes', 60), n('max_tokens', 1000000), n('concurrent', 1), n('interval_minutes', 0), n('max_cycles', 1)]
  if (!(runs >= 1 && runs <= 32 && minutes >= 1 && minutes <= 1440 && tokens >= 1 && tokens <= 100000000 && [1, 2].includes(concurrent) && interval >= 0 && interval <= 10080 && cycles >= 1 && cycles <= 32)) fail(400, 'bad_budget', 'Mission limits are out of range.')
  const steps = body.steps?.length ? missionValidate(body.steps) : []
  if (missionsState().length >= 50) fail(400, 'limit', 'The mission list is full.')
  const m = { ...missionNew(title, body.path, goal, runs, minutes, tokens, concurrent, interval, cycles), steps }
  S.missions.push(m); bus('missions')
  return missionOut(m)
})
R('GET', '/api/missions/:id', ({ params }) => { missionsRead(); return missionOut(missionFind(params.id)) })
R('PUT', '/api/missions/:id/plan', ({ params, body }) => {
  const m = missionFind(params.id), steps = missionValidate(body.steps)
  if (!['draft', 'plan_review', 'paused'].includes(m.phase) || m.steps.some((s) => s.session)) fail(409, 'busy', 'A running or previously executed plan cannot be replaced.')
  Object.assign(m, { steps, phase: 'plan_review', reason: '' }); bus('missions')
  return missionOut(m)
})
R('POST', '/api/missions/:id/control', ({ params, body }) => {
  const m = missionFind(params.id), action = body.action
  if (!['start', 'pause', 'stop', 'plan'].includes(action)) fail(400, 'bad_action', 'Unknown mission action.')
  if (action === 'plan') {
    if (!['draft', 'plan_review', 'paused'].includes(m.phase) || m.planner || m.steps.some((s) => s.session)) fail(409, 'busy', 'This mission already has a planner run.')
    Object.assign(m, { phase: 'planning', active_since: null, reason: '' })
  } else if (action === 'start') {
    if (body.fingerprint !== missionFingerprint(m)) fail(409, 'changed', 'The plan or limits changed. Review the current plan before starting it.')
    if (!['draft', 'plan_review', 'paused'].includes(m.phase) || !m.steps.length) fail(409, 'busy', 'Review a plan before starting this mission.')
    if (missionRuns(m) >= m.max_runs || m.spent_seconds >= m.max_seconds || m.tokens >= m.max_tokens) fail(409, 'budget', 'The authorized mission budget is exhausted.')
    for (const s of m.steps) if (s.state === 'interrupted' && !s.session) Object.assign(s, { state: 'pending' })
    if (m.steps.some((s) => ['failed', 'rejected', 'interrupted'].includes(s.state))) fail(409, 'unresolved', 'Retry or skip the steps that need your attention first.')
    Object.assign(m, { phase: 'active', active_since: null, reason: '' })
  } else {
    if (action === 'stop' && ['completed', 'stopped', 'budget'].includes(m.phase)) fail(409, 'busy', 'A terminal mission cannot be stopped again.')
    if (action === 'pause' && !['active', 'planning'].includes(m.phase)) fail(409, 'busy', 'Only an active mission can be paused.')
    missionBank(m)
    Object.assign(m, { phase: action === 'pause' ? 'paused' : 'stopped', reason: 'owner' })
    for (const step of [...m.steps, ...(m.planner ? [m.planner] : [])]) {
      if (!step.session || step.state !== 'running') continue
      const s = S.sessions.find((x) => x.id === step.session)
      if (s && s.state === 'running') { clearTimers(s); s.state = 'idle'; addEvents(s, { type: 'note', text: 'Turn stopped by user.', level: 'warn', at: now() }) }
      step.state = 'interrupted'
    }
    bus('sessions')
  }
  missionAdvance(m) // the server's worker launches within 2 s
  bus('missions')
  return missionOut(m)
})
for (const [what, states, verb] of [['skip', ['interrupted', 'failed', 'rejected'], 'skipped'], ['retry', ['interrupted', 'failed', 'rejected'], 'retried']]) {
  R('POST', `/api/missions/:id/steps/:step/${what}`, ({ params }) => {
    const m = missionFind(params.id)
    if (m.phase !== 'paused') fail(409, 'busy', `Only a paused mission can ${what} a step.`)
    const step = m.steps.find((s) => s.id === params.step)
    if (!step || !states.includes(step.state)) fail(409, 'busy', `Only an interrupted, failed or rejected step can be ${verb}.`)
    if (what === 'skip') step.state = 'skipped'; else { delete step.error; Object.assign(step, { state: 'pending', session: null }) }
    m.reason = 'owner'; bus('missions')
    return missionOut(m)
  })
}

/* ---- update checks (server/maxxing/smartupdate.py), Codex status, automatic updates, health issues marked as seen.
   The preflight shows an update that needs adapting one customization; "Verify" finds one extension to fix. */
const UPDATE_TOPIC = 'projects/system/topics/harness' // cmd_core.update_topic(): created on first use in the mock
const updateTopic = () => {
  let p = S.projects.find((x) => x.name === 'system')
  if (!p) { p = { name: 'system', description: 'Harness itself: tutorial, help, updates.', topics: [] }; S.projects.push(p) }
  if (!p.topics.some((x) => x.name === 'harness')) { p.topics.push({ name: 'harness', description: 'Updates and customizations of this server' }); fsAdd(S, `${UPDATE_TOPIC}/CLAUDE.md`, '# Topic harness\n', now()) }
  return UPDATE_TOPIC
}
const updateReport = (ok) => ({ at: now(), version: VERSION, ok, problems: ok ? 0 : 1,
  extensions: [{ id: 'shop-sales', name: 'Shop sales', type: 'widget', ok: true, error: '' }, { id: 'notes', name: 'Notes', type: 'page', ok: true, error: '' },
    { id: 'broken-widget', name: 'Broken widget', type: 'widget', ok: ok, error: ok ? '' : 'SyntaxError in api.py line 12', skipped: false }],
  checks: [{ id: 'c-20261020-7f3a', title: 'Mirror up to 80 sessions on Telegram', check: "grep -q 'MAX_THREADS = 80' $MAXXING_CODE/server/maxxing/telegram/gateway.py", ok: true, output: '' }] })
function updateSession(title, prompt) {
  const t = now(), s = { id: uuid(), title, path: updateTopic(), state: 'idle', queue: 0, created: t, updated: t, turns: 0, cost_usd: 0, model: '', real_model: null,
    context_tokens: null, context_window: null, archived: false, notify: false, source: 'web', unread: false, last_text: '', error: null }
  S.sessions.push(s); S.events[s.id] = []
  startTurn(s, prompt)
  bus('sessions', 'workspace')
  return s
}
R('POST', '/api/system/health/seen', ({ body }) => {
  if (!healthObj().issues.some((i) => i.id === body.id)) fail(404, 'not_found', 'No current issue with this id')
  const seen = (S.healthSeen ||= {})
  if (body.seen === false) delete seen[body.id]; else seen[body.id] = now()
  bus('health')
  return healthObj()
})
/* ---- codex sign-in (Settings -> Codex, the wizard's Codex step). MOCK_CODEX=signed-in | signed-out | missing |
 * device-fails (default: signed in with ChatGPT in ready / maxxing, signed out otherwise). The device code is accepted
 * 12 s after it is shown; an API key starting with "sk-bad" is refused. */
const codexState = () => (S.codex ||= (() => {
  const mode = process.env.MOCK_CODEX || (S.scenario === 'ready' || S.scenario === 'maxxing' ? 'signed-in' : 'signed-out')
  return { installed: mode !== 'missing', method: mode === 'signed-in' ? 'chatgpt' : null, fails: mode === 'device-fails', login: { state: 'none' } }
})())
const codexStatus = () => {
  const c = codexState()
  if (!c.installed) return { installed: false, authenticated: false, reason: 'not_installed', method: null }
  return { installed: true, authenticated: !!c.method, reason: c.method ? null : 'not_authenticated', method: c.method }
}
const codexLogin = () => {
  const c = codexState(), l = c.login
  if (l.state === 'waiting' && now() - l.started_at > 12) {
    if (c.fails) Object.assign(l, { state: 'failed', error: 'Error: failed to complete device code sign-in: the request was denied', code: null })
    else { Object.assign(l, { state: 'succeeded', code: null }); c.method = 'chatgpt'; bus('health') }
  }
  const waiting = l.state === 'waiting'
  return { state: l.state, url: waiting ? 'https://auth.openai.com/codex/device' : null, code: waiting ? l.code : null,
    expires_at: waiting ? l.started_at + 900 : null, started_at: l.started_at ?? null, error: l.error ?? null }
}
const codexNeeded = () => { if (!codexState().installed) fail(409, 'not_installed', 'The Codex command was not found by this server') }
R('GET', '/api/system/codex', () => { codexLogin(); return codexStatus() })
R('GET', '/api/system/codex/login', () => codexLogin())
R('POST', '/api/system/codex/login', async () => {
  codexNeeded()
  const c = codexState()
  if (c.login.state !== 'waiting') {
    await sleep(900)
    c.login = { state: 'waiting', started_at: now(), code: 'WXYZ-12345', error: null }   // a made-up code
  }
  return codexLogin()
})
R('DELETE', '/api/system/codex/login', () => {
  const l = codexState().login
  if (l.state === 'waiting') Object.assign(l, { state: 'cancelled', code: null })
  return codexLogin()
})
R('POST', '/api/system/codex/auth', async ({ body }) => {
  codexNeeded()
  const v = String(body.value || '').trim()
  if (v.length < 20 || /\s/.test(v)) fail(400, 'invalid', 'This does not look like an API key')
  await sleep(800)
  if (v.startsWith('sk-bad')) fail(502, 'login_failed', 'Error: the API key was refused')
  const c = codexState()
  if (c.login.state === 'waiting') Object.assign(c.login, { state: 'cancelled', code: null })
  c.method = 'api_key'
  bus('health')
  return { ok: true, ...codexStatus() }
})
R('DELETE', '/api/system/codex/auth', () => {
  codexNeeded()
  const c = codexState()
  if (c.login.state === 'waiting') Object.assign(c.login, { state: 'cancelled', code: null })
  c.method = null
  bus('health')
  return { ok: true, ...codexStatus() }
})
R('PUT', '/api/system/auto-update', ({ body }) => { S.autoUpdate = !!body.enabled; return { ok: true, enabled: S.autoUpdate } })
R('GET', '/api/system/update/preflight', async ({ q }) => {
  if (q.get('refresh')) await sleep(1500)
  return { ok: true, verdict: 'adapt', current: VERSION, latest: '2.0.1', behind: 3,
    // a customization is a server change (pilot custom save refuses web/); edits of web/ only show as web_changes
    customs: [{ id: 'c-20261020-7f3a', title: 'Mirror up to 80 sessions on Telegram', why: 'I keep more than 50 sessions open and want each one in its own thread.', files: ['server/maxxing/telegram/gateway.py'],
      status: 'review', conflicts: [], overlap: ['server/maxxing/telegram/gateway.py'] }],
    unsaved: [], web_changes: ['web/src/features/dashboard'], extensions: [{ id: 'broken-widget', name: 'Broken widget', api: 1, reason: 'Extension API 1 is no longer loaded: move it to API 2' }],
    notes: [{ version: '2.0.1' }], changelog: '- **Bulk task actions**: select several tasks and change them at once.\n- Faster dashboard cards.' }
})
R('GET', '/api/system/update/report', () => ({ report: S.updateReport || null }))
R('POST', '/api/system/update/verify', async () => { await sleep(1800); S.updateReport = updateReport(false); return { report: S.updateReport } })
R('POST', '/api/system/update/assist', () => ({ session: updateSession('Adapt my changes, then update', 'Adapt the customizations of this server to the next version (see the preflight), then run the update.') }))
R('POST', '/api/system/update/fix', () => {
  if (!S.updateReport || S.updateReport.ok) fail(409, 'nothing_to_fix', 'The last verification found nothing broken')
  return { session: updateSession(`Fix after the update to ${S.updateReport.version}`, 'The last verification found a problem: Broken widget (SyntaxError in api.py line 12). Fix it and verify again.') }
})
/* ---- import from another agent (server/maxxing/importer.py): the prompt to paste into the old agent, then its zip.
   The mock does not unzip: any ZIP file (PK header) gives the same preview, and applying it creates its project. */
const IMPORT_HINTS = {
  hermes: 'You are Hermes Agent: your memory lives in ~/.hermes/ (MEMORY.md, USER.md, memories/, skills/, sessions, cron jobs). Read all of it.',
  'claude-code': 'You are Claude Code: read every CLAUDE.md and memory file you use (~/.claude/CLAUDE.md, the project folders, ~/.claude/projects/*/memory/), your skills (~/.claude/skills/, .claude/skills/) and anything the user keeps notes in.',
  openclaw: 'You are OpenClaw: read your workspace (by default ~/.openclaw/workspace/: AGENTS.md, SOUL.md, USER.md, MEMORY.md, memory/*.md, skills/) and your scheduled jobs.',
  other: 'Read every place where you keep memory, notes, instructions, skills and scheduled jobs.',
}
const importPrompt = (agent) => `I am moving to harness-pilot, a control room for Claude Code. Please export everything you know and keep about me and my work into ONE zip file that it can import. ${IMPORT_HINTS[agent]}

Build a folder \`harness-pilot-export/\` with this layout (Markdown, UTF-8): memory.md, projects/<project>/CLAUDE.md and memory.md, projects/<project>/topics/<topic>/CLAUDE.md, memory.md and useful files, skills/<skill-name>/SKILL.md, tasks.md, crons.md, SECRETS.md (key NAMES only).

NEVER write a secret value anywhere - only their names in SECRETS.md. Then zip it and give me the file.`
const importsState = () => (S.imports ||= { uploads: {}, applying: false })
R('GET', '/api/import/prompt', ({ q }) => {
  const agent = Object.keys(IMPORT_HINTS).includes(q.get('agent')) ? q.get('agent') : 'other'
  return { agent, agents: Object.keys(IMPORT_HINTS), prompt: importPrompt(agent) }
})
R('POST', '/api/import/upload', ({ req, rawBody }) => {
  const [file] = parseMultipart(rawBody, req.headers['content-type'] || '')
  if (!file || !file.data.length) fail(400, 'empty', 'The file is empty')
  if (file.data.length > 600 * 1024 * 1024) fail(413, 'too_big', 'The archive is larger than 600 MB')
  if (!file.data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) fail(400, 'bad_zip', 'This is not a ZIP archive')
  const exists = (p, t) => S.projects.some((x) => x.name === p && (!t || x.topics.some((y) => y.name === t)))
  const plan = { id: crypto.randomBytes(12).toString('hex'), name: file.name,
    projects: [{ name: 'freelance', exists: exists('freelance'), topics: [{ name: 'clients', source: 'projects/freelance/topics/clients', files: 6, exists: exists('freelance', 'clients') },
      { name: 'invoices', source: 'projects/freelance/topics/invoices', files: 3, exists: exists('freelance', 'invoices') }] },
    { name: 'acme', exists: exists('acme'), topics: [{ name: 'blog', source: 'projects/acme/topics/blog', files: 4, exists: exists('acme', 'blog') }] }],
    skills: ['weekly-report'], aside: ['tasks.md', 'crons.md', 'SECRETS.md'], root_memory: true, files: 19, size: file.data.length,
    skipped: [{ file: 'harness-pilot-export/.DS_Store', reason: 'hidden' }], secrets: [{ file: 'projects/freelance/topics/invoices/stripe.md', kinds: ['stripe_key'] }],
    renamed: [{ from: 'projects/Freelance Work', to: 'projects/freelance' }] }
  importsState().uploads[plan.id] = { plan, at: now() }
  return plan
})
R('POST', '/api/import/:id/apply', async ({ params }) => {
  const st = importsState(), up = st.uploads[params.id]
  if (!up || now() - up.at > DAY) fail(404, 'not_found', 'This upload expired: upload the file again')
  if (st.applying) fail(409, 'busy', 'Another import is being applied')
  st.applying = true
  try { await sleep(1200) } finally { st.applying = false }
  const merged = [], topics = []
  for (const p of up.plan.projects) {
    let proj = S.projects.find((x) => x.name === p.name)
    if (!proj) { proj = { name: p.name, description: '', topics: [] }; S.projects.push(proj); fsAdd(S, `${projPath(p.name)}/CLAUDE.md`, `# Project ${p.name}\n\n@memory.md\n`, now()) }
    for (const t of p.topics) {
      topics.push(`${p.name}/${t.name}`)
      if (proj.topics.some((x) => x.name === t.name)) merged.push(`${topicPath(p.name, t.name)}/memory.md`)
      else { proj.topics.push({ name: t.name, description: '' }); fsAdd(S, `${topicPath(p.name, t.name)}/memory.md`, `# ${t.name} — memory\n\n## Imported\n\nImported from the previous agent.\n`, now()) }
    }
  }
  const stamp = new Date().toISOString().slice(0, 10), folder = `imports/${stamp}`, report = `${folder}/REPORT.md`
  fsAdd(S, report, `# Import ${stamp}\n\n${up.plan.files} files from ${up.plan.name}.\n`, now(), 'text/markdown')
  delete st.uploads[params.id]
  bus('workspace')
  return { ok: true, projects: up.plan.projects.map((p) => p.name), topics, files: up.plan.files - 1, merged, renamed: [{ from: 'skills/weekly-report', to: 'skills/weekly-report-imported' }],
    skills: ['weekly-report-imported'], aside: up.plan.aside.map((a) => `${folder}/${a}`), secrets: up.plan.secrets, skipped: up.plan.skipped, folder, report,
    finish_prompt: `An import from my previous agent was just applied. Read ${report} first, then finish it with me: merge duplicates in memory, create the open tasks from tasks.md, propose the jobs of crons.md (ask before creating any), list the keys of SECRETS.md to add in Settings -> Keys.` }
})
R('DELETE', '/api/import/:id', ({ params }) => { delete importsState().uploads[params.id]; return { ok: true } })

/* ---- docs */
R('GET', '/api/docs', () => DOCS.map(({ slug, title, section, order }) => ({ slug, title, section, order })))
R('GET', '/api/docs/:slug', ({ params }) => {
  const d = DOCS.find((x) => x.slug === params.slug) || fail(404, 'not_found', 'No such doc page')
  return { slug: d.slug, title: d.title, markdown: d.markdown }
})

/* ---- pull request integration queue (server/maxxing/pr_queue.py): the owner reviews the exact diff, approves it, and
   the worker merges approved entries in order once checks pass and prerequisites are merged. Starts paused. Here a
   fake GitHub answers, and each read advances the queue like the worker (queued -> merging -> merged in a few s). */
const PRQ_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,9})$/
const PRQ_TITLES = { 140: 'Refuse slashes in file names', 142: 'Keyboard focus on the Files page', 143: 'Test the Files toolbar with the keyboard' }
function prqRemote(item) { // the fake GitHub pull request, stable per entry
  const st = prqState()
  return (st.remote[item.url] ||= { head: sha(), base_ref: 'main', base_sha: st.base, title: PRQ_TITLES[item.number] || `Improve ${item.repo.split('/')[1]} (#${item.number})`,
    body: 'Proposed by a resident companion and reviewed in Harness Pilot.', draft: false, open: true, merged: false })
}
const prqPatch = (item) => `diff --git a/docs/user/notes.md b/docs/user/notes.md
index 1a2b3c4..5d6e7f8 100644
--- a/docs/user/notes.md
+++ b/docs/user/notes.md
@@ -1,3 +1,4 @@
 # Notes

 Short notes about the product.
+- ${prqRemote(item).title}.
`
function prqState() {
  if (S.prQueue) return S.prQueue
  const t = now(), ready = S.scenario === 'ready' || S.scenario === 'maxxing'
  S.prQueue = { paused: true, base: sha(), remote: {}, items: [] }
  if (ready) {
    const add = (number, extra) => { const it = { id: crypto.randomBytes(16).toString('hex'), repo: 'acme/platform', number, url: `https://github.com/acme/platform/pull/${number}`, method: 'merge',
      dependencies: [], state: 'awaiting_review', reason: 'approval', approval: null, created: t - (150 - number) * HOUR, checked_at: 0, revision: 0, ...extra }; S.prQueue.items.push(it); return it }
    const merged = add(140, { state: 'merged', reason: 'merged', checked_at: t - 20 * HOUR })
    const r = prqRemote(merged); Object.assign(r, { merged: true, open: false })
    Object.assign(merged, { snapshot: { ...r }, approval: { fingerprint: crypto.randomBytes(32).toString('hex'), head: r.head, base_ref: 'main', base_sha: r.base_sha, dependencies: [], at: t - 21 * HOUR } })
    const focus = add(142, {})
    add(143, { dependencies: [focus.id], method: 'squash' })
  }
  return S.prQueue
}
const prqOut = () => { const st = prqState(); return { paused: st.paused, github_cli_available: true, items: clone(st.items) } }
const prqFind = (id) => prqState().items.find((i) => i.id === id) || fail(404, 'not_found', 'Pull request queue item not found.')
const prqBindings = (item) => item.dependencies.map((id) => {
  const dep = prqFind(id)
  return [id, dep.state === 'merged' ? dep.snapshot?.head || null : dep.approval?.head || null]
})
const prqFingerprint = (item, remote) => crypto.createHash('sha256').update(JSON.stringify([item.repo.toLowerCase(), item.number, remote.head, remote.base_ref,
  remote.base_sha, item.method, prqBindings(item), crypto.createHash('sha256').update(prqPatch(item)).digest('hex')])).digest('hex')
function prqAdvance() { // one worker pass
  const st = prqState(), t = now()
  for (const item of st.items) {
    if (!['queued', 'blocked', 'merging'].includes(item.state)) continue
    if (st.paused && item.state !== 'merging') { Object.assign(item, { state: 'queued', reason: 'paused' }); continue }
    const waiting = item.dependencies.some((id) => prqFind(id).state !== 'merged')
    if (item.state === 'merging') {
      if (t - item.checked_at < 3) continue
      const r = prqRemote(item); Object.assign(r, { merged: true, open: false })
      Object.assign(item, { state: 'merged', reason: 'merged', snapshot: { ...r }, checked_at: t, revision: item.revision + 1 })
    } else if (waiting) Object.assign(item, { state: 'blocked', reason: 'dependencies', checked_at: t })
    else if (item.reason !== 'checks' || t - item.checked_at >= 3) Object.assign(item, item.reason === 'checks' ? { state: 'merging', reason: 'github_pending', checked_at: t } : { state: 'queued', reason: 'checks', checked_at: t })
  }
}
R('GET', '/api/pr-queue', () => { prqAdvance(); return prqOut() })
R('POST', '/api/pr-queue', ({ body }) => {
  const m = String(body.url || '').trim().match(PRQ_URL), method = body.method || 'merge', deps = body.dependencies || []
  if (!m || ['.', '..'].includes(m[2]) || !['merge', 'squash'].includes(method)) fail(400, 'bad_request', 'Use a canonical GitHub pull request URL and merge or squash.')
  if (!Array.isArray(deps) || deps.length > 20 || new Set(deps).size !== deps.length) fail(400, 'bad_dependencies', 'Choose up to 20 distinct existing prerequisites.')
  const st = prqState(), repo = `${m[1]}/${m[2]}`, number = Number(m[3])
  if (st.items.length >= 100) fail(400, 'limit', 'The integration queue is full.')
  if (st.items.some((i) => i.repo.toLowerCase() === repo.toLowerCase() && i.number === number && i.state !== 'cancelled')) fail(409, 'duplicate', 'This pull request is already in the queue.')
  deps.forEach(prqFind)
  const item = { id: crypto.randomBytes(16).toString('hex'), repo, number, url: `https://github.com/${repo}/pull/${number}`, method, dependencies: deps,
    state: 'awaiting_review', reason: 'approval', approval: null, created: now(), checked_at: 0, revision: 0 }
  st.items.push(item)
  return clone(item)
})
R('PUT', '/api/pr-queue/pause', ({ body }) => { prqState().paused = !!body.paused; prqAdvance(); return prqOut() })
R('POST', '/api/pr-queue/refresh', async () => { // reads the three oldest unchecked entries from GitHub, never merges
  await sleep(600)
  for (const item of prqState().items.filter((i) => i.state === 'awaiting_review').sort((a, b) => a.checked_at - b.checked_at).slice(0, 3)) {
    Object.assign(item, { snapshot: { ...prqRemote(item) }, checked_at: now() })
  }
  prqAdvance()
  return prqOut()
})
R('GET', '/api/pr-queue/:id/preview', async ({ params }) => {
  const item = prqFind(params.id), remote = prqRemote(item)
  await sleep(400)
  return { item: clone(item), snapshot: { ...remote }, patch: prqPatch(item), fingerprint: prqFingerprint(item, remote), dependencies: prqBindings(item) }
})
R('POST', '/api/pr-queue/:id/approve', ({ params, body }) => {
  const item = prqFind(params.id), remote = prqRemote(item)
  if (body.fingerprint !== prqFingerprint(item, remote)) fail(409, 'changed', 'The reviewed commit or dependencies changed. Review the current diff.')
  if (remote.merged || !remote.open || remote.draft) fail(409, 'not_open', 'Only a ready, open pull request can be approved for integration.')
  if (prqBindings(item).some(([, head]) => !head)) fail(409, 'dependencies_unreviewed', 'Review and approve the prerequisite pull requests first.')
  if (['merging', 'merge_requested', 'cancelled', 'merged'].includes(item.state)) fail(409, 'busy', 'This item cannot receive a new approval in its current state.')
  Object.assign(item, { approval: { fingerprint: body.fingerprint, head: remote.head, base_ref: remote.base_ref, base_sha: remote.base_sha, dependencies: prqBindings(item), at: now() },
    snapshot: { ...remote }, state: 'queued', reason: prqState().paused ? 'paused' : 'checks', checked_at: 0, revision: item.revision + 1 })
  return prqOut()
})
R('POST', '/api/pr-queue/:id/cancel', ({ params }) => {
  const item = prqFind(params.id)
  if (['merging', 'merge_requested', 'merged'].includes(item.state)) fail(409, 'already_sent', 'An already initiated GitHub merge cannot be cancelled here.')
  Object.assign(item, { state: 'cancelled', reason: 'cancelled', approval: null, revision: item.revision + 1 })
  return prqOut()
})
R('POST', '/api/pr-queue/:id/retry', ({ params }) => {
  const item = prqFind(params.id)
  if (item.state !== 'merge_failed' || !item.approval) fail(409, 'not_retryable', 'This item has no approved merge to retry.')
  Object.assign(item, { state: 'queued', reason: 'checks', checked_at: 0, revision: item.revision + 1 })
  return prqOut()
})

/* ---- small gaps: tree order, one job, backup preview, search index stats, incoming webhooks */
const orderBy = (items, names) => { // listed names first in that order, the others A-Z (projects/.order.json, .maxxing.json)
  const at = new Map(names.map((n, i) => [n, i]))
  return [...items].sort((a, b) => (at.has(a.name) ? at.get(a.name) : 1e6) - (at.has(b.name) ? at.get(b.name) : 1e6) || a.name.localeCompare(b.name))
}
R('PUT', '/api/workspace/order', ({ body }) => {
  if (!Array.isArray(body.names)) fail(422, 'invalid', 'names must be a list')
  S.projects = orderBy(S.projects, body.names.map(String)); bus('workspace')
  return { projects: S.projects.map((p) => p.name) }
})
R('PUT', '/api/workspace/projects/:project/order', ({ params, body }) => {
  const p = S.projects.find((x) => x.name === params.project) || fail(404, 'not_found', 'Unknown project')
  if (!Array.isArray(body.names)) fail(422, 'invalid', 'names must be a list')
  p.topics = orderBy(p.topics, body.names.map(String)); bus('workspace')
  return { topics: p.topics.map((t) => t.name) }
})
R('GET', '/api/crons/:id', ({ params }) => cronOut(S.crons.find((x) => x.id === params.id) || fail(404, 'not_found', 'Cron not found')))
R('POST', '/api/backup/preview', async ({ body }) => {
  if (!S.backup.configured) fail(409, 'not_configured', 'Configure the backup repository first')
  await sleep(900)
  const files = [...S.fs.entries()].filter(([, n]) => n.type === 'file').map(([k]) => k.slice(ROOT.length + 1)).filter((k) => /(^|\/)(CLAUDE|memory)\.md$|^tasks\.json$/.test(k)).sort()
  const paths = { create: ['projects/acme/topics/newsletter/memory.md'], replace: files.filter((f) => f.endsWith('memory.md')).slice(0, 3), unchanged: files.filter((f) => !f.endsWith('memory.md')),
    held: ['extensions/shop-sales/api.py'], skip: [] }
  return { ok: true, commit: (body.ref && /^[0-9a-f]{7,40}$/.test(body.ref) ? body.ref : S.backup.history.filter((h) => h.ok).at(-1)?.commit || sha().slice(0, 7)).padEnd(40, '0'), hold: true,
    counts: Object.fromEntries(Object.entries(paths).map(([k, v]) => [k, v.length])), paths, settings: true, crons: true, mcp: false }
})
R('GET', '/api/search/stats', () => ({ counts: { session: S.sessions.length, file: [...S.fs.values()].filter((n) => n.type === 'file').length,
  memory: [...S.fs.keys()].filter((k) => k.endsWith('/memory.md')).length, task: S.tasks.tasks.length }, bytes: 3.4e6, refreshed_at: now() - 4 * MIN }))
// Incoming webhook: the token is the permission. Signatures are not verified in the mock; the rules of a missing secret are.
R('POST', '/api/hooks/:token', ({ params, body }) => {
  const h = S.feed.hooks.find((x) => x.token === params.token) || fail(404, 'not_found', 'Unknown hook')
  if (h.kind !== 'generic' && !h.secret) fail(401, 'secret_required', `A ${h.kind} hook needs its signing secret`)
  if (typeof body !== 'object' || Array.isArray(body)) fail(400, 'bad_payload', 'Unexpected payload')
  const title = h.kind === 'generic' ? String(body.title || 'Webhook') : h.kind === 'stripe' ? String(body.type || 'stripe event') : h.kind === 'github' ? 'GitHub event' : 'Shopify event'
  const e = feedAdd(S, { source: h.name, kind: 'webhook', level: ['info', 'success', 'warning', 'error'].includes(body.level) ? body.level : 'info', title: title.slice(0, 200), body: String(body.body || '').slice(0, 2000) })
  bus('feed')
  return { ok: true, duplicate: false, id: e.id }
}, { public: true, csrf: false }) // called by Stripe, GitHub…: no cookie, no CSRF header

/* ---- dashboard & extensions */
R('GET', '/api/dashboard', () => dashboard())
R('GET', '/api/dashboard/widgets/:id', async ({ params, q }) => {
  const d = widgetDefs().find((x) => x.id === params.id) || fail(404, 'not_found', 'Unknown widget')
  if (q.get('force') === '1') {
    await sleep(params.id === 'uptime' ? 900 : 300)
    S.widgetUpdated[d.id] = now()
    if (d.id === 'uptime') S.uptimeFixed = true
  }
  return renderWidget(d)
})
R('PUT', '/api/dashboard/layout', ({ body }) => {
  if (!Array.isArray(body.order) || !Array.isArray(body.hidden)) fail(422, 'invalid', 'order and hidden must be lists')
  S.layout = { order: body.order.map(String), hidden: body.hidden.map(String) }
  return { ok: true }
})
// Access of a widget or page (API.md, Permissions): what it may use now and what waits for the user.
function extAccess(e) {
  if (!e || (e.type !== 'widget' && e.type !== 'page')) return null
  const g = S.extPerms.grants[e.id] || { secrets: {}, refused: null, denied: [] }
  const legacy = S.extPerms.legacy.includes(e.id)
  const refused = !!g.refused
  const state = e.permissions ? 'declared' : legacy ? 'legacy' : 'undeclared'
  const secrets = e.permissions
    ? e.permissions.secrets.map((name) => { const x = g.secrets[name]; return { name, status: refused ? 'refused' : x ? 'allowed' : 'pending', how: x?.how ?? null, at: x?.at ?? null } })
    : state === 'legacy' ? Object.entries(g.secrets).map(([name, x]) => ({ name, status: refused ? 'refused' : 'allowed', how: x.how, at: x.at })) : []
  return {
    state, secrets, refused,
    legacy: { secrets: Object.entries(g.secrets).filter(([, x]) => x.how === 'legacy').map(([name, x]) => ({ name, at: x.at })) },
    pending: secrets.some((x) => x.status === 'pending'),
    denied: g.denied || [],
  }
}
const extPermDetail = (e) => {
  const a = extAccess(e)
  const base = e.permissions || { network: [], secrets: [], read: [] }
  const keep = a.legacy.secrets.map((x) => x.name).filter((n) => !base.secrets.includes(n))
  return { id: e.id, name: e.name, type: e.type, permissions: e.permissions ?? null, access: a, suggested: { ...base, secrets: [...base.secrets, ...keep] } }
}
const permTarget = (id) => {
  const e = S.extensions.find((x) => x.id === id)
  if (!e || (e.type !== 'widget' && e.type !== 'page')) fail(404, 'not_found', `no widget or page extension ${id}`)
  return e
}
R('GET', '/api/extensions/permissions', () => ({ since: S.extPerms.since, items: S.extensions.filter((e) => e.type === 'widget' || e.type === 'page').sort((a, b) => a.id.localeCompare(b.id)).map(extPermDetail) }))
R('GET', '/api/extensions/:id/permissions', ({ params }) => extPermDetail(permTarget(params.id)))
R('POST', '/api/extensions/:id/consent', ({ params, body }) => {
  const e = permTarget(params.id)
  if (!['always', 'deny', 'reset'].includes(body.decision)) fail(422, 'invalid', 'decision must be always, deny or reset')
  const g = (S.extPerms.grants[e.id] ||= { secrets: {}, refused: null, denied: [] })
  if (body.decision === 'always') {
    if (!e.permissions) fail(400, 'not_declared', 'this extension declares no "permissions": nothing to allow')
    for (const n of e.permissions.secrets) g.secrets[n] ||= { at: now(), how: 'accepted' }
    g.refused = null
  } else {
    g.secrets = Object.fromEntries(Object.entries(g.secrets).filter(([, x]) => x.how === 'legacy'))
    g.refused = body.decision === 'deny' ? now() : null
  }
  bus('extensions')
  return { ok: true, access: extAccess(e) }
})
// `origin`: the session that made it while it exists and is not archived (extfix.origin)
const extOrigin = (e) => {
  const s = e.origin_session && S.sessions.find((x) => x.id === e.origin_session && !x.archived)
  return s ? { id: s.id, title: s.title, path: s.path } : null
}
R('GET', '/api/extensions', () => S.extensions.map(({ origin_session, ...e }) => ({ ...e, origin: extOrigin({ origin_session }), access: extAccess(e) })))
// "Ask for a fix" (extfix.py): the message, sent to the session that made it or to a new system/harness session
R('POST', '/api/extensions/:id/fix', ({ params, body }) => {
  const e = S.extensions.find((x) => x.id === params.id) || fail(404, 'not_found', `no extension ${params.id}`)
  const seen = body.error && String(body.error.message || '').trim()
  const errs = [...(e.error ? [`- does not load: ${e.error}`] : []), ...(seen && !(e.runtime_errors || []).some((r) => r.message === seen) ? [`- the error I see: ${seen}`] : []),
    ...(e.runtime_errors || []).slice(0, 3).flatMap((r) => [`- ${r.where}: ${r.message}`, ...r.stack.split('\n').slice(0, 6).map((l) => `    ${l}`)])]
  const dir = `${ROOT}/extensions/${e.id}`
  const prompt = [`My ${e.type} extension \`${e.id}\` ("${e.name}", folder ${dir}) is broken. Fix it.`, '', 'What broke:', ...(errs.length ? errs : ['- the error I see: (no error message was recorded)']), '',
    'Files:', `- ${dir}/manifest.json`, ...(e.has_api ? [`- ${dir}/api.py`] : []), ...(e.type === 'page' ? [`- ${dir}/page.js`] : []), '',
    `Use the skill ${e.type === 'block' ? 'pilot-blocks' : 'pilot-widgets-pages'}. Run \`pilot ext check ${e.id} --json\` first (its \`runtime_errors\` list what broke while I used it), fix the files of this extension only, run the check again until it exits 0, then tell me in two or three plain sentences what was wrong and what you changed.`].join('\n')
  const origin = extOrigin(e)
  if (body.dry_run) return { prompt, target: origin ? { session: origin } : { topic: UPDATE_TOPIC } }
  if (origin) {
    const s = findSession(origin.id)
    if (s.state === 'running') { (S.queues[s.id] ||= []).push({ text: prompt, attachments: [] }); s.queue = S.queues[s.id].length; bus('sessions') }
    else startTurn(s, prompt, [])
    return { session: s, reused: true }
  }
  return { session: updateSession(`Fix the extension ${e.name}`, prompt), reused: false }
})
installBlocks({ R, state: () => S, fail, bus })
installAtelier({
  R, state: () => S, fail, bus, now,
  // request-change: continue the draft's session (queued while it runs), else a new session in its topic
  sendMessage: (sid, path, text, title) => {
    const s = sid && S.sessions.find((x) => x.id === sid)
    if (s) {
      if (s.archived) s.archived = false
      if (s.state === 'running') {
        (S.queues[s.id] ||= []).push({ text, attachments: [] })
        s.queue = S.queues[s.id].length
        bus('sessions')
        return { session: s, created: false, queued: true }
      }
      startTurn(s, text, [])
      return { session: s, created: false, queued: false }
    }
    const t = now()
    const n = { id: uuid(), title, path, state: 'idle', queue: 0, created: t, updated: t, turns: 0, cost_usd: 0, model: '', real_model: null, context_tokens: null, context_window: null, archived: false, notify: false, source: 'web', unread: false, last_text: '', error: null }
    S.sessions.push(n); S.events[n.id] = []
    startTurn(n, text, [])
    bus('sessions', 'workspace')
    return { session: n, created: true, queued: false }
  },
})
// The extensions' own API (`/api/ext/<id>[/<path>]`, forwarded to their api.py `handle()` on the server): the two
// seeded extensions answer like their example code; a LookupError is 404, a ValueError 400.
const EXT_HANDLERS = {
  notes: (method, p, body) => {
    if (p === 'hello') return { hello: 'world', method, at: now() }
    if (p === 'notes' && method === 'GET') return { notes: (S.extNotes ||= [{ id: 1, text: 'Call the printer about the flyers', at: now() - DAY }]) }
    if (p === 'notes' && method === 'POST') {
      const text = String(body.text || '').trim()
      if (!text) fail(400, 'bad_request', 'text is required')
      const n = { id: (S.extNotes ||= []).length + 1, text: text.slice(0, 2000), at: now() }
      S.extNotes.push(n)
      return n
    }
    fail(404, 'not_found', `No ${method} ${p || '/'} in this extension`)
  },
  'shop-sales': (method, p) => {
    if (p === '' || p === 'summary') return { orders_today: 37, revenue_today: 2184.5, currency: 'EUR', unfulfilled: 4, at: now() }
    fail(404, 'not_found', `No ${method} ${p || '/'} in this extension`)
  },
}
for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) for (const pattern of ['/api/ext/:id', '/api/ext/:id/*']) R(method, pattern, ({ params, req, body }) => {
  const e = S.extensions.find((x) => x.id === params.id)
  if (!e || !e.has_api) fail(404, 'not_found', 'Unknown extension')
  if (!e.enabled) fail(409, 'disabled', 'Extension is disabled')
  const p = params.rest || ''
  if (p.split('/').some((x) => x === '.' || x === '..')) fail(400, 'bad_path', 'No . or .. in the path')
  const handler = EXT_HANDLERS[e.id] || (() => fail(500, 'extension_error', e.error || 'The extension failed'))
  return handler(req.method, p, body || {})
})
R('PATCH', '/api/extensions/:id', ({ params, body }) => {
  // an extension of the Atelier's seeded rows (web/mock/atelier.mjs) is turned on / off there too
  const known = atelierHasExtension(S, params.id)
  const e = S.extensions.find((x) => x.id === params.id) || (known ? null : fail(404, 'not_found', 'Unknown extension'))
  if (typeof body.enabled !== 'boolean') fail(422, 'invalid', 'enabled must be a boolean')
  if (body.enabled && e?.error) fail(409, 'broken', `Cannot enable: ${e.error}`)
  if (e) e.enabled = body.enabled
  if (known) {
    atelierSetEnabled(S, params.id, body.enabled)
    bus('atelier')
  }
  bus('extensions')
  return { ok: true }
})
// Runtime errors (exterrors.py): the browser's reports, kept 10 per extension, the same message bumps its count
R('POST', '/api/extensions/:id/errors', ({ params, body }) => {
  const e = S.extensions.find((x) => x.id === params.id) || fail(404, 'not_found', `no extension ${params.id}`)
  if (!['widget', 'page'].includes(body.where)) fail(422, 'invalid', 'where must be widget or page')
  const message = String(body.message || '').slice(0, 500)
  if (!message) fail(422, 'invalid', 'message is required')
  const lines = String(body.stack || '').split('\n').map((l) => l.trim().replace(/https?:\/\/[^/\s)]+\/ext\/[^/]+\/(?:@[^/]+\/)?/g, '')).filter(Boolean)
  const stack = (lines[0] === message ? lines.slice(1) : lines).slice(0, 6).join('\n')
  const errs = (e.runtime_errors ||= [])
  if (errs[0] && errs[0].where === body.where && errs[0].message === message) Object.assign(errs[0], { at: now(), count: errs[0].count + 1, stack: stack || errs[0].stack })
  else errs.unshift({ where: body.where, message, stack, at: now(), count: 1 })
  errs.splice(10)
  bus('extensions')
  return { ok: true, error: errs[0] }
})
R('DELETE', '/api/extensions/:id/errors', ({ params }) => {
  const e = S.extensions.find((x) => x.id === params.id) || fail(404, 'not_found', `no extension ${params.id}`)
  e.runtime_errors = []
  bus('extensions')
  return { ok: true }
})
R('POST', '/api/extensions/reload', async () => { await sleep(400); bus('extensions'); return { ok: true, count: S.extensions.length } })
for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
  R(m, '/api/ext/:id/*', ({ params, req, body, q }) => {
    const e = S.extensions.find((x) => x.id === params.id)
    if (!e || !e.has_api) fail(404, 'not_found', 'Unknown extension')
    if (!e.enabled) fail(409, 'disabled', 'Extension is disabled')
    if (e.error) fail(500, 'extension_error', e.error)
    if (e.id === 'notes' && params.rest === 'hello') return { hello: 'world', at: now() }
    if (e.id === 'notes') return { method: req.method, path: params.rest, query: Object.fromEntries(q), body }
    if (e.id === 'shop-sales' && params.rest === 'orders') return { orders: [{ id: 1042, total: 89, currency: 'EUR' }, { id: 1041, total: 34.5, currency: 'EUR' }] }
    fail(404, 'not_found', 'Unknown extension route')
  })
}

/* =================================================================== feed (notifications) + web push */
// docs/dev/API.md#feed-notifications and #web-push. In-memory: S.feed = {events, nextId, settings, hooks}, S.push.
const FEED_CATEGORIES = ['sessions', 'crons', 'system', 'webhooks']
const FEED_OWN_THREAD = ['crons', 'system', 'security', 'sessions']
const FEED_BUILTIN = { crons: 'Cron jobs', system: 'harness-pilot', security: 'Sign-ins', sessions: 'Sessions' }
const FEED_RULES = ['auto', 'off', 'silent', 'loud']
const FEED_LEVELS = ['info', 'success', 'warning', 'error']
// kind -> [source, typical level] (same order as the server's registry)
const FEED_KINDS = {
  'session.done': ['sessions', 'success'], 'session.failed': ['sessions', 'error'], 'discussion.paused': ['sessions', 'warning'],
  'cron.succeeded': ['crons', 'success'], 'cron.failed': ['crons', 'error'],
  'update.available': ['system', 'info'], 'update.attention': ['system', 'warning'], 'update.review': ['system', 'info'],
  'update.started': ['system', 'info'], 'update.broken': ['system', 'warning'], 'claude.updated': ['system', 'success'],
  'claude.update_failed': ['system', 'error'], 'deps.vulnerable': ['system', 'warning'], 'deps.update_failed': ['system', 'warning'],
  'health.issue': ['system', 'warning'],
  'signin.ok': ['security', 'info'], 'signin.failed': ['security', 'warning'], 'signin.denied': ['security', 'warning'],
  'webhook.refused': ['security', 'warning'], 'backup.restore_held': ['security', 'warning'],
  'infra.down': ['infra', 'error'], 'infra.up': ['infra', 'success'], 'infra.cert_expiring': ['infra', 'warning'],
  'infra.domain_expiring': ['infra', 'warning'],
  'webhook.test': ['', 'info'],
  'stripe.sale': ['', 'success'], 'stripe.payment': ['', 'success'], 'stripe.refund': ['', 'warning'], 'stripe.payment_failed': ['', 'error'],
  'stripe.dispute': ['', 'error'], 'stripe.subscription_created': ['', 'success'], 'stripe.subscription_cancelled': ['', 'warning'], 'stripe.event': ['', 'info'],
  'shopify.order_created': ['', 'success'], 'shopify.order_paid': ['', 'success'], 'shopify.order_cancelled': ['', 'warning'],
  'shopify.refund': ['', 'warning'], 'shopify.stock': ['', 'info'], 'shopify.event': ['', 'info'],
  'github.ping': ['', 'success'], 'github.push': ['', 'info'], 'github.pull_request': ['', 'info'], 'github.issue': ['', 'info'],
  'github.workflow': ['', 'success'], 'github.release': ['', 'success'], 'github.star': ['', 'info'], 'github.event': ['', 'info'],
  custom: ['', 'info'],
}
const POST_ACTIONS = [/^\/api\/crons\/[A-Za-z0-9_-]{1,64}\/run$/, /^\/api\/sessions\/[A-Za-z0-9-]{1,64}\/discussion\/resume$/]
const feedCategory = (source) => (source === 'sessions' ? 'sessions' : source === 'crons' ? 'crons' : ['system', 'security', 'infra'].includes(source) ? 'system' : 'webhooks')
const feedPending = (e) => (e.level === 'warning' || e.level === 'error') && !e.read && !e.resolved_at
function feedPublic(e, detail = false) {
  const { group, occurrences, dedupe, ...rest } = e
  const out = { ...rest, category: feedCategory(e.source), pending: feedPending(e) }
  if (detail) out.occurrences = occurrences && occurrences.length ? occurrences : [{ at: e.at, title: e.title, body: e.body.slice(0, 300), params: e.params }]
  return out
}
const feedLink = (id, label, url) => ({ id, label, type: 'link', url })
const feedPost = (id, label, url) => ({ id, label, type: 'post', url })
const sessionUrl = (s) => `/sessions?path=${encodeURIComponent(s.path)}&session=${s.id}`

function feedAdd(st, ev) {
  const t = ev.at ?? now()
  const e = { id: st.feed.nextId++, at: t, source: 'custom', level: 'info', title: '', body: '', url: '', count: 1, read: false,
    kind: 'custom', params: {}, actions: [], resolved_at: null, first_at: t, group: null, occurrences: [], quiet: false, ...ev }
  if (e.group) {
    const row = st.feed.events.find((x) => x.source === e.source && x.group === e.group && x.level === e.level && !x.read && !x.resolved_at && t - x.at < DAY)
    if (row) {
      if (!row.occurrences.length) row.occurrences.push({ at: row.at, title: row.title, body: row.body.slice(0, 300), params: row.params })
      row.occurrences.unshift({ at: t, title: e.title, body: e.body.slice(0, 300), params: e.params })
      row.occurrences = row.occurrences.slice(0, 20)
      Object.assign(row, { count: row.count + 1, at: t, title: e.title, body: e.body, url: e.url, params: e.params, actions: e.actions })
      return row
    }
  }
  st.feed.events.push(e)
  st.feed.events.sort((a, b) => b.id - a.id)
  return e
}
function feedResolve(st, source, group) {
  let n = 0
  for (const e of st.feed.events) if (e.source === source && e.group === group && !e.resolved_at && (e.level === 'warning' || e.level === 'error')) { e.resolved_at = now(); n++ }
  return n
}
function feedCounts() {
  const sources = new Map(), categories = Object.fromEntries(FEED_CATEGORIES.map((c) => [c, { total: 0, unread: 0, pending: 0 }])), kinds = {}
  let unread = 0, pending = 0
  for (const e of [...S.feed.events].sort((a, b) => b.at - a.at)) {
    const p = feedPending(e) ? 1 : 0, u = e.read ? 0 : 1
    unread += u; pending += p
    const s = sources.get(e.source) || { source: e.source, total: 0, unread: 0, pending: 0 }
    s.total++; s.unread += u; s.pending += p; sources.set(e.source, s)
    const c = categories[feedCategory(e.source)]; c.total++; c.unread += u; c.pending += p
    const k = (kinds[e.kind] ||= { total: 0, unread: 0, pending: 0 }); k.total++; k.unread += u; k.pending += p
  }
  return { unread, pending, sources: [...sources.values()], categories, kinds }
}
function feedRule(kind, source, level) {
  const f = S.feed.settings
  if (f.kind_rules[kind] && f.kind_rules[kind] !== 'auto') return f.kind_rules[kind]
  return feedDefault(source, level)
}
function feedDefault(source, level) {
  const r = S.feed.settings.rules[source]
  if (r && r !== 'auto') return r
  if (FEED_OWN_THREAD.includes(source)) return 'off'
  return level === 'error' ? 'loud' : level === 'warning' ? 'silent' : 'off'
}
function feedSettings() {
  const f = S.feed.settings
  const seen = new Set(S.feed.events.map((e) => e.source))
  const names = [...Object.keys(FEED_BUILTIN), ...S.feed.hooks.map((h) => h.name)]
  for (const n of [...seen].sort()) if (!names.includes(n)) names.push(n)
  const sources = names.map((n) => ({ source: n, label: FEED_BUILTIN[n] || n, builtin: n in FEED_BUILTIN, rule: f.rules[n] || 'auto', own_thread: FEED_OWN_THREAD.includes(n) }))
  const eventKinds = Object.entries(FEED_KINDS).map(([kind, [source, level]]) => ({ kind, category: source ? feedCategory(source) : 'webhooks', source, level, builtin: true,
    rule: f.kind_rules[kind] || 'auto', default: feedDefault(source, level), own_thread: FEED_OWN_THREAD.includes(source) }))
  const extra = new Map()
  for (const e of S.feed.events) if (!(e.kind in FEED_KINDS) && !extra.has(e.kind)) extra.set(e.kind, e)
  for (const [kind, e] of extra) eventKinds.push({ kind, category: feedCategory(e.source), source: e.source, level: e.level, builtin: false, rule: f.kind_rules[kind] || 'auto',
    default: feedDefault(e.source, e.level), own_thread: FEED_OWN_THREAD.includes(e.source) })
  return { telegram: f.telegram, sources, hooks: S.feed.hooks.map(hookOut), kinds: ['stripe', 'shopify', 'github', 'generic'], rules: FEED_RULES,
    kind_rules: { ...f.kind_rules }, event_kinds: eventKinds }
}
const hookOut = (h) => ({ id: h.id, name: h.name, kind: h.kind, created: h.created, url: `https://ui.example.com/api/hooks/${h.token}`, has_secret: !!h.secret })

function seedFeed(st, t) {
  st.feed = { events: [], nextId: 1, settings: { telegram: true, rules: {}, kind_rules: {} }, hooks: [
    { id: 'h_stripe1', name: 'stripe', kind: 'stripe', created: t - 20 * DAY, token: 'tok-stripe-demo', secret: 'whsec_demo' },
    { id: 'h_shop01', name: 'acme-shop', kind: 'shopify', created: t - 9 * DAY, token: 'tok-shop-demo', secret: '' },
    { id: 'h_gh0001', name: 'github', kind: 'github', created: t - 30 * DAY, token: 'tok-gh-demo', secret: 'ghs_demo' },
  ] }
  st.push = { subs: [] }
  const add = (ev) => feedAdd(st, ev)
  const find = (title) => st.sessions.find((s) => s.title === title)
  // a Claude Code + Codex discussion paused by its turn limit (pending, with Resume)
  const disc = { id: uuid(), title: 'Compare hosting offers', path: topicPath('ops', 'server'), state: 'idle', queue: 0, created: t - 3 * HOUR, updated: t - 40 * MIN,
    turns: 12, cost_usd: 1.9, model: '', real_model: 'claude-opus-5-5', context_tokens: 64000, context_window: 1000000, archived: false, notify: false,
    source: 'web', unread: true, last_text: 'Codex: the managed option wins on maintenance, the VPS on price. Shall we write the decision record?', error: null,
    provider: 'discussion', debate_paused: true, discussion_pause_reason: 'limit', discussion_paused_at: t - 40 * MIN, discussion_turns: 12, discussion_turn_limit: 12,
    discussion_duration_seconds: null, discussion_elapsed: 22 * MIN }
  st.sessions.push(disc)
  st.events[disc.id] = conversation(disc, { last: disc.last_text, turns: disc.turns })
  // ---- three days ago
  add({ at: t - 3 * DAY - 2 * HOUR, source: 'system', level: 'success', kind: 'claude.updated', title: 'Claude Code updated to 2.4.1', body: 'From 2.4.0, while nothing was running.',
    url: '/settings/claude', params: { version: '2.4.1', previous: '2.4.0' }, read: true })
  const down = add({ at: t - 3 * DAY - HOUR, source: 'infra', level: 'error', kind: 'infra.down', title: 'Down: www.example.com', body: 'https://www.example.com/: http_502',
    url: '/infra?id=site:local:www.example.com', group: 'down:site:local:www.example.com', params: { resource_id: 'site:local:www.example.com', name: 'www.example.com', reason: 'http_502' },
    actions: [feedLink('open', 'Open', '/infra?id=site:local:www.example.com')], read: true })
  add({ at: t - 3 * DAY - 40 * MIN, source: 'infra', level: 'success', kind: 'infra.up', title: 'Back up: www.example.com', url: '/infra?id=site:local:www.example.com',
    group: 'up:site:local:www.example.com', params: { resource_id: 'site:local:www.example.com', name: 'www.example.com' }, read: true })
  down.resolved_at = t - 3 * DAY - 40 * MIN
  const oldFail = add({ at: t - 3 * DAY, source: 'crons', level: 'error', kind: 'cron.failed', title: 'Cron failed: Memory backup', body: 'fatal: unable to access (HTTP 404)',
    url: '/crons?job=c_backup', group: 'failed:c_backup', params: { cron_id: 'c_backup', name: 'Memory backup', run_id: 'r_0a1b2c3d', code: 128, duration_s: 3.1 },
    actions: [feedLink('open_run', 'Open the run', '/crons?job=c_backup&run=r_0a1b2c3d'), feedPost('rerun', 'Run again', '/api/crons/c_backup/run')] })
  oldFail.resolved_at = t - 2 * DAY - 19 * HOUR                       // the next run succeeded: unread, but no longer pending
  // ---- yesterday
  add({ at: t - DAY - 6 * HOUR, source: 'stripe', level: 'success', kind: 'stripe.sale', title: 'Sale: 49.00 EUR', body: 'customer@example.com', url: 'https://dashboard.stripe.com/payments',
    params: { amount: '49.00 EUR', email: 'customer@example.com' }, read: true })
  add({ at: t - DAY - 5 * HOUR, source: 'acme-shop', level: 'success', kind: 'shopify.order_created', title: 'New order #1042: 89.00 EUR', body: 'buyer@example.com',
    url: 'https://acme.myshopify.com/admin/orders/1042', params: { order: '#1042', amount: '89.00 EUR', email: 'buyer@example.com' } })
  add({ at: t - DAY - 4 * HOUR, source: 'system', level: 'info', kind: 'update.available', title: 'Update available: 2.0.1', body: 'Installed: 2.0.0. Open the topic ops/server and say: update.',
    url: '/sessions?path=projects/ops/topics/server', dedupe: 'update-2.0.1', params: { version: '2.0.1', current: '2.0.0', topic: 'ops/server' },
    actions: [feedLink('open', 'Open', '/sessions?path=projects/ops/topics/server')] })
  add({ at: t - DAY - 3 * HOUR, source: 'github', level: 'error', kind: 'github.workflow', title: 'CI failure - acme/website', body: 'main', url: 'https://github.com/acme/website/actions/runs/1',
    params: { repo: 'acme/website', workflow: 'CI', conclusion: 'failure', branch: 'main' } })
  add({ at: t - DAY - 2 * HOUR, source: 'security', level: 'warning', kind: 'signin.failed', title: '3 wrong passwords', body: '203.0.113.7 · Mozilla/5.0 (X11; Linux x86_64)',
    params: { count: 3, ip: '203.0.113.7', ua: 'Mozilla/5.0 (X11; Linux x86_64)' }, actions: [feedLink('open', 'Open', '/settings/security')], read: true })
  add({ at: t - DAY - HOUR, source: 'mail', level: 'warning', kind: 'custom', title: 'Invoice from ACME: 39 EUR due Friday', body: 'From billing@acme.example', dedupe: 'msg-1234' })
  // ---- today
  for (let i = 0; i < 12; i++) {
    const name = i % 3 === 0 ? 'Daily blog article' : i % 3 === 1 ? 'Memory backup' : 'Weekly SEO report'
    const cid = i % 3 === 0 ? 'c_blog' : i % 3 === 1 ? 'c_backup' : 'c_seo'
    add({ at: t - 10 * HOUR + i * 40 * MIN, source: 'crons', level: 'success', kind: 'cron.succeeded', title: 'Cron jobs succeeded', body: `${name} (${4 + i} s)`,
      url: `/crons?job=${cid}`, group: 'ok', params: { cron_id: cid, name, run_id: rid('r'), duration_s: 4 + i } })
  }
  for (let i = 0; i < 3; i++) {
    const run = rid('r')
    add({ at: t - (45 - i * 15) * MIN, source: 'crons', level: 'error', kind: 'cron.failed', title: 'Cron failed: Uptime check',
      body: 'curl: (22) The requested URL returned error: 503', url: '/crons?job=c_uptime', group: 'failed:c_uptime',
      params: { cron_id: 'c_uptime', name: 'Uptime check', run_id: run, code: 22, duration_s: 10.0 },
      actions: [feedLink('open_run', 'Open the run', `/crons?job=c_uptime&run=${run}`), feedPost('rerun', 'Run again', '/api/crons/c_uptime/run')] })
  }
  add({ at: t - 40 * MIN, source: 'sessions', level: 'warning', kind: 'discussion.paused', title: `Discussion paused: ${disc.title}`,
    body: 'The turn limit was reached (12 turns).', url: sessionUrl(disc), group: `discussion:${disc.id}`,
    params: { session_id: disc.id, title: disc.title, path: disc.path, provider: 'discussion', turns: 12, turn_limit: 12, duration_s: 2280, duration_limit_s: null },
    actions: [feedPost('resume', 'Resume', `/api/sessions/${disc.id}/discussion/resume`), feedLink('open_session', 'Open', sessionUrl(disc))] })
  add({ at: t - 35 * MIN, source: 'security', level: 'warning', kind: 'webhook.refused', title: 'Webhook acme-shop refused: no signing secret',
    body: 'Add the Shopify signing secret in Settings -> Notifications (source menu -> Set the signing secret); events are refused until then.',
    group: 'hook-secret-h_shop01', params: { hook_id: 'h_shop01', name: 'acme-shop', service: 'shopify' },
    actions: [feedLink('add_secret', 'Add the secret', '/settings/notifications?hook=h_shop01')] })
  add({ at: t - 30 * MIN, source: 'system', level: 'warning', kind: 'health.issue', title: 'Disk 91 % full (8.2 GB free)', group: 'health:3f2a9c1b7d4e',
    params: { issue_id: '3f2a9c1b7d4e', code: 'disk_full', text: 'Disk 91 % full (8.2 GB free)', level: 'warn' }, actions: [feedLink('open', 'Open', '/settings/system')] })
  const failed = find('Categorise September expenses')
  if (failed) add({ at: t - 28 * MIN, source: 'sessions', level: 'error', kind: 'session.failed', title: `Session failed: ${failed.title}`, body: failed.error || '',
    url: sessionUrl(failed), group: `session:${failed.id}`, params: { session_id: failed.id, title: failed.title, path: failed.path, provider: 'claude', error: failed.error || '' },
    actions: [feedLink('open_session', 'Open', sessionUrl(failed))] })
  for (const [title, ago] of [['Fix hero image on mobile', 62], ['Editorial calendar for November', 25]]) {
    const s = find(title)
    if (!s) continue
    for (let i = 0; i < (title.startsWith('Fix') ? 2 : 1); i++) add({ at: t - (ago - i * 5) * MIN, source: 'sessions', level: 'success', kind: 'session.done',
      title: `Session finished: ${s.title}`, body: s.last_text, url: sessionUrl(s), group: `session:${s.id}`,
      params: { session_id: s.id, title: s.title, path: s.path, provider: 'claude', turns: s.turns }, actions: [feedLink('open_session', 'Open', sessionUrl(s))] })
  }
  for (let i = 0; i < 2; i++) add({ at: t - (20 - i * 10) * MIN, source: 'security', level: 'info', kind: 'signin.ok', title: 'Signed in', body: '198.51.100.4 · Mozilla/5.0 (iPhone)',
    group: 'signin', params: { ip: '198.51.100.4', ua: 'Mozilla/5.0 (iPhone)', via: 'password' } })
}

function feedCronRun(c, run) {
  if (!S.feed) return
  if (run.ok) {
    feedResolve(S, 'crons', `failed:${c.id}`)
    feedAdd(S, { source: 'crons', level: 'success', kind: 'cron.succeeded', title: 'Cron jobs succeeded', body: `${c.name} (${run.duration_s} s)`, url: `/crons?job=${c.id}`,
      group: 'ok', params: { cron_id: c.id, name: c.name, run_id: run.id, duration_s: run.duration_s } })
  } else {
    const url = `/crons?job=${c.id}&run=${run.id}`
    feedAdd(S, { source: 'crons', level: 'error', kind: 'cron.failed', title: `Cron failed: ${c.name}`, body: run.output_tail, url: `/crons?job=${c.id}`, group: `failed:${c.id}`,
      params: { cron_id: c.id, name: c.name, run_id: run.id, code: run.code, duration_s: run.duration_s },
      actions: [feedLink('open_run', 'Open the run', url), feedPost('rerun', 'Run again', `/api/crons/${c.id}/run`)] })
  }
  bus('feed')
}

function feedActions(list) {
  if (list == null) return []
  if (!Array.isArray(list) || list.length > 4) fail(400, 'bad_action', 'At most 4 actions')
  return list.map((a) => {
    if (!a || typeof a !== 'object' || !/^[a-z0-9_-]{1,32}$/.test(String(a.id || '')) || !String(a.label || '').trim() || String(a.label).length > 60) fail(400, 'bad_action', 'Action: {id, label, type, url}')
    const url = String(a.url || '')
    if ((a.type || 'link') !== 'link' || !(/^\/(?![/\\])/.test(url) || /^https:\/\//.test(url))) fail(400, 'bad_action', 'Only link actions to an app path or an https:// URL')
    return { id: a.id, label: String(a.label).trim(), type: 'link', url }
  })
}
function feedParams(p) {
  if (p == null) return {}
  if (typeof p !== 'object' || Array.isArray(p) || Object.keys(p).length > 20) fail(400, 'bad_params', 'params: an object (20 names at most)')
  const out = {}
  for (const [k, v] of Object.entries(p)) {
    if (!/^[a-z_][a-z0-9_]{0,31}$/.test(k) || !(v === null || ['string', 'number', 'boolean'].includes(typeof v))) fail(400, 'bad_params', `params.${k}`)
    out[k] = typeof v === 'string' ? v.slice(0, 500) : v
  }
  return out
}

R('GET', '/api/feed', ({ q }) => {
  const limit = Math.max(1, Math.min(Number(q.get('limit') || 50), 200))
  const before = Number(q.get('before') || 0)
  let list = S.feed.events.filter((e) => e.at > now() - 30 * DAY)
  if (q.get('source')) list = list.filter((e) => e.source === q.get('source'))
  if (q.get('category')) list = list.filter((e) => feedCategory(e.source) === q.get('category'))
  if (q.get('kind')) list = list.filter((e) => e.kind === q.get('kind'))
  if (['1', 'true'].includes(q.get('unread'))) list = list.filter((e) => !e.read)
  if (['1', 'true'].includes(q.get('pending'))) list = list.filter(feedPending)
  if (before) list = list.filter((e) => e.id < before)
  list.sort((a, b) => b.id - a.id)
  return { events: list.slice(0, limit).map((e) => feedPublic(e)), more: list.length > limit, ...feedCounts() }
})
R('GET', '/api/feed/summary', () => feedCounts())
R('GET', '/api/feed/settings', () => feedSettings())
R('PUT', '/api/feed/settings', ({ body }) => {
  const f = S.feed.settings
  for (const key of ['rules', 'kind_rules']) {
    if (body[key] == null) continue
    for (const [k, v] of Object.entries(body[key])) {
      if (!FEED_RULES.includes(v)) fail(400, 'bad_rule', `Rule: ${FEED_RULES.join(', ')}`)
      if (v === 'auto') delete f[key][k]; else f[key][k] = v
    }
  }
  if (typeof body.telegram === 'boolean') f.telegram = body.telegram
  bus('feed')
  return feedSettings()
})
R('POST', '/api/feed/read', ({ body }) => {
  for (const e of S.feed.events) if (body.all || (body.source && e.source === body.source) || (Array.isArray(body.ids) && body.ids.includes(e.id))) e.read = true
  bus('feed')
  const c = feedCounts()
  return { unread: c.unread, pending: c.pending }
})
R('POST', '/api/feed/resolve', ({ body }) => {
  if (!Array.isArray(body.ids)) fail(422, 'invalid', 'ids must be a list')
  for (const e of S.feed.events) if (body.ids.includes(e.id) && !e.resolved_at) e.resolved_at = now()
  bus('feed')
  return { pending: feedCounts().pending }
})
R('POST', '/api/feed', ({ body }) => {
  const title = String(body.title || '').trim()
  if (!title) fail(400, 'empty', 'An event needs a title')
  const level = body.level || 'info'
  if (!FEED_LEVELS.includes(level)) fail(400, 'bad_level', `Level: ${FEED_LEVELS.join(', ')}`)
  const kind = body.kind || 'custom'
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(kind) || (kind in FEED_KINDS && FEED_KINDS[kind][0] !== '')) fail(400, 'bad_kind', 'This kind is reserved')
  const source = String(body.source || 'custom').toLowerCase()
  if (body.dedupe && S.feed.events.some((e) => e.source === source && e.dedupe === body.dedupe)) return { event: null, duplicate: true }
  const ev = feedAdd(S, { source, level, title, body: String(body.body || ''), url: String(body.url || ''), dedupe: body.dedupe || undefined, group: body.group || null,
    kind, params: feedParams(body.params), actions: feedActions(body.actions), quiet: body.quiet === true })
  bus('feed')
  return { event: feedPublic(ev), duplicate: false }
})
R('GET', '/api/feed/:id', ({ params }) => {
  const e = S.feed.events.find((x) => x.id === Number(params.id)) || fail(404, 'not_found', 'No such event')
  return { event: feedPublic(e, true) }
})
R('DELETE', '/api/feed/:id', ({ params }) => {
  S.feed.events = S.feed.events.filter((x) => x.id !== Number(params.id))
  bus('feed')
  return { ok: true }
})
R('POST', '/api/feed/hooks', ({ body }) => {
  if (!['stripe', 'shopify', 'github', 'generic'].includes(body.kind)) fail(400, 'bad_kind', 'Kind: stripe, shopify, github, generic')
  const name = String(body.name || body.kind).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').slice(0, 40)
  if (name in FEED_BUILTIN) fail(409, 'reserved', `${name} is a built-in source`)
  if (S.feed.hooks.some((h) => h.name === name)) fail(409, 'exists', `A source named ${name} already exists`)
  const h = { id: crypto.randomBytes(4).toString('hex'), name, kind: body.kind, created: now(), token: crypto.randomBytes(18).toString('base64url'), secret: String(body.secret || '') }
  S.feed.hooks.push(h); bus('feed')
  return hookOut(h)
})
R('PATCH', '/api/feed/hooks/:id', ({ params, body }) => {
  const h = S.feed.hooks.find((x) => x.id === params.id) || fail(404, 'not_found', 'Unknown source')
  if (typeof body.secret === 'string') h.secret = body.secret.trim()
  if (body.regenerate) h.token = crypto.randomBytes(18).toString('base64url')
  if (h.secret) feedResolve(S, 'security', `hook-secret-${h.id}`)
  bus('feed')
  return hookOut(h)
})
R('DELETE', '/api/feed/hooks/:id', ({ params }) => {
  const h = S.feed.hooks.find((x) => x.id === params.id) || fail(404, 'not_found', 'Unknown source')
  S.feed.hooks = S.feed.hooks.filter((x) => x !== h)
  feedResolve(S, 'security', `hook-secret-${h.id}`)
  bus('feed')
  return { ok: true }
})
R('POST', '/api/feed/hooks/:id/test', ({ params }) => {
  const h = S.feed.hooks.find((x) => x.id === params.id) || fail(404, 'not_found', 'Unknown source')
  const ev = feedAdd(S, { source: h.name, level: 'info', kind: 'webhook.test', title: `Test from ${h.name}`, body: 'If you can read this, the source works.', params: { name: h.name } })
  bus('feed')
  return { event: feedPublic(ev) }
})
R('POST', '/api/sessions/:id/discussion/resume', ({ params }) => {
  const s = S.sessions.find((x) => x.id === params.id) || fail(404, 'not_found', 'Session not found')
  if (!['discussion', 'debate'].includes(s.provider)) fail(400, 'unsupported', 'Only agent conversations can be resumed.')
  if (!s.debate_paused) fail(409, 'not_paused', 'The conversation is not paused.')
  // after a limit pause: a new period only while a limit is still reached (API.md "Discussion periods")
  const reached = (s.discussion_turn_limit && s.discussion_turns >= s.discussion_turn_limit) || (s.discussion_duration_seconds && (s.discussion_elapsed || 0) >= s.discussion_duration_seconds)
  if (s.discussion_pause_reason === 'limit' && reached) Object.assign(s, { discussion_turns: 0, discussion_elapsed: 0 })
  Object.assign(s, { debate_paused: false, discussion_pause_reason: null, discussion_paused_at: null, updated: now() })
  feedResolve(S, 'sessions', `discussion:${s.id}`)
  bus('sessions', 'feed')
  return s
})
R('POST', '/api/sessions/:id/discussion/pause', ({ params }) => {
  const s = S.sessions.find((x) => x.id === params.id) || fail(404, 'not_found', 'Session not found')
  if (!['discussion', 'debate'].includes(s.provider)) fail(400, 'unsupported', 'Only agent conversations can be paused.')
  Object.assign(s, { debate_paused: true, discussion_pause_reason: 'user', discussion_paused_at: s.debate_paused ? s.discussion_paused_at : now(), updated: now() })
  bus('sessions')
  return s
})
R('PATCH', '/api/sessions/:id/discussion', ({ params, body }) => {
  const s = S.sessions.find((x) => x.id === params.id) || fail(404, 'not_found', 'Session not found')
  if (!['discussion', 'debate'].includes(s.provider)) fail(400, 'unsupported', 'Only agent conversations have limits.')
  const ok = (v, hi) => v === null || (Number.isInteger(v) && v >= 1 && v <= hi)
  if ('turn_limit' in body && !ok(body.turn_limit, 200)) fail(422, 'invalid', 'turn_limit: 1-200')
  if ('duration_minutes' in body && !ok(body.duration_minutes, 1440)) fail(422, 'invalid', 'duration_minutes: 1-1440')
  if ('turn_limit' in body) s.discussion_turn_limit = body.turn_limit
  if ('duration_minutes' in body) s.discussion_duration_seconds = body.duration_minutes === null ? null : body.duration_minutes * 60
  s.updated = now()
  bus('sessions')
  return s
})

// ---- web push (the mock never sends anything: /test answers ok)
const PUSH_KEY = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'
const pushOut = (p) => ({ id: p.id, endpoint: p.endpoint, label: p.label, created: p.created, last_ok: p.last_ok, last_error: p.last_error, prefs: p.prefs })
function pushPrefs(p, base = { levels: ['warning', 'error'], sound: true, kinds: {}, sources: {} }) {
  if (p == null) return clone(base)
  if (typeof p !== 'object' || Array.isArray(p)) fail(400, 'bad_prefs', 'prefs: {levels, sound, kinds, sources}')
  const levels = p.levels ?? base.levels, sound = p.sound ?? base.sound ?? true
  if (!Array.isArray(levels) || levels.some((l) => !FEED_LEVELS.includes(l))) fail(400, 'bad_prefs', 'prefs.levels')
  if (typeof sound !== 'boolean') fail(400, 'bad_prefs', 'prefs.sound')
  // kinds / sources: {<name>: {enabled, sound}} (a bare boolean = enabled with the default sound)
  const entries = (name, map) => {
    if (typeof map !== 'object' || map === null || Array.isArray(map)) fail(400, 'bad_prefs', `prefs.${name}`)
    const out = {}
    for (const [k, v] of Object.entries(map)) {
      if (typeof v === 'boolean') { out[k] = { enabled: v, sound }; continue }
      if (!v || typeof v !== 'object' || typeof (v.enabled ?? true) !== 'boolean' || typeof (v.sound ?? sound) !== 'boolean') fail(400, 'bad_prefs', `prefs.${name}.${k}: {enabled, sound}`)
      out[k] = { enabled: v.enabled ?? true, sound: v.sound ?? sound }
    }
    return out
  }
  return { levels: FEED_LEVELS.filter((l) => levels.includes(l)), sound, kinds: entries('kinds', p.kinds ?? base.kinds ?? {}), sources: entries('sources', p.sources ?? base.sources ?? {}) }
}
R('GET', '/api/push', () => ({ available: true, public_key: PUSH_KEY, subscriptions: S.push.subs.map(pushOut) }))
R('POST', '/api/push/subscriptions', ({ body }) => {
  if (!/^https:\/\//.test(String(body.endpoint || '')) || !body.keys || !body.keys.p256dh || !body.keys.auth) fail(400, 'bad_subscription', 'endpoint (https) and keys {p256dh, auth}')
  let p = S.push.subs.find((x) => x.endpoint === body.endpoint)
  if (!p) { p = { id: crypto.randomBytes(6).toString('hex'), endpoint: body.endpoint, label: '', created: now(), last_ok: null, last_error: null, prefs: pushPrefs(null) }; S.push.subs.push(p) }
  // (the real server also checks that keys are a P-256 point and a 16-byte secret)
  p.keys = body.keys
  if (typeof body.label === 'string') p.label = body.label.slice(0, 80)
  if (body.prefs != null) p.prefs = pushPrefs(body.prefs, p.prefs)
  return pushOut(p)
})
R('PATCH', '/api/push/subscriptions/:id', ({ params, body }) => {
  const p = S.push.subs.find((x) => x.id === params.id) || fail(404, 'not_found', 'Unknown subscription')
  if (typeof body.label === 'string') p.label = body.label.slice(0, 80)
  if (body.prefs != null) p.prefs = pushPrefs(body.prefs, p.prefs)
  return pushOut(p)
})
R('DELETE', '/api/push/subscriptions/:id', ({ params }) => {
  S.push.subs = S.push.subs.filter((x) => x.id !== params.id)
  return { ok: true }
})
R('POST', '/api/push/subscriptions/:id/test', ({ params }) => {
  const p = S.push.subs.find((x) => x.id === params.id) || fail(404, 'not_found', 'Unknown subscription')
  p.last_ok = now()
  return { ok: true, status: 201 }
})

/* =================================================================== http plumbing */
function cookieToken(req) {
  const m = /(?:^|;\s*)mx_session=([^;]+)/.exec(req.headers.cookie || '')
  return m ? m[1] : null
}
function newToken() { const tk = crypto.randomBytes(24).toString('hex'); S.tokens.add(tk); return tk }
function setCookie(res, tk) { res.setHeader('Set-Cookie', `mx_session=${tk}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`) }
const isAuthed = (req) => !S.setup_required && (S.autoAuth || S.tokens.has(cookieToken(req)))

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0
    req.on('data', (c) => { n += c.length; if (n > 200 * 1024 * 1024) { reject(new HttpError(413, 'too_large', 'Body too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
function parseMultipart(buf, ctype) {
  const m = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/)
  if (!m || !buf.length) return []
  const b = Buffer.from('--' + (m[1] || m[2]))
  const files = []
  let pos = buf.indexOf(b)
  while (pos !== -1) {
    const start = pos + b.length
    if (buf.subarray(start, start + 2).toString() === '--') break
    const hEnd = buf.indexOf('\r\n\r\n', start)
    if (hEnd === -1) break
    const headers = buf.subarray(start + 2, hEnd).toString()
    const next = buf.indexOf(b, hEnd + 4)
    if (next === -1) break
    const data = buf.subarray(hEnd + 4, next - 2)
    const fn = headers.match(/filename="([^"]*)"/)
    const ct = headers.match(/content-type:\s*([^\r\n]+)/i)
    if (fn && fn[1]) files.push({ name: path.basename(fn[1]).replace(/[^\w.\- ]/g, '_'), data: Buffer.from(data), mime: ct ? ct[1].trim() : mimeOf(fn[1]) })
    pos = next
  }
  return files
}
function sendJson(res, status, obj) {
  if (res.headersSent) return
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

async function handleApi(req, res, url) {
  const p = url.pathname
  const candidates = routes.filter((r) => r.re.test(p))
  if (!candidates.length) return sendJson(res, 404, { error: 'not_found', message: `No route for ${p}` })
  const route = candidates.find((r) => r.method === req.method)
  if (!route) return sendJson(res, 405, { error: 'method_not_allowed', message: `${req.method} not allowed on ${p}` })
  if (req.method !== 'GET' && route.csrf && req.headers['x-maxxing'] !== '1') return sendJson(res, 403, { error: 'csrf', message: 'Missing X-Maxxing header' })
  const authed = isAuthed(req)
  if (!route.public && !authed) return sendJson(res, 401, { error: 'auth_required', message: 'Please log in' })
  const m = route.re.exec(p)
  const params = {}
  route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]) })
  let rawBody = Buffer.alloc(0), body = {}
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    rawBody = await readBody(req)
    const ct = req.headers['content-type'] || ''
    if (rawBody.length && !ct.startsWith('multipart/')) {
      try { body = JSON.parse(rawBody.toString('utf8')) } catch { return sendJson(res, 400, { error: 'bad_json', message: 'Request body is not valid JSON' }) }
      if (body === null || typeof body !== 'object') body = {}
    }
  }
  const out = await route.handler({ req, res, q: url.searchParams, params, body, rawBody, authed })
  if (out === RAW) return
  sendJson(res, 200, out)
}

function serveStatic(req, res, url) {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end(`web/dist is missing (${DIST}). Run "npm run build" in web/ — or use "npm run dev" with MAXXING_API=http://127.0.0.1:${PORT}.\n`)
  }
  let rel
  try { rel = decodeURIComponent(url.pathname) } catch { rel = '/' }
  const file = path.resolve(DIST, '.' + path.posix.normalize(rel))
  if (file.startsWith(DIST + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const immutable = rel.startsWith('/assets/')
    res.writeHead(200, { 'Content-Type': mimeOf(file) + (isText(mimeOf(file)) ? '; charset=utf-8' : ''), 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' })
    return fs.createReadStream(file).pipe(res)
  }
  if (rel.startsWith('/assets/')) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found') }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  fs.createReadStream(path.join(DIST, 'index.html')).pipe(res)
}

// Page modules, like api/extensions.py: /ext/<id>/[@<version>/]<path> (page.js and the .js .mjs .css .json files of
// the folder it imports; the version segment is ignored).
const EXT_MODULE_TYPES = { js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json' }
function serveExt(req, res, url) {
  const m = /^\/ext\/([a-z0-9][a-z0-9-]*)\/(?:@[^/]+\/)?((?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.(js|mjs|css|json))$/.exec(url.pathname)
  if (!isAuthed(req)) return sendJson(res, 401, { error: 'auth_required', message: 'Please log in' })
  const e = m && S.extensions.find((x) => x.id === m[1] && x.type === 'page')
  if (!e) return sendJson(res, 404, { error: 'not_found', message: 'Unknown extension page' })
  if (!e.enabled) return sendJson(res, 404, { error: 'not_found', message: `no page for extension ${e.id}` })
  const n = S.fs.get(`${ROOT}/extensions/${e.id}/${m[2]}`)
  if (!n && m[2] !== 'page.js') return sendJson(res, 404, { error: 'not_found', message: `${m[2]} is not a module of extension ${e.id}` })
  res.writeHead(200, { 'Content-Type': `${EXT_MODULE_TYPES[m[3]]}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  // MOCK_EXT_BROKEN=1: the Notes page's module does not parse (the page's error state, Ask for a fix)
  if (process.env.MOCK_EXT_BROKEN && e.id === 'notes' && m[2] === 'page.js') return res.end('export function mount(el) {\n  const rows = ;\n}\n')
  res.end(n ? n.content : NOTES_PAGE_JS)
}

function resetScenario(name) {
  for (const id of Object.keys(S?.timers || {})) for (const h of S.timers[id]) clearTimeout(h)
  GEN++
  S = buildState(name)
  startMaxxing()
  for (const set of sessionSubs.values()) for (const r of set) r.end()
  sessionSubs.clear()
  bus('sessions', 'workspace', 'tasks', 'crons', 'telegram', 'backup', 'health', 'extensions', 'feed')
}

const server = http.createServer(async (req, res) => {
  const t0 = process.hrtime.bigint()
  let url
  try { url = new URL(req.url, 'http://localhost') } catch { res.writeHead(400); return res.end() }
  res.on('close', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    console.log(`${req.method} ${url.pathname}${url.search} ${res.statusCode} ${ms.toFixed(0)}ms`)
  })
  try {
    if (url.pathname === '/__mock/scenario') {
      if (req.method === 'GET') return sendJson(res, 200, { name: S.scenario, scenarios: SCENARIOS })
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed', message: 'Use POST' })
      let name
      try { name = JSON.parse((await readBody(req)).toString() || '{}').name } catch { name = null }
      if (!SCENARIOS.includes(name)) return sendJson(res, 422, { error: 'invalid', message: `name must be one of ${SCENARIOS.join(', ')}` })
      resetScenario(name)
      return sendJson(res, 200, { ok: true, name })
    }
    if (url.pathname === '/__mock/bus' && req.method === 'POST') { // emit a bus event, e.g. {"topics":["sessions","workspace"]}
      let topics
      try { topics = JSON.parse((await readBody(req)).toString() || '{}').topics } catch { topics = null }
      if (!Array.isArray(topics) || !topics.length) return sendJson(res, 422, { error: 'invalid', message: 'topics must be a non-empty list' })
      bus(...topics)
      return sendJson(res, 200, { ok: true })
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/api') return await handleApi(req, res, url)
    if (url.pathname.startsWith('/ext/_blocks/')) return serveBlockFrame(req, res, url, isAuthed(req), () => S)
    if (url.pathname.startsWith('/ext/_drafts/')) return serveDraftFrame(req, res, url, isAuthed(req), () => S)
    if (url.pathname.startsWith('/ext/')) return serveExt(req, res, url)
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed', message: 'Static files are read-only' })
    return serveStatic(req, res, url)
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.error, message: e.message })
    console.error(e)
    return sendJson(res, 500, { error: 'internal', message: String(e && e.message || e) })
  }
})

const initial = SCENARIOS.includes(process.env.MOCK_SCENARIO) ? process.env.MOCK_SCENARIO : 'ready'
S = buildState(initial)
startMaxxing()
server.listen(PORT, HOST, () => {
  console.log(`[mock] harness-pilot mock API on http://${HOST}:${PORT} — scenario "${initial}"${initial === 'setup' ? ` (setup token "${SETUP_TOKEN}")` : initial === 'login' ? ` (password "${DEFAULT_PASSWORD}")` : ''}`)
  console.log(`[mock] SPA from ${DIST}${fs.existsSync(DIST) ? '' : ' (missing — 503 until built)'} · switch: POST /__mock/scenario {"name":"setup|login|onboarding|ready|maxxing"}`)
})
