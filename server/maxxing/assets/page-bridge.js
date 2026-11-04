(function () {
  'use strict';
  var channel = '', started = false, ctx, seq = 0, pending = new Map();
  try { channel = JSON.parse(decodeURIComponent(location.hash.slice(1))).channel || ''; } catch (_) {}
  function send(m) { parent.postMessage(Object.assign({channel: channel}, m), '*'); }
  function report(error, fatal) {
    var e = error || {};
    send({mx: 'page-error', message: String(e.message || error || 'Error').slice(0, 2000),
      stack: String(e.stack || '').slice(0, 8000), fatal: !!fatal, recorded: e.status >= 500});
  }
  function apply(m) {
    if (!ctx) return;
    ctx.theme = m.theme || ctx.theme; ctx.lang = m.lang || ctx.lang;
    ctx.route = typeof m.route === 'string' ? m.route : ctx.route;
    ctx.dictionary = m.dictionary || ctx.dictionary;
    document.documentElement.dataset.theme = ctx.theme;
    document.documentElement.style.colorScheme = ctx.theme;
    document.documentElement.lang = ctx.lang;
    for (var k in m.vars || {}) document.documentElement.style.setProperty(k, m.vars[k]);
  }
  addEventListener('error', function (e) { report(e.error || new Error(e.message), false); });
  addEventListener('unhandledrejection', function (e) { report(e.reason, false); });
  addEventListener('message', async function (e) {
    if (e.source !== parent) return;
    var m = e.data || {};
    if (m.channel !== channel) return;
    if (m.mx === 'page-ping') send({mx: 'page-hello'});
    if (m.mx === 'page-reply') {
      var p = pending.get(m.seq);
      if (!p) return;
      pending.delete(m.seq); clearTimeout(p.timer);
      if (m.ok) p.resolve(m.data);
      else { var err = new Error(m.error || 'Request failed'); err.status = m.status; err.mxExt = ctx.id; p.reject(err); }
    }
    if (m.mx === 'page-context') apply(m);
    if (m.mx !== 'page-init' || started) return;
    started = true;
    ctx = {id: m.id, theme: 'dark', lang: 'en', route: '', dictionary: {},
      api: function (path, opts) {
        opts = opts || {};
        return new Promise(function (resolve, reject) {
          var n = ++seq;
          var timer = setTimeout(function () { pending.delete(n); reject(new Error('Extension request timed out')); }, 45000);
          pending.set(n, {resolve: resolve, reject: reject, timer: timer});
          send({mx: 'page-api', seq: n, path: path, method: opts.method || 'GET', body: opts.body, query: opts.query});
        });
      },
      navigate: function (route) { send({mx: 'page-navigate', route: route}); },
      setRoute: function (route) { send({mx: 'page-route', route: route}); },
      t: function (key, vars) {
        var one = vars && typeof vars.count === 'number' && (ctx.lang === 'fr' ? vars.count <= 1 : vars.count === 1);
        var text = (one && ctx.dictionary[key + '#one']) || ctx.dictionary[key] || key;
        for (var k in vars || {}) text = text.split('{' + k + '}').join(String(vars[k]));
        return text;
      },
      icon: function (name, opts) {
        opts = opts || {};
        var svg = new DOMParser().parseFromString((m.icons || {})[name] || (m.icons || {}).puzzle || '<svg/>', 'image/svg+xml').documentElement;
        svg.setAttribute('class', 'ui-icon' + (opts.className ? ' ' + opts.className : ''));
        if (opts.size) { svg.setAttribute('width', opts.size); svg.setAttribute('height', opts.size); }
        return document.importNode(svg, true);
      }};
    apply(m);
    try {
      if (document.readyState === 'loading') await new Promise(function (resolve) { document.addEventListener('DOMContentLoaded', resolve, {once: true}); });
      var mod = await import('./page.js');
      var mount = mod.mount || (mod.default || {}).mount;
      if (typeof mount !== 'function') throw new Error('page.js does not export mount(el, ctx)');
      var cleanup = await mount(document.getElementById('page'), ctx);
      addEventListener('pagehide', function () { if (typeof cleanup === 'function') cleanup(); }, {once: true});
      send({mx: 'page-ready'});
    } catch (error) { report(error, true); }
  });
  send({mx: 'page-hello'});
})();
