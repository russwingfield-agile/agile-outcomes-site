/* Release metrics page. Reads /data/dora-<source>.json (built by scripts/build-dora.mjs) and draws it. No libraries.
   ?sample=1 loads a synthetic preview instead. */
(function () {
  'use strict';
  var sec = document.getElementById('dora');
  if (!sec) return;
  var NS = 'http://www.w3.org/2000/svg', DAY = 86400000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var qs = new URLSearchParams(location.search);
  var sample = qs.get('sample') === '1';
  var sourceId = /^[a-z0-9-]{1,30}$/.test(qs.get('source') || '') ? qs.get('source') : 'kafka';
  var data = null;

  /* ---------- helpers ---------- */
  function el(name, attrs, parent) { var n = document.createElementNS(NS, name); for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]); if (parent) parent.appendChild(n); return n; }
  function text(parent, x, y, str, cls, anchor, rot) { var t = el('text', { x: x, y: y, class: cls || 'ax', 'text-anchor': anchor || 'start', transform: rot ? 'rotate(' + rot + ' ' + x + ' ' + y + ')' : null }, parent); t.textContent = str; return t; }
  function set(id, v) { var n = document.getElementById(id); if (n) n.textContent = v; }
  function num(v) { return v == null ? '–' : Number(v).toLocaleString('en-GB'); }
  function days(v) { return v == null ? '–' : (v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v).toLocaleString('en-GB')) + (v === 1 ? ' day' : ' days'); }
  function dmy(iso) { var d = new Date(iso + 'T00:00:00Z'); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; }
  function dmyFull(iso) { var d = new Date(iso + 'T00:00:00Z'); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
  function niceStep(max, n) { var raw = max / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
  function linearTicks(max, n) { var step = niceStep(max, n || 4), out = []; for (var v = 0; v <= max + step * 0.001; v += step) out.push(v); if (out[out.length - 1] < max) out.push(out[out.length - 1] + step); return out; }
  function setup(id, h) {
    var host = document.getElementById(id), w = Math.max(280, Math.floor(host.clientWidth || 320));
    host.textContent = '';
    var svg = el('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h, role: 'img' }); host.appendChild(svg);
    var tip = document.createElement('div'); tip.className = 'ptip'; tip.hidden = true; host.appendChild(tip);
    host.onpointermove = function (e) {
      var t = e.target.closest && e.target.closest('[data-tip]');
      if (!t) { tip.hidden = true; return; }
      tip.textContent = t.getAttribute('data-tip'); tip.hidden = false;
      var r = host.getBoundingClientRect(), x = Math.min(Math.max(e.clientX - r.left, 90), r.width - 90);
      tip.style.left = x + 'px'; tip.style.top = Math.max(e.clientY - r.top - 12, 8) + 'px';
    };
    host.onpointerleave = function () { tip.hidden = true; };
    return { svg: svg, w: w, h: h, m: { l: 62, r: 14, t: 12, b: 70 } };
  }
  function axes(s, o) {
    var m = s.m, g = el('g', { class: 'axes' }, s.svg), base = s.h - m.b;
    o.yTicks.forEach(function (t) { el('line', { x1: m.l, x2: s.w - m.r, y1: t[0], y2: t[0], class: 'gl' }, g); text(g, m.l - 8, t[0] + 4, t[1], 'ax', 'end'); });
    el('line', { x1: m.l, x2: s.w - m.r, y1: base, y2: base, class: 'axl' }, g); el('line', { x1: m.l, x2: m.l, y1: m.t, y2: base, class: 'axl' }, g);
    o.xTicks.forEach(function (t) { el('line', { x1: t[0], x2: t[0], y1: base, y2: base + 5, class: 'axl' }, g); text(g, t[0], base + 19, t[1], 'ax', 'end', -35); });
    if (o.yTitle) text(g, 14, m.t + (base - m.t) / 2, o.yTitle, 'axt', 'middle', -90);
    if (o.xTitle) text(g, m.l + (s.w - m.l - m.r) / 2, s.h - 6, o.xTitle, 'axt', 'middle');
  }
  function plotH(w) { return w < 520 ? 290 : 340; }
  function aria(id, str) { var s = document.querySelector('#' + id + ' svg'); if (s) s.setAttribute('aria-label', str); }
  // x ticks for categorical bars: every release when there is room, otherwise every few
  function tickEvery(n, w) { return Math.max(1, Math.ceil(n / Math.max(4, Math.floor((w - 90) / 44)))); }
  function catX(s, n) { var iw = s.w - s.m.l - s.m.r, bw = iw / n; return { bw: bw, x: function (i) { return s.m.l + i * bw; } }; }

  /* ---------- 1. cadence ---------- */
  function drawCadence(d) {
    var g = d.cadence.gaps.filter(function (x) { return x.gap != null; });
    var host = document.getElementById('p-cad'), s = setup('p-cad', plotH(host.clientWidth)), m = s.m;
    set('r-cad-n', num(d.cadence.releases)); set('r-cad-med', days(d.cadence.medianGapDays)); set('r-cad-max', days(d.cadence.longestGapDays));
    if (!g.length) { host.textContent = 'Too few releases to draw.'; return; }
    var max = Math.max.apply(null, g.map(function (x) { return x.gap; })), yt = linearTicks(max * 1.08, 4), top = yt[yt.length - 1];
    var ih = s.h - m.t - m.b, c = catX(s, g.length), y = function (v) { return m.t + ih - (v / top) * ih; }, every = tickEvery(g.length, s.w), xt = [];
    g.forEach(function (x, i) { if (i % every === 0) xt.push([c.x(i) + c.bw / 2, x.name]); });
    axes(s, { yTicks: yt.map(function (v) { return [y(v), num(v)]; }), xTicks: xt, yTitle: 'Days since previous release', xTitle: 'Release' });
    g.forEach(function (x, i) {
      var minor = /\.0$/.test(x.name);
      el('rect', { x: c.x(i) + c.bw * 0.16, y: y(x.gap), width: c.bw * 0.68, height: Math.max(0, (x.gap / top) * ih), rx: 2, class: 'cbar' + (minor ? '' : ' part'), 'data-tip': x.name + ', ' + dmyFull(x.date) + ': ' + Math.round(x.gap) + ' days after the previous release' }, s.svg);
    });
    aria('p-cad', 'Bar chart of days between releases. ' + d.cadence.releases + ' releases, median gap ' + d.cadence.medianGapDays + ' days, longest ' + d.cadence.longestGapDays + '.');
  }

  /* ---------- 2. lead time, split into review and waiting ---------- */
  function drawLead(d) {
    var L = d.lead, host = document.getElementById('p-lead');
    set('r-ld-p50', days(L.p50)); set('r-ld-rev', days(L.reviewP50)); set('r-ld-wait', days(L.waitP50)); set('r-ld-p85', days(L.p85));
    var rows = L.byRelease;
    if (!L.reported || !rows.length) { host.textContent = ''; var p = document.createElement('p'); p.className = 'dora-note'; p.textContent = 'Too few pull requests could be linked to a shipped ticket to measure lead time. ' + L.changes + ' linked.'; host.appendChild(p); return; }
    var s = setup('p-lead', plotH(host.clientWidth)), m = s.m;
    var max = Math.max.apply(null, rows.map(function (r) { return (r.review || 0) + (r.wait || 0); }).concat([1])), yt = linearTicks(max * 1.08, 4), top = yt[yt.length - 1];
    var ih = s.h - m.t - m.b, c = catX(s, rows.length), y = function (v) { return m.t + ih - (v / top) * ih; }, every = tickEvery(rows.length, s.w), xt = [];
    rows.forEach(function (r, i) { if (i % every === 0) xt.push([c.x(i) + c.bw / 2, r.name]); });
    axes(s, { yTicks: yt.map(function (v) { return [y(v), num(v)]; }), xTicks: xt, yTitle: 'Median days, opened to released', xTitle: 'Release that shipped the changes' });
    rows.forEach(function (r, i) {
      var x0 = c.x(i) + c.bw * 0.16, w = c.bw * 0.68;
      if (r.review == null) { el('rect', { x: x0, y: y(top * 0.04), width: w, height: (top * 0.04 / top) * ih, rx: 2, class: 'dbar-none', 'data-tip': r.name + ': too few linked changes (' + r.n + ') to measure' }, s.svg); return; }
      var hr = (r.review / top) * ih, hw = (r.wait / top) * ih;
      var tip = r.name + ', ' + dmyFull(r.date) + ', ' + r.n + ' changes: median ' + r.review + ' days in review, then ' + r.wait + ' days waiting for the release';
      el('rect', { x: x0, y: m.t + ih - hr, width: w, height: Math.max(0, hr), class: 'dbar-rev', 'data-tip': tip }, s.svg);
      el('rect', { x: x0, y: m.t + ih - hr - hw, width: w, height: Math.max(0, hw), rx: 2, class: 'dbar-wait', 'data-tip': tip }, s.svg);
    });
    aria('p-lead', 'Stacked bars of median days per release, split into time in review and time waiting for the release. Overall median ' + L.p50 + ' days: ' + L.reviewP50 + ' in review and ' + L.waitP50 + ' waiting.');
  }

  /* ---------- 3. change failure ---------- */
  function drawFailure(d, browse) {
    var F = d.failure, rows = F.perRelease, host = document.getElementById('p-fail');
    set('r-fl-j', num(F.judged)); set('r-fl-f', num(F.failed)); set('r-fl-r', F.rate == null ? '–' : F.rate + '%');
    if (!rows.length) { host.textContent = ''; return; }
    var s = setup('p-fail', plotH(host.clientWidth) - 40), m = s.m;
    var max = Math.max.apply(null, rows.map(function (r) { return r.bugs; }).concat([2])), yt = linearTicks(max, Math.min(4, max)), top = yt[yt.length - 1];
    var ih = s.h - m.t - m.b, c = catX(s, rows.length), y = function (v) { return m.t + ih - (v / top) * ih; }, every = tickEvery(rows.length, s.w), xt = [];
    rows.forEach(function (r, i) { if (i % every === 0) xt.push([c.x(i) + c.bw / 2, r.name]); });
    axes(s, { yTicks: yt.map(function (v) { return [y(v), num(v)]; }), xTicks: xt, yTitle: 'Serious bugs within 30 days', xTitle: 'Release' });
    rows.forEach(function (r, i) {
      var cx = c.x(i) + c.bw / 2, rad = Math.min(8, c.bw * 0.3), tip = r.name + ', ' + dmyFull(r.date) + ': ' + (!r.judged ? 'less than 30 days old, not judged yet' : r.bugs ? r.bugs + ' serious bug' + (r.bugs > 1 ? 's' : '') + ' within 30 days' + (r.keys.length ? ' (' + r.keys.join(', ') + ')' : '') : 'no serious bugs within 30 days');
      el('circle', { cx: cx, cy: y(r.bugs), r: rad, class: !r.judged ? 'dmk-open' : r.bugs ? 'dmk-fail' : 'dmk-ok', 'data-tip': tip }, s.svg);
      el('rect', { x: c.x(i), y: m.t, width: c.bw, height: ih, fill: 'transparent', 'data-tip': tip }, s.svg);
    });
    aria('p-fail', F.failed + ' of ' + F.judged + ' releases were followed by a Blocker or Critical bug within 30 days.');
    // the bugs, linked to the tracker when it is a real project
    var list = document.getElementById('d-fail-list'), ol = document.getElementById('d-fail-ol'); ol.textContent = '';
    var shown = 0;
    rows.slice().reverse().forEach(function (r) {
      r.keys.forEach(function (k) {
        if (shown >= 8) return; shown++;
        var li = document.createElement('li'), a = document.createElement(browse ? 'a' : 'b');
        if (browse) { a.href = browse + k; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        a.textContent = k; var sp = document.createElement('span'); sp.textContent = 'raised within 30 days of release ' + r.name + ' (' + dmyFull(r.date) + ')';
        li.appendChild(a); li.appendChild(sp); ol.appendChild(li);
      });
    });
    list.hidden = !shown;
  }

  /* ---------- 4. time to restore, and how the data was linked: ranked bars ---------- */
  function bars(hostId, rows, valueText) {
    var host = document.getElementById(hostId); host.textContent = '';
    var max = Math.max.apply(null, rows.map(function (r) { return r.v; }).concat([1]));
    rows.forEach(function (r) {
      var row = document.createElement('div'); row.className = 'pl-row';
      var lab = document.createElement('span'); lab.className = 'pl-l'; lab.textContent = r.label; lab.title = r.label;
      var track = document.createElement('span'); track.className = 'pl-t'; var bar = document.createElement('i'); bar.style.width = Math.max(1.5, (r.v / max) * 100) + '%'; track.appendChild(bar);
      var val = document.createElement('span'); val.className = 'pl-v'; val.textContent = valueText(r);
      row.appendChild(lab); row.appendChild(track); row.appendChild(val); host.appendChild(row);
    });
  }
  function drawRestore(d) {
    var R = d.restore;
    set('r-rs-n', num(R.fixed)); set('r-rs-p50', days(R.p50)); set('r-rs-p85', days(R.p85)); set('r-rs-open', num(R.notYetShipped));
    var items = R.items.slice().sort(function (a, b) { return b.days - a.days; }).slice(0, 12);
    bars('d-restore', items.map(function (x) { return { label: x.key + ' (fixed in ' + x.fixedIn + ')', v: x.days }; }), function (r) { return days(r.v); });
    if (!items.length) document.getElementById('d-restore').textContent = 'No serious bugs in the period have a released fix yet.';
  }
  function drawLinkage(d) {
    var k = d.linkage, rows = [
      { label: 'Merged pull requests', v: k.mergedPullRequests },
      { label: 'With a ticket key in the title', v: k.withTicketKey != null ? k.withTicketKey : Math.round(k.mergedPullRequests * (k.withTicketKeyPercent || 0) / 100) },
      { label: 'Linked to a shipped ticket', v: k.changesLinked },
      { label: 'Merged, not yet released', v: k.mergedNotYetReleased },
      { label: 'Ticket not in the shipped set', v: k.ticketNotFound },
    ];
    bars('d-link', rows, function (r) { return num(r.v) + (r.label === 'With a ticket key in the title' && k.withTicketKeyPercent != null ? ' · ' + k.withTicketKeyPercent + '%' : ''); });
    var cover = 'Releases from ' + dmyFull(d.from) + ' to ' + dmyFull(d.to) + '. Lead time covers releases from ' + dmyFull(d.leadFrom) + (d.prsFrom ? ', because pull requests are read back to ' + dmyFull(d.prsFrom) + ' and work can wait months for a release' : '') + '.';
    if (d.source && d.source.pullRequestListComplete === false) cover += ' The pull request list stopped early (' + (d.source.pullRequestError || 'page limit') + '), so lead time covers less than a full year.';
    set('d-cover', cover);
  }

  /* ---------- headline, commentary, loading ---------- */
  function headline(d) {
    set('k-rel', num(d.cadence.releases)); set('k-rel-d', d.cadence.medianGapDays != null ? 'one every ' + days(d.cadence.medianGapDays) : '');
    set('k-lead', days(d.lead.p50)); set('k-lead-d', d.lead.reported ? days(d.lead.reviewP50) + ' in review, ' + days(d.lead.waitP50) + ' waiting' : 'too few linked changes');
    set('k-cfr', d.failure.rate == null ? '–' : d.failure.rate + '%'); set('k-cfr-d', d.failure.judged ? d.failure.failed + ' of ' + d.failure.judged + ' releases' : 'too few releases');
    set('k-ttr', days(d.restore.p50)); set('k-ttr-d', d.restore.p85 != null ? '85th percentile ' + days(d.restore.p85) : d.restore.fixed ? 'too few to measure' : '');
    set('d-period', 'Last ' + Math.round(d.windowDays / 30.44) + ' months, ' + dmy(d.from) + ' to ' + dmyFull(d.to));
    var when = new Date(d.generatedAt);
    set('d-updated', (d.source && d.source.synthetic ? 'Simulated ' : 'Refreshed ') + when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }));
  }
  var MAP = { overall: 'in-overall', release: 'in-release', leadTime: 'in-leadTime', failure: 'in-failure', restore: 'in-restore', summary: 'in-summary' };
  function commentary(d) {
    var f = d.findings || {};
    Object.keys(MAP).forEach(function (k) {
      var box = document.getElementById(MAP[k]); if (!box) return;
      if (f[k]) { box.querySelector('.in-t').textContent = f[k].text; box.hidden = false; } else box.hidden = true;
    });
    document.getElementById('d-sum-box').hidden = !f.summary;
  }
  function draw() {
    if (!data) return;
    var browse = data.source && !data.source.synthetic ? data.source.jiraBrowse : null;
    [function () { drawCadence(data); }, function () { drawLead(data); }, function () { drawFailure(data, browse); }, function () { drawRestore(data); }, function () { drawLinkage(data); }].forEach(function (f) { try { f(); } catch (e) { if (window.console) console.error(e); } });
  }
  function show(j) {
    data = j; sec.setAttribute('data-state', 'ready');
    var src = j.source || {}, syn = !!src.synthetic;
    document.getElementById('d-synth').hidden = !syn;
    set('dora-h', syn ? 'How fast, and how safely, does a fictional project ship?' : 'How fast, and how safely, does ' + (src.title || 'this project') + ' ship?');
    set('d-blurb', syn ? 'A simulated project with Kafka-like habits, to preview the page.' : 'Release cadence, lead time for changes, change failure rate and time to restore, worked out by linking the project\'s Jira tickets to its GitHub pull requests.');
    var s = document.getElementById('d-src');
    s.textContent = '';
    if (!syn && src.jiraUrl) {
      s.appendChild(document.createTextNode('Data source: the public Jira project '));
      var a = document.createElement('a'); a.href = src.jiraUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = src.jiraUrl.replace('https://', ''); s.appendChild(a);
      s.appendChild(document.createTextNode(' and the pull requests at '));
      var b = document.createElement('a'); b.href = src.githubUrl; b.target = '_blank'; b.rel = 'noopener'; b.textContent = src.githubUrl.replace('https://', ''); s.appendChild(b);
      s.appendChild(document.createTextNode(', used here as a worked example. Team-level figures only: pull request titles are read to find a ticket key and are not kept, and no individuals are shown. Refreshed on a schedule, not live.'));
    } else if (syn) s.textContent = 'Synthetic data from a simulation. No real project or person is represented.';
    headline(j); draw(); commentary(j);
  }
  function missing(msg) { sec.setAttribute('data-state', 'missing'); if (msg) set('d-missing', msg); set('d-updated', 'Not available yet'); }

  var url = sample ? '/data/dora-sample.json' : '/data/dora-' + sourceId + '.json';
  fetch(url, { headers: { Accept: 'application/json' } })
    .then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
    .then(show)
    .catch(function () { missing(); });
  var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(draw, 150); });
})();
