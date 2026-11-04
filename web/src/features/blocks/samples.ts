// Sample data of each built-in block (previews in Settings -> Conversation blocks). Product-neutral.
export const SAMPLES: Record<string, Record<string, unknown>> = {
  chart: {
    title: 'Revenue per day',
    kind: 'line',
    unit: '€',
    source: 'sales-october.csv',
    series: [
      { name: 'October', points: [['1 Oct', 320], ['8 Oct', 410], ['15 Oct', 455], ['22 Oct', 560], ['31 Oct', 652]] },
      { name: 'September', points: [['1 Oct', 300], ['8 Oct', 330], ['15 Oct', 350], ['22 Oct', 372], ['31 Oct', 398]] },
    ],
  },
  table: {
    title: 'Best products',
    source: 'sales-october.csv',
    columns: ['Product', { label: 'Revenue', type: 'number' }, { label: 'Sales', type: 'number' }, { label: 'Share', type: 'bar' }, { label: 'vs Sept', type: 'delta' }],
    rows: [
      ['Ceramic mug', 3120, 104, 25, '+32 %'],
      ['A5 notebook', 2460, 164, 20, '+9 %'],
      ['Canvas bag', 1980, 66, 16, '-4 %'],
      ['Poster 30 × 40', 1450, 58, 12, '+21 %'],
    ],
  },
  stats: {
    items: [
      { label: 'Revenue', value: '12 480 €', delta: '+18 % vs Sept' },
      { label: 'Orders', value: 312, delta: '+11 %' },
      { label: 'Average basket', value: '40.00 €', delta: '+6 %' },
      { label: 'Refunds', value: 7, delta: '+2', tone: 'warn' },
    ],
  },
  list: {
    title: 'Services',
    items: [
      { title: 'Web server', subtitle: 'ui.example.com', status: 'ok', icon: 'server', value: '99.9 %' },
      { title: 'Nightly backup', subtitle: 'Last run 04:40', status: 'ok', icon: 'database-backup' },
      { title: 'Disk', subtitle: '66 of 80 GB', status: 'warn', icon: 'hard-drive', value: '82 %' },
    ],
  },
  timeline: {
    title: 'Scheduled jobs this week',
    start: '2026-11-02T00:00:00Z',
    end: '2026-11-09T00:00:00Z',
    lanes: [
      { name: 'Backup', sub: 'every day 04:40', events: [{ at: '2026-11-02T04:40:00Z', state: 'ok' }, { at: '2026-11-03T04:40:00Z', state: 'ok' }, { at: '2026-11-04T04:40:00Z', state: 'error' }, { at: '2026-11-05T04:40:00Z', state: 'planned' }] },
      { name: 'Weekly report', sub: 'Mondays 08:30', events: [{ at: '2026-11-02T08:30:00Z', state: 'ok' }] },
    ],
  },
  progress: {
    title: 'Server',
    items: [
      { label: 'Disk /', value: 66, max: 80, unit: 'GB' },
      { label: 'Memory', value: 5.1, max: 16, unit: 'GB' },
      { label: 'Monthly quota', value: 45, max: 100, format: 'percent' },
    ],
  },
  terminal: {
    command: 'npm test -- steps',
    exit_code: 1,
    duration_ms: 4200,
    output: 'FAIL src/checkout/steps.test.tsx\n  ✕ keeps Apple Pay on top (12 ms)\n\n  Expected: "apple-pay"\n  Received: "free-shipping-banner"\n\nTests: 1 failed, 23 passed, 24 total',
  },
  diff: {
    path: '/root/maxxing/projects/acme/topics/website/src/checkout/steps.tsx',
    diff: '@@ -41,6 +41,6 @@ export function CheckoutForm() {\n   return (\n     <form className="checkout">\n-      <FreeShippingBanner />\n       <ApplePayButton />\n+      <FreeShippingBanner />\n       <ShippingAndPayment />\n     </form>\n',
  },
  file: { items: [{ path: '/root/maxxing/projects/acme/topics/website/attachments/2026-10/hero-mobile.png', caption: 'Hero on a phone' }, { path: '/root/maxxing/projects/acme/topics/blog/reports/october.pdf', caption: 'October report' }] },
  link: { url: 'https://ui.example.com/products/mug', title: 'Hand-glazed ceramic mug', description: 'Product page updated with the chosen visual and the new description.', site: 'ui.example.com' },
  form: {
    title: 'Campaign settings',
    submit: 'Send',
    fields: [
      { id: 'audience', label: 'Audience', type: 'choice', options: ['Existing customers', 'New customers', 'Both'], default: 'Both' },
      { id: 'budget', label: 'Ad budget', type: 'range', min: 0, max: 1000, step: 50, unit: '€', default: 200 },
      { id: 'start', label: 'Start', type: 'date', default: '2026-11-10' },
      { id: 'channels', label: 'Channels', type: 'multi', options: ['E-mail', 'Instagram', 'Telegram'], default: ['E-mail', 'Instagram'] },
    ],
  },
  checklist: { title: 'Before sending on 10 Nov', items: [{ label: 'Pick the main visual', checked: true }, 'Proofread the subject line', 'Test the product link'] },
  app: {
    title: 'Price simulator',
    height: 190,
    html: '<div class="ui-grid" style="grid-template-columns:1fr 1fr 1fr;gap:12px;align-items:end"><label class="ui-field"><span class="ui-label">Price</span><input id="p" class="ui-input" type="number" value="29" step="0.5"></label><label class="ui-field"><span class="ui-label">Launch discount: <b id="dv">12</b> %</span><input id="d" type="range" min="0" max="40" value="12" style="accent-color:var(--primary)"></label><div class="ui-card" style="padding:10px 14px"><span class="ui-muted ui-small">Shown price</span><div id="o" class="ui-h2" style="margin:2px 0 0"></div></div></div><p style="margin-top:12px"><button class="ui-btn ui-sm" id="use">Use this price</button></p><script>const p=document.getElementById("p"),d=document.getElementById("d"),o=document.getElementById("o"),dv=document.getElementById("dv");function f(){const v=(p.value*(1-d.value/100));o.textContent=v.toFixed(2)+" €";dv.textContent=d.value}p.oninput=f;d.oninput=f;f();document.getElementById("use").onclick=()=>maxxing.send("Use a launch price of "+o.textContent+" ("+d.value+" % off "+p.value+" €).")</script>',
  },
  created: {
    title: 'What I created for you',
    items: [
      { kind: 'task', title: 'Proofread the launch email', subtitle: 'Acme · before 9 Nov', id: 't_8f2a' },
      { kind: 'cron', title: 'Campaign report', subtitle: 'Every Monday at 08:30', id: 'c_51bd' },
      { kind: 'notification', title: 'Mug stock under 20', subtitle: 'Sound · Telegram' },
    ],
  },
}
